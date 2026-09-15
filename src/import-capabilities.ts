/**
 * Import capability matrix: what `base_import` looks like on a given Odoo
 * version, and what this plugin refuses to guess.
 *
 * The native importer changed shape across versions, and the differences are not
 * cosmetic:
 *
 *   - the upload endpoint took `file` + `import_id` and answered JSONP in older
 *     releases, and takes `ufile` + `id` and answers JSON from 17 on;
 *   - the apply call is `do(fields, options, ...)` in 10–11,
 *     `do(fields, columns, options, ...)` in 12–14 and `execute_import(...)` from
 *     15 on;
 *   - `base_import.import.file` takes RAW BYTES, not base64.
 *
 * A version outside the known families is NOT assumed compatible: the operation
 * is refused with what to investigate, because a wrong guess here writes data.
 *
 * @module dsh-odoo-sdd/import-capabilities
 */

/** How the import file is uploaded for one version family. */
export interface UploadContract {
	/** Path of the upload endpoint. */
	path: string;
	/** Form field carrying the file bytes. */
	fileField: string;
	/** Form field carrying the import id (database id of the temp importer record). */
	idField: string;
	/** Response format the endpoint produces. */
	response: "json" | "jsonp";
}

/** How the import is applied for one version family. */
export interface ApplyContract {
	/** Method name on `base_import.import`. */
	method: "do" | "execute_import";
	/**
	 * Positional shape of the call, as the version's own signature declares it.
	 * `fields` = the import_id/fields pair, `columns` = the column mapping,
	 * `options` = the options dict, `dryrun` = the test flag.
	 */
	signature: Array<"import_id" | "fields" | "columns" | "options" | "dryrun">;
}

/** Everything needed to drive the native importer on one version. */
export interface ImportCapabilities {
	/** Odoo major version this describes. */
	major: number;
	/** Human label of the family. */
	family: string;
	upload: UploadContract;
	apply: ApplyContract;
	/** Method used to read the field list of the target model. */
	fieldsMethod: "get_fields" | "get_fields_tree";
	/** Notes worth showing the operator (behaviour that surprises people). */
	notes: string[];
}

/** Families this plugin has verified contracts for. */
const FAMILIES: ImportCapabilities[] = [
	{
		major: 19,
		family: "17-19",
		upload: { path: "/base_import/set_file", fileField: "ufile", idField: "id", response: "json" },
		apply: { method: "execute_import", signature: ["import_id", "fields", "columns", "options", "dryrun"] },
		fieldsMethod: "get_fields",
		notes: [
			"`res.config.settings`-style properties are stored as JSONB from 18 on; write values through the ORM, never a JSONB dictionary.",
			"Confirm the endpoint shape against the instance: the response is JSON here, and a JSONP body means a different family.",
		],
	},
	{
		major: 18,
		family: "17-19",
		upload: { path: "/base_import/set_file", fileField: "ufile", idField: "id", response: "json" },
		apply: { method: "execute_import", signature: ["import_id", "fields", "columns", "options", "dryrun"] },
		fieldsMethod: "get_fields",
		notes: [
			"Properties live in JSONB from 18 on, but the value is still written through the ORM normal path.",
			"A dry run executes ORM logic and can persist mapping preferences outside the savepoint: it is not a pure read.",
		],
	},
	{
		major: 17,
		family: "17-19",
		upload: { path: "/base_import/set_file", fileField: "ufile", idField: "id", response: "json" },
		apply: { method: "execute_import", signature: ["import_id", "fields", "columns", "options", "dryrun"] },
		fieldsMethod: "get_fields",
		notes: [
			"`ir.property` is still in use on 17; write the normal value through the ORM with the company context.",
			"A dry run executes ORM logic and can persist mapping preferences: it is not a pure read.",
		],
	},
	{
		major: 16,
		family: "15-16",
		upload: { path: "/base_import/set_file", fileField: "ufile", idField: "id", response: "json" },
		apply: { method: "execute_import", signature: ["import_id", "fields", "columns", "options", "dryrun"] },
		fieldsMethod: "get_fields_tree",
		notes: ["Verify the upload field names on the instance: this family is close to the older JSONP shape."],
	},
	{
		major: 15,
		family: "15-16",
		upload: { path: "/base_import/set_file", fileField: "ufile", idField: "id", response: "json" },
		apply: { method: "execute_import", signature: ["import_id", "fields", "columns", "options", "dryrun"] },
		fieldsMethod: "get_fields_tree",
		notes: ["Verify the upload field names on the instance: this family is close to the older JSONP shape."],
	},
	{
		major: 14,
		family: "12-14",
		upload: { path: "/base_import/set_file", fileField: "file", idField: "import_id", response: "jsonp" },
		apply: { method: "do", signature: ["fields", "columns", "options", "dryrun"] },
		fieldsMethod: "get_fields_tree",
		notes: ["The upload answers JSONP: this plugin parses it as DATA and never executes it."],
	},
	{
		major: 13,
		family: "12-14",
		upload: { path: "/base_import/set_file", fileField: "file", idField: "import_id", response: "jsonp" },
		apply: { method: "do", signature: ["fields", "columns", "options", "dryrun"] },
		fieldsMethod: "get_fields_tree",
		notes: ["The upload answers JSONP: this plugin parses it as DATA and never executes it."],
	},
	{
		major: 12,
		family: "12-14",
		upload: { path: "/base_import/set_file", fileField: "file", idField: "import_id", response: "jsonp" },
		apply: { method: "do", signature: ["fields", "columns", "options", "dryrun"] },
		fieldsMethod: "get_fields_tree",
		notes: ["The upload answers JSONP: this plugin parses it as DATA and never executes it."],
	},
	{
		major: 11,
		family: "10-11",
		upload: { path: "/base_import/set_file", fileField: "file", idField: "import_id", response: "jsonp" },
		apply: { method: "do", signature: ["fields", "options", "dryrun"] },
		fieldsMethod: "get_fields_tree",
		notes: [
			"The apply signature has no separate columns argument on this family.",
			"The upload answers JSONP: this plugin parses it as DATA and never executes it.",
		],
	},
	{
		major: 10,
		family: "10-11",
		upload: { path: "/base_import/set_file", fileField: "file", idField: "import_id", response: "jsonp" },
		apply: { method: "do", signature: ["fields", "options", "dryrun"] },
		fieldsMethod: "get_fields_tree",
		notes: [
			"The apply signature has no separate columns argument on this family.",
			"The upload answers JSONP: this plugin parses it as DATA and never executes it.",
		],
	},
];

