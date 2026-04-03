---
name: surrealdb-migrate
description: "SurrealDB v2 to v3 migration assistant. Use when migrating SurrealDB from v2.x to v3.x, updating schemas, fixing broken queries, or restoring backups across versions."
user-invocable: true
allowed-tools: Read Grep Bash Glob Edit Write
argument-hint: "[backup-file or schema-directory]"
---

# SurrealDB v2 to v3 Migration Assistant

You are a SurrealDB migration expert. You help users migrate from SurrealDB v2.x (including v2.3.7) to v3.x (including v3.0.5), and from JS SDK v1.x to v2.x.

## Migration Strategy Overview

The official `surreal export` + `surreal import` roundtrip is **broken** for most real-world databases. Common failures:

1. **Backslash escaping bug**: v2 export doesn't properly escape backslashes in strings (LaTeX `\boldsymbol`, file paths `\n` in content). The v3 parser rejects these.
2. **Compound array record IDs**: IDs like `block:[document:xxx, '/path']` are not supported by the text-based `surreal import`.
3. **Multi-line INSERT statements**: Exports split INSERT statements across lines when string content contains newlines (markdown paragraphs). The importer can't reassemble them.
4. **Large INSERT batches**: Statements over ~10MB crash SurrealDB's text parser.

**The solution**: Use the custom migration scripts in this repo that bypass the text parser entirely by using the JS SDK's CBOR-over-WebSocket protocol.

## Step-by-Step Migration Playbook

### Phase 1: Pre-Migration Assessment

1. **Check current SurrealDB version**:
   ```bash
   surreal version
   # or via HTTP:
   curl -s http://localhost:8000/version
   ```

2. **Export your v2 database**:
   ```bash
   # v2 uses GET for export
   curl -X GET http://localhost:8000/export \
     -H "NS: your_namespace" -H "DB: your_database" \
     -H "Authorization: Basic $(echo -n 'root:root' | base64)" \
     > backup-v2.surql
   ```
   Note: v3 changed export to POST - adjust if exporting from v3.

3. **Assess backup size and complexity**:
   ```bash
   bun run scripts/surrealdb-migrate.ts backup-v2.surql --dry-run
   ```
   This parses without importing, showing statement counts and sizes.

4. **Scan for v2-specific patterns** in your codebase:
   ```bash
   # Find v2 function calls that need renaming
   rg 'type::thing|rand::guid|SEARCH ANALYZER|::from::|::is::' --type ts --type surql
   ```

### Phase 2: Schema Migration

Apply these transformations to all `.surql` schema files and application code:

#### Function Renames
| v2 | v3 |
|----|-----|
| `duration::from::X()` | `duration::from_X()` |
| `string::is::X()` | `string::is_X()` |
| `type::is::X()` | `type::is_X()` |
| `time::is::X()` | `time::is_X()` |
| `time::from::X()` | `time::from_X()` |
| `rand::guid()` | `rand::id()` |
| `type::thing(table, id)` | `type::record(table, id)` |
| `string::distance::osa_distance()` | `string::distance::osa()` |

#### Syntax Changes
| v2 | v3 |
|----|-----|
| `SEARCH ANALYZER` | `FULLTEXT ANALYZER` |
| `MTREE DIMENSION N` | `HNSW DIMENSION N` |
| `VALUE <future> { ... }` | `COMPUTED ...` |
| `references<T>` | `option<array<record<T>>> REFERENCE` |
| `FLEXIBLE` (on SCHEMALESS) | Only allowed on SCHEMAFULL tables |
| `IF NOT EXISTS` | `OVERWRITE` (preferred for idempotent schemas) |

#### Index Changes
- `DOC_IDS_ORDER`, `POSTINGS_ORDER`, `DOC_LENGTHS_ORDER`, `DOC_IDS_CACHE`, `POSTINGS_CACHE`, `DOC_LENGTHS_CACHE` - all removed from fulltext index syntax
- Vector indexes: `MTREE` replaced by `HNSW`

#### Export/Import Changes
- Export endpoint: `GET /export` changed to `POST /export`
- `record_references` is GA - no `--allow-experimental` flag needed

### Phase 3: JS SDK v1 to v2 Migration

#### Connection
```typescript
// v1
await db.connect(url, { auth: { username, password } });

// v2
await db.connect(url, { authentication: { username, password } });
// OR connect + signin separately:
await db.connect(url);
await db.signin({ username, password });
```

#### RecordId API
```typescript
// v1
recordId.tb    // table name
stringRecordId.rid  // raw ID string

// v2
recordId.table  // table name
stringRecordId.toString()  // raw ID string
```

#### Query Results
```typescript
// v1 - query returns results directly
const results = await db.query("SELECT * FROM user");

// v2 - query returns builder, use .collect()
const results = await db.query("SELECT * FROM user").collect();
```

#### Transactions
```typescript
// v1 - returns just the RETURN value
const [result] = await db.query("BEGIN; LET $x = 1; RETURN $x; COMMIT;");

// v2 - returns one slot per statement
const results = await db.query("BEGIN; LET $x = 1; RETURN $x; COMMIT;").collect();
// Use .collect(N) to pick specific index
```

#### Critical: Compound Record IDs
```typescript
// BROKEN in v3 - StringRecordId with compound array format rejected by HTTP parser
const id = new StringRecordId('block:[document:xxx, "/path"]');
await db.select(id); // FAILS on v3

// CORRECT - pass RecordId objects directly as query params
await db.query("SELECT * FROM $id", { id: new RecordId("block", [docId, path]) });
```

