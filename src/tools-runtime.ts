/**
 * Runtime tools of dsh-odoo-sdd: `odoo_execute` (generic CRUD/RPC with a
 * fail-closed allowlist) and `odoo_validate` (local, instance-free module
 * checks). Built here as functions that receive the registrant context plus
 * live dependencies, so the plugin entry stays thin and these layers remain
 * individually testable. Registration happens from src/index.ts.
 *
 * @module dsh-odoo-sdd/tools-runtime
 */
import { defineTool } from "@deepseek-ai/dsh-tools";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";

/** Live dependencies provided by the registrant. */
export interface RuntimeDeps {
	/** Resolve and cache an OdooClient instance, or null when unconfigured. */
	client(): {
		client: { executeKw<T>(model: string, method: string, args: unknown[], kwargs: Record<string, unknown>): Promise<{ ok: true; value: T } | { ok: false; error: string }> } | null;
		report: string;
	};
	/** Effective onboarding status, used in remediation text. */
	status(projectRoot: string): { detail: string };
	/** Deployment config resolution. */
	projectRoot: string;
	/** Models allowed for MUTATING calls, resolved AT CALL TIME (live config). */
	allowlist(): string[];
	/** Journal one applied mutation for the checkpoint rollback (best-effort). */
	recordDataOp?(op: {
		model: string;
		method: "create" | "write" | "unlink";
		ids: number[];
		preImage: Array<Record<string, unknown>>;
		createdIds: number[];
	}): void;
	/** Path/display masking helper. */
	display(pathValue: string): string;
}

