# SurrealDB v2 to v3 Migration Playbook

A battle-tested, step-by-step guide for migrating SurrealDB from v2.x to v3.x in production.

This playbook was developed during a real production migration of 119,962 records with zero data loss.

## Prerequisites

- [Bun](https://bun.sh/) runtime installed
- Access to both v2 (source) and v3 (target) SurrealDB instances
- Sufficient disk space for backup files

```bash
# Install dependencies
cd surrealdb-v2-to-v3
bun install
```

## Phase 1: Export from v2

### 1.1 Create a Full Export

```bash
# v2 uses GET for export
curl -X GET http://localhost:8000/export \
  -H "NS: your_namespace" \
  -H "DB: your_database" \
  -H "Authorization: Basic $(echo -n 'user:pass' | base64)" \
  -o backup-v2-$(date +%Y%m%d).surql
```

### 1.2 Verify the Export

```bash
# Check file size and line count
wc -l backup-v2-*.surql
du -h backup-v2-*.surql

# Dry run to assess complexity
bun run scripts/surrealdb-migrate.ts backup-v2-*.surql --dry-run
```

This shows you:
- Number of INSERT statements (data)
- Number of DEFINE/OPTION statements (schema)
- Size of each statement
- Tables involved

### 1.3 Scan for Problem Patterns

Look for content that will break the text-based importer:

```bash
# Backslashes in string content (LaTeX, file paths)
grep -c '\\\\' backup-v2-*.surql

# Compound array record IDs
grep -c '\[document:' backup-v2-*.surql

# Very long lines (>1MB INSERTs)
awk 'length > 1000000' backup-v2-*.surql | wc -l
```

If any of these return non-zero counts, you **must** use the custom migration tool instead of `surreal import`.

## Phase 2: Prepare v3 Schema

### 2.1 Extract Schema from Export

The export file contains schema (DEFINE/OPTION) and data (INSERT) mixed together. You can either:

**Option A**: Let the migration tool handle both schema and data:
```bash
bun run scripts/surrealdb-migrate.ts backup.surql --v3
```

**Option B**: Apply schema separately for more control:
```bash
# Create v3-compatible schema file manually
# Apply the transformations listed in docs/breaking-changes.md
# Then import data only:
bun run scripts/surrealdb-migrate.ts backup.surql --data-only --v3
```

### 2.2 Apply v3 Transformations

The `--v3` flag automatically transforms:

| v2 Pattern | v3 Replacement |
|------------|----------------|
| `type::thing` | `type::record` |
| `duration::from::X` | `duration::from_X` |
| `string::is::X` | `string::is_X` |
| `type::is::X` | `type::is_X` |
| `time::is::X` / `time::from::X` | `time::is_X` / `time::from_X` |
| `rand::guid()` | `rand::id()` |
| `string::distance::osa_distance` | `string::distance::osa` |
| `SEARCH ANALYZER` | `FULLTEXT ANALYZER` |
| `MTREE` | `HNSW` |

Manual transformations still needed:
- `VALUE <future> { ... }` to `COMPUTED ...`
- `references<T>` to `option<array<record<T>>> REFERENCE`
- `IF NOT EXISTS` to `OVERWRITE` (optional but recommended)

## Phase 3: Start v3 Instance

### 3.1 Docker

```bash
docker run -d --name surrealdb-v3 \
  -p 8001:8000 \
  surrealdb/surrealdb:v3.0.5 \
  start --user root --pass root \
  surrealkv://data/database.db
```

### 3.2 Binary

```bash
surreal start --user root --pass root \
  --bind 0.0.0.0:8001 \
  surrealkv://data/database.db
```

Note: Use a different port (8001) so you can run v2 and v3 side by side during migration.

## Phase 4: Run Migration

### 4.1 Full Migration (Schema + Data)

```bash
bun run scripts/surrealdb-migrate.ts backup-v2.surql \
  --url http://localhost:8001 \
  --user root --pass root \
  --ns your_namespace --db your_database \
  --v3
```

### 4.2 Monitor Progress

The tool outputs progress for each statement:
```
  ✓ 1/250 [schema] (2.1KB)
  ✓ 2/250 [schema] (1.3KB)
  ✓ 3/250 document: 500/500 (1.2MB)
    ... block 1000/5000
  ✓ 4/250 block: 5000/5000 (8.4MB)
```

Icons:
- `✓` = all records imported
- `~` = partial (some already existed or failed)
- `✗` = all failed

### 4.3 Crash Recovery

If the migration crashes (network drop, OOM, etc.), just re-run the same command. The checkpoint file (`backup.surql.checkpoint.json`) tracks completed statements.

```bash
# Resume from checkpoint
bun run scripts/surrealdb-migrate.ts backup-v2.surql \
  --url http://localhost:8001 \
  --user root --pass root \
  --ns your_namespace --db your_database \
  --v3
# Output: "Resuming: 150/250 done (50000 ok, 0 fail)"
```

To start fresh, delete the checkpoint:
```bash
rm backup-v2.surql.checkpoint.json
```

### 4.4 Troubleshooting Failures

**Parse errors on specific records**: The tool automatically falls back to record-by-record insertion when a batch fails. Check the summary at the end for failed records.

**Connection drops**: The tool auto-reconnects up to 3 times with exponential backoff (2s, 4s, 6s).

**Large statements (>10MB)**: Reduce batch size:
```bash
bun run scripts/surrealdb-migrate.ts backup.surql --batch 10 --v3
```

## Phase 5: Verify Migration

### 5.1 Compare Record Counts

```bash
# On v2
echo "SELECT count() FROM your_table GROUP ALL;" | surreal sql \
  --conn http://localhost:8000 --user root --pass root \
  --ns your_ns --db your_db --pretty

# On v3
echo "SELECT count() FROM your_table GROUP ALL;" | surreal sql \
  --conn http://localhost:8001 --user root --pass root \
  --ns your_ns --db your_db --pretty
```

### 5.2 Spot Check Data

```bash
# Sample a few records and compare
echo "SELECT * FROM your_table LIMIT 5;" | surreal sql \
  --conn http://localhost:8001 --user root --pass root \
  --ns your_ns --db your_db --pretty
```

### 5.3 Test Queries

Run your application's most common queries against v3 to verify they still work. Pay attention to:
- Queries using `type::thing` (should be `type::record` now)
- Fulltext search queries
- Vector similarity queries
- Computed/future fields

## Phase 6: Update Application Code

### 6.1 SurrealDB Server Upgrade

Update your Docker image / binary:
```yaml
# docker-compose.yml
services:
  surrealdb:
    image: surrealdb/surrealdb:v3.0.5  # was v2.3.7
```

### 6.2 JS SDK Upgrade

```bash
bun add surrealdb@^2.0.3  # was ^1.3.2
```

### 6.3 Code Changes

See `docs/breaking-changes.md` for the full list. Key search-and-replace patterns:

```bash
# In your application code
rg 'type::thing' --type ts -l | xargs sed -i '' 's/type::thing/type::record/g'

# In schema files
rg 'SEARCH ANALYZER' --glob '*.surql' -l | xargs sed -i '' 's/SEARCH ANALYZER/FULLTEXT ANALYZER/g'
```

## Phase 7: Cutover

### 7.1 Stop v2 Writes
Stop your application to prevent new writes to v2.

### 7.2 Final Export + Migration
Run a final export from v2 and migrate to v3 (or just migrate the delta if you have a way to identify new records).

### 7.3 Point Application to v3
Update connection strings and restart your application.

### 7.4 Verify in Production
Monitor logs for query errors, check response times, verify data integrity.

## Rollback Plan

If v3 has issues:
1. Stop the application
2. Point connection strings back to v2
3. Restart the application
4. Investigate and fix v3 issues
5. Re-attempt migration

Keep your v2 instance running (read-only) until you're confident v3 is stable.

## Known Issues and Workarounds

### Official `surreal import` Fails
The official import tool cannot handle:
- Backslashes in string content (LaTeX, file paths)
- Compound array record IDs
- Multi-line INSERT statements
- Large INSERT batches (>10MB)

**Workaround**: Use the custom `surrealdb-migrate.ts` script.

### `null` Values for Optional Fields
SurrealDB v3 rejects `null` for `option<T>` fields.

**Workaround**: Omit the field entirely instead of setting it to `null`.

### DEFAULT on Existing Records
Adding `DEFAULT false` to a field on an existing table does not backfill existing records - they get `NONE`.

**Workaround**: Use `option<bool>` for new fields on populated tables, or run an UPDATE to set defaults.

### DDL Parameterization
`DEFINE USER`, `REMOVE USER`, etc. don't support `$param` syntax.

**Workaround**: Use string interpolation (safe when values are self-generated, not user input).
