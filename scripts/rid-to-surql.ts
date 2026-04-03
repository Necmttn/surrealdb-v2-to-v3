/**
 * SurrealDB RecordId to SurrealQL Serialization Utility
 *
 * The SurrealDB SDK v2 serializes compound/array RecordIds into an internal
 * format (with r"..." and s"..." type prefixes) that type::record() cannot
 * parse back. This utility produces valid SurrealQL strings.
 *
 * Usage:
 *   import { ridToSurql } from "./rid-to-surql";
 *
 *   ridToSurql(new RecordId("document", "abc123"))
 *   // => "document:abc123"
 *
 *   ridToSurql(new RecordId("page", "21493df7-786f-8189-bafc-ffb262928309"))
 *   // => "page:⟨21493df7-786f-8189-bafc-ffb262928309⟩"
 *
 *   ridToSurql(new RecordId("block", [new RecordId("document", "abc"), "/page/0/Text/13"]))
 *   // => "block:[document:abc, '/page/0/Text/13']"
 */

import { RecordId, StringRecordId } from "surrealdb";

/**
 * Convert a RecordId (or primitive) to a valid SurrealQL string literal.
 *
 * SDK v2's RecordId.toString() produces type-prefixed compound IDs:
 *   block:[ r"document:x", s"section/0" ]
 *
 * This is the SDK's internal CBOR serialization format. type::record()
 * CANNOT parse it back. This function produces correct SurrealQL:
 *   block:[document:x, 'section/0']
 */
export function ridToSurql(rid: unknown): string {
	if (rid instanceof RecordId) {
		const table = rid.table;
		const id = rid.id;
		if (Array.isArray(id)) {
			const parts = id.map((p) => ridToSurql(p));
			return `${table}:[${parts.join(", ")}]`;
		}
		if (typeof id === "string") {
			if (/^[a-zA-Z0-9_]+$/.test(id)) return `${table}:${id}`;
			return `${table}:\u27E8${id}\u27E9`;
		}
		return `${table}:${String(id)}`;
	}
	// StringRecordId wraps a pre-formatted "table:id" string
	if (rid instanceof StringRecordId) {
		return rid.toString();
	}
	if (typeof rid === "string") return `'${rid.replace(/'/g, "\\'")}'`;
	if (typeof rid === "number" || typeof rid === "bigint") return String(rid);
	return String(rid);
}

/**
 * Escape a value for embedding in a SurrealQL string literal.
 */
export function escSurqlValue(v: unknown): string {
	if (v == null) return "NONE";
	if (typeof v === "string") return `'${v.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
	if (typeof v === "object") return JSON.stringify(v);
	return String(v);
}
