# SurrealDB v2 to v3 Migration Benchmarks

Real-world benchmarks from a production migration of 119,962 records.

## Migration Performance

### Custom Migration Tool (`surrealdb-migrate.ts`)

| Metric | Value |
|--------|-------|
| Source version | SurrealDB v2.3.7 |
| Target version | SurrealDB v3.0.5 |
| Total records | 119,962 |
| Schema statements | ~100 |
| INSERT statements | ~200 (batched) |
| Batch size | 50 records |
| Protocol | CBOR over WebSocket |
| **Migration failures** | **0** |
| **Data loss** | **0 records** |

### Why Custom Tool vs Official Import

| Approach | Result |
|----------|--------|
| `surreal export` + `surreal import` (v3) | **FAILED** - Parse errors on backslashes in LaTeX content |
| `surreal export` + SDK `query()` per line | **PARTIAL** - ~5% parse failures on compound IDs |
| Custom SurQL parser + SDK `insert()` (this tool) | **SUCCESS** - 119,962/119,962 records, 0 failures |

The custom tool outperforms the official tooling because:
1. It parses SurQL export format into JS objects (bypasses the text parser)
2. Uses CBOR binary protocol over WebSocket (no string escaping issues)
3. Handles compound record IDs natively via `RecordId` objects
4. Reassembles multi-line INSERT statements correctly

## v3 Engine Improvements

### Query Execution

SurrealDB v3 ships a new **streaming execution engine** and **query planner**:

- Queries no longer buffer entire result sets in memory before returning
- Better index utilization for complex WHERE clauses
- Improved performance for JOIN-heavy workloads

### Vector Search

| Feature | v2 (MTREE) | v3 (HNSW) |
|---------|-----------|-----------|
| Algorithm | M-Tree | Hierarchical NSW |
| Approximate search | No | Yes |
| Build time | Slower | Faster |
| Query time | Exact | Approximate (faster) |
| Memory usage | Higher | Lower |

HNSW is the industry standard for approximate nearest neighbor search and provides significantly better performance for high-dimensional vectors.

### Record References

| Feature | v2 | v3 |
|---------|----|----|
| Status | Experimental | GA (stable) |
| Flag needed | `--allow-experimental` | None |
| Syntax | `references<T>` | `option<array<record<T>>> REFERENCE` |

## Codebase Impact Assessment

### Typical Migration Effort by Pattern

Based on a ~50K LOC TypeScript + SurQL codebase:

| Pattern | Occurrences Found | Fix Complexity | Automated? |
|---------|-------------------|----------------|------------|
| `type::thing` to `type::record` | 105 | Search & replace | Yes |
| `::from::` / `::is::` renames | 30 | Search & replace | Yes |
| `SEARCH ANALYZER` to `FULLTEXT` | 3 | Schema files | Yes |
| `MTREE` to `HNSW` | 2 | Schema files | Yes |
| SDK `auth` to `authentication` | 2 | Connection code | Yes |
| `RecordId.tb` to `.table` | 15 | Grep + replace | Yes |
| `StringRecordId.rid` to `.toString()` | 8 | Grep + replace | Yes |
| `<future>` to `COMPUTED` | 5 | Manual review | Partial |
| Compound ID handling | 12 | Rewrite to use RecordId | No |
| Transaction result shape | 3 | Manual review | No |
| 32 migration files consolidated | 32 files -> 1 | One-time effort | No |

### Time Estimate

| Phase | Estimated Time |
|-------|---------------|
| Assessment + export | 30 min |
| Schema transformation | 1-2 hours |
| SDK code updates | 2-4 hours |
| Data migration (custom tool) | 30-60 min |
| Verification | 1 hour |
| **Total** | **5-8 hours** |

This is significantly less than the time spent debugging the official `surreal import` failures (which in our case consumed ~12 hours before we built the custom tool).

## Data Integrity

### Verification Results

After migration, we verified:

| Check | Status |
|-------|--------|
| Record count match (all tables) | PASS |
| Random sample verification (10 per table) | PASS |
| Foreign key integrity | PASS |
| Fulltext search functionality | PASS |
| Vector similarity queries | PASS |
| Computed field evaluation | PASS |
| Live query subscriptions | PASS |

### What We Tested

1. **Count comparison**: Total records per table between v2 and v3
2. **Data sampling**: Random 10 records per table, field-by-field comparison
3. **Relationship integrity**: All foreign key references resolve correctly
4. **Query compatibility**: Application's top 20 queries return identical results
5. **Real-time features**: Live queries reconnect and deliver updates correctly
