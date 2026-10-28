/**
 * Localized approval reasons.
 *
 * The host's native approval seam renders `reason` verbatim (audited, English)
 * and, when supplied, resolves `displayReason` against the USER'S interface
 * locale (`dsh-user-approval` ApprovalRequestEvent.displayReason, resolved by
 * the client's `locale.resolveText`). Every question the plugin asks a human
 * therefore ships as a small `{en, es, zh}` record: English stays the audit
 * text, `es`/`zh` are presentation only. A host that ignores `displayReason`
 * degrades to the English reason with no behavior change.
 */

/** One question in every language the plugin presents. */
export interface LocalizedReason {
	/** Audit text and fallback: always present, always English. */
	en: string;
	/** Spanish presentation text (Franyer's own chat language). */
	es?: string;
	/** Simplified Chinese presentation text. */
	zh?: string;
}

/** A reason either way: legacy plain strings stay valid at every seam. */
export type ApprovalReason = string | LocalizedReason;

/** The host's `displayReason` shape: `en` required, other locales optional. */
export type DisplayReason = { en: string } & Record<string, string>;

/** Narrow a reason to the host's display shape, or undefined for plain text. */
export function toDisplayReason(reason: ApprovalReason): DisplayReason | undefined {
	if (typeof reason === "string") return undefined;
	const display: DisplayReason = { en: reason.en };
	if (reason.es !== undefined) display.es = reason.es;
	if (reason.zh !== undefined) display.zh = reason.zh;
	return display;
}

/* ============================================================================
 * Factories — one per approval the plugin asks. The English text is byte-for-
 * byte the message each call site asked before localization, so the audit log
 * and the fail-closed semantics are unchanged.
 * ========================================================================== */

/** Phase gate (sdd_phase advance): leave PHASE for NEXT in SPEC. */
export function gatePhaseReason(input: {
	phase: string;
	next: string;
	spec: string;
	note?: string;
	/** Gate documents the preview stamp covered (display paths). */
	docPaths?: readonly string[];
}): LocalizedReason {
	const suffix = input.note !== undefined && input.note.trim() !== ""
		? ` — ${input.note.trim().slice(0, 300)}`
		: "";
	const docBlock = (label: string): string =>
		input.docPaths !== undefined && input.docPaths.length > 0
			? `\n${label} ${input.docPaths.join(", ")}`
			: "";
	return {
		en: `Approve the phase gate: leave ${input.phase} for ${input.next} in spec ${input.spec}${suffix}.` +
			docBlock("Documents:"),
		es: `Aprueba el gate de fase: salir de ${input.phase} hacia ${input.next} en la spec ${input.spec}${suffix}.` +
			docBlock("Documentos:"),
		zh: `批准阶段门禁：spec ${input.spec} 从 ${input.phase} 进入 ${input.next}${suffix}.` +
			docBlock("文档:"),
	};
}

/** odoo_setup authorize: connection grant for one exact target. */
export function authorizeConnectionReason(input: {
	url: string;
	db: string;
	username: string;
	instance?: string;
}): LocalizedReason {
	const inst = input.instance === undefined ? "" : ` [instance=${input.instance}]`;
	return {
		en: `Authorize Odoo connection to ${input.url} (db=${input.db}, user=${input.username})${inst}? ` +
			"The grant covers this exact target and expires; any change to url/db/user requires a new one.",
		es: `¿Autorizar la conexión Odoo a ${input.url} (db=${input.db}, user=${input.username})${inst}? ` +
			"El permiso cubre exactamente este destino y expira; cualquier cambio de url/db/user exige uno nuevo.",
		zh: `是否授权连接 Odoo ${input.url}（db=${input.db}，user=${input.username}）${inst}？` +
			"授权仅覆盖此目标且会过期；url/db/user 任一变更都需要重新授权。",
	};
}

/** odoo_setup purge: delete the plugin's own state. */
export function purgeReason(dir: string): LocalizedReason {
	return {
		en: `Purge the plugin's own state under ${dir} ` +
			"(grants, session cookie, active run, audit log, configuration, setup marker, checkpoints)? " +
			"Your .env, stop.md and specs/ are preserved.",
		es: `¿Purgar el estado propio del plugin bajo ${dir} ` +
			"(grants, cookie de sesión, ejecución activa, audit log, configuración, marcador de setup, checkpoints)? " +
			"Tu .env, stop.md y specs/ se conservan.",
		zh: `是否清除插件在 ${dir} 下的自身状态` +
			"（授权、会话 cookie、活动运行、审计日志、配置、setup 标记、检查点）？" +
			"你的 .env、stop.md 和 specs/ 会保留。",
	};
}