#### Table Class
```typescript
// v2 requires Table class for select/update/create
import { Table } from "surrealdb";
await db.select(new Table("user"));

// OR use raw query (still works)
await db.query("SELECT * FROM user");
```

### Phase 4: Data Migration

Use the custom migration tool (bypasses broken export/import):

```bash
# Basic migration to v3 instance
bun run scripts/surrealdb-migrate.ts backup-v2.surql \
  --url http://localhost:8000 \
  --user root --pass root \
  --ns prod --db prod \
  --v3

# Data only (schema already applied separately)
bun run scripts/surrealdb-migrate.ts backup-v2.surql \
  --data-only \
  --url http://localhost:8000 \
  --user root --pass root \
  --ns prod --db prod

# With custom batch size (default 50)
bun run scripts/surrealdb-migrate.ts backup-v2.surql --batch 100 --v3
```

The tool provides:
- **Custom SurQL parser** that handles compound IDs, angle brackets, multi-line INSERTs
- **CBOR-over-WebSocket** import (bypasses text parser entirely)
- **Checkpoint/resume** for crash recovery
- **Auto-reconnect** on WebSocket drops
- **Record-by-record fallback** when batch insert fails
- **v3 schema transformations** applied on-the-fly with `--v3` flag

#### Alternative: SDK-based Restore (for backslash issues)

If your main issue is backslash escaping in string content:

```bash
bun run scripts/surrealdb-restore-sdk.ts backup-v2.surql \
  --url http://localhost:8000 \
  --user root --pass root \
  --ns prod --db prod
```

This tool fixes backslash escaping in-flight and uses WebSocket SDK for import.

### Phase 5: Verification

After migration, verify data integrity:

```bash
# Check record counts per table
echo "INFO FOR DB;" | surreal sql \
  --conn http://localhost:8000 \
  --user root --pass root \
  --ns prod --db prod

# Spot-check specific tables
echo "SELECT count() FROM your_table GROUP ALL;" | surreal sql \
  --conn http://localhost:8000 \
  --user root --pass root \
  --ns prod --db prod --pretty

# Compare with v2 counts
echo "SELECT count() FROM your_table GROUP ALL;" | surreal sql \
  --conn http://v2-instance:8000 \
  --user root --pass root \
  --ns prod --db prod --pretty
```

## Benchmarks and Impact

Based on real-world migration of a production database (119,962 records):

### Migration Performance
| Metric | Value |
|--------|-------|
| Total records migrated | 119,962 |
| Migration failures | 0 |
| Schema statements | ~100 (DEFINE/OPTION) |
| INSERT statements | ~200 (batched) |
| Batch size | 50 records |
| Protocol | CBOR over WebSocket |

### v3 Improvements
- **Streaming execution engine**: Queries no longer buffer entire result sets in memory
- **New query planner**: Better index utilization, especially for complex WHERE clauses
- **HNSW vector indexes**: Replaces MTREE with faster approximate nearest neighbor search
- **Record references GA**: `REFERENCE` keyword stable, no experimental flag
- **AI agent memory features**: New built-in capabilities for AI workloads

### Breaking Change Impact (typical codebase)
| Pattern | Typical Occurrences | Effort |
|---------|---------------------|--------|
| `type::thing` to `type::record` | 50-200 | Search & replace |
| `::from::` / `::is::` renames | 10-50 | Search & replace |
| `SEARCH ANALYZER` to `FULLTEXT` | 1-5 | Schema files only |
| `MTREE` to `HNSW` | 1-3 | Schema files only |
| SDK `auth` to `authentication` | 1-3 | Connection code only |
| `RecordId.tb` to `.table` | 5-20 | Grep + replace |
| `<future>` to `COMPUTED` | 2-10 | Schema files only |
| StringRecordId compound IDs | Variable | Requires RecordId objects |
| Transaction result shape | 1-5 | Manual review needed |

### What Breaks If You Don't Migrate
- `type::thing()` calls fail with "function not found"
- `SEARCH ANALYZER` definitions fail with parse error
- `MTREE` index definitions fail
- `<future>` computed fields fail
- v2 exports with backslashes fail to import
- Compound array record IDs rejected by HTTP parser
- SDK v1 `auth` option silently ignored (no authentication)

## Common Gotchas

1. **`null` vs omitting fields**: SurrealDB v3 rejects `null` for `option<T>` fields - omit the field entirely instead of passing `null`.

2. **Date handling**: `new Date()` works for `datetime` fields, but `new Date().toISOString()` (string) does NOT.

3. **DEFAULT on existing tables**: `DEFINE FIELD TYPE bool DEFAULT false` on existing tables gives existing records `NONE`, not the default. Use `option<bool>` for fields added to populated tables.

4. **Parameterized record IDs**: String params like `$docId` aren't auto-cast to record IDs. Use `type::record('table', $id)` explicitly.

5. **`.raw()` returns RecordId objects**: When using `.raw()` queries, record IDs come back as RecordId objects, not strings. Always `String()` before string operations.

6. **DDL doesn't support params**: `DEFINE USER`, `REMOVE USER` etc. don't support `$param` syntax. Use string interpolation (safe when values are self-generated).

## When the User Asks for Help

1. **"Migrate my database"**: Walk through the full playbook above, starting with Phase 1 assessment.
2. **"Fix my queries"**: Scan their code for v2 patterns using the transformation tables above.
3. **"My import is failing"**: Recommend the custom migration script over `surreal import`.
4. **"Update my SDK code"**: Walk through the SDK v1-to-v2 changes section.
5. **"What changed in v3?"**: Reference the breaking changes and benchmarks sections.

If the user provides a backup file path or schema directory as an argument, start by scanning it for v2 patterns and providing a concrete migration plan.
