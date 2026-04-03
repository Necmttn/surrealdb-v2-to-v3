# SurrealDB v2 to v3 Breaking Changes Reference

Complete reference of all breaking changes between SurrealDB v2.x (tested on v2.3.7) and v3.x (tested on v3.0.5).

## Server-Side Breaking Changes

### Function Renames

All namespaced function calls using `::from::` and `::is::` patterns have been flattened:

```
duration::from::days()    -> duration::from_days()
duration::from::hours()   -> duration::from_hours()
duration::from::micros()  -> duration::from_micros()
duration::from::millis()  -> duration::from_millis()
duration::from::mins()    -> duration::from_mins()
duration::from::nanos()   -> duration::from_nanos()
duration::from::secs()    -> duration::from_secs()
duration::from::weeks()   -> duration::from_weeks()

string::is::alphanum()    -> string::is_alphanum()
string::is::alpha()       -> string::is_alpha()
string::is::ascii()       -> string::is_ascii()
string::is::datetime()    -> string::is_datetime()
string::is::domain()      -> string::is_domain()
string::is::email()       -> string::is_email()
string::is::hexadecimal() -> string::is_hexadecimal()
string::is::ip()          -> string::is_ip()
string::is::ipv4()        -> string::is_ipv4()
string::is::ipv6()        -> string::is_ipv6()
string::is::latitude()    -> string::is_latitude()
string::is::longitude()   -> string::is_longitude()
string::is::numeric()     -> string::is_numeric()
string::is::semver()      -> string::is_semver()
string::is::url()         -> string::is_url()
string::is::uuid()        -> string::is_uuid()

type::is::array()         -> type::is_array()
type::is::bool()          -> type::is_bool()
type::is::bytes()         -> type::is_bytes()
type::is::collection()    -> type::is_collection()
type::is::datetime()      -> type::is_datetime()
type::is::decimal()       -> type::is_decimal()
type::is::duration()      -> type::is_duration()
type::is::float()         -> type::is_float()
type::is::geometry()      -> type::is_geometry()
type::is::int()           -> type::is_int()
type::is::line()          -> type::is_line()
type::is::none()          -> type::is_none()
type::is::null()          -> type::is_null()
type::is::multiline()     -> type::is_multiline()
type::is::multipoint()    -> type::is_multipoint()
type::is::multipolygon()  -> type::is_multipolygon()
type::is::number()        -> type::is_number()
type::is::object()        -> type::is_object()
type::is::point()         -> type::is_point()
type::is::polygon()       -> type::is_polygon()
type::is::record()        -> type::is_record()
type::is::string()        -> type::is_string()
type::is::uuid()          -> type::is_uuid()

time::is::X()             -> time::is_X()
time::from::X()           -> time::from_X()

rand::guid()              -> rand::id()
type::thing(tb, id)       -> type::record(tb, id)

string::distance::osa_distance() -> string::distance::osa()
```

### Schema Definition Changes

#### Fulltext Indexes
```sql
-- v2
DEFINE INDEX my_idx ON my_table FIELDS content SEARCH ANALYZER my_analyzer BM25;

-- v3
DEFINE INDEX my_idx ON my_table FIELDS content FULLTEXT ANALYZER my_analyzer BM25;
```

Removed parameters: `DOC_IDS_ORDER`, `POSTINGS_ORDER`, `DOC_LENGTHS_ORDER`, `DOC_IDS_CACHE`, `POSTINGS_CACHE`, `DOC_LENGTHS_CACHE`.

#### Vector Indexes
```sql
-- v2
DEFINE INDEX my_vec ON my_table FIELDS embedding MTREE DIMENSION 1024 DIST COSINE;

-- v3
DEFINE INDEX my_vec ON my_table FIELDS embedding HNSW DIMENSION 1024 DIST COSINE;
```

#### Computed Fields (Futures)
```sql
-- v2
DEFINE FIELD full_name ON user VALUE <future> { string::concat(first_name, ' ', last_name) };

-- v3
DEFINE FIELD full_name ON user COMPUTED string::concat(first_name, ' ', last_name);
```

#### References
```sql
-- v2
DEFINE FIELD tags ON post TYPE references<tag>;

-- v3
DEFINE FIELD tags ON post TYPE option<array<record<tag>>> REFERENCE;
```

#### FLEXIBLE Keyword
- v2: Allowed on both SCHEMAFULL and SCHEMALESS tables
- v3: Only allowed on SCHEMAFULL tables

#### Idempotent Definitions
```sql
-- v2
DEFINE TABLE IF NOT EXISTS my_table ...;

-- v3 (preferred)
DEFINE TABLE OVERWRITE my_table ...;
```

### HTTP API Changes

#### Export Endpoint
```bash
# v2
curl -X GET http://localhost:8000/export -H "NS: ns" -H "DB: db" ...

# v3
curl -X POST http://localhost:8000/export -H "NS: ns" -H "DB: db" ...
```

### Feature Flags
- `record_references` is now GA - `--allow-experimental` flag no longer needed

## JS SDK v1 to v2 Breaking Changes

### Connection Options
```typescript
// v1
await db.connect(url, { auth: { username, password } });

// v2
await db.connect(url, { authentication: { username, password } });
```

### RecordId API
```typescript
// v1
recordId.tb         // table name
stringRecordId.rid  // raw string

// v2
recordId.table           // table name
stringRecordId.toString() // raw string
```

### Query Builder
```typescript
// v1
const [results] = await db.query("SELECT * FROM user");

// v2
const results = await db.query("SELECT * FROM user").collect();
```

### Transaction Results
```typescript
// v1 - single return value
const [result] = await db.query("BEGIN; LET $x = ...; RETURN $x; COMMIT;");

// v2 - one array slot per statement
const results = await db.query("BEGIN; ...; RETURN $x; COMMIT;").collect();
// Pick specific index with .collect(2) for the RETURN value
```

### Table Class Required
```typescript
// v2 requires Table for typed operations
import { Table } from "surrealdb";
await db.select(new Table("user"));

// Raw queries still work without Table
await db.query("SELECT * FROM user");
```

### Compound Record IDs (Critical)
```typescript
// BROKEN - StringRecordId with compound array format rejected by v3 HTTP parser
const id = new StringRecordId('block:[document:xxx, "/path"]');

// CORRECT - Use RecordId objects directly as query params
await db.query("SELECT * FROM $id", {
  id: new RecordId("block", [docId, path])
});
```

## Regex Patterns for Codebase Scanning

Find all v2 patterns that need updating:

```bash
# Function renames
rg '(duration|string|type|time)::(from|is)::' --type ts --type js
rg 'type::thing\b' --type ts --type js
rg 'rand::guid\(\)' --type ts --type js

# Schema changes
rg 'SEARCH ANALYZER' --glob '*.surql'
rg 'MTREE' --glob '*.surql'
rg 'VALUE <future>' --glob '*.surql'
rg 'references<' --glob '*.surql'
rg 'IF NOT EXISTS' --glob '*.surql'

# SDK changes
rg '\.tb\b' --type ts  # RecordId.tb -> .table
rg '\.rid\b' --type ts  # StringRecordId.rid -> .toString()
rg 'auth:\s*\{' --type ts  # auth -> authentication
```
