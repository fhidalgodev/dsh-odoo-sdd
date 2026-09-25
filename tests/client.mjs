/**
 * Client-half (browser) smoke test for dsh-odoo-sdd.
 *
 * The browser bundle has no build step and no bundler: it is plain JS served
 * from the installed package, so nothing in the server-side test run touches
 * it. This test loads `client/client.js` exactly the way the DSH ModuleLoader
 * does, applies it against a stub context, renders the settings section with a
 * minimal `createElement`, and asserts the properties that matter:
 *
 *   - the module registers under its id and exports the host contract
 *     (`apply`, `inject`, `name`);
 *   - the section renders WITHOUT throwing, and every localized label resolves
 *     (a missing dictionary key would render as `undefined`);
 *   - the Specs card offers the two layouts and shows the right folder field
 *     for each, and the legacy project-root field is gone from the panel.
 *
 * Usage: `node tests/client.mjs` (no build step required).
 *
 * @module dsh-odoo-sdd/tests/client
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

let failures = 0;
let checks = 0;
/**
 * Assert one client-half invariant.
 * @param name - what is being checked.
 * @param ok - whether it holds.
 * @param detail - extra context printed on failure.
 */
function check(name, ok, detail) {
	checks += 1;
	if (ok) {
		console.log(`  PASS  ${name}`);
		return;
	}
	failures += 1;
	console.log(`  FAIL  ${name}${detail === undefined ? "" : ` — ${detail}`}`);
}

console.log("== client half (ModuleLoader contract + settings section) ==");

// ---- minimal React: createElement builds a descriptor tree with children in
// props (as React does), and the two hooks used by the bundle get a
// synchronous per-render implementation.
let hookSlots = [];
let hookIndex = 0;
const react = {
	createElement(type, props, ...children) {
		const kids = children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false);
		return {
			type,
			props: Object.assign({}, props ?? {}, { children: kids.length === 0 ? null : kids.length === 1 ? kids[0] : kids }),
		};
	},
	useState(initial) {
		const i = hookIndex++;
		if (hookSlots[i] === undefined) hookSlots[i] = { value: typeof initial === "function" ? initial() : initial };
		return [
			hookSlots[i].value,
			(next) => {
				hookSlots[i].value = typeof next === "function" ? next(hookSlots[i].value) : next;
			},
		];
	},
	// Not executed: the assertions describe the FIRST render, which is what a
	// developer sees when the panel opens.
	useEffect() {},
};

// ---- ModuleLoader shim (the exact seam the browser uses).
const loaded = new Map();
globalThis.window = {
	__ModuleLoader__: {
		load({ id, factory }) {
			loaded.set(id, factory((name) => {
				if (name === "react") return react;
				throw new Error(`unexpected require("${name}")`);
			}));
		},
	},
};
await import(new URL("../client/client.js", import.meta.url).href);

const client = loaded.get("dsh-odoo-sdd");
check("the bundle registers itself with the ModuleLoader", client !== undefined);
check("it exports the host contract", client !== undefined && typeof client.apply === "function" && Array.isArray(client.inject) && client.name === "odoo-sdd");
check(
	"it declares the services it reads",
	client !== undefined && ["slots", "locale", "theme"].every((s) => client.inject.includes(s)),
);

// ---- context stub: effects run immediately so the section is registered.
let registered = null;
/**
 * The settings snapshot the panel reads. Declared before the context because
 * `bind()` reads it during apply.
 */
let settingsScope = { getSnapshot: () => ({ value: {}, status: "ready", writable: true }) };
const context = {
	effect(fn) {
		const dispose = fn();
		return typeof dispose === "function" ? dispose : () => {};
	},
	locale: {
		register() {},
		bind: () => (key) => {
			// A missing key is a real defect: surface it as undefined so the
			// render assertions below can catch it.
			const dict = dictionaries();
			return Object.prototype.hasOwnProperty.call(dict, key) ? dict[key] : undefined;
		},
	},
	inject(_names, cb) {
		cb({
			settingsScope: {
				// A live getter, like the host scope: it must reflect later renders.
				bind: () => ({
					getSnapshot: () => settingsScope.getSnapshot(),
					subscribe: () => () => {},
					set: async () => {},
				}),
			},
		});
	},
	slots: {
		inject(_name, cb) {
			cb();
		},
		register(_spec, render) {
			registered = render;
			return () => {};
		},
	},
	uiWorkspace: {},
};

