#!/usr/bin/env bun
/**
 * SurrealDB v2 → v3 Migration Script
 *
 * Restores a v2 SurrealDB export into a v2 or v3 instance by:
 * 1. Parsing the SurQL export format into JS objects (bypasses SurQL parser)
 * 2. Inserting records via the SDK's insert() / CBOR over WebSocket
 * 3. Applying v3 migration transformations to schema statements
 * 4. Checkpointing progress for crash recovery
 * 5. Auto-reconnecting on WebSocket drops
 *
 * Usage:
 *   bun run scripts/surrealdb-migrate.ts <backup.sql> [options]
 *
 *   --url      SurrealDB URL (default: http://localhost:8000)
 *   --user     Username (default: root)
 *   --pass     Password (default: root)
 *   --ns       Namespace (default: prod)
 *   --db       Database (default: prod)
 *   --batch    Records per insert batch (default: 50)
 *   --v3       Apply v3 migration transformations to schema
 *   --data-only  Skip schema, only import INSERT data
 *   --dry-run  Parse and report without importing
 */

import { readFileSync, writeFileSync, existsSync, unlinkSync } from "fs";
import { Surreal, RecordId, StringRecordId } from "surrealdb";

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
if (!file) {
    console.error("Usage: bun run scripts/surrealdb-migrate.ts <backup.sql> [options]");
    process.exit(1);
}
function getArg(name: string, def: string) {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && args[i + 1] ? args[i + 1] : def;
}
const url = getArg("url", "http://localhost:8000");
const user = getArg("user", "root");
const pass = getArg("pass", "root");
const ns = getArg("ns", "prod");
const db = getArg("db", "prod");
const BATCH = Number(getArg("batch", "50"));
const applyV3 = args.includes("--v3");
const dataOnly = args.includes("--data-only");
const dryRun = args.includes("--dry-run");

// ---------------------------------------------------------------------------
// v3 Migration Transformations (applied to schema statements)
// ---------------------------------------------------------------------------
const V3_FUNCTION_RENAMES: [RegExp, string][] = [
    [/\bduration::from::(\w+)/g, "duration::from_$1"],
    [/\bstring::is::(\w+)/g, "string::is_$1"],
    [/\btype::is::(\w+)/g, "type::is_$1"],
    [/\btime::is::(\w+)/g, "time::is_$1"],
    [/\btime::from::(\w+)/g, "time::from_$1"],
    [/\brand::guid\(\)/g, "rand::id()"],
    [/\btype::thing\b/g, "type::record"],
    [/\bstring::distance::osa_distance\b/g, "string::distance::osa"],
];

const V3_SYNTAX_TRANSFORMS: [RegExp, string][] = [
    // SEARCH ANALYZER → FULLTEXT ANALYZER
    [/\bSEARCH ANALYZER\b/g, "FULLTEXT ANALYZER"],
    // MTREE → HNSW for vector indexes
    [/\bMTREE\b/g, "HNSW"],
];

function applyV3Transforms(stmt: string): string {
    let result = stmt;
    for (const [pattern, replacement] of V3_FUNCTION_RENAMES) {
        result = result.replace(pattern, replacement);
    }
    for (const [pattern, replacement] of V3_SYNTAX_TRANSFORMS) {
        result = result.replace(pattern, replacement);
    }
    return result;
}

// ---------------------------------------------------------------------------
// SurQL Value Parser — converts SurQL literals to JS values
// ---------------------------------------------------------------------------
class SurqlParser {
    private pos = 0;
    constructor(private src: string) {}

    parseValue(): unknown {
        this.skipWs();
        if (this.pos >= this.src.length) return undefined;
        const ch = this.peek();

        if (ch === "{") return this.parseObject();
        if (ch === "[") return this.parseArray();
        if (ch === "'" || ch === '"') return this.parseString(ch);
        // Datetime: d'...'
        if (ch === "d" && (this.peekAt(1) === "'" || this.peekAt(1) === '"')) {
            this.pos++;
            const raw = this.parseString(this.peek());
            return new Date(raw as string);
        }
        // UUID: u'...'
        if (ch === "u" && (this.peekAt(1) === "'" || this.peekAt(1) === '"')) {
            this.pos++;
            return this.parseString(this.peek());
        }
        return this.parseAtom();
    }

