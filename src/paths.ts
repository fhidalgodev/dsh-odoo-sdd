/**
 * Path resolution shared by the tools that take a module directory.
 *
 * The three tools that accept `module_dir` used to disagree: one resolved a
 * relative path against the project root using a POSIX-only
 * `startsWith("/")` test (so a Windows `C:\...` was concatenated under the
 * root), while the other two passed the string through and let the filesystem
 * resolve it against the PROCESS cwd. This module gives them one rule.
 *
 * @module dsh-odoo-sdd/paths
 */
import { isAbsolute, resolve } from "node:path";

/**
 * Resolve a `module_dir` argument to an absolute path.
 *
 * An absolute path — including a Windows drive or UNC path, which
 * `isAbsolute` recognises — is used as given. A relative path is resolved
 * against the project root, never against the process cwd.
 * @param raw - the argument as the model supplied it.
 * @param projectRoot - the resolved project root for this invocation.
 * @returns an absolute, normalized module directory.
 */
export function resolveModuleDir(raw: string, projectRoot: string): string {
	const value = (raw ?? "").trim();
	if (value === "") return resolve(projectRoot);
	return isAbsolute(value) ? resolve(value) : resolve(projectRoot, value);
}
