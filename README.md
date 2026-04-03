# SurrealDB v2 to v3 Migration Toolkit

Battle-tested tools for migrating SurrealDB from v2.x to v3.x. Built after discovering that the official `surreal export/import` roundtrip fails on real-world databases with backslash escaping, compound record IDs, and multi-line INSERT statements.

Tested on a production database: **119,962 records migrated with zero failures**.

## What's Included

- **`scripts/surrealdb-migrate.ts`** - Custom SurQL parser + CBOR-over-WebSocket importer with checkpoint/resume
- **`scripts/surrealdb-restore-sdk.ts`** - SDK-based restore that fixes v2's backslash escaping bug
- **`scripts/rid-to-surql.ts`** - RecordId-to-SurrealQL serializer (fixes SDK v2's broken `toString()` for compound IDs)
- **`docs/breaking-changes.md`** - Complete v2-to-v3 breaking changes reference
- **`docs/playbook.md`** - Step-by-step production migration playbook
- **`docs/benchmarks.md`** - Real-world migration benchmarks and impact assessment
- **Claude Code Skill** - AI-assisted migration via Claude Code

## Quick Start

### Prerequisites

- [Bun](https://bun.sh/) runtime
- Access to SurrealDB v2 (source) and v3 (target) instances

### Install

```bash
git clone https://github.com/necmttn/surrealdb-v2-to-v3.git
cd surrealdb-v2-to-v3
bun install
```

### Export from v2

```bash
curl -X GET http://localhost:8000/export \
  -H "NS: your_ns" -H "DB: your_db" \
  -H "Authorization: Basic $(echo -n 'root:root' | base64)" \
  -o backup.surql
```

### Migrate to v3

```bash
# Full migration with v3 schema transformations
bun run scripts/surrealdb-migrate.ts backup.surql \
  --url http://localhost:8000 \
  --user root --pass root \
  --ns your_ns --db your_db \
  --v3

# Dry run first to assess
bun run scripts/surrealdb-migrate.ts backup.surql --dry-run
```

### Options

| Flag | Default | Description |
|------|---------|-------------|
| `--url` | `http://localhost:8000` | SurrealDB URL |
| `--user` | `root` | Username |
| `--pass` | `root` | Password |
| `--ns` | `prod` | Namespace |
| `--db` | `prod` | Database |
| `--batch` | `50` | Records per insert batch |
| `--v3` | off | Apply v3 schema transformations |
| `--data-only` | off | Skip schema, only import INSERT data |
| `--dry-run` | off | Parse and report without importing |

## Why Not `surreal import`?

The official `surreal export` + `surreal import` roundtrip breaks on:

1. **Backslash escaping** - v2 exports don't escape backslashes in strings (LaTeX `\boldsymbol`, file paths). v3's parser rejects them.
2. **Compound record IDs** - IDs like `block:[document:xxx, '/path']` aren't supported by the text importer.
3. **Multi-line INSERTs** - Exports split INSERTs across lines when content has newlines. The importer can't reassemble them.
4. **Large batches** - INSERT statements >10MB crash the text parser.

This toolkit solves all of these by parsing the SurQL export into JS objects and using the SDK's CBOR binary protocol over WebSocket.

See [Troubled Migrations](docs/troubled-migrations.md) for detailed examples with real data patterns showing exactly how each failure manifests and how the custom tools handle them.

## Claude Code Skill

This repo includes a [Claude Code](https://claude.ai/code) skill for AI-assisted migration.

### Install the skill

```bash
# From your project directory
claude plugin install github://necmttn/surrealdb-v2-to-v3
```

### Use the skill

```
/surrealdb-migrate ./path/to/schema/or/backup
```

The skill provides:
- Full migration playbook guidance
- v2-to-v3 breaking changes reference
- JS SDK v1-to-v2 migration patterns
- Codebase scanning for v2 patterns
- Common gotchas and workarounds

## Documentation

- [Breaking Changes Reference](docs/breaking-changes.md) - Every v2-to-v3 breaking change
- [Troubled Migrations](docs/troubled-migrations.md) - Real failures the native tool can't handle, with concrete examples
- [Migration Playbook](docs/playbook.md) - Step-by-step production migration guide
- [Benchmarks](docs/benchmarks.md) - Real-world performance data and impact assessment

## Features

### Custom SurQL Parser
Handles the full SurQL export format including:
- Compound array record IDs (`block:[document:xxx, '/path']`)
- Angle bracket IDs (`table:⟨uuid⟩`)
- Quoted strings inside compound IDs
- Multi-line INSERT reassembly
- SurrealQL datetime (`d'...'`) and UUID (`u'...'`) literals

### Checkpoint/Resume
Crash recovery built-in. If migration fails mid-way, re-run the same command to resume from the last checkpoint.

### Auto-Reconnect
Handles WebSocket disconnections with up to 3 retries and exponential backoff.

### Record-by-Record Fallback
When a batch insert fails, automatically falls back to inserting records one-by-one to maximize data recovery.

### v3 Schema Transformations
The `--v3` flag automatically transforms function names and syntax in schema statements during import.

## License

MIT