    private parseObject(): Record<string, unknown> {
        this.expect("{");
        const obj: Record<string, unknown> = {};
        this.skipWs();
        while (this.peek() !== "}" && this.pos < this.src.length) {
            this.skipWs();
            let key: string;
            if (this.peek() === "'" || this.peek() === '"') {
                key = this.parseString(this.peek()) as string;
            } else {
                key = this.readUntil(":").trim();
            }
            this.expect(":");
            this.skipWs();
            obj[key] = this.parseValue();
            this.skipWs();
            if (this.peek() === ",") this.pos++;
            this.skipWs();
        }
        if (this.peek() === "}") this.pos++;
        return obj;
    }

    private parseArray(): unknown[] {
        this.expect("[");
        const arr: unknown[] = [];
        this.skipWs();
        while (this.peek() !== "]" && this.pos < this.src.length) {
            arr.push(this.parseValue());
            this.skipWs();
            if (this.peek() === ",") this.pos++;
            this.skipWs();
        }
        if (this.peek() === "]") this.pos++;
        return arr;
    }

    private parseString(quote: string): string {
        this.expect(quote);
        const parts: string[] = [];
        while (this.pos < this.src.length) {
            const ch = this.src[this.pos];
            if (ch === "\\") {
                this.pos++;
                if (this.pos >= this.src.length) {
                    parts.push("\\");
                    break;
                }
                const next = this.src[this.pos];
                switch (next) {
                    case "\\":
                        parts.push("\\");
                        break;
                    case "'":
                        parts.push("'");
                        break;
                    case '"':
                        parts.push('"');
                        break;
                    case "n":
                        parts.push("\n");
                        break;
                    case "r":
                        parts.push("\r");
                        break;
                    case "t":
                        parts.push("\t");
                        break;
                    case "0":
                        parts.push("\0");
                        break;
                    case "/":
                        parts.push("/");
                        break;
                    default:
                        parts.push("\\", next);
                        break; // v2 export bug — keep literal
                }
                this.pos++;
            } else if (ch === quote) {
                this.pos++;
                return parts.join("");
            } else {
                parts.push(ch);
                this.pos++;
            }
        }
        return parts.join(""); // unterminated
    }

    private parseAtom(): unknown {
        this.skipWs();
        if (this.matchWord("true")) return true;
        if (this.matchWord("false")) return false;
        if (this.matchWord("NONE")) return undefined;
        if (this.matchWord("NULL")) return null;

        let atom = "";
        let bracketDepth = 0;

        while (this.pos < this.src.length) {
            const ch = this.src[this.pos];

            // Only treat , } ) as delimiters at top level (not inside [...] compound IDs)
            if (bracketDepth === 0 && (ch === "," || ch === "}" || ch === ")")) break;
            if (ch === "]" && bracketDepth === 0) break;

            // Track bracket depth for compound record IDs: block:[document:xxx, '/path']
            if (ch === "[") bracketDepth++;
            if (ch === "]") bracketDepth--;

            // Handle angle brackets: table:⟨uuid⟩ or table:⟨[r"...", s"..."]⟩
            if (ch === "⟨") {
                atom += ch;
                this.pos++;
                while (this.pos < this.src.length && this.src[this.pos] !== "⟩") {
                    atom += this.src[this.pos];
                    this.pos++;
                }
                if (this.pos < this.src.length) {
                    atom += this.src[this.pos];
                    this.pos++;
                }
                continue;
            }

            // Handle quoted strings inside compound IDs: '...' or "..."
            if ((ch === '"' || ch === "'") && bracketDepth > 0) {
                atom += ch;
                this.pos++;
                while (this.pos < this.src.length && this.src[this.pos] !== ch) {
                    if (this.src[this.pos] === "\\") {
                        atom += this.src[this.pos];
                        this.pos++;
                        if (this.pos < this.src.length) {
                            atom += this.src[this.pos];
                            this.pos++;
                        }
                    } else {
                        atom += this.src[this.pos];
                        this.pos++;
                    }
                }
                if (this.pos < this.src.length) {
                    atom += this.src[this.pos];
                    this.pos++;
                }
                continue;
            }

            atom += ch;
            this.pos++;
        }
        atom = atom.trim();

        if (atom.endsWith("f")) {
            const n = Number(atom.slice(0, -1));
            if (!isNaN(n)) return n;
        }
        if (atom.endsWith("dec")) {
            const n = Number(atom.slice(0, -3));
            if (!isNaN(n)) return n;
        }
        const num = Number(atom);
        if (!isNaN(num) && atom !== "") return num;

        // Record ID with compound array ID: table:[val1, val2] or table:⟨[...]⟩
        const compoundMatch = atom.match(/^([a-z_]+):\[.+\]$/s);
        if (compoundMatch) {
            return new StringRecordId(atom);
        }

        // Record ID: table:id or table:⟨uuid⟩
        const ridMatch = atom.match(/^([a-z_]+):(.+)$/);
        if (ridMatch) {
            let [, table, id] = ridMatch;
            if (id.startsWith("⟨") && id.endsWith("⟩")) id = id.slice(1, -1);
            return new RecordId(table, id);
        }
        return atom || undefined;
    }

