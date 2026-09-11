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
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

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
			"the model is in the mutation allowlist. The allowlist is read live from the " +
			"plugin config (.sdd/config.json), so odoo_config changes apply immediately. " +
			"Output is redacted. Target must be a disposable dev/staging DB.",
		parameters: {
			model: { type: "string", required: true, description: "Odoo model name." },
			method: {
				type: "string",
				required: true,
				enum: ["search_read", "read", "create", "write", "unlink", "search_count"],
				description: "Method to call.",
			},
			kwargs: { type: "object", additionalProperties: true, description: "Keyword arguments (domain, fields, values...)." },
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
				kwargs?: Record<string, unknown>;
				confirm_destructive?: boolean;
				limit?: number;
			};
			const model = a.model.trim();
			const isMutating = ["create", "write", "unlink"].includes(a.method);
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
			const { client, report } = deps.client();
			if (client === null) {
				return { denied: true, reason: `NOT CONFIGURED: ${deps.status(deps.projectRoot).detail}`, result: "" };
			}
			const kwargs = a.kwargs ?? {};
			if (a.limit !== undefined && typeof kwargs["limit"] !== "number") {
				kwargs["limit"] = a.limit;
			}
			const rpc = await client.executeKw<unknown>(model, a.method, [], kwargs);
			if (!rpc.ok) {
				return { denied: false, reason: `SERVER ERROR`, result: rpc.error };
			}
			return { denied: false, reason: `${model}.${a.method} OK`, result: JSON.stringify(rpc.value).slice(0, 4000) };
		},
	}));

	// -----------------------------------------------------------------
	// odoo_validate — local, instance-free module structure validation
	// -----------------------------------------------------------------
	ctx.tools.register(defineTool({
		name: "odoo_validate",
		description:
			"Validate a module directory's structure WITHOUT a running instance: " +
			"__manifest__.py present and parseable, declared data XML files exist, " +
			"security/ir.model.access.csv present when models are declared. Returns " +
			"file:line findings (ERROR/WARN). NO server required.",
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
			const dataMatch = /'data'\s*:\s*\[([^\]]*)\]/.exec(manifestText);
			const declaresAnyModel = /_inherit\s*=/.test(manifestText) || /class\s+\w+\s*\(models\.Model\)/.test(manifestText);
			if (declaresAnyModel && !existsSync(join(moduleDir, "security", "ir.model.access.csv"))) {
				findings.push({ severity: "WARN", file: "security/ir.model.access.csv", message: "Models declared but no ACL csv." });
			}
			if (dataMatch && dataMatch[1]!.trim() !== "") {
				for (const tok of dataMatch[1]!.split(",")) {
					const rel = tok.replace(/['"\s]/g, "").trim();
					if (rel === "" || !rel.endsWith(".xml")) continue;
					const xmlPath = join(moduleDir, rel);
					if (!existsSync(xmlPath)) {
						findings.push({ severity: "ERROR", file: rel, message: "Declared data XML not found." });
						continue;
					}
					const xmlText = readFileSync(xmlPath, "utf8");
					if (!/\s*<(openerp|odoo|record)\b/.test(xmlText)) {
						findings.push({ severity: "WARN", file: rel, message: "XML root not recognized." });
					}
				}
			}
			const errors = findings.filter((f) => f.severity === "ERROR").length;
			const detail = findings.length === 0
				? "Module structure OK."
				: `${errors} ERROR(s), ${findings.length - errors} WARNING(s). Review findings.`;
			return { valid: errors === 0, findings, detail };
		},
	}));
}