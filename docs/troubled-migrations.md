# Troubled Migrations: Real Failures the Native Tool Can't Handle

These are real production failures encountered during a SurrealDB v2.3.7 to v3.0.5 migration. Every example below crashed the official `surreal import` tool. The custom migration scripts in this repo handle all of them.

---

## 1. Compound Array Record IDs

### The Problem

SurrealDB supports compound (array-based) record IDs for composite keys. These look like:

```
block:[document:abc123, '/page/0/Text/5']
```

The v2 export produces INSERT statements containing these IDs:

```sql
INSERT [
  {
    id: block:[document:⟨a1b2c3d4-e5f6-7890-abcd-ef1234567890⟩, '/page/0/Text/13'],
    content: 'Introduction to quantum computing...',
    type: 'paragraph',
    page: document:⟨a1b2c3d4-e5f6-7890-abcd-ef1234567890⟩
  }
];
```

**`surreal import` result:** Parse error. The text parser cannot handle the nested record IDs inside the array brackets. 100% failure rate on these records.

### Why It Breaks

The v3 text parser sees `[document:⟨...⟩, '/page/...']` and fails to parse the nested record ID inside the array literal. The comma between array elements gets confused with the comma between object fields.

### SDK Parameter Binding Also Breaks

Even using the JS SDK, `StringRecordId` with compound IDs is rejected by v3's parameter binding:

```typescript
// BROKEN - v3 rejects this
const id = new StringRecordId("block:[document:abc, '/page/0']");
await db.query("SELECT * FROM $id", { id });
// Error: compound array format rejected by HTTP parser

// ALSO BROKEN - SDK serializes to internal format
const rid = new RecordId("block", [new RecordId("document", "abc"), "/page/0"]);
console.log(rid.toString());
// => block:[ r"document:abc", s"/page/0" ]
// The r"..." and s"..." prefixes are SDK internal format, not valid SurrealQL
```

### How the Custom Tool Fixes It

The custom SurQL parser (`surrealdb-migrate.ts`) parses compound IDs into proper `RecordId` objects and sends them via CBOR binary protocol (not text):

```typescript
// Parser tracks bracket depth for compound IDs
while (this.pos < this.src.length) {
    if (ch === "[") bracketDepth++;
    if (ch === "]") bracketDepth--;
    // Only treat , as delimiter at top level (not inside [...])
    if (bracketDepth === 0 && ch === ",") break;
}

// Then imports via CBOR over WebSocket
const hasCompoundIds = batch.some(r =>
    Object.values(r).some(v => v instanceof StringRecordId)
);
if (hasCompoundIds) {
    await s.query("INSERT $data", { data: batch }); // CBOR, not text
}
```

### Real Table That Uses Compound IDs

```sql
-- The block table uses compound array IDs: block:[document_id, path]
DEFINE TABLE OVERWRITE block SCHEMAFULL;
DEFINE FIELD OVERWRITE content ON block TYPE option<string>;
DEFINE FIELD OVERWRITE type ON block TYPE option<string>;
DEFINE FIELD OVERWRITE page ON block TYPE option<record<document>>;

-- chunk.block_ids contains arrays of these compound IDs
DEFINE FIELD OVERWRITE block_ids ON chunk TYPE array<record<block>>;
```

---

## 2. Backslash Escaping in String Content (LaTeX, File Paths)

### The Problem

SurrealDB v2's export does not properly escape backslashes inside string literals. If your data contains LaTeX, file paths, or any content with backslashes, the export produces invalid SurQL.

**Exported (broken):**
```sql
INSERT {
  id: document:⟨abc123⟩,
  content: 'The equation uses \boldsymbol{x} and \sum_{i=0}^{n} for the proof'
};
```

**`surreal import` result:** Parse error. `\b` is interpreted as a backspace escape, `\s` as an invalid escape sequence.

### More Real Examples