    private matchWord(word: string): boolean {
        if (this.src.startsWith(word, this.pos)) {
            const after = this.src[this.pos + word.length];
            if (!after || ",}] )".includes(after)) {
                this.pos += word.length;
                return true;
            }
        }
        return false;
    }

    private skipWs() {
        while (this.pos < this.src.length && /\s/.test(this.src[this.pos])) this.pos++;
    }
    private peek() {
        return this.src[this.pos] || "";
    }
    private peekAt(n: number) {
        return this.src[this.pos + n] || "";
    }
    private expect(ch: string) {
        if (this.src[this.pos] !== ch) throw new Error(`Expected '${ch}' at ${this.pos}, got '${this.src[this.pos] || "EOF"}'`);
        this.pos++;
    }
    private readUntil(ch: string) {
        const s = this.pos;
        while (this.pos < this.src.length && this.src[this.pos] !== ch) this.pos++;
        return this.src.slice(s, this.pos);
    }
}

function parseInsertBody(body: string): Record<string, unknown>[] {
    const parser = new SurqlParser(body.trim());
    const result = parser.parseValue();
    if (Array.isArray(result)) return result as Record<string, unknown>[];
    if (typeof result === "object" && result !== null) return [result as Record<string, unknown>];
    return [];
}

function tableFromRecord(record: Record<string, unknown>): string {
    const id = record.id;
    if (id instanceof RecordId) return id.table;
    if (id instanceof StringRecordId) return String(id).split(":")[0];
    if (typeof id === "string") return id.split(":")[0];
    return "unknown";
}