/** Outcome of resolving the import capabilities of a server version. */
export type CapabilityResult =
	| { ok: true; capabilities: ImportCapabilities }
	| { ok: false; reason: "unparsable_version" | "unknown_family"; message: string };

/**
 * Parse the major version out of an Odoo `server_version` string.
 * @param serverVersion - e.g. `"17.0"`, `"16.0+e"`, `"19.0-20260101"`.
 * @returns the major, or null when it cannot be read.
 */
export function majorVersion(serverVersion: string): number | null {
	const match = /^\s*(\d+)\./.exec(serverVersion);
	if (match === null) {
		// Accept a bare major ("17") too: some proxies report it that way.
		const bare = /^\s*(\d+)\s*$/.exec(serverVersion);
		if (bare === null) return null;
		const value = Number(bare[1]);
		return Number.isInteger(value) && value > 0 ? value : null;
	}
	const value = Number(match[1]);
	return Number.isInteger(value) && value > 0 ? value : null;
}

/**
 * Resolve what the native importer looks like on this version.
 *
 * A version outside the verified families is NOT assumed to work like its
 * neighbour: the caller gets an explicit refusal with what to investigate,
 * because guessing here writes data through a contract nobody checked.
 * @param serverVersion - the instance's `server_version` string.
 * @returns the capabilities, or the reason they cannot be resolved.
 */
export function importCapabilities(serverVersion: string): CapabilityResult {
	const major = majorVersion(serverVersion);
	if (major === null) {
		return {
			ok: false,
			reason: "unparsable_version",
			message:
				`Cannot read a major version out of server_version="${serverVersion}". ` +
				"Detect the version with odoo_connect and report it; the import contract cannot be guessed.",
		};
	}
	const found = FAMILIES.find((f) => f.major === major);
	if (found === undefined) {
		return {
			ok: false,
			reason: "unknown_family",
			message:
				`Odoo ${major} is outside the import families this plugin has verified contracts for ` +
				`(majors ${[...new Set(FAMILIES.map((f) => f.major))].sort((a, b) => a - b).join(", ")}). ` +
				"Investigate `/base_import/set_file` (upload field names and response format) and the apply " +
				"signature in that version's source BEFORE importing: the differences are real and writing " +
				"data through the wrong one is not recoverable by re-reading.",
		};
	}
	return { ok: true, capabilities: found };
}

/** Every major this plugin claims a contract for. */
export function knownMajors(): number[] {
	return [...new Set(FAMILIES.map((f) => f.major))].sort((a, b) => a - b);
}

/**
 * Build the positional arguments of the apply call for this family.
 * @param capabilities - resolved capabilities.
 * @param input - the pieces the signature may consume.
 * @returns the positional argument list, in the version's own order.
 */
export function applyArguments(
	capabilities: ImportCapabilities,
	input: {
		importId: number;
		fields: unknown[];
		columns: unknown[];
		options: Record<string, unknown>;
		dryRun: boolean;
	},
): unknown[] {
	return capabilities.apply.signature.map((token) => {
		switch (token) {
			case "import_id":
				return input.importId;
			case "fields":
				return input.fields;
			case "columns":
				return input.columns;
			case "options":
				return input.options;
			case "dryrun":
				return input.dryRun;
		}
	});
}
