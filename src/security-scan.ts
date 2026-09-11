/**
 * Local security scan for an Odoo module tree — no instance required.
 *
 * This is the evidence source for the pipeline's mandatory Security Review.
 * It looks for the risk patterns that most often slip through generated code
 * (raw SQL built by concatenation, dynamic execution, hardcoded secrets,
 * unauthenticated routes, XSS in QWeb, unjustified sudo) and reports each hit
 * as a `file:line` finding, so the agent argues about a concrete line instead
 * of guessing.
 *
 * It is deliberately heuristic: every finding carries the rule id and a hint,
 * and the caller decides (with the security-reviewer persona) whether it is a
 * real defect or an accepted exception.
 *
 * @module dsh-odoo-sdd/security-scan
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";

/** Severity of one finding; ERROR blocks `DONE`. */
export type Severity = "ERROR" | "WARN" | "INFO";

/** One security finding, anchored to a file and line. */
export interface SecurityFinding {
	severity: Severity;
	rule: string;
	file: string;
	line: number;
	message: string;
	hint: string;
}

/** Result of scanning a module directory. */
export interface ScanResult {
	findings: SecurityFinding[];
	scannedFiles: number;
	truncated: boolean;
	/** True when no ERROR finding was produced. */
	clean: boolean;
}

const SKIP_DIRS = new Set(["node_modules", ".git", "__pycache__", ".mypy_cache", ".pytest_cache"]);
const SCANNED_EXT = new Set([".py", ".xml", ".js", ".csv", ".yml", ".yaml"]);
const MAX_FILES = 4000;
const MAX_BYTES_PER_FILE = 2 * 1024 * 1024;

/** Rules applied line by line. Each returns null when the line is fine. */
interface Rule {
	id: string;
	severity: Severity;
	/** File extensions this rule applies to (empty = all scanned). */
	exts: string[];
	message: string;
	hint: string;
	/** True when the line violates the rule. */
	match(line: string, ext: string): boolean;
}

