#!/usr/bin/env bun
/**
 * SurrealDB Backup Restore via JS SDK
 *
 * Fixes the SurrealDB v2 export/import roundtrip bug where backslashes
 * in string content (LaTeX, file paths, etc.) are not properly escaped
 * in the export, causing parse errors on re-import.
 *
 * Strategy:
 * 1. Read each INSERT line from the backup
 * 2. Fix backslash escaping inside single-quoted string literals
 * 3. Execute via WebSocket SDK query()
 * 4. On failure, try splitting the INSERT array into smaller batches
 * 5. Log all failures and continue
 *
 * Usage:
 *   bun run scripts/surrealdb-restore-sdk.ts <backup-file> [options]
 *
 * Options:
 *   --url       SurrealDB URL (default: http://localhost:8000)
 *   --user      Username (default: root)
 *   --pass      Password (default: root)
 *   --ns        Namespace (default: prod)
 *   --db        Database (default: prod)
 *   --skip-schema  Skip DEFINE/OPTION/function statements
 *   --inserts-only Only process INSERT statements
 *   --dry-run   Parse and report without importing
 */

import { readFileSync } from "fs";
import Surreal from "surrealdb";

// Parse CLI args
const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
if (!file) {
    console.error("Usage: bun run scripts/surrealdb-restore-sdk.ts <backup-file> [options]");
    process.exit(1);
}

function getArg(name: string, defaultVal: string): string {
    const idx = args.indexOf(`--${name}`);
    return idx >= 0 && args[idx + 1] ? args[idx + 1] : defaultVal;
}

const url = getArg("url", "http://localhost:8000");
const user = getArg("user", "root");
const pass = getArg("pass", "root");
const ns = getArg("ns", "prod");
const db = getArg("db", "prod");
const skipSchema = args.includes("--skip-schema");
const insertsOnly = args.includes("--inserts-only");
const dryRun = args.includes("--dry-run");

