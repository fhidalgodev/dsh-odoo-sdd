/**
 * How one pending tool call describes itself to a UI.
 *
 * A tool that declares no presenter renders as its raw argument JSON, which is
 * noise beside a call whose whole meaning is one model name and one method. The
 * per-tool table below is deliberate: what is salient differs by tool (a model
 * for `odoo_execute`, a spec id for `sdd_phase`), and "first string argument in
 * the object" produces cards that read `odoo_execute: read`.
 *
 * Presentation is a pure projection of the parsed arguments — no filesystem, no
 * instance, no clock — because the Host replays it.
 * @module dsh-odoo-sdd/src/present
 */
import type { ToolCallKind } from "@deepseek-ai/dsh-tools";

/** A pending-call card: the shape a UI needs, before it is tagged `card: 'generic'`. */
export interface CallCard {
	title: string;
	kind?: ToolCallKind;
	rawInput?: unknown;
}

const text = (value: unknown): string | undefined =>
	typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;

/** The last segment of a POSIX or Windows path — `path.basename` would follow the RUNNING platform. */
const leaf = (value: unknown): string | undefined => {
	const path = text(value);
	if (path === undefined) return undefined;
	return path.split(/[\\/]/).filter((part) => part !== "").pop() ?? path;
};

const joined = (value: unknown): string | undefined =>
	Array.isArray(value) && value.length > 0 ? value.map(String).join(", ") : undefined;

const fields = (...values: Array<string | undefined>): string =>
	values.filter((value): value is string => value !== undefined && value !== "").join(" ");

/**
 * One builder per tool. Anything missing falls back to the tool name, so adding a
 * tool never breaks a call — it only renders less well until it is added here.
 */
const CARDS: Record<string, (args: Record<string, unknown>) => CallCard> = {
	odoo_connect: () => ({ title: "Probe the Odoo instance", kind: "read" }),
	odoo_setup: (a) => ({
		title: fields("Odoo setup:", text(a["mode"]) ?? "check"),
		kind: text(a["mode"]) === "check" ? "read" : "execute",
		rawInput: a["name"] ?? a["url"],
	}),
	odoo_config: (a) =>
		text(a["mode"]) === "set"
			? { title: "Update the plugin configuration", kind: "edit" }
			: { title: "Read the plugin configuration", kind: "read" },
	odoo_module: (a) => ({
		title: fields(text(a["operation"]) ?? "module", joined(a["modules"])),
		kind: "execute",
	}),
	odoo_errors: (a) => ({
		title: `Read server errors (last ${String(a["sinceMinutes"] ?? 30)} min)`,
		kind: "read",
	}),
	odoo_session: () => ({ title: "Mint a passwordless web session", kind: "execute" }),
	odoo_execute: (a) => {
		const model = text(a["model"]);
		const method = text(a["method"]);
		// `model.method` is the one identifier a reader can place instantly; a card
		// that spaces the two apart reads as two unrelated words.
		return { title: model === undefined ? (method ?? "odoo_execute") : method === undefined ? model : `${model}.${method}`, kind: "execute", rawInput: a["domain"] ?? a["ids"] };
	},
	odoo_validate: (a) => ({
		title: fields("Validate", leaf(a["module_dir"])),
		kind: "search",
		rawInput: text(a["spec_dir"]),
	}),
	odoo_security_scan: (a) => ({ title: fields("Security scan", leaf(a["module_dir"])), kind: "search" }),
	odoo_tests: (a) => ({
		title: fields("Tests:", text(a["operation"]) ?? "check", leaf(a["module_dir"])),
		kind: "search",
	}),
	odoo_docs: (a) => ({
		title: fields("Docs:", text(a["operation"]) ?? "check", leaf(a["module_dir"])),
		kind: "search",
	}),
	odoo_i18n: (a) => ({
		title: fields("i18n", text(a["operation"]) ?? "status", text(a["lang"]), leaf(a["module_dir"])),
		kind: "read",
	}),
	odoo_manual: (a) => ({
		title: fields("Manual", text(a["operation"]) ?? "canon", text(a["model"]) ?? text(a["slug"])),
		kind: "execute",
	}),
	odoo_video: (a) => ({
		title: fields("Video", text(a["operation"]) ?? "plan", text(a["model"]) ?? text(a["flow"])),
		kind: "execute",
	}),
	odoo_ui_verify: (a) => ({
		title: fields("UI verify", text(a["operation"]) ?? "run", text(a["spec_id"]) ?? text(a["flow"])),
		kind: "execute",
	}),
	sdd_phase: (a) => ({
		title: fields(text(a["spec_id"]) ?? "project", text(a["operation"]) ?? "status"),
		kind: "execute",
	}),
	sdd_checkpoint: (a) => ({
		title: fields("Checkpoint", text(a["operation"]) ?? "list", text(a["checkpoint_id"])),
		kind: "other",
	}),
	sdd_handoff: (a) => ({ title: fields("Handoff", text(a["spec_id"])), kind: "edit" }),
	odoo_functional: (a) => ({
		title: fields(text(a["spec_id"]), text(a["operation"]) ?? "status"),
		kind: "execute",
		rawInput: text(a["batch_id"]),
	}),
	odoo_import: (a) => ({
		title: fields("Import", text(a["use"]) ?? "prepare", text(a["model"])),
		kind: "edit",
		rawInput: leaf(a["file_path"]),
	}),
};

/** The pending card for `tool`, tagged the way the Host's generic card expects. */
export function presentCall(tool: string, args: unknown): { card: "generic"; title: string; kind?: ToolCallKind; rawInput?: unknown } {
	const a = (typeof args === "object" && args !== null ? args : {}) as Record<string, unknown>;
	const card = CARDS[tool]?.(a) ?? { title: tool, kind: "other" as ToolCallKind };
	const view: { card: "generic"; title: string; kind?: ToolCallKind; rawInput?: unknown } = {
		card: "generic",
		title: card.title === "" ? tool : card.title,
	};
	if (card.kind !== undefined) view.kind = card.kind;
	if (card.rawInput !== undefined) view.rawInput = card.rawInput;
	return view;
}