const RULES: Rule[] = [
	{
		id: "sql-injection",
		severity: "ERROR",
		exts: [".py"],
		message: "SQL executed with an interpolated/concatenated query (injection risk).",
		hint: 'Pass parameters: cr.execute("... WHERE id = %s", (id,)).',
		match: (l) => /\.execute\s*\(/.test(l) && /(f["']|["']\s*%|\+\s*\w|\.format\s*\()/.test(l),
	},
	{
		id: "dynamic-exec",
		severity: "ERROR",
		exts: [".py"],
		message: "Dynamic code execution or unsafe deserialization.",
		hint: "Remove eval/exec/pickle/subprocess/os.system; use the ORM and safe APIs.",
		match: (l) => /\b(eval|exec)\s*\(|\bpickle\.loads\s*\(|\bos\.system\s*\(|\bsubprocess\.(run|Popen|call)\s*\(/.test(l),
	},
	{
		id: "hardcoded-secret",
		severity: "ERROR",
		exts: [".py", ".xml", ".yml", ".yaml", ".js"],
		message: "Hardcoded credential-like literal.",
		hint: "Read secrets from configuration or ir.config_parameter; never commit literals.",
		match: (l) => /(password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token)\s*[:=]\s*["'][^"']{4,}["']/i.test(l),
	},
	{
		id: "sudo-unjustified",
		severity: "WARN",
		exts: [".py"],
		message: "sudo() without an adjacent justification comment.",
		hint: "Add a comment explaining why the rights escalation is required, or avoid sudo().",
		match: (l) => /\.sudo\s*\(/.test(l) && !/(#.*(justif|reason|bypass|acl|sudo))/.test(l),
	},
	{
		id: "route-public",
		severity: "WARN",
		exts: [".py"],
		message: 'Route declared with auth="none" (reachable without authentication).',
		hint: "Confirm the route must be public; validate input and rate-limit it.",
		match: (l) => /auth\s*=\s*["']none["']/.test(l),
	},
	{
		id: "csrf-disabled",
		severity: "WARN",
		exts: [".py"],
		message: "CSRF protection disabled on a route.",
		hint: "Keep csrf enabled unless the endpoint is a signed webhook.",
		match: (l) => /csrf\s*=\s*False/.test(l),
	},
	{
		id: "qweb-traw",
		severity: "WARN",
		exts: [".xml"],
		message: "QWeb t-raw renders unescaped HTML (XSS risk).",
		hint: "Prefer t-esc/t-out; sanitize the value when raw HTML is required.",
		match: (l) => /\bt-raw\s*=/.test(l),
	},
	{
		id: "xml-eval-dangerous",
		severity: "WARN",
		exts: [".xml"],
		message: "Data eval executes a dangerous expression.",
		hint: "Avoid __import__/os/subprocess inside eval= data.",
		match: (l) => /eval\s*=\s*["'][^"']*(__import__|os\.|subprocess|eval\(|exec\()/.test(l),
	},
	{
		id: "debug-leftover",
		severity: "INFO",
		exts: [".py"],
		message: "Debug instrumentation left in the source.",
		hint: "Remove pdb/breakpoint and stray prints before delivery.",
		match: (l) => /\b(import\s+pdb|breakpoint\s*\(|pdb\.set_trace\s*\()/.test(l),
	},
];

/** Recursively collect scannable files under `dir`, bounded. */
function collectFiles(dir: string, rel: string, out: Array<{ abs: string; rel: string }>): boolean {
	let truncated = false;
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return false;
	}
	for (const name of entries) {
		if (out.length >= MAX_FILES) return true;
		if (SKIP_DIRS.has(name)) continue;
		const abs = join(dir, name);
		const relPath = rel === "" ? name : `${rel}/${name}`;
		let st;
		try {
			st = statSync(abs);
		} catch {
			continue;
		}
		if (st.isDirectory()) {
			if (collectFiles(abs, relPath, out)) truncated = true;
			continue;
		}
		if (!st.isFile() || st.size > MAX_BYTES_PER_FILE) continue;
		if (SCANNED_EXT.has(extname(name).toLowerCase())) out.push({ abs, rel: relPath });
	}
	return truncated;
}

/**
 * Scan a module directory for security-risk patterns.
 * @param moduleDir - module root (absolute or relative to the process cwd).
 * @returns findings with file:line, plus coverage facts.
 */
export function scanModule(moduleDir: string): ScanResult {
	const findings: SecurityFinding[] = [];
	const files: Array<{ abs: string; rel: string }> = [];
	if (!existsSync(moduleDir)) {
		return { findings, scannedFiles: 0, truncated: false, clean: true };
	}
	const truncated = collectFiles(moduleDir, "", files);
	for (const file of files) {
		let text: string;
		try {
			text = readFileSync(file.abs, "utf8");
		} catch {
			continue;
		}
		const ext = extname(file.abs).toLowerCase();
		const lines = text.split(/\r?\n/);
		for (let i = 0; i < lines.length; i += 1) {
			const line = lines[i] ?? "";
			if (line.trim() === "") continue;
			for (const rule of RULES) {
				if (rule.exts.length > 0 && !rule.exts.includes(ext)) continue;
				if (!rule.match(line, ext)) continue;
				// A justification comment on the SAME or PREVIOUS line clears
				// the sudo warning (the comment may sit above the call).
				if (rule.id === "sudo-unjustified") {
					const prev = i > 0 ? (lines[i - 1] ?? "") : "";
					if (/(#.*(justif|reason|bypass|acl|sudo))/.test(prev)) continue;
				}
				findings.push({
					severity: rule.severity,
					rule: rule.id,
					file: file.rel,
					line: i + 1,
					message: rule.message,
					hint: rule.hint,
				});
			}
		}
	}
	const order: Record<Severity, number> = { ERROR: 0, WARN: 1, INFO: 2 };
	findings.sort((a, b) => order[a.severity] - order[b.severity] || a.file.localeCompare(b.file) || a.line - b.line);
	return {
		findings,
		scannedFiles: files.length,
		truncated,
		clean: findings.every((f) => f.severity !== "ERROR"),
	};
}