/** The English dictionary captured from the bundle's own register() call. */
function dictionaries() {
	return globalThis.__odooSddDictEn;
}

// Capture the English dictionary by intercepting register().
context.locale.register = (_ns, dict) => {
	globalThis.__odooSddDictEn = dict.en;
};
client.apply(context);
check("applying the bundle registers the settings section", typeof registered === "function");

/**
 * Render the section once with a given settings snapshot.
 * @param snapshot - the settings scope value.
 * @returns the descriptor tree.
 */
function render(snapshot) {
	hookSlots = [];
	hookIndex = 0;
	settingsScope = { getSnapshot: () => ({ value: snapshot, status: "ready", writable: true }) };
	return registered();
}

/** Children of a descriptor, as a list (React allows a single child). */
function childrenOf(node) {
	const kids = node?.props?.children;
	if (kids === null || kids === undefined) return [];
	return Array.isArray(kids) ? kids : [kids];
}

/**
 * Walk the tree, CALLING function components exactly like React does (the
 * bundle's section is one), and collect every node a predicate selects.
 * @param node - descriptor, string or null.
 * @param predicate - test applied to host elements.
 * @param out - accumulator.
 * @returns the selected host elements.
 */
function walk(node, predicate, out = []) {
	if (node === null || node === undefined || typeof node === "boolean") return out;
	if (typeof node === "string" || typeof node === "number") return out;
	if (typeof node.type === "function") {
		// Each component owns its hook list, like React: reset the cursor so a
		// second traversal reads the same state instead of appending new slots.
		hookIndex = 0;
		return walk(node.type(node.props), predicate, out);
	}
	if (predicate(node)) out.push(node);
	for (const child of childrenOf(node)) walk(child, predicate, out);
	return out;
}

/** Every string rendered in the tree, in document order. */
function textsOf(node) {
	const out = [];
	const visit = (n) => {
		if (n === null || n === undefined || typeof n === "boolean") return;
		if (typeof n === "string" || typeof n === "number") {
			out.push(String(n));
			return;
		}
		if (typeof n.type === "function") {
			hookIndex = 0;
			return visit(n.type(n.props));
		}
		for (const child of childrenOf(n)) visit(child);
	};
	visit(node);
	return out;
}

/** Every element whose className contains the token. */
function findByClass(node, token) {
	return walk(node, (n) => {
		const cls = typeof n.props?.className === "string" ? n.props.className : "";
		return cls.split(/\s+/).includes(token);
	});
}

/** Every input id in the tree. */
function inputIds(node) {
	return walk(node, (n) => n.type === "input" && typeof n.props?.id === "string").map((n) => n.props.id);
}

const baseSnapshot = {
	autonomy: "supervised",
	licensed: "community",
	executeAllowlist: [],
	projectRoot: "",
	specsMode: "project",
	specsRoot: "",
	specsDir: "specs",
	communityRepoUrl: "https://github.com/odoo/odoo",
	communityRepoPath: "",
	enterpriseRepoUrl: "https://github.com/enterprise",
	enterpriseRepoPath: "",
	requireCheckpointBeforeMutation: true,
	securityReviewRequired: true,
	securityInterviewRequired: true,
	auditAllTools: true,
	maxCheckpoints: 5,
	documentationPolicy: "required",
	documentationLanguage: "",
};

// ---- project layout render.
let threw = null;
let tree = null;
try {
	tree = render(baseSnapshot);
} catch (err) {
	threw = err;
}
check("the section renders with the project layout", threw === null, threw === null ? "" : String(threw && threw.message));