```sql
-- LaTeX in academic papers
'Given \alpha \in \mathbb{R}, we define \phi(x) = \frac{1}{\sqrt{2\pi}}'
-- Parser sees: \a (invalid), \i (invalid), \m (invalid), \p (invalid), \f (invalid), \s (invalid)

-- File paths in document metadata
'source: C:\Users\Documents\2025\report.pdf'
-- Parser sees: \U (invalid), \D (invalid), \2 (invalid), \r (carriage return!)

-- Markdown with code blocks containing regex
'Pattern: /^[a-z]+\.[a-z]+$/  matches domain.tld'
-- Parser sees: \. (invalid)

-- JSON embedded in content
'config: {"path": "data\\models\\v2"}'
-- Double backslash is valid, but single backslashes in other strings aren't
```

### How the Restore Script Fixes It

The `surrealdb-restore-sdk.ts` script walks through every string literal and fixes invalid escape sequences by doubling the backslash:

```typescript
function fixBackslashEscaping(line: string): string {
    // Walk char by char inside string literals
    if (c === "\\") {
        const next = line[i + 1];
        // Valid SurrealQL escapes: \\ \' \" \n \r \t \0 \/ \u{...}
        if (['\\', "'", '"', 'n', 'r', 't', '0', '/', 'u'].includes(next)) {
            result.push(c, next); // keep valid escapes
        } else {
            result.push("\\\\"); // double invalid backslashes
            // \boldsymbol => \\boldsymbol (now valid)
        }
    }
}
```

The custom migration tool (`surrealdb-migrate.ts`) avoids this entirely by parsing into JS objects and using CBOR binary protocol - no text escaping needed.

---

## 3. Multi-line INSERT Statements

### The Problem

When record content contains newlines (markdown documents, code blocks, etc.), the v2 export splits the INSERT statement across multiple lines:

```sql
INSERT {
  id: document:⟨abc123⟩,
  content: 'Chapter 1: Introduction

This chapter covers the basics of machine learning.
We start with supervised learning and then move to
unsupervised approaches.

## Key Concepts

- Classification
- Regression
- Clustering',
  type: 'markdown'
};
```

**`surreal import` result:** Fails because it reads line-by-line and sees `This chapter covers...` as a standalone statement, not part of the INSERT.

### Real Scale

In a production database with 119,962 records, roughly 30% of INSERT statements spanned multiple lines due to markdown content in documents.

### How the Custom Tool Fixes It

The parser reassembles multi-line statements by tracking when an INSERT starts and accumulating continuation lines:

```typescript
for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i];
    const trimmed = line.trim();

    if (trimmed.startsWith("INSERT")) {
        flushInsert(); // save previous INSERT
        currentInsert = line;
    } else if (currentInsert) {
        // Not a new keyword - continuation of current INSERT
        currentInsert += "\n" + line;
    }
}
```

---

## 4. Transaction Result Shape Changed

### The Problem

SurrealDB v3 + SDK v2 changed how transaction results are returned. This isn't a migration tool failure, but it broke application code after upgrading.

**v1 SDK behavior:**
```typescript
const result = await db.query(`
    BEGIN TRANSACTION;
    UPDATE $id SET status = 'uploaded';
    LET $doc = CREATE ONLY document CONTENT { ... };
    RETURN (SELECT * FROM $doc);
    COMMIT TRANSACTION;
`);
// result = [[{ id: "document:abc", ... }]]  -- just the RETURN value
```

**v2 SDK behavior:**
```typescript
const results = await db.query(`
    BEGIN TRANSACTION;
    UPDATE $id SET status = 'uploaded';
    LET $doc = CREATE ONLY document CONTENT { ... };
    RETURN (SELECT * FROM $doc);
    COMMIT TRANSACTION;
`).collect();
// results = [
//   null,                    // BEGIN
//   [{ id: "...", ... }],    // UPDATE result
//   null,                    // LET
//   [{ id: "...", ... }],    // RETURN result
//   null,                    // COMMIT
// ]
// WRONG: .find(r => Array.isArray(r)) matches UPDATE, not RETURN!
```

### Production Bug This Caused

Code that used `.find(r => Array.isArray(r))` to extract the RETURN value started returning the UPDATE result instead, because UPDATE also returns an array in v2.

### The Fix

Break transactions into separate queries:

```typescript
// BEFORE (broken - ambiguous result parsing)
const rawResults = await db.query(`
    BEGIN TRANSACTION;
    UPDATE $id SET status = 'uploaded';
    LET $doc = CREATE ONLY document CONTENT { ... };
    RETURN (SELECT * FROM $doc);
    COMMIT TRANSACTION;
`, params);
const document = rawResults.find(r => Array.isArray(r))?.[0]; // WRONG

// AFTER (correct - each query returns exactly its result)
await db.query(`UPDATE $id SET status = 'uploaded'`, { id });
const [doc] = await db.query(`CREATE ONLY document CONTENT { ... }`, params).raw();
```

---

## 5. INSERT RELATION with Compound IDs

### The Problem

`INSERT RELATION` statements with compound record IDs fail in v3 when using parameter binding:

```sql
-- Exported from v2
INSERT RELATION [
  {
    id: sources_from:⟨generated-id-1⟩,
    in: chunk:⟨chunk-uuid-1⟩,
    out: block:[document:⟨doc-uuid⟩, '/page/0/Text/5'],
    order: 0
  },
  {
    id: sources_from:⟨generated-id-2⟩,
    in: chunk:⟨chunk-uuid-1⟩,
    out: block:[document:⟨doc-uuid⟩, '/page/0/Text/6'],
    order: 1
  }
];
```

**`surreal import` result:** Parse error on the compound `out` field.

**SDK parameter binding also fails:**
```typescript
const rels = blockIds.map((bid, i) => ({
    in: SurrealIdAuto(chunkId),
    out: SurrealIdAuto(bid),  // StringRecordId - rejected by v3
    order: i,
}));
await db.query("INSERT RELATION INTO sources_from $rels", { rels });
// Error: v3 rejects StringRecordId in parameter binding
```

### The Fix (Application Code)

Use `LET` + `type::record()` + `RELATE` instead of `INSERT RELATION`:

```typescript
// ridToSurql() converts RecordId objects to valid SurrealQL strings
import { ridToSurql } from "./record-id";

// Convert SDK RecordId to valid SurrealQL that type::record() can parse
const blockIdStr = ridToSurql(blockRid);
// => "block:[document:abc, '/page/0/Text/5']"  (valid SurrealQL)
// NOT: "block:[ r\"document:abc\", s\"/page/0/Text/5\" ]"  (SDK internal format)

await db.query(
    `LET $in = type::record($chunkId);
     LET $out = type::record($blockId);
     RELATE $in->sources_from->$out SET order = $order`,
    { chunkId: ridToSurql(chunkRid), blockId: blockIdStr, order: 0 },
);
```

### Where `type::record()` Works and Where It Doesn't

| Statement | `type::record()` inline | Needs LET workaround |
|-----------|------------------------|---------------------|
| `SELECT ... WHERE` | Yes | No |
| `UPDATE` | Yes | No |
| `DELETE ... WHERE` | Yes | No |
| `CREATE CONTENT` | Yes | No |
| `RELATE $a->edge->$b` | **No** | Yes |
| `INSERT RELATION $data` | **No** | Yes |

---

## 6. Large INSERT Batches (>10MB)

### The Problem

Some tables with large text content (full document bodies, embeddings) produce INSERT statements exceeding 10MB. The SurrealDB text parser crashes on these.

### Real Example

```sql
-- A single INSERT with 500 document records, each with full markdown content
INSERT [
  { id: document:⟨uuid1⟩, content: '...50KB of markdown...', embedding: [0.1, 0.2, ... 1024 floats] },
  { id: document:⟨uuid2⟩, content: '...40KB of markdown...', embedding: [0.3, 0.1, ... 1024 floats] },
  -- ... 498 more records
];
-- Total: ~12MB single statement
```

**`surreal import` result:** OOM crash or parse timeout.

### How the Custom Tool Handles It

The tool batches records (default 50 per batch) and sends them individually via the SDK:

```typescript
const BATCH = 50; // configurable via --batch flag

for (let b = 0; b < records.length; b += BATCH) {
    const batch = records.slice(b, b + BATCH);
    try {
        await surreal.insert(table, batch);
    } catch {
        // Fallback: insert one-by-one
        for (const record of batch) {
            await surreal.insert(table, [record]);
        }
    }
}
```

The restore script also proactively splits large INSERTs:

```typescript
const MAX_BULK_SIZE = 10 * 1024 * 1024; // 10MB
if (size > MAX_BULK_SIZE) {
    console.log(`too large - splitting into records...`);
    const { successes, errors } = await importRecordByRecord(surreal, stmt.line, table);
}
```

---

## 7. SDK v2 RecordId Serialization Format Mismatch

### The Problem

The SDK v2's `RecordId.toString()` produces a type-prefixed format for compound IDs that is NOT valid SurrealQL:

```typescript
const rid = new RecordId("block", [
    new RecordId("document", "abc123"),
    "/page/0/Text/5"
]);

// SDK internal format (INVALID SurrealQL)
console.log(rid.toString());
// => block:[ r"document:abc123", s"/page/0/Text/5" ]
//    ^^^ r"..." and s"..." are SDK type prefixes

// What type::record() needs (VALID SurrealQL)
// => block:[document:abc123, '/page/0/Text/5']
```

If you call `String()` on a RecordId and then pass it back as a parameter, `type::record()` cannot parse the SDK's internal format.

### The Fix

We built `ridToSurql()` to produce valid SurrealQL from RecordId objects:

```typescript
function ridToSurql(rid: unknown): string {
    if (rid instanceof RecordId) {
        const table = rid.table;
        const id = rid.id;
        if (Array.isArray(id)) {
            // Recursively convert each part
            const parts = id.map(p => ridToSurql(p));
            return `${table}:[${parts.join(", ")}]`;
        }
        if (typeof id === "string") {
            // Simple alphanumeric IDs: document:abc123
            if (/^[a-zA-Z0-9_]+$/.test(id)) return `${table}:${id}`;
            // Complex IDs need angle brackets: page:⟨uuid-here⟩
            return `${table}:\u27E8${id}\u27E9`;
        }
    }
    // StringRecordId already has the right format
    if (rid instanceof StringRecordId) return rid.toString();
    // Primitives in compound IDs
    if (typeof rid === "string") return `'${rid.replace(/'/g, "\\'")}'`;
    return String(rid);
}
```

**Examples:**
```typescript
ridToSurql(new RecordId("document", "abc123"))
// => "document:abc123"

ridToSurql(new RecordId("page", "21493df7-786f-8189-bafc-ffb262928309"))
// => "page:⟨21493df7-786f-8189-bafc-ffb262928309⟩"

ridToSurql(new RecordId("block", [new RecordId("document", "abc"), "/page/0/Text/13"]))
// => "block:[document:abc, '/page/0/Text/13']"
```

---

## Summary: Official Tool vs Custom Tool

| Failure Case | `surreal import` | `surrealdb-migrate.ts` |
|--------------|-------------------|----------------------|
| Compound array record IDs | Parse error (100% fail) | CBOR binary - works |
| Backslash in strings (LaTeX) | Parse error (~30% fail) | JS object parsing - works |
| Multi-line INSERT statements | Broken reassembly (~30% fail) | Line-by-line accumulation - works |
| Large INSERT batches (>10MB) | OOM / timeout | Batched (50 records) - works |
| INSERT RELATION + compound IDs | Parse error (100% fail) | CBOR + query param - works |
| Unicode angle bracket IDs | Intermittent failures | Proper parsing - works |
| **Total: 119,962 records** | **Thousands of failures** | **0 failures** |
