/**
 * Native Odoo translations: export a module's terms, merge them into `i18n/`, and
 * report what is missing.
 *
 * WHY IT USES ODDO'S OWN MODELS
 * `base.language.export` knows what the module's translatable terms ARE: it walks
 * the registry, the views and the field definitions, and it is the only thing that
 * stays correct as the module changes. Re-deriving that list by scanning XML and
 * Python would be a second implementation of a rule Odoo already owns, and it would
 * drift.
 *
 * WHAT IT DOES NOT DO
 * It does not translate. The export supplies the message IDs; the translation is
 * written by whoever reviews the file. Inventing translations mechanically is how a
 * module ships with confident nonsense in every string.
 *
 * VERSION BEHAVIOUR (verified in the installed sources, one boundary: Odoo 16)
 * - `base.language.install` takes `lang` (Char) up to 15 and `lang_ids` (m2m) from
 *   16; the method is `lang_install()` in both.
 * - `ir.translation` exists up to 15 and is GONE from 16, where the `i18n/*.po`
 *   files are the source of translations.
 * So through 15 the database is authoritative and a PO can be loaded on its own;
 * from 16 the file is the source and applying it means upgrading the module.
 *
 * @module dsh-odoo-sdd/odoo-i18n
 */

import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { writeFileAtomic } from "./atomic.js";
import { displayPath } from "./credentials.js";
import type { RpcErrorKind } from "./odoo-client.js";
import {
	isLanguageCode,
	mergePo,
	parsePo,
	poCoverage,
	serializePo,
	type PoFile,
	type PoMergeResult,
} from "./po.js";

/**
 * First Odoo major whose `base.language.install` wizard takes `lang_ids` instead
 * of `lang`, and whose translations live in files instead of `ir.translation`.
 */
export const I18N_MODERN_MAJOR = 16;

/**
 * Timeout for the export calls, in milliseconds.
 *
 * `act_getfile` walks the registry, the views and the field definitions to collect
 * the terms, and a measured run against a real Odoo 19 took ~27 s — right at the
 * client's 30 s default, so a slightly loaded server aborted the call. A heavy
 * operation gets its own budget instead of inheriting one sized for a query.
 */
const EXPORT_TIMEOUT_MS = 300_000;

/** The narrow client surface this tool needs. */
interface I18nClient {
	executeKw<T>(
		model: string,
		method: string,
		args: unknown[],
		kwargs?: Record<string, unknown>,
		timeoutMs?: number,
		signal?: AbortSignal,
	): Promise<{ ok: true; value: T } | { ok: false; error: string; errorKind?: RpcErrorKind }>;
	readonly serverMajor?: number | null;
}

/** What this tool needs from the plugin. */
export interface I18nDeps {
	client(exec?: unknown): { client: I18nClient | null; report: string };
	projectRoot(exec?: unknown): string;
}

/** Resolve a module directory argument against the session's project root. */
function resolveModuleDir(raw: string, projectRoot: string): string {
	return isAbsolute(raw) ? resolve(raw) : resolve(projectRoot, raw);
}

/** The `i18n` directory of a module, whether or not it exists yet. */
function i18nDir(moduleDir: string): string {
	return join(moduleDir, "i18n");
}

/** Absolute path of one language's PO file. */
function poPath(moduleDir: string, lang: string): string {
	return join(i18nDir(moduleDir), `${lang}.po`);
}

/** The languages a module already ships, from its `i18n/*.po` file names. */
function poFilesIn(dir: string): string[] {
	if (!existsSync(dir)) return [];
	try {
		return readdirSync(dir)
			.filter((entry) => entry.endsWith(".po"))
			.map((entry) => entry.slice(0, -3))
			.filter(isLanguageCode)
			.sort();
	} catch {
		return [];
	}
}