/** Build and register `odoo_execute` and `odoo_validate`. */
export function registerRuntimeTools(
	ctx: { tools: { register(tool: unknown): void } },
	deps: RuntimeDeps,
): void {
	// -----------------------------------------------------------------
	// odoo_execute — generic CRUD/RPC with a fail-closed allowlist
	// -----------------------------------------------------------------
	ctx.tools.register(defineTool({
		name: "odoo_execute",
		description:
			"Execute a JSON-RPC call against the connected instance with a fail-closed " +
			"allowlist. READ calls (search_read/read/search_count) are allowed; MUTATING " +
			"calls (create/write/unlink) are denied unless BOTH confirm_destructive=true AND " +
			"the model is in the mutation allowlist, and they are journaled so " +
			"sdd_checkpoint can undo them. Parameters are explicit (domain/ids/values/fields) " +
			"to avoid guessing argument shapes. Output is redacted. Target must be a " +
			"disposable dev/staging DB.",
		parameters: {
			model: { type: "string", required: true, description: "Odoo model name." },
			method: {
				type: "string",
				required: true,
				enum: ["search_read", "read", "create", "write", "unlink", "search_count"],
				description: "Method to call.",
			},
			domain: { type: "array", items: { type: "array", items: { type: "object", additionalProperties: true } }, description: "search_read/search_count domain, e.g. [[\"state\",\"=\",\"draft\"]]." },
			ids: { type: "array", items: { type: "number" }, description: "Record ids (read/write/unlink)." },
			values: { type: "object", additionalProperties: true, description: "Field values (create/write)." },
			fields: { type: "array", items: { type: "string" }, description: "Fields to read." },
			order: { type: "string", description: "Order clause for search_read." },
			confirm_destructive: { type: "boolean", description: "REQUIRED true for create/write/unlink." },
			limit: { type: "number", description: "Row cap for reads (default 10)." },
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					denied: { type: "boolean", required: true },
					reason: { type: "string", required: true },
					result: { type: "string", required: true },
				},
			},
			render: (_args: unknown, value: unknown) => {
				const v = value as { denied: boolean; reason: string };
				return [{ type: "text", text: v.denied ? `[DENIED] ${v.reason}` : v.reason }];
			},
		},
		async execute(args: unknown) {
			const a = args as {
				model: string;
				method: string;
				domain?: unknown[];
				ids?: number[];
				values?: Record<string, unknown>;
				fields?: string[];
				order?: string;
				confirm_destructive?: boolean;
				limit?: number;
			};
			const model = a.model.trim();
			const method = a.method;
			const isMutating = method === "create" || method === "write" || method === "unlink";

			// ---- policy (allowlist + explicit confirmation) ------------------
			if (isMutating) {
				if (a.confirm_destructive !== true) {
					return { denied: true, reason: "Mutating call requires confirm_destructive=true.", result: "" };
				}
				if (!deps.allowlist().includes(model)) {
					return {
						denied: true,
						reason: `Model "${model}" is not allowlisted for mutations — add it via odoo_config mode=set executeAllowlist=[...] or run read-only.`,
						result: "",
					};
				}
			}

			// ---- build the positional call (no argument guessing) ------------
			let callArgs: unknown[];
			let callKwargs: Record<string, unknown> = {};
			if (method === "search_read" || method === "search_count") {
				callArgs = [Array.isArray(a.domain) ? a.domain : []];
				if (method === "search_read") {
					if (Array.isArray(a.fields)) callKwargs["fields"] = a.fields;
					callKwargs["limit"] = typeof a.limit === "number" ? a.limit : 10;
					if (typeof a.order === "string" && a.order !== "") callKwargs["order"] = a.order;
				}
			} else if (method === "read") {
				if (!Array.isArray(a.ids) || a.ids.length === 0) {
					return { denied: true, reason: "read requires a non-empty `ids` array.", result: "" };
				}
				callArgs = [a.ids];
				if (Array.isArray(a.fields)) callKwargs["fields"] = a.fields;
			} else if (method === "create") {
				if (a.values === undefined || typeof a.values !== "object") {
					return { denied: true, reason: "create requires a `values` object.", result: "" };
				}
				callArgs = [a.values];
			} else if (method === "write") {
				if (!Array.isArray(a.ids) || a.ids.length === 0) {
					return { denied: true, reason: "write requires a non-empty `ids` array.", result: "" };
				}
				if (a.values === undefined || typeof a.values !== "object") {
					return { denied: true, reason: "write requires a `values` object.", result: "" };
				}
				callArgs = [a.ids, a.values];
			} else {
				// unlink
				if (!Array.isArray(a.ids) || a.ids.length === 0) {
					return { denied: true, reason: "unlink requires a non-empty `ids` array.", result: "" };
				}
				callArgs = [a.ids];
			}

			const { client } = deps.client();
			if (client === null) {
				return { denied: true, reason: `NOT CONFIGURED: ${deps.status(deps.projectRoot).detail}`, result: "" };
			}

			// ---- pre-image capture (for the rollback journal) ----------------
			let preImage: Array<Record<string, unknown>> = [];
			if (isMutating && deps.recordDataOp) {
				const ids = Array.isArray(a.ids) ? a.ids : [];
				if (method === "write" && ids.length > 0) {
					const fields = Object.keys(a.values ?? {});
					const pre = await client.executeKw<Array<Record<string, unknown>>>(model, "read", [ids], fields.length > 0 ? { fields } : {});
					if (pre.ok && Array.isArray(pre.value)) preImage = pre.value;
				} else if (method === "unlink" && ids.length > 0) {
					const pre = await client.executeKw<Array<Record<string, unknown>>>(model, "read", [ids], {});
					if (pre.ok && Array.isArray(pre.value)) preImage = pre.value;
				}
			}

			// ---- execute ----------------------------------------------------
			const rpc = await client.executeKw<unknown>(model, method, callArgs, callKwargs);
			if (!rpc.ok) {
				return { denied: false, reason: "SERVER ERROR", result: rpc.error };
			}

			// ---- journal the applied mutation (best-effort undo) ------------
			if (isMutating && deps.recordDataOp) {
				const ids = Array.isArray(a.ids) ? a.ids : [];
				const createdIds = method === "create" && typeof rpc.value === "number" ? [rpc.value] : [];
				deps.recordDataOp({
					model,
					method: method as "create" | "write" | "unlink",
					ids,
					preImage,
					createdIds,
				});
			}

			return { denied: false, reason: `${model}.${method} OK`, result: JSON.stringify(rpc.value).slice(0, 4000) };
		},
	}));

	// -----------------------------------------------------------------
	// odoo_validate — local, instance-free module structure validation
	// -----------------------------------------------------------------
	ctx.tools.register(defineTool({
		name: "odoo_validate",
		description:
			"Validate a module directory WITHOUT a running instance: __manifest__.py present, declared data " +
			"XML files exist, and the SECURITY model is coherent — every new model (models/*.py `_name`) must " +
			"have a line in security/ir.model.access.csv, and referenced group xmlids must resolve inside the " +
			"module (or be base.* groups). Returns file:line findings (ERROR/WARN). NO server required.",
		parameters: {
			module_dir: { type: "string", required: true, description: "Absolute path to the module directory (must contain __manifest__.py)." },
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					valid: { type: "boolean", required: true },
					findings: { type: "array", required: true, items: { type: "object", additionalProperties: true } },
					detail: { type: "string", required: true },
				},
			},
			render: (_args: unknown, value: unknown) => {
				const v = value as { detail: string };
				return [{ type: "text", text: v.detail }];
			},
		},
		async execute(args: { module_dir: string }) {
			const moduleDir = args.module_dir.trim();
			const moduleName = basename(moduleDir);
			const manifestPath = join(moduleDir, "__manifest__.py");
			const findings: Array<{ severity: string; file: string; message: string }> = [];
			if (!existsSync(manifestPath)) {
				findings.push({ severity: "ERROR", file: manifestPath, message: "__manifest__.py not found." });
				return { valid: false, findings, detail: "No __manifest__.py — invalid module." };
			}
			const manifestText = readFileSync(manifestPath, "utf8");
			if (!/'depends'\s*:/.test(manifestText)) {
				findings.push({ severity: "WARN", file: "__manifest__.py", message: "No 'depends' section." });
			}

			// ---- declared data files exist and parse -------------------------
			const dataMatch = /'data'\s*:\s*\[([^\]]*)\]/.exec(manifestText);
			const declaredXml: string[] = [];
			if (dataMatch && dataMatch[1]!.trim() !== "") {
				for (const tok of dataMatch[1]!.split(",")) {
					const rel = tok.replace(/['"\s]/g, "").trim();
					if (rel === "" || !rel.endsWith(".xml")) continue;
					const xmlPath = join(moduleDir, rel);
					if (!existsSync(xmlPath)) {
						findings.push({ severity: "ERROR", file: rel, message: "Declared data XML not found." });
						continue;
					}
					declaredXml.push(rel);
					const xmlText = readFileSync(xmlPath, "utf8");
					if (!/\s*<(openerp|odoo|record)\b/.test(xmlText)) {
						findings.push({ severity: "WARN", file: rel, message: "XML root not recognized." });
					}
				}
			}

			// ---- new models declared in models/*.py --------------------------
			const newModels: Array<{ name: string; file: string }> = [];
			const modelsDir = join(moduleDir, "models");
			if (existsSync(modelsDir)) {
				for (const fileName of readdirSync(modelsDir)) {
					if (!fileName.endsWith(".py")) continue;
					let text = "";
					try {
						text = readFileSync(join(modelsDir, fileName), "utf8");
					} catch {
						continue;
					}
					for (const line of text.split(/\r?\n/)) {
						const m = /^\s*_name\s*=\s*["']([a-z0-9_.]+)["']/.exec(line);
						if (m) newModels.push({ name: m[1]!, file: `models/${fileName}` });
					}
				}
			}

			// ---- security coherence -----------------------------------------
			const aclPath = join(moduleDir, "security", "ir.model.access.csv");
			const aclExists = existsSync(aclPath);
			if (newModels.length > 0 && !aclExists) {
				findings.push({
					severity: "ERROR",
					file: "security/ir.model.access.csv",
					message: `Module declares ${newModels.length} new model(s) (${newModels.map((m) => m.name).join(", ")}) but has no ACL file.`,
				});
			}
			if (aclExists) {
				const acl = readFileSync(aclPath, "utf8");
				const aclLines = acl.split(/\r?\n/).filter((l) => l.trim() !== "" && !l.trim().startsWith("id,"));
				const aclModels = new Set<string>();
				const referencedGroups = new Set<string>();
				// Odoo derives a model's xmlid from its name with dots as underscores.
				const modelKey = (name: string): string => name.replace(/\./g, "_").replace(/^model_/, "");
				for (const line of aclLines) {
					const parts = line.split(",");
					if (parts.length < 5) {
						findings.push({ severity: "WARN", file: "security/ir.model.access.csv", message: `Malformed ACL row (expected id,name,model_id:id,group_id:id,perm_*): ${line.slice(0, 60)}` });
						continue;
					}
					aclModels.add(modelKey(parts[2]!.trim()));
					const groupRef = parts[3]!.trim();
					if (groupRef !== "" && groupRef !== "group_id:id") referencedGroups.add(groupRef);
				}
				for (const model of newModels) {
					if (!aclModels.has(modelKey(model.name))) {
						findings.push({
							severity: "ERROR",
							file: "security/ir.model.access.csv",
							message: `New model "${model.name}" (${model.file}) has no ACL row — add model_${modelKey(model.name)}.`,
						});
					}
				}
				// Groups must resolve inside the module (declared res.groups records)
				// or be a base group; an external module cannot be verified locally.
				const declaredGroupIds = new Set<string>();
				for (const rel of declaredXml) {
					try {
						const xml = readFileSync(join(moduleDir, rel), "utf8");
						for (const m of xml.matchAll(/<record[^>]*\bid=["']([^"']+)["'][^>]*model=["']res\.groups["']/g)) declaredGroupIds.add(m[1]!);
						for (const m of xml.matchAll(/<record[^>]*\bmodel=["']res\.groups["'][^>]*\bid=["']([^"']+)["']/g)) declaredGroupIds.add(m[1]!);
					} catch {
						// unreadable file already reported
					}
				}
				for (const ref of referencedGroups) {
					const bare = ref.includes(".") ? ref.split(".").pop()! : ref;
					const isBase = ref.startsWith("base.") || ref.startsWith("base_");
					const isOwn = declaredGroupIds.has(bare) || ref === `${moduleName}.${bare}`;
					if (!isBase && !isOwn) {
						findings.push({
							severity: "WARN",
							file: "security/ir.model.access.csv",
							message: `Group "${ref}" is neither a base.* group nor a res.groups record declared by this module — verify it exists.`,
						});
					}
				}
			}

			// ---- record rules reference groups ------------------------------
			for (const rel of declaredXml) {
				let xml = "";
				try {
					xml = readFileSync(join(moduleDir, rel), "utf8");
				} catch {
					continue;
				}
				if (/model=["']ir\.rule["']/.test(xml) && !/groups/.test(xml)) {
					findings.push({
						severity: "WARN",
						file: rel,
						message: "Record rule (ir.rule) without an explicit `groups` field — it applies globally.",
					});
				}
			}

			const errors = findings.filter((f) => f.severity === "ERROR").length;
			const detail = findings.length === 0
				? `Module structure and security model OK (${newModels.length} new model(s), ACL present=${aclExists}).`
				: `${errors} ERROR(s), ${findings.length - errors} WARNING(s) — ${newModels.length} new model(s). Review findings.`;
			return { valid: errors === 0, findings, detail };
		},
	}));
}