/** odoo_setup autonomy: who answers the later gates. */
export function autonomyReason(decision: string): LocalizedReason {
	return {
		en: `Switch the delegation mode to ${decision.toUpperCase()}? This decides who answers every later phase gate.`,
		es: `¿Cambiar el modo de delegación a ${decision.toUpperCase()}? Esto decide quién responde cada gate de fase posterior.`,
		zh: `是否将委派模式切换为 ${decision.toUpperCase()}？这决定由谁回答之后的每个阶段门禁。`,
	};
}

/** sdd_phase waive: one session may change the project without a spec. */
export function waiveReason(input: { reason: string; sessionId: string }): LocalizedReason {
	return {
		en: `Allow THIS session to change the project without a spec.\n` +
			`Reason given by the developer: ${input.reason}\n` +
			`Scope: this chat only (session ${input.sessionId}); the next session starts under the policy again. ` +
			"Every change made under it still has to be recorded as a KB decision.",
		es: `Permitir que ESTA sesión cambie el proyecto sin una spec.\n` +
			`Motivo dado por el developer: ${input.reason}\n` +
			`Alcance: solo este chat (sesión ${input.sessionId}); la siguiente sesión vuelve a la política normal. ` +
			"Cada cambio hecho bajo la exención seguirá exigido como decisión en la KB.",
		zh: `允许本会话在没有 spec 的情况下修改项目。\n` +
			`开发者给出的理由：${input.reason}\n` +
			`范围：仅限本会话（session ${input.sessionId}）；下一个会话重新受策略约束。` +
			"豁免期间所做的每项更改仍须记录为 KB 决策。",
	};
}

/** odoo_config mode=set: policy guards / allowlist / repositories. */
export function configSetReason(): LocalizedReason {
	return {
		en: "Apply plugin configuration changes (allowlist / policy guards / repositories)? " +
			"This alters which RPC mutations are permitted and which safety guards stay armed.",
		es: "¿Aplicar los cambios de configuración del plugin (allowlist / guardas de política / repositorios)? " +
			"Esto altera qué mutaciones RPC se permiten y qué guardas de seguridad quedan armadas.",
		zh: "是否应用插件配置更改（白名单 / 策略防护 / 仓库）？这会改变允许哪些 RPC 变更以及哪些安全防护保持启用。",
	};
}

/** odoo_functional approve: one batch, bound by hashes. */
export function functionalBatchReason(input: {
	batchId: string;
	scope: string;
	specId: string;
	operations: number;
	target: string;
	environment: string;
	highRisk: boolean;
	backupReference: string;
}): LocalizedReason {
	const risk = input.highRisk ? " — HIGH RISK" : "";
	const backup = input.backupReference === "" ? "" : `, backup: ${input.backupReference}`;
	return {
		en: `Approve batch ${input.batchId} (${input.scope}) for spec ${input.specId}: ${input.operations} operation(s) ` +
			`against ${input.target} in environment ${input.environment}${risk}${backup}?`,
		es: `¿Aprobar el batch ${input.batchId} (${input.scope}) para la spec ${input.specId}: ${input.operations} operación(es) ` +
			`contra ${input.target} en el entorno ${input.environment}${risk}${backup}?`,
		zh: `是否批准 batch ${input.batchId}（${input.scope}，spec ${input.specId}）：对 ${input.target} 在环境 ${input.environment} ` +
			`执行 ${input.operations} 个操作${risk}${backup}？`,
	};
}

/** odoo_import use=prepare: upload one authorised file to the temp importer. */
export function importPrepareReason(input: { specId: string; batchId: string; file: string }): LocalizedReason {
	return {
		en: `Prepare a file import for spec ${input.specId} (batch ${input.batchId}): upload ${input.file} to the ` +
			"temporary importer of the instance? This writes a temporary record and nothing else.",
		es: `¿Preparar una importación de archivo para la spec ${input.specId} (batch ${input.batchId}): subir ${input.file} al ` +
			"importador temporal de la instancia? Esto solo escribe un registro temporal y nada más.",
		zh: `是否为 spec ${input.specId}（batch ${input.batchId}）准备文件导入：将 ${input.file} 上传到实例的临时导入器？` +
			"这只写入一条临时记录，不进行其他操作。",
	};
}