/** Read a PO file, or null when it is absent. Throws when it exists but is unusable. */
function readExistingPo(moduleDir: string, lang: string): PoFile | null {
	const file = poPath(moduleDir, lang);
	if (!existsSync(file)) return null;
	const parsed = parsePo(readFileSync(file, "utf8"));
	// A file with neither header nor entries is not a PO file. Refusing here is what
	// stops the merge from silently replacing something it did not understand.
	if (Object.keys(parsed.header).length === 0 && parsed.entries.length === 0) {
		throw new Error(`${displayPath(file)} exists but does not parse as a PO file`);
	}
	return parsed;
}

/** Locate a module on the instance and say whether it can be exported. */
async function findModule(
	client: I18nClient,
	module: string,
): Promise<{ ok: true; id: number } | { ok: false; reason: string }> {
	const res = await client.executeKw<Array<{ id: number; state: string }>>(
		"ir.module.module",
		"search_read",
		[[["name", "=", module]]],
		{ fields: ["id", "state"], limit: 1 },
	);
	if (!res.ok) return { ok: false, reason: `could not query ir.module.module: ${res.error}` };
	const row = res.value[0];
	if (row === undefined) {
		return {
			ok: false,
			reason:
				`module "${module}" is not on the instance. The export needs the module INSTALLED there ` +
				"(the wizard's own domain requires it): install or upgrade it first with odoo_module.",
		};
	}
	if (row.state !== "installed") {
		return {
			ok: false,
			reason:
				`module "${module}" is on the instance in state "${row.state}", not "installed". ` +
				"Odoo can only export the terms of an installed module.",
		};
	}
	return { ok: true, id: row.id };
}

/**
 * Make sure the language is active, using the parameter shape of the server's
 * version and nothing else.
 * @param client - the RPC client.
 * @param lang - the language code.
 * @returns ok, or the reason it cannot be activated.
 */
async function ensureLanguage(
	client: I18nClient,
	lang: string,
): Promise<{ ok: true; activated: boolean } | { ok: false; reason: string }> {
	const found = await client.executeKw<Array<{ id: number; active: boolean; name: string }>>(
		"res.lang",
		"search_read",
		[[["code", "=", lang]]],
		{ fields: ["id", "active", "name"], limit: 1, context: { active_test: false } },
	);
	if (!found.ok) return { ok: false, reason: `could not query res.lang: ${found.error}` };
	const row = found.value[0];
	if (row === undefined) {
		const available = await client.executeKw<Array<{ code: string }>>("res.lang", "search_read", [[]], {
			fields: ["code"],
			limit: 40,
			context: { active_test: false },
		});
		const list = available.ok ? available.value.map((entry) => entry.code).join(", ") : "(could not list)";
		return {
			ok: false,
			reason:
				`"${lang}" is not a language this server knows. Odoo uses gettext codes (ll or ll_CC, e.g. ` +
				`es_VE, es_PA, pt_BR). Some known codes: ${list}`,
		};
	}
	if (row.active) return { ok: true, activated: false };
	const major = client.serverMajor ?? null;
	// The parameter NAME is the version boundary: `lang` through 15, `lang_ids` from
	// 16. Sending the wrong one is an opaque ORM error, so the shape is chosen here.
	const values =
		major !== null && major < I18N_MODERN_MAJOR
			? { lang, overwrite: false }
			: { lang_ids: [[6, 0, [row.id]]], overwrite: false };
	const created = await client.executeKw<number>("base.language.install", "create", [values]);
	if (!created.ok) {
		return { ok: false, reason: `could not create base.language.install: ${created.error}` };
	}
	const installed = await client.executeKw<boolean>("base.language.install", "lang_install", [[created.value]]);
	if (!installed.ok) return { ok: false, reason: `could not activate "${lang}": ${installed.error}` };
	return { ok: true, activated: true };
}

/**
 * Export one module's terms as PO text through `base.language.export`.
 * @param client - the RPC client.
 * @param moduleId - the `ir.module.module` id.
 * @param lang - the language code.
 * @returns the decoded PO text, or the reason it failed.
 */
async function exportPo(
	client: I18nClient,
	moduleId: number,
	lang: string,
): Promise<{ ok: true; content: string; name: string } | { ok: false; reason: string }> {
	const created = await client.executeKw<number>("base.language.export", "create", [
		{
			format: "po",
			export_type: "module",
			modules: [[6, 0, [moduleId]]],
			lang,
			state: "choose",
		},
	]);
	if (!created.ok) return { ok: false, reason: `could not create base.language.export: ${created.error}` };
	// `act_getfile` writes the payload onto the record and returns an action; the
	// file is read back from the record, never from the action.
	const generated = await client.executeKw<unknown>(
		"base.language.export",
		"act_getfile",
		[[created.value]],
		{},
		EXPORT_TIMEOUT_MS,
	);
	if (!generated.ok) return { ok: false, reason: `export failed: ${generated.error}` };
	const row = await client.executeKw<Array<{ data: string | false; name: string }>>(
		"base.language.export",
		"read",
		[[created.value], ["data", "name"]],
		{},
		EXPORT_TIMEOUT_MS,
	);
	if (!row.ok) return { ok: false, reason: `could not read the exported file: ${row.error}` };
	const record = row.value[0];
	if (record === undefined || record.data === false || record.data === "") {
		return { ok: false, reason: "Odoo returned an empty export (no terms for that module and language)" };
	}
	return { ok: true, content: Buffer.from(record.data, "base64").toString("utf8"), name: record.name };
}

/** The tool's own result shape, kept flat so the schema stays checkable. */
interface I18nResult {
	operation: string;
	ok: boolean;
	module: string;
	lang?: string;
	i18nDir?: string;
	file?: string;
	created?: boolean;
	added?: number;
	preserved?: number;
	pending?: number;
	obsoleted?: number;
	total?: number;
	translated?: number;
	detail: string;
}

/**
 * Register the `odoo_i18n` tool.
 * @param ctx - the host context (only `tools.register` is used).
 * @param deps - the plugin services this tool needs.
 */