function humanSize(bytes: number): string {
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)}KB`;
    return `${(bytes / 1048576).toFixed(1)}MB`;
}

function extractInsertBody(stmt: string): string {
    let body = stmt.trim();
    while (body.endsWith(";")) body = body.slice(0, -1).trim();
    if (body.startsWith("INSERT RELATION")) return body.slice("INSERT RELATION".length).trim();
    if (body.startsWith("INSERT")) return body.slice("INSERT".length).trim();
    return body;
}

// ---------------------------------------------------------------------------
// Checkpoint
// ---------------------------------------------------------------------------
interface Checkpoint {
    completedStmts: number[];
    totalOk: number;
    totalFail: number;
    failedRecords: { stmt: number; table: string; error: string }[];
}

const checkpointPath = file + ".checkpoint.json";

function loadCheckpoint(): Checkpoint {
    try {
        if (existsSync(checkpointPath)) {
            const data = JSON.parse(readFileSync(checkpointPath, "utf-8"));
            return data;
        }
    } catch {}
    return { completedStmts: [], totalOk: 0, totalFail: 0, failedRecords: [] };
}

function saveCheckpoint(cp: Checkpoint) {
    writeFileSync(checkpointPath, JSON.stringify(cp, null, 2));
}

// ---------------------------------------------------------------------------
// Connection with auto-reconnect
// ---------------------------------------------------------------------------
async function connectSurreal(): Promise<Surreal> {
    const wsUrl = url.replace("http://", "ws://").replace("https://", "wss://") + "/rpc";
    const s = new Surreal();
    await s.connect(wsUrl);
    await s.signin({ username: user, password: pass });
    await s.use({ namespace: ns, database: db });
    return s;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
    console.log(`\n=== SurrealDB Migration Tool ===`);
    console.log(`File: ${file}`);
    console.log(`Target: ${url} (${ns}/${db})`);
    console.log(`Batch: ${BATCH} | v3 transforms: ${applyV3} | Data only: ${dataOnly}\n`);

    // 1. Read and join multi-line INSERT statements
    console.log("Reading backup...");
    const rawLines = readFileSync(file, "utf-8").split("\n");
    console.log(`Raw lines: ${rawLines.length}`);

    type Stmt = { idx: number; raw: string; type: "insert" | "schema"; isRelation: boolean };
    const stmts: Stmt[] = [];
    let currentInsert = "";
    let currentIdx = 0;
    let currentIsRelation = false;

    function flushInsert() {
        if (currentInsert.trim()) {
            stmts.push({
                idx: currentIdx,
                raw: currentInsert,
                type: "insert",
                isRelation: currentIsRelation,
            });
        }
        currentInsert = "";
    }

    for (let i = 0; i < rawLines.length; i++) {
        const line = rawLines[i];
        const trimmed = line.trim();

        if (trimmed.startsWith("INSERT")) {
            flushInsert();
            currentInsert = line;
            currentIdx = i + 1;
            currentIsRelation = trimmed.startsWith("INSERT RELATION");
        } else if (currentInsert) {
            // Continuation of multi-line INSERT
            currentInsert += "\n" + line;
        } else if (!dataOnly && (trimmed.startsWith("DEFINE") || trimmed.startsWith("OPTION"))) {
            stmts.push({ idx: i + 1, raw: trimmed, type: "schema", isRelation: false });
        }
        // Skip: comments, LET, RETURN, IF, ELSE, empty
    }
    flushInsert();

    const insertCount = stmts.filter((s) => s.type === "insert").length;
    const schemaCount = stmts.filter((s) => s.type === "schema").length;
    console.log(`Statements: ${stmts.length} (${insertCount} inserts, ${schemaCount} schema)\n`);

    if (dryRun) {
        for (const s of stmts) {
            if (s.type === "insert") {
                const body = extractInsertBody(s.raw);
                const table = body.match(/id:\s*([a-z_]+)[:⟨]/)?.[1] || "unknown";
                console.log(`  ${s.idx}: INSERT ${table} (${humanSize(Buffer.byteLength(s.raw))})`);
            } else {
                console.log(`  ${s.idx}: SCHEMA (${humanSize(Buffer.byteLength(s.raw))})`);
            }
        }
        return;
    }

    // 2. Load checkpoint
    const cp = loadCheckpoint();
    if (cp.completedStmts.length > 0) {
        console.log(`Resuming: ${cp.completedStmts.length}/${stmts.length} done (${cp.totalOk} ok, ${cp.totalFail} fail)\n`);
    }

    // 3. Connect
    console.log("Connecting...");
    let surreal = await connectSurreal();
    console.log("Connected.\n");

    // Helper: execute with reconnect
    async function withReconnect<T>(fn: (s: Surreal) => Promise<T>, retries = 3): Promise<T> {
        for (let attempt = 0; attempt < retries; attempt++) {
            try {
                return await fn(surreal);
            } catch (err: any) {
                const msg = err?.message || String(err);
                const isConnectionError =
                    msg.includes("connection") ||
                    msg.includes("WebSocket") ||
                    msg.includes("decoding") ||
                    msg.includes("closed") ||
                    msg.includes("ECONNREFUSED") ||
                    msg.includes("socket");
                if (isConnectionError && attempt < retries - 1) {
                    console.log(`    reconnecting (attempt ${attempt + 2})...`);
                    await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
                    try {
                        await surreal.close();
                    } catch {}
                    surreal = await connectSurreal();
                    continue;
                }
                throw err;
            }
        }
        throw new Error("unreachable");
    }

    // 4. Process statements
    for (let si = 0; si < stmts.length; si++) {
        if (cp.completedStmts.includes(si)) continue;

        const stmt = stmts[si];

        // -- Schema statements --
        if (stmt.type === "schema") {
            let sql = stmt.raw;
            if (applyV3) sql = applyV3Transforms(sql);
            try {
                await withReconnect((s) => s.query(sql.endsWith(";") ? sql : sql + ";"));
                console.log(`  ✓ ${si + 1}/${stmts.length} [schema] (${humanSize(Buffer.byteLength(sql))})`);
            } catch (err: any) {
                const msg = err?.message?.slice(0, 120) || String(err).slice(0, 120);
                if (msg.includes("already exists")) {
                    console.log(`  ~ ${si + 1}/${stmts.length} [schema] already exists`);
                } else {
                    console.log(`  ✗ ${si + 1}/${stmts.length} [schema]: ${msg}`);
                    cp.totalFail++;
                }
            }
            cp.completedStmts.push(si);
            saveCheckpoint(cp);
            continue;
        }

        // -- INSERT statements --
        const body = extractInsertBody(stmt.raw);
        let records: Record<string, unknown>[];
        try {
            records = parseInsertBody(body);
        } catch (err: any) {
            console.log(`  ✗ ${si + 1}/${stmts.length} parse error: ${err.message?.slice(0, 120)}`);
            cp.totalFail++;
            cp.completedStmts.push(si);
            cp.failedRecords.push({ stmt: si, table: "unknown", error: err.message?.slice(0, 200) || "parse error" });
            saveCheckpoint(cp);
            continue;
        }

        if (records.length === 0) {
            cp.completedStmts.push(si);
            saveCheckpoint(cp);
            continue;
        }

        const table = tableFromRecord(records[0]);
        const total = records.length;
        let ok = 0;
        let fail = 0;

        for (let b = 0; b < records.length; b += BATCH) {
            const batch = records.slice(b, b + BATCH);

            // Use INSERT $data for compound IDs (StringRecordId), else use insert()
            const hasCompoundIds = batch.some((r) => Object.values(r).some((v) => v instanceof StringRecordId));
            const doInsert = async (s: Surreal, data: Record<string, unknown>[]) => {
                if (stmt.isRelation || hasCompoundIds) {
                    const kw = stmt.isRelation ? "INSERT RELATION $data" : "INSERT $data";
                    await s.query(kw, { data });
                } else {
                    await s.insert(table, data);
                }
            };

            try {
                await withReconnect((s) => doInsert(s, batch));
                ok += batch.length;
            } catch (err: any) {
                const errMsg = err?.message || String(err);
                if (errMsg.includes("already exists") || errMsg.includes("already contains")) {
                    ok += batch.length;
                } else if (batch.length > 1) {
                    // One-by-one fallback
                    for (const record of batch) {
                        try {
                            await withReconnect((s) => doInsert(s, [record]));
                            ok++;
                        } catch (innerErr: any) {
                            const innerMsg = innerErr?.message || String(innerErr);
                            if (innerMsg.includes("already exists")) {
                                ok++;
                            } else {
                                fail++;
                                cp.failedRecords.push({ stmt: si, table, error: innerMsg.slice(0, 150) });
                            }
                        }
                    }
                } else {
                    fail += batch.length;
                    cp.failedRecords.push({ stmt: si, table, error: errMsg.slice(0, 150) });
                }
            }

            if (total > 200 && (b + BATCH) % 500 < BATCH) {
                console.log(`    ... ${table} ${Math.min(b + BATCH, total)}/${total}`);
            }
        }

        cp.totalOk += ok;
        cp.totalFail += fail;
        cp.completedStmts.push(si);
        saveCheckpoint(cp);

        const icon = fail === 0 ? "✓" : fail === total ? "✗" : "~";
        console.log(`  ${icon} ${si + 1}/${stmts.length} ${table}: ${ok}/${total} (${humanSize(Buffer.byteLength(stmt.raw))})`);
    }

    // 5. Summary
    console.log(`\n${"=".repeat(60)}`);
    console.log(`MIGRATION COMPLETE`);
    console.log(`  OK: ${cp.totalOk} | Failed: ${cp.totalFail} | Stmts: ${cp.completedStmts.length}/${stmts.length}`);
    if (cp.failedRecords.length > 0) {
        console.log(`\nFailed records (${cp.failedRecords.length}):`);
        const grouped = new Map<string, number>();
        for (const f of cp.failedRecords) {
            grouped.set(f.table, (grouped.get(f.table) || 0) + 1);
        }
        for (const [table, count] of grouped) {
            console.log(`  ${table}: ${count} failures`);
        }
    }
    console.log(`${"=".repeat(60)}`);

    // Clean checkpoint on full success
    if (cp.totalFail === 0) {
        try {
            unlinkSync(checkpointPath);
        } catch {}
    }

    await surreal.close();
}

main().catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
});