function humanSize(bytes: number): string {
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

/**
 * Fix backslash escaping inside SurrealQL single-quoted string literals.
 *
 * The SurrealDB v2 export writes string content like:
 *   'some text with \boldsymbol and \sum'
 * But the parser interprets \b, \s as escape sequences.
 *
 * This function finds single-quoted strings and doubles any unescaped
 * backslashes that aren't already part of a valid escape sequence.
 *
 * Valid SurrealQL escape sequences: \\ \' \n \r \t \0
 * Everything else (like \b \s \o) needs to be escaped as \\b \\s \\o
 */
function fixBackslashEscaping(line: string): string {
    // Walk char by char, track when inside single or double quoted strings,
    // and fix backslashes that aren't valid escape sequences.
    //
    // SurrealDB exports use both ' and " for string literals.
    // Valid SurrealQL escapes: \\ \' \" \n \r \t \0 \/ \u{...}
    // Everything else (\b \s \o etc from LaTeX) needs \\

    const result: string[] = [];
    let i = 0;
    const len = line.length;

    while (i < len) {
        const ch = line[i];

        if (ch === "'" || ch === '"') {
            const quote = ch;
            result.push(quote);
            i++;

            while (i < len) {
                const c = line[i];

                if (c === quote) {
                    // Check if this quote is escaped by counting preceding backslashes
                    let bsCount = 0;
                    let j = result.length - 1;
                    while (j >= 0 && result[j] === "\\") {
                        bsCount++;
                        j--;
                    }
                    if (bsCount % 2 === 0) {
                        // Unescaped quote — end of string
                        result.push(quote);
                        i++;
                        break;
                    } else {
                        // Escaped quote — part of string
                        result.push(c);
                        i++;
                        continue;
                    }
                }

                if (c === "\\") {
                    const next = i + 1 < len ? line[i + 1] : "";
                    // Valid escape sequences in SurrealQL
                    if (
                        next === "\\" ||
                        next === "'" ||
                        next === '"' ||
                        next === "n" ||
                        next === "r" ||
                        next === "t" ||
                        next === "0" ||
                        next === "/" ||
                        next === "u"
                    ) {
                        result.push(c, next);
                        i += 2;
                    } else {
                        // Invalid escape — double the backslash
                        result.push("\\\\");
                        i++;
                    }
                } else {
                    result.push(c);
                    i++;
                }
            }
        } else {
            result.push(ch);
            i++;
        }
    }

    return result.join("");
}

// Extract table name from INSERT line
function getTableName(line: string): string {
    const match = line.match(/id:\s*([a-z_]+)[:⟨]/);
    return match ? match[1] : "unknown";
}

/**
 * Check if a SurQL statement is complete by verifying brackets/braces are balanced.
 * Also handles strings (single and double quoted) to avoid counting brackets inside strings.
 */
function isStatementComplete(stmt: string): boolean {
    const trimmed = stmt.trim();
    // Simple statements (DEFINE, OPTION, etc.) — complete if they end with ;
    if (!trimmed.startsWith("INSERT") && !trimmed.startsWith("UPDATE") && !trimmed.startsWith("CREATE")) {
        return true; // non-data statements are single-line
    }

    let brackets = 0;
    let braces = 0;
    let inSingleQuote = false;
    let inDoubleQuote = false;
    let escaped = false;

    for (let i = 0; i < trimmed.length; i++) {
        const ch = trimmed[i];

        if (escaped) {
            escaped = false;
            continue;
        }

        if (ch === "\\") {
            escaped = true;
            continue;
        }

        if (ch === "'" && !inDoubleQuote) {
            inSingleQuote = !inSingleQuote;
            continue;
        }

        if (ch === '"' && !inSingleQuote) {
            inDoubleQuote = !inDoubleQuote;
            continue;
        }

        if (inSingleQuote || inDoubleQuote) continue;

        if (ch === "[") brackets++;
        if (ch === "]") brackets--;
        if (ch === "{") braces++;
        if (ch === "}") braces--;
    }

    return brackets <= 0 && braces <= 0;
}

function isInsert(line: string): boolean {
    return line.startsWith("INSERT");
}

function isSchema(line: string): boolean {
    const t = line.trim();
    return (
        t.startsWith("DEFINE") ||
        t.startsWith("OPTION") ||
        t.startsWith("LET") ||
        t.startsWith("RETURN") ||
        t.startsWith("IF") ||
        t.startsWith("ELSE")
    );
}

async function main() {
    console.log(`\n=== SurrealDB SDK Restore (with backslash fix) ===`);
    console.log(`File: ${file}`);
    console.log(`Target: ${url} (${ns}/${db})`);
    console.log(`Skip schema: ${skipSchema}, Inserts only: ${insertsOnly}\n`);

    // Read file and join multi-line INSERT statements.
    // SurrealDB exports split INSERT statements across lines when string
    // content contains newlines (e.g., markdown with paragraphs).
    //
    // Strategy: read line by line. An INSERT starts a new statement.
    // Any line that doesn't start with a known keyword (INSERT, DEFINE, OPTION,
    // LET, RETURN, --, etc.) is a continuation of the current INSERT.
    console.log("Reading and joining multi-line statements...");
    const rawContent = readFileSync(file, "utf-8");
    const rawLines = rawContent.split("\n");
    console.log(`Raw lines: ${rawLines.length}`);

    const stmts: { idx: number; line: string; type: "data" | "schema" }[] = [];
    let currentInsert = "";
    let currentIdx = 0;

    function flushInsert() {
        if (currentInsert.trim()) {
            stmts.push({ idx: currentIdx, line: currentInsert, type: "data" });
        }
        currentInsert = "";
    }

    const keywordRe = /^(INSERT|DEFINE|OPTION|LET|RETURN|IF|ELSE|--|$)/;

    for (let i = 0; i < rawLines.length; i++) {
        const line = rawLines[i];
        const trimmed = line.trim();

        if (trimmed.startsWith("INSERT")) {
            flushInsert();
            currentInsert = line;
            currentIdx = i + 1;
        } else if (currentInsert) {
            // Continuation of INSERT — append with space
            currentInsert += " " + line;
        } else if (trimmed.startsWith("DEFINE") || trimmed.startsWith("OPTION")) {
            if (!insertsOnly && !skipSchema) {
                stmts.push({ idx: i + 1, line: trimmed, type: "schema" });
            }
        }
        // Skip comments, LET, RETURN, IF, ELSE, empty lines
    }
    flushInsert();

    console.log(`Joined statements: ${stmts.length}`);

    console.log(`Statements to process: ${stmts.length}`);

    if (dryRun) {
        for (const s of stmts) {
            const table = s.type === "data" ? getTableName(s.line) : "schema";
            console.log(`  Line ${s.idx}: ${table} (${humanSize(Buffer.byteLength(s.line))})`);
        }
        return;
    }

    // Connect to SurrealDB via WebSocket
    const wsUrl = url.replace("http://", "ws://").replace("https://", "wss://") + "/rpc";
    console.log(`Connecting to ${wsUrl}...`);
    const surreal = new Surreal();
    await surreal.connect(wsUrl);
    await surreal.signin({ username: user, password: pass });
    await surreal.use({ namespace: ns, database: db });
    console.log("Connected.\n");

    let ok = 0;
    let fail = 0;
    let skipped = 0;
    const failures: { line: number; table: string; size: string; error: string }[] = [];
    const total = stmts.length;

    for (const stmt of stmts) {
        const table = getTableName(stmt.line);
        const size = Buffer.byteLength(stmt.line);
        const sizeStr = humanSize(size);

        const MAX_BULK_SIZE = 10 * 1024 * 1024; // 10MB — split larger INSERTs

        // Large INSERT statements crash SurrealDB — split them proactively
        if (size > MAX_BULK_SIZE && (stmt.line.startsWith("INSERT [") || stmt.line.startsWith("INSERT RELATION ["))) {
            console.log(`  ⚡ ${stmt.idx} ${table} (${sizeStr}) too large — splitting into records...`);
            const { successes, errors } = await importRecordByRecord(surreal, stmt.line, table);
            ok += successes;
            fail += errors.length;
            for (const e of errors) {
                failures.push({ line: stmt.idx, table, size: sizeStr, error: e });
            }
            console.log(`    → ${successes} ok, ${errors.length} fail`);
            continue;
        }

        // Apply backslash fix
        const fixed = fixBackslashEscaping(stmt.line);
        const addSemicolon = fixed.trimEnd().endsWith(";") ? fixed : fixed + ";";

        try {
            await surreal.query(addSemicolon);
            ok++;
            console.log(`  ✓ ${stmt.idx} ${table} (${sizeStr})`);
        } catch (err: any) {
            const errMsg = err?.message || String(err);

            // If "already exists", that's OK — data is already there
            if (errMsg.includes("already exists") || errMsg.includes("already contains")) {
                skipped++;
                console.log(`  ~ ${stmt.idx} ${table} (${sizeStr}) [already exists]`);
                continue;
            }

            // If parse error and the INSERT has multiple records, try splitting
            if (errMsg.includes("Parse error") && (stmt.line.startsWith("INSERT [") || stmt.line.startsWith("INSERT RELATION ["))) {
                console.log(`  ! ${stmt.idx} ${table} (${sizeStr}) parse error — trying record-by-record...`);
                const { successes, errors } = await importRecordByRecord(surreal, stmt.line, table);
                ok += successes;
                fail += errors.length;
                for (const e of errors) {
                    failures.push({ line: stmt.idx, table, size: sizeStr, error: e });
                }
                console.log(`    → ${successes} ok, ${errors.length} fail`);
                continue;
            }

            fail++;
            const shortErr = errMsg.length > 200 ? errMsg.slice(0, 200) + "..." : errMsg;
            failures.push({ line: stmt.idx, table, size: sizeStr, error: shortErr });
            console.log(`  ✗ ${stmt.idx} ${table} (${sizeStr}): ${shortErr}`);
        }

        if ((ok + fail) % 20 === 0 && ok + fail > 0) {
            console.log(`  --- Progress: ${ok + skipped} ok, ${fail} fail (${ok + fail + skipped}/${total}) ---`);
        }
    }

    console.log(`\n${"=".repeat(60)}`);
    console.log(`RESTORE COMPLETE`);
    console.log(`  OK: ${ok} | Already existed: ${skipped} | Failed: ${fail}`);
    console.log(`${"=".repeat(60)}`);

    if (failures.length > 0) {
        console.log(`\nFailed statements (${failures.length}):`);
        for (const f of failures) {
            console.log(`  Line ${f.line} [${f.table}] (${f.size}): ${f.error.slice(0, 100)}`);
        }
    }

    await surreal.close();
}

/**
 * When a bulk INSERT [...] fails, split into individual INSERT { ... }
 * statements and try each one. This way we import as much as possible
 * and only skip the specific records that have parser-breaking content.
 */
async function importRecordByRecord(surreal: Surreal, insertLine: string, table: string): Promise<{ successes: number; errors: string[] }> {
    // The format is: INSERT [ { id: ..., ... }, { id: ..., ... }, ... ]
    // We need to split at top-level `}, {` boundaries.
    // This is a simplified splitter that tracks brace depth.

    let content = insertLine;

    // Handle INSERT RELATION [ ... ]
    const relMatch = content.match(/^INSERT\s+(?:RELATION\s+)?\[\s*/);
    if (!relMatch) {
        return { successes: 0, errors: ["Could not parse INSERT array"] };
    }

    const prefix = content.startsWith("INSERT RELATION") ? "INSERT RELATION" : "INSERT";
    content = content.slice(relMatch[0].length);

    // Remove trailing ] and ;
    content = content.replace(/\s*\]\s*;?\s*$/, "");

    // Split into individual records by tracking brace depth
    const records: string[] = [];
    let depth = 0;
    let start = 0;
    let inString = false;
    let escaped = false;

    for (let i = 0; i < content.length; i++) {
        const ch = content[i];

        if (escaped) {
            escaped = false;
            continue;
        }

        if (ch === "\\") {
            escaped = true;
            continue;
        }

        if (ch === "'") {
            inString = !inString;
            continue;
        }

        if (inString) continue;

        if (ch === "{") depth++;
        if (ch === "}") {
            depth--;
            if (depth === 0) {
                // End of a record
                records.push(content.slice(start, i + 1).trim());
                // Skip comma and whitespace
                let j = i + 1;
                while (j < content.length && (content[j] === "," || content[j] === " " || content[j] === "\n")) j++;
                start = j;
                i = j - 1;
            }
        }
    }

    // Try any remaining content
    const remaining = content.slice(start).trim();
    if (remaining && remaining.startsWith("{")) {
        records.push(remaining);
    }

    let successes = 0;
    const errors: string[] = [];

    for (let i = 0; i < records.length; i++) {
        const record = records[i];
        const fixed = fixBackslashEscaping(`${prefix} ${record};`);

        try {
            await surreal.query(fixed);
            successes++;
        } catch (err: any) {
            const errMsg = err?.message || String(err);
            if (errMsg.includes("already exists")) {
                successes++; // count as success
                continue;
            }
            // Extract record ID for logging
            const idMatch = record.match(/id:\s*([a-z_]+:[^\s,}]+)/);
            const recordId = idMatch ? idMatch[1].slice(0, 60) : `record ${i + 1}/${records.length}`;
            errors.push(`${recordId}: ${errMsg.slice(0, 100)}`);
        }

        // Progress for large tables
        if ((i + 1) % 500 === 0) {
            console.log(`    ... ${i + 1}/${records.length} records processed`);
        }
    }

    return { successes, errors };
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