export function registerI18nTools(ctx: { tools: { register(tool: unknown): void } }, deps: I18nDeps): void {
	ctx.tools.register(defineTool({
		name: "odoo_i18n",
		description:
			"Generate and maintain a module's translations using ODDO'S OWN MODELS: `base.language.export` supplies " +
			"the translatable terms (message IDs) and `base.language.install` activates the language. " +
			"operation=export writes `<module>/i18n/<lang>.po`, creating the `i18n/` folder when it does not exist, " +
			"and MERGES with the file already there: translated entries are preserved as they are, new terms are " +
			"added, and terms the module no longer has are kept as obsolete (`#~`) instead of deleted. " +
			"operation=status reports which languages the module ships and how much of each is translated. " +
			"operation=check fails on entries still awaiting translation. " +
			"It does NOT translate: the export gives the message IDs and a person writes the text. " +
			"Version-aware — through Odoo 15 translations live in `ir.translation` (the database is authoritative " +
			"and `base.language.install` takes `lang`); from 16 the `i18n/*.po` files are the source and `lang_ids` " +
			"is the parameter, so APPLYING the file means upgrading the module.",
		parameters: {
			operation: {
				type: "string",
				required: true,
				enum: ["export", "status", "check"],
				description:
					"export: fetch the terms from the instance and write/update the PO. status: what exists and how " +
					"complete it is. check: report entries with an empty translation.",
			},
			module_dir: {
				type: "string",
				required: true,
				description: "The module directory (the one holding __manifest__.py), absolute or relative to the project root.",
			},
			module: {
				type: "string",
				description: "Technical module name on the instance. Defaults to the module directory's name, which is what Odoo uses.",
			},
			lang: {
				type: "string",
				description: "Language code for export/check (gettext form: ll or ll_CC, e.g. es_VE, es_PA, pt_BR).",
			},
			langs: {
				type: "array",
				items: { type: "string" },
				description: "operation=status only: languages to report on. Defaults to the ones already present in i18n/.",
			},
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					operation: { type: "string", required: true },
					ok: { type: "boolean", required: true },
					module: { type: "string", required: true },
					lang: { type: "string" },
					i18nDir: { type: "string" },
					file: { type: "string" },
					created: { type: "boolean" },
					added: { type: "number" },
					preserved: { type: "number" },
					pending: { type: "number" },
					obsoleted: { type: "number" },
					total: { type: "number" },
					translated: { type: "number" },
					detail: { type: "string", required: true },
				},
			},
			render: (_args: unknown, value: unknown) => [{ type: "text", text: (value as { detail: string }).detail }],
		},
		async execute(args: {
			operation: "export" | "status" | "check";
			module_dir: string;
			module?: string;
			lang?: string;
			langs?: string[];
		}, exec?: unknown) {
			const operation = args.operation;
			const moduleDir = resolveModuleDir(args.module_dir, deps.projectRoot(exec));
			const module = (args.module ?? basename(moduleDir)).trim();
			const dir = i18nDir(moduleDir);

			if (!existsSync(join(moduleDir, "__manifest__.py"))) {
				return {
					operation, ok: false, module,
					detail: `${displayPath(moduleDir)} has no __manifest__.py, so it is not a module directory.`,
				} satisfies I18nResult;
			}

			// ---- status: purely local, no instance needed --------------------
			if (operation === "status") {
				const wanted = (args.langs ?? []).filter(isLanguageCode);
				const present = poFilesIn(dir);
				const langs = wanted.length > 0 ? wanted : present;
				if (langs.length === 0) {
					return {
						operation, ok: true, module, i18nDir: displayPath(dir),
						detail:
							`${displayPath(moduleDir)} ships no translations yet (no i18n/*.po). ` +
							"Use operation=export with a language to create the first one.",
					} satisfies I18nResult;
				}
				const lines = langs.map((lang: string) => {
					const file = poPath(moduleDir, lang);
					if (!existsSync(file)) return `- ${lang}: MISSING (no ${displayPath(file)})`;
					try {
						const coverage = poCoverage(parsePo(readFileSync(file, "utf8")));
						return `- ${lang}: ${coverage.translated}/${coverage.total} translated${coverage.pending.length > 0 ? `, ${coverage.pending.length} pending` : ""}`;
					} catch {
						return `- ${lang}: present but unreadable`;
					}
				});
				return {
					operation, ok: true, module, i18nDir: displayPath(dir),
					detail: `Translations of ${module} (${displayPath(dir)}):\n${lines.join("\n")}`,
				} satisfies I18nResult;
			}

			// ---- check: local validation of what is on disk ------------------
			if (operation === "check") {
				const wanted = args.lang !== undefined ? [args.lang] : [];
				if (wanted.length > 0 && !isLanguageCode(wanted[0])) {
					return { operation, ok: false, module, detail: `"${wanted[0]}" is not a valid language code.` } satisfies I18nResult;
				}
				const langs = wanted.length > 0
					? wanted
					: poFilesIn(dir);
				if (langs.length === 0) {
					return { operation, ok: false, module, detail: `No PO file to check under ${displayPath(dir)}.` } satisfies I18nResult;
				}
				let bad = 0;
				const lines: string[] = [];
				for (const lang of langs) {
					const file = poPath(moduleDir, lang);
					if (!existsSync(file)) {
						bad += 1;
						lines.push(`- ${lang}: MISSING`);
						continue;
					}
					const coverage = poCoverage(parsePo(readFileSync(file, "utf8")));
					if (coverage.pending.length > 0) {
						bad += 1;
						const sample = coverage.pending.slice(0, 5).map((id) => `    ${JSON.stringify(id.slice(0, 60))}`).join("\n");
						lines.push(`- ${lang}: ${coverage.pending.length} entr(y/ies) with an EMPTY translation:\n${sample}`);
					} else {
						lines.push(`- ${lang}: complete (${coverage.translated}/${coverage.total})`);
					}
				}
				return {
					operation, ok: bad === 0, module, i18nDir: displayPath(dir),
					detail:
						`${lines.join("\n")}\n` +
						(bad === 0
							? "Every exported term has a translation."
							: "An empty msgstr is an untranslated string the user will see in English. " +
								"Write the text, then run operation=check again."),
				} satisfies I18nResult;
			}

			// ---- export: the RPC flow ----------------------------------------
			const lang = (args.lang ?? "").trim();
			if (!isLanguageCode(lang)) {
				return {
					operation, ok: false, module,
					detail:
						`operation=export needs a valid \`lang\` (gettext code: ll or ll_CC, e.g. es_VE, es_PA, pt_BR). ` +
						`Received ${JSON.stringify(args.lang ?? null)}.`,
				} satisfies I18nResult;
			}
			const { client, report } = deps.client(exec);
			if (client === null) {
				return { operation, ok: false, module, lang, detail: `${report}\nNothing was exported.` } satisfies I18nResult;
			}

			const found = await findModule(client, module);
			if (!found.ok) return { operation, ok: false, module, lang, detail: found.reason } satisfies I18nResult;

			const language = await ensureLanguage(client, lang);
			if (!language.ok) return { operation, ok: false, module, lang, detail: language.reason } satisfies I18nResult;

			const exported = await exportPo(client, found.id, lang);
			if (!exported.ok) return { operation, ok: false, module, lang, detail: exported.reason } satisfies I18nResult;

			let existing: PoFile | null = null;
			try {
				existing = readExistingPo(moduleDir, lang);
			} catch (err) {
				// Refusing beats overwriting: a file that does not parse may hold work
				// this plugin cannot see, and replacing it would destroy it silently.
				return {
					operation, ok: false, module, lang,
					detail: `${err instanceof Error ? err.message : String(err)}. Refusing to overwrite it: fix or remove the file first.`,
				} satisfies I18nResult;
			}

			let merged: PoMergeResult;
			try {
				merged = mergePo(existing, parsePo(exported.content), lang);
			} catch (err) {
				return {
					operation, ok: false, module, lang,
					detail: `The export could not be parsed (${err instanceof Error ? err.message : String(err)}); nothing was written.`,
				} satisfies I18nResult;
			}

			const file = poPath(moduleDir, lang);
			try {
				mkdirSync(dir, { recursive: true, mode: 0o700 });
				writeFileAtomic(file, serializePo(merged.file));
			} catch (err) {
				return {
					operation, ok: false, module, lang,
					detail: `Could not write ${displayPath(file)}: ${err instanceof Error ? err.message : String(err)}`,
				} satisfies I18nResult;
			}

			const coverage = poCoverage(merged.file);
			const major = client.serverMajor ?? null;
			const applyNote =
				major !== null && major < I18N_MODERN_MAJOR
					? "Through Odoo 15 the database is authoritative: load the file with the base.language.import wizard " +
						"(or reinstall the module) for the translations to take effect."
					: "From Odoo 16 the i18n/*.po files are the source: upgrade the module (odoo_module operation=upgrade) " +
						"for the server to load them.";
			return {
				operation, ok: true, module, lang,
				i18nDir: displayPath(dir),
				file: displayPath(file),
				created: existing === null,
				added: merged.added.length,
				preserved: merged.preserved.length,
				pending: coverage.pending.length,
				obsoleted: merged.obsoleted.length,
				total: coverage.total,
				translated: coverage.translated,
				detail:
					`${existing === null ? "Created" : "Updated"} ${displayPath(file)} for "${lang}"` +
					`${language.activated ? " (the language was inactive and has been activated)" : ""}.\n` +
					`Terms: ${coverage.total} — ${coverage.translated} already translated, ${coverage.pending.length} awaiting text.\n` +
					`Merge: ${merged.added.length} added, ${merged.preserved.length} preserved (a written translation is never ` +
					`replaced by the export's), ${merged.obsoleted.length} kept as obsolete (\`#~\`) because the module no ` +
					"longer has them.\n" +
					(merged.preserved.length > 0
						? "The entries marked preserved were left EXACTLY as they were: review the new ones, not those.\n"
						: "") +
					applyNote,
			} satisfies I18nResult;
		},
	}));
}