if (tree !== null) {
	const titles = findByClass(tree, "odoo-sdd-title").map((n) => textsOf(n).join(""));
	check("the panel carries a Specs card", titles.includes("Specs"), titles.join(" | "));
	check("the Workspace card is gone (the root is per session)", !titles.includes("Workspace"), titles.join(" | "));
	const ids = inputIds(tree);
	check("project layout asks for the subfolder, not a project root", ids.includes("odoo-sdd-sec-specsDir") && !ids.includes("odoo-sdd-sec-projectRoot"), ids.join(", "));
	check("central folder field is hidden in project mode", !ids.includes("odoo-sdd-sec-specsRoot"));
	// A folder NAME in a 100%-wide box is a real UI defect: `.odoo-sdd-input` is
	// width:100%, so short values must carry the narrow modifier.
	const inputById = (id) => walk(tree, (n) => n.type === "input" && n.props?.id === id)[0];
	const shortInput = inputById("odoo-sdd-sec-specsDir");
	check(
		"the subfolder name is a narrow input, not a full-width box",
		shortInput !== undefined && String(shortInput.props.className).includes("odoo-sdd-input--short"),
		shortInput === undefined ? "input not found" : String(shortInput.props.className),
	);
	check("the subfolder name is length-capped", shortInput !== undefined && shortInput.props.maxLength === 64);
	check(
		"other short values are narrow too (language code, checkpoint count)",
		["odoo-sdd-sec-doclang", "odoo-sdd-sec-maxcp"].every((id) => {
			const node = inputById(id);
			return node !== undefined && String(node.props.className).includes("odoo-sdd-input--short");
		}),
	);
	const allText = textsOf(tree);
	check("no label rendered as undefined (dictionary complete)", !allText.some((s) => s.includes("undefined")));
	check("the hint explains the project layout", allText.some((s) => s.includes("<project>/<subfolder>/<spec>")));
	check("the mode control offers both layouts", allText.includes("Inside the project") && allText.includes("Central folder"));
}

// ---- central layout render.
tree = render({ ...baseSnapshot, specsMode: "central", specsRoot: "/home/dev/specs" });
const centralIds = inputIds(tree);
check("central layout asks for the central folder", centralIds.includes("odoo-sdd-sec-specsRoot"));
check("central layout hides the in-project subfolder field", !centralIds.includes("odoo-sdd-sec-specsDir"));
check(
	"the central folder value is shown",
	(() => {
		const inputs = findByClass(tree, "odoo-sdd-input").filter((n) => n.type === "input" && n.props.id === "odoo-sdd-sec-specsRoot");
		return inputs.length === 1 && inputs[0].props.value === "/home/dev/specs";
	})(),
);
check(
	"the hint explains the central layout",
	textsOf(tree).some((s) => s.includes("<central folder>/<project>/<spec>")),
);

// ---- read-only host: the panel must still render and say so.
tree = render({ ...baseSnapshot });
check("a writable scope reports editable", textsOf(tree).includes("Editable"));

// ---- the persisted shape the panel writes (persist() target keys).
const source = readFileSync(join(root, "client", "client.js"), "utf8");
// The change policy is a first-class switch, not a hidden default: it must
// render, and the form must round-trip it in BOTH directions — a save that
// forgot to persist it would silently reset the policy to its default.
check(
	"the panel offers the spec-required switch",
	textsOf(tree).some((s) => s.includes("Require a spec for every change")),
	textsOf(tree).join(" | ").slice(0, 200),
);
check("the panel reads the switch from the snapshot", /requireSpecForChanges:\s*asBool\(s\.requireSpecForChanges/.test(source));
check("the panel persists the switch", /requireSpecForChanges:\s*form\.requireSpecForChanges\s*===/.test(source));
check("the panel writes specsMode", /specsMode:\s*form\.specsMode/.test(source));
check("the panel never writes projectRoot", !/projectRoot:\s*form\.projectRoot/.test(source));
check("the panel keeps the specs dir key for compatibility", /specsDir:\s*form\.specsDir/.test(source));
check(
	"the narrow-input rule is actually shipped in the stylesheet",
	/\.odoo-sdd-input--short\{width:min\(100%,200px\)\}/.test(source),
);

console.log(`\n${checks - failures}/${checks} checks passed.`);
if (failures > 0) {
	console.error(`${failures} CHECK(S) FAILED`);
	process.exit(1);
}
console.log("ALL CLIENT CHECKS PASSED");
