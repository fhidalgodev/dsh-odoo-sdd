/* dsh-odoo-sdd — browser half (portable, autocargable).
 *
 * Loaded by the DSH web ModuleLoader from a profile's installed plugin
 * (the `./client` export). Canonical dshmarket-shaped client:
 *   function apply(ctx) with ctx.effect / ctx.locale / ctx.slots.inject /
 *   ctx.configForms.get(NS) / ctx.configForms.whileServed([NS], register) /
 *   ctx.uiWorkspace.listDirectory (for the local-path folder browser).
 *
 * Contributes the "Odoo SDD" settings section (sidebar), EDITABLE through the
 * config form of our namespace (getSnapshot/subscribe to read, set/unset to
 * write) so changes persist to the Host.
 *
 * WHY `configForms` AND NOT `settingsScope`: the host 0.2.0-rc.2 removed the
 * `settingsScope` service, and the section used to be registered INSIDE the
 * callback of `ctx.inject(["settingsScope"], …)`. An inject of a service that
 * does not exist never runs its callback, so the section silently vanished from
 * the sidebar — no error, no panel. `exports.inject` below is what makes
 * `ctx.configForms` resolvable, and its absence is now reported out loud.
 *
 * UI/UX: theme-aware (host --dsw-alias-* tokens, light + dark), accessible
 * (labelled fields, visible focus, aria-live status, modal focus trap), smooth
 * 150-200ms transitions, prefers-reduced-motion respected, no emoji icons.
 */
window.__ModuleLoader__.load({ id: "dsh-odoo-sdd", factory: (require) => {

	var module = { exports: {} };
	var exports = module.exports;

	var react = require("react");
	var h = react.createElement;

	var NS = "odoo-sdd";

var zh = {
	"nav": "Odoo SDD",
	"editable": "可编辑",
	"readonly": "只读",
	"readonlyHint": "此宿主不提供配置表单；请在会话中通过 odoo_config 修改设置。",
	"delegation": "委派",
	"delegationHint": "由谁批准流水线的各个阶段。",
	"supervised": "受监督",
	"autonomous": "自主",
	"license": "许可",
	"licenseHint": "无论哪种情况，都会始终搜索 OCA/社区版。",
	"adoptHint": "新会话把项目最近的规范当作提示采用",
	"adoptHintHint": "选择「是」（默认）时，一个还没有自己指针的会话会从项目"
		+ "上次停下的地方继续，只要提示足够新且规范仍然存在。选择「否」时，每个会话在声明之前都没有"
		+ "规范：这样两个会话就永远不能拿对方的规范来授权改动。",
	"licensePerSpec": "Odoo 的版本不是插件设置：它在 CLARIFY 中按规范逐个回答"
		+ "（operation=clarify licensed=community|enterprise），因为同一个工作区可以同时容纳 EE 和 CE "
		+ "项目。不存在工作区级别的版本选择。",
	"community": "社区版",
	"enterprise": "企业版",
	"allowlist": "变更白名单",
	"allowlistHint": "odoo_execute 可以 create/write/unlink 的模型。留空 = 只读。",
	"methods": "业务动作",
	"methodsHint": "功能批次可以调用的 model.method 对：任意模型的任何动作（Odoo 的惯例通常是 action_*、button_*、do_*）。每一对都需要前置条件和后置条件。留空 = 无。",
	"noMethods": "不允许任何业务动作",
	"repoCommunity": "Odoo 社区版仓库",
	"repoEnterprise": "Odoo 企业版仓库",
	"repoHint": "选择 git URL 或本地操作系统路径。",
	"useUrl": "URL",
	"usePath": "本地路径",
	"browse": "浏览…",
	"pipeline": "流水线",
	"pipelineHint": "SDD 实时状态：在会话中使用 sdd_phase status 工具。",
	"policy": "策略",
	"specs": "规范",
	"specsHint": "项目来自本会话中打开的文件夹，因此不在这里配置。请选择规范文档的存放位置。",
	"specsMode": "位置",
	"specsModeProject": "项目内",
	"specsModeCentral": "中央文件夹",
	"specsRoot": "中央规范文件夹",
	"specsSubdir": "项目内的子文件夹",
	"specsProjectResolved": "每个项目把它的规范保存在 <project>/<subfolder>/<spec>。",
	"specsCentralResolved": "每个项目都把规范保存在 <central folder>/<project>/<spec> 下，各自位于自己的子文件夹中，并由一个 .dsh-project-root 文件标识。",
	"manuals": "手册",
	"manualsHint": "odoo_manual 把叙述式手册存放在哪里，以及它产出什么。",
	"manualsMode": "手册位置",
	"manualsSpecs": "与规范同目录",
	"manualsDocs": "文档树",
	"manualsModule": "模块片段",
	"manualsModeHint_specs": "每份手册位于 <specs>/manuals/<manual>，与记录该变更的规范放在一起。这是默认选项，也覆盖没有规范的独立工作：它绝不会因为缺少规范而被阻塞。",
	"manualsModeHint_docs": "每份手册位于项目文档树中的 <project>/<folder>/<manual>（默认为 docs/manuals）。canon 仍然从实例读取；改变的只是文件落地位置。",
	"manualsModeHint_module": "每份手册都是 <module>/readme/manual/<manual> 下的一个 OCA 片段，可与模块的 README 一起编译。每次调用都必须指定 module_dir。",
	"manualsDir": "手册文件夹",
	"videos": "视频",
	"videosHint": "odoo_video 为脚本配音并把视频组装成编号系列。请选择配音、存放文件夹和收尾选项。",
	"voice": "配音音色",
	"voiceNone": "请选择用于视频配音的音色",
	"voicePrivacy": "云端音色会把配音文本发送给 Microsoft —— 选择它即视为你的明确决定。",
	"voiceCloud": "云端",
	"voiceOffline": "离线",
	"voiceRecommended": "推荐",
	"voiceStyle_viral": "快节奏",
	"voiceStyle_calm": "沉稳",
	"voiceStyle_offline": "离线",
	"genderMale": "男声",
	"genderFemale": "女声",
	"voiceLabel_viral-male": "快节奏 — 男声",
	"voiceLabel_viral-female": "快节奏 — 女声",
	"voiceLabel_calm-male": "沉稳 — 男声",
	"voiceLabel_calm-female": "沉稳 — 女声",
	"voiceLabel_offline-piper": "离线 — Piper",
	"voiceLabel_custom": "自定义命令",
	"voiceNote_viral": "快节奏的神经网络音色，适合简短有力的旁白。",
	"voiceNote_calm": "平稳的纪录片节奏，适合较长的操作演示。",
	"voiceNote_offline-piper": "本地引擎（更机械）：文本不会离开本机。需要把 ttsVoice 设为一个 .onnx 模型文件。",
	"voiceNote_custom": "使用你自己的 ttsCommand/ttsVoice，完全按配置执行。",
	"voiceListen": "试听",
	"voiceSampleNote": "选择云端音色会播放插件自带的示例：试听不会向 Microsoft 发送任何内容。",
	"ttsCommand": "TTS 命令",
	"ttsCommandHint": "不带 shell 的 argv；占位符 {text} {textFile} {voice} {out}。",
	"ttsVoice": "音色",
	"ttsVoiceHint": "引擎相关的音色字符串（例如 edge-tts 的 es-ES-AlvaroNeural，piper 的 .onnx 路径）。",
	"videoMusic": "背景音乐",
	"videoSfx": "音效",
	"videosDir": "视频文件夹",
	"policyHint": "插件的 fail-closed 守卫：在守卫条件满足之前，它会阻止任何变更（实例变更与项目文件编辑）。",
	"docPolicy": "模块文档",
	"docRequired": "必需",
	"docOptional": "可选",
	"docOff": "关闭",
	"docLanguage": "文档语言",
	"docLanguageHint": "生成的模块文档所用的语言，而不是本界面的语言（界面语言跟随「设置 → 通用」）。留空 = 默认英文，除非 AGENTS.md 或项目的其他文件另有规定。",
	"yes": "是",
	"no": "否",
	"checkpointRequired": "变更前要求创建检查点",
	"specRequired": "每次变更都要求规范",
	"specScope": "在何处询问",
	"specScopeHint": "「仅 Odoo 工作」只在显示出 Odoo 工作的文件夹中询问（保存了状态的 .sdd、__manifest__.py，或者已经在那里用过的某个 Odoo 工具）。「所有位置」则在任何文件夹中都会询问。",
	"scopeOdoo": "仅 Odoo 工作",
	"scopeEverywhere": "所有位置",
	"securityReview": "DONE 前要求安全审查",
	"securityInterview": "要求安全访谈（用户组/ACL）",
	"auditAll": "审计每一次工具调用",
	"maxCheckpoints": "保留的检查点数量",
	"save": "保存",
	"saving": "保存中…",
	"saved": "更改已保存",
	"discard": "丢弃",
	"error": "无法保存",
	"noModels": "没有允许的模型（只读）",
	"pickTitle": "选择文件夹",
	"pickUp": "上一级",
	"pickHere": "使用此文件夹",
	"pickCancel": "取消",
	"pickLoading": "加载中…",
	"pickEmpty": "没有子文件夹",
	"pickPath": "路径",
	"pickGo": "转到",
	"pickClose": "关闭",
	"pickError": "无法列出该文件夹",
	"pickUnavailable": "宿主文件夹浏览器不可用",
};
	var en = {
		"nav": "Odoo SDD",
		"editable": "Editable",
		"readonly": "Read only",
		"readonlyHint": "This host exposes no configuration forms; edit the settings from the conversation with odoo_config.",
		"delegation": "Delegation",
		"delegationHint": "Who approves the pipeline phases.",
		"supervised": "Supervised",
		"autonomous": "Autonomous",
		"license": "Licensing",
		"licenseHint": "OCA/Community is always searched, in both cases.",
		"adoptHint": "A new session adopts the project's last spec as a hint",
		"adoptHintHint": "With Yes (default), a session that has no pointer of its own continues where the project "
			+ "left off, as long as the hint is fresh and the spec still exists. With No, every session starts with "
			+ "no spec until it declares one: two sessions then can never authorize changes against each other's spec.",
		"licensePerSpec": "The Odoo edition is not a plugin setting: it is answered per spec in CLARIFY "
			+ "(operation=clarify licensed=community|enterprise), because one workspace can hold EE and CE "
			+ "projects at the same time. There is no workspace-wide edition.",
		"community": "Community",
		"enterprise": "Enterprise",
		"allowlist": "Mutation allowlist",
		"allowlistHint": "Models odoo_execute may create/write/unlink. Empty = read-only.",
		"methods": "Business actions",
		"methodsHint": "model.method pairs a functional batch may call: any action of any model (Odoo convention is usually action_*, button_*, do_*). Each pair needs a precondition and a postcondition. Empty = none.",
		"noMethods": "No business action allowed",
		"repoCommunity": "Odoo Community repository",
		"repoEnterprise": "Odoo Enterprise repository",
		"repoHint": "Pick a git URL or a local operating-system path.",
		"useUrl": "URL",
		"usePath": "Local path",
		"browse": "Browse…",
		"pipeline": "Pipeline",
		"pipelineHint": "Live SDD state: use the sdd_phase status tool in the session.",
		"policy": "Policy",
		"specs": "Specs",
		"specsHint": "The project comes from the folder open in this session, so it is not configured here. Choose where the spec documents are stored.",
		"specsMode": "Location",
		"specsModeProject": "Inside the project",
		"specsModeCentral": "Central folder",
		"specsRoot": "Central specs folder",
		"specsSubdir": "Subfolder inside the project",
		"specsProjectResolved": "Each project keeps its specs in <project>/<subfolder>/<spec>.",
		"specsCentralResolved": "Every project keeps its specs under <central folder>/<project>/<spec>, each in its own subfolder identified by a .dsh-project-root file.",
		"manuals": "Manuals",
		"manualsHint": "Where odoo_manual keeps the narrated manuals and what it produces.",
		"manualsMode": "Manuals location",
		"manualsSpecs": "Next to the spec",
		"manualsDocs": "Documentation tree",
		"manualsModule": "Module fragments",
		"manualsModeHint_specs": "Each manual lives at <specs>/manuals/<manual>, next to the spec documenting the change. This is the default and also covers standalone work without a spec: it never blocks on a missing one.",
		"manualsModeHint_docs": "Each manual lives at <project>/<folder>/<manual> inside the project's documentation tree (default docs/manuals). The canon is still read from the instance; only where files land changes.",
		"manualsModeHint_module": "Each manual is an OCA fragment at <module>/readme/manual/<manual>, ready to compile with the module's README. Each call must name a module_dir.",
		"manualsDir": "Manuals folder",
		"videos": "Videos",
		"videosHint": "odoo_video narrates the storyboard and assembles a numbered series. Pick the voice, the folder and the finishing touches.",
		"voice": "Narration voice",
		"voiceNone": "Choose a voice to narrate the videos",
		"voicePrivacy": "Cloud voices send the narration text to Microsoft — picking one is your explicit decision.",
		"voiceCloud": "Cloud",
		"voiceOffline": "Offline",
		"voiceRecommended": "Recommended",
		"voiceStyle_viral": "Viral",
		"voiceStyle_calm": "Calm",
		"voiceStyle_offline": "Offline",
		"genderMale": "Male",
		"genderFemale": "Female",
		"voiceLabel_viral-male": "Viral — male",
		"voiceLabel_viral-female": "Viral — female",
		"voiceLabel_calm-male": "Calm — male",
		"voiceLabel_calm-female": "Calm — female",
		"voiceLabel_offline-piper": "Offline — Piper",
		"voiceLabel_custom": "Custom command",
		"voiceNote_viral": "Fast-paced neural voice for short, punchy narration.",
		"voiceNote_calm": "Even, documentary pace for long walkthroughs.",
		"voiceNote_offline-piper": "Local engine (more robotic): the text never leaves the machine. Needs ttsVoice set to a .onnx model file.",
		"voiceNote_custom": "Your own ttsCommand/ttsVoice, exactly as configured.",
		"voiceListen": "Listen",
		"voiceSampleNote": "Picking a cloud voice plays a sample that ships with the plugin: listening sends nothing to Microsoft.",
		"ttsCommand": "TTS command",
		"ttsCommandHint": "argv without a shell; placeholders {text} {textFile} {voice} {out}.",
		"ttsVoice": "Voice",
		"ttsVoiceHint": "Engine-specific voice string (e.g. es-ES-AlvaroNeural for edge-tts, a .onnx path for piper).",
		"videoMusic": "Music bed",
		"videoSfx": "Sound effects",
		"videosDir": "Videos folder",
		"policyHint": "Fail-closed plugin guards: the guard blocks every change (instance mutations and project file edits) until they are satisfied.",
		"docPolicy": "Module documentation",
		"docRequired": "Required",
		"docOptional": "Optional",
		"docOff": "Off",
		"docLanguage": "Documentation language",
		"docLanguageHint": "Language of the generated module documentation, not of this interface (that one follows Settings → General). Empty = English by default, unless AGENTS.md or another project file says otherwise.",
		"yes": "Yes",
		"no": "No",
		"checkpointRequired": "Require a checkpoint before mutating",
		"specRequired": "Require a spec for every change",
		"specScope": "Where it is asked",
		"specScopeHint": "\"Odoo work only\" asks the question only in folders that show Odoo work (a .sdd holding state, a __manifest__.py, or an Odoo tool already used there). \"Everywhere\" asks it in any folder.",
		"scopeOdoo": "Odoo work only",
		"scopeEverywhere": "Everywhere",
		"securityReview": "Require the security review before DONE",
		"securityInterview": "Require the security interview (groups/ACL)",
		"auditAll": "Audit every tool call",
		"maxCheckpoints": "Checkpoints to retain",
		"save": "Save",
		"saving": "Saving…",
		"saved": "Changes saved",
		"discard": "Discard",
		"error": "Could not save",
		"noModels": "No models allowed (read-only)",
		"pickTitle": "Select folder",
		"pickUp": "Up",
		"pickHere": "Use this folder",
		"pickCancel": "Cancel",
		"pickLoading": "Loading…",
		"pickEmpty": "No subfolders",
		"pickPath": "Path",
		"pickGo": "Go",
		"pickClose": "Close",
		"pickError": "Could not list the folder",
		"pickUnavailable": "The host folder browser is unavailable"
	};
	var es = {
		"nav": "Odoo SDD",
		"editable": "Editable",
		"readonly": "Solo lectura",
		"readonlyHint": "Este host no ofrece formularios de configuración; cambia los ajustes desde la conversación con odoo_config.",
		"delegation": "Delegación",
		"delegationHint": "Quién aprueba las fases del pipeline.",
		"supervised": "Supervisado",
		"autonomous": "Autónomo",
		"license": "Licencia",
		"licenseHint": "OCA/Community se busca siempre, en ambos casos.",
		"adoptHint": "Una sesión nueva adopta la última spec del proyecto como pista",
		"adoptHintHint": "Con Sí (por defecto), una sesión que aún no tiene puntero propio continúa donde el proyecto "
			+ "se quedó, siempre que la pista sea reciente y la spec siga existiendo. Con No, cada sesión empieza sin "
			+ "spec hasta que declara una: así dos sesiones nunca pueden autorizar cambios con la spec de la otra.",
		"licensePerSpec": "La edición de Odoo no es un ajuste del plugin: se responde por spec en CLARIFY "
			+ "(operation=clarify licensed=community|enterprise), porque un mismo espacio de trabajo puede tener proyectos "
			+ "EE y CE a la vez. No existe una edición para todo el espacio de trabajo.",
		"community": "Community",
		"enterprise": "Enterprise",
		"allowlist": "Modelos modificables",
		"allowlistHint": "Modelos en los que odoo_execute puede hacer create/write/unlink. Vacío = solo lectura.",
		"methods": "Acciones de negocio",
		"methodsHint": "Pares model.method que un lote funcional puede llamar: cualquier acción de cualquier modelo (en Odoo suelen ser action_*, button_*, do_*). Cada par necesita una precondición y una postcondición. Vacío = ninguna.",
		"noMethods": "No se permite ninguna acción de negocio",
		"repoCommunity": "Repositorio de Odoo Community",
		"repoEnterprise": "Repositorio de Odoo Enterprise",
		"repoHint": "Elige una URL de git o una ruta local del sistema operativo.",
		"useUrl": "URL",
		"usePath": "Ruta local",
		"browse": "Examinar…",
		"pipeline": "Pipeline",
		"pipelineHint": "Estado SDD en vivo: usa la herramienta sdd_phase status en la sesión.",
		"policy": "Política",
		"specs": "Specs",
		"specsHint": "El proyecto es la carpeta abierta en esta sesión, por eso no se configura aquí. Elige dónde se guardan los documentos de spec.",
		"specsMode": "Ubicación",
		"specsModeProject": "Dentro del proyecto",
		"specsModeCentral": "Carpeta central",
		"specsRoot": "Carpeta central de specs",
		"specsSubdir": "Subcarpeta dentro del proyecto",
		"specsProjectResolved": "Cada proyecto guarda sus specs en <project>/<subfolder>/<spec>.",
		"specsCentralResolved": "Cada proyecto guarda sus specs en <central folder>/<project>/<spec>, cada uno en su propia subcarpeta identificada por un archivo .dsh-project-root.",
		"manuals": "Manuales",
		"manualsHint": "Dónde guarda odoo_manual los manuales narrados y qué produce.",
		"manualsMode": "Ubicación de los manuales",
		"manualsSpecs": "Junto a la spec",
		"manualsDocs": "Árbol de documentación",
		"manualsModule": "Fragmentos del módulo",
		"manualsModeHint_specs": "Cada manual vive en <specs>/manuals/<manual>, junto a la spec que documenta el cambio. Es la opción por defecto y también cubre el trabajo independiente sin spec: nunca se bloquea porque falte una.",
		"manualsModeHint_docs": "Cada manual vive en <project>/<folder>/<manual> dentro del árbol de documentación del proyecto (por defecto docs/manuals). El canon se sigue leyendo de la instancia; solo cambia dónde se escriben los archivos.",
		"manualsModeHint_module": "Cada manual es un fragmento OCA en <module>/readme/manual/<manual>, listo para compilarse con el README del módulo. Cada llamada debe indicar un module_dir.",
		"manualsDir": "Carpeta de manuales",
		"videos": "Vídeos",
		"videosHint": "odoo_video narra el storyboard y monta una serie numerada. Elige la voz, la carpeta y los acabados.",
		"voice": "Voz de narración",
		"voiceNone": "Elige una voz para narrar los vídeos",
		"voicePrivacy": "Las voces en la nube envían el texto de la narración a Microsoft: elegir una es una decisión explícita tuya.",
		"voiceCloud": "Nube",
		"voiceOffline": "Sin conexión",
		"voiceRecommended": "Recomendada",
		"voiceStyle_viral": "Viral",
		"voiceStyle_calm": "Pausada",
		"voiceStyle_offline": "Local",
		"genderMale": "Masculina",
		"genderFemale": "Femenina",
		"voiceLabel_viral-male": "Viral — masculina",
		"voiceLabel_viral-female": "Viral — femenina",
		"voiceLabel_calm-male": "Pausada — masculina",
		"voiceLabel_calm-female": "Pausada — femenina",
		"voiceLabel_offline-piper": "Local — Piper",
		"voiceLabel_custom": "Comando propio",
		"voiceNote_viral": "Voz neuronal de ritmo rápido para narraciones cortas y directas.",
		"voiceNote_calm": "Ritmo uniforme, de documental, para recorridos largos.",
		"voiceNote_offline-piper": "Motor local (más robótico): el texto nunca sale de la máquina. Requiere que ttsVoice apunte a un modelo .onnx.",
		"voiceNote_custom": "Tu propio ttsCommand/ttsVoice, tal como esté configurado.",
		"voiceListen": "Escuchar",
		"voiceSampleNote": "Al elegir una voz en la nube suena una muestra que viene con el plugin: escucharla no envía nada a Microsoft.",
		"ttsCommand": "Comando TTS",
		"ttsCommandHint": "argv sin shell; marcadores {text} {textFile} {voice} {out}.",
		"ttsVoice": "Voz",
		"ttsVoiceHint": "Cadena de voz propia del motor (p. ej. es-ES-AlvaroNeural para edge-tts, una ruta .onnx para piper).",
		"videoMusic": "Música de fondo",
		"videoSfx": "Efectos de sonido",
		"videosDir": "Carpeta de vídeos",
		"policyHint": "Guardas fail-closed del plugin: bloquean cualquier cambio (mutaciones en la instancia y ediciones de archivos del proyecto) hasta que se cumplan.",
		"docPolicy": "Documentación del módulo",
		"docRequired": "Obligatoria",
		"docOptional": "Opcional",
		"docOff": "Desactivada",
		"docLanguage": "Idioma de la documentación",
		"docLanguageHint": "Idioma de la documentación generada del módulo, no de esta interfaz (que sigue Ajustes → General). Vacío = inglés por defecto, salvo que AGENTS.md u otro archivo del proyecto diga otra cosa.",
		"yes": "Sí",
		"no": "No",
		"checkpointRequired": "Exigir un checkpoint antes de modificar",
		"specRequired": "Exigir una spec para cada cambio",
		"specScope": "Dónde se pregunta",
		"specScopeHint": "\"Solo trabajo Odoo\" pregunta únicamente en carpetas con trabajo Odoo (un .sdd con estado, un __manifest__.py o una herramienta Odoo ya usada allí). \"En todas partes\" pregunta en cualquier carpeta.",
		"scopeOdoo": "Solo trabajo Odoo",
		"scopeEverywhere": "En todas partes",
		"securityReview": "Exigir la revisión de seguridad antes de DONE",
		"securityInterview": "Exigir la entrevista de seguridad (grupos/ACL)",
		"auditAll": "Auditar cada llamada a herramienta",
		"maxCheckpoints": "Checkpoints que se conservan",
		"save": "Guardar",
		"saving": "Guardando…",
		"saved": "Cambios guardados",
		"discard": "Descartar",
		"error": "No se pudo guardar",
		"noModels": "Ningún modelo permitido (solo lectura)",
		"pickTitle": "Seleccionar carpeta",
		"pickUp": "Subir",
		"pickHere": "Usar esta carpeta",
		"pickCancel": "Cancelar",
		"pickLoading": "Cargando…",
		"pickEmpty": "Sin subcarpetas",
		"pickPath": "Ruta",
		"pickGo": "Ir",
		"pickClose": "Cerrar",
		"pickError": "No se pudo listar la carpeta",
		"pickUnavailable": "El explorador de carpetas del host no está disponible"
	};

	/** Theme-aware stylesheet, injected once. Uses host tokens with fallbacks. */
	var CSS = [
		".odoo-sdd-root{display:flex;flex-direction:column;gap:10px;padding:4px 4px 24px;color:var(--dsw-alias-label-primary,#1f2328);font-size:13px;line-height:1.5}",
		".odoo-sdd-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:2px}",
		".odoo-sdd-h1{margin:0;font-size:15px;font-weight:600}",
		".odoo-sdd-badge{font-size:11px;font-weight:600;border-radius:6px;padding:2px 8px;white-space:nowrap}",
		".odoo-sdd-badge--on{color:var(--dsw-alias-state-success-primary,#16a34a);background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#16a34a) 12%,transparent)}",
		".odoo-sdd-badge--off{color:var(--dsw-alias-state-warn-primary,#b45309);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#b45309) 12%,transparent)}",
		".odoo-sdd-card{background:var(--dsw-alias-bg-layer-1,#fff);border:1px solid var(--dsw-alias-border-l2,#e5e7eb);border-radius:12px;padding:12px 14px;transition:border-color .18s cubic-bezier(.16,1,.3,1)}",
		".odoo-sdd-card:hover{border-color:var(--dsw-alias-border-l3,#d9dde3)}",
		".odoo-sdd-title{margin:0 0 2px;font-size:13px;font-weight:600}",
		".odoo-sdd-sub{margin:0 0 6px;font-size:12px;color:var(--dsw-alias-label-tertiary,#8b93a1)}",
		".odoo-sdd-field{display:flex;flex-direction:column;gap:5px;margin-top:8px}",
		".odoo-sdd-label{font-size:12px;font-weight:500;color:var(--dsw-alias-label-secondary,#6b7280)}",
		".odoo-sdd-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}",
		".odoo-sdd-input,.odoo-sdd-select{box-sizing:border-box;width:100%;padding:7px 10px;font:inherit;font-size:13px;color:var(--dsw-alias-label-primary,#1f2328);background:var(--dsw-alias-bg-layer-3,#fff);border:1px solid var(--dsw-alias-border-l2,#d1d5db);border-radius:8px;transition:border-color .15s,box-shadow .15s}",
		".odoo-sdd-input:hover:not(:disabled),.odoo-sdd-select:hover:not(:disabled){border-color:var(--dsw-alias-border-l3,#b8bec7)}",
		".odoo-sdd-input:focus-visible,.odoo-sdd-select:focus-visible{outline:none;border-color:var(--dsw-alias-brand-primary,#4f6ef7);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-brand-primary,#4f6ef7) 22%,transparent)}",
		".odoo-sdd-input:disabled,.odoo-sdd-select:disabled{opacity:.6;cursor:not-allowed}",
		".odoo-sdd-input--mono{font-family:var(--dsw-alias-font-mono,ui-monospace,Menlo,monospace);font-size:12px}",
		// A folder name, a language code or a small count does NOT need a
		// full-width box: `.odoo-sdd-input` is width:100% inside a column field,
		// so short values get an explicit, still-responsive cap.
		".odoo-sdd-input--short{width:min(100%,200px)}",
		".odoo-sdd-seg{display:inline-flex;gap:2px;padding:2px;border:1px solid var(--dsw-alias-border-l2,#e5e7eb);border-radius:8px;background:var(--dsw-alias-bg-layer-2,#f3f4f6)}",
		".odoo-sdd-seg-btn{font:inherit;font-size:12px;padding:5px 12px;min-height:30px;border:none;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary,#6b7280);cursor:pointer;transition:background .15s,color .15s}",
		".odoo-sdd-seg-btn:hover:not(:disabled):not(.is-on){color:var(--dsw-alias-label-primary,#1f2328)}",
		".odoo-sdd-seg-btn.is-on{background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#1f2328);font-weight:600}",
		".odoo-sdd-seg-btn:disabled{opacity:.55;cursor:not-allowed}",
		".odoo-sdd-seg-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4f6ef7);outline-offset:1px}",
		".odoo-sdd-chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}",
		".odoo-sdd-chip{font-family:var(--dsw-alias-font-mono,ui-monospace,monospace);font-size:11px;padding:1px 7px;border-radius:5px;background:var(--dsw-alias-bg-layer-2,#f3f4f6);color:var(--dsw-alias-label-secondary,#6b7280)}",
		".odoo-sdd-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:6px}",
		".odoo-sdd-btn{font:inherit;font-size:13px;padding:7px 16px;min-height:34px;border-radius:8px;border:1px solid transparent;cursor:pointer;transition:background .15s,border-color .15s,color .15s}",
		".odoo-sdd-btn--primary{background:var(--dsw-alias-label-primary,#1f2328);color:var(--dsw-alias-bg-layer-1,#fff);font-weight:600}",
		".odoo-sdd-btn--primary:hover:not(:disabled){opacity:.88}",
		".odoo-sdd-btn--primary:disabled{background:var(--dsw-alias-bg-layer-2,#f3f4f6);color:var(--dsw-alias-label-tertiary,#8b93a1);cursor:not-allowed}",
		".odoo-sdd-btn--ghost{background:transparent;border-color:var(--dsw-alias-border-l2,#d1d5db);color:var(--dsw-alias-label-secondary,#6b7280)}",
		".odoo-sdd-btn--ghost:hover:not(:disabled){border-color:var(--dsw-alias-border-l3,#b8bec7);color:var(--dsw-alias-label-primary,#1f2328)}",
		".odoo-sdd-btn--small{min-height:30px;padding:5px 10px;font-size:12px}",
		".odoo-sdd-btn:disabled{opacity:.55;cursor:not-allowed}",
		".odoo-sdd-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4f6ef7);outline-offset:2px}",
		".odoo-sdd-status{font-size:12px;min-height:16px}",
		".odoo-sdd-status--ok{color:var(--dsw-alias-state-success-primary,#16a34a)}",
		".odoo-sdd-status--err{color:var(--dsw-alias-state-error-primary,#dc2626)}",
		".odoo-sdd-banner{display:flex;flex-direction:column;gap:3px;padding:9px 12px;border-radius:8px;font-size:12px;color:var(--dsw-alias-state-warn-primary,#b45309);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#b45309) 8%,transparent);border:1px solid color-mix(in srgb,var(--dsw-alias-state-warn-primary,#b45309) 22%,transparent)}",
		".odoo-sdd-overlay{position:fixed;inset:0;z-index:10000;background:#00000080;display:flex;align-items:center;justify-content:center;padding:16px}",
		".odoo-sdd-modal{display:flex;flex-direction:column;gap:10px;width:min(560px,100%);max-height:80vh;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#1f2328);border:1px solid var(--dsw-alias-border-l2,#e5e7eb);border-radius:12px;padding:14px 16px}",
		".odoo-sdd-modal-head{display:flex;align-items:center;justify-content:space-between;gap:8px}",
		".odoo-sdd-crumbs{display:flex;flex-wrap:wrap;gap:4px;font-size:12px}",
		".odoo-sdd-crumb{background:transparent;border:none;padding:1px 4px;border-radius:4px;color:var(--dsw-alias-brand-primary,#4f6ef7);cursor:pointer;font:inherit;font-size:12px}",
		".odoo-sdd-crumb:hover{background:var(--dsw-alias-bg-layer-2,#f3f4f6)}",
		".odoo-sdd-crumb:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4f6ef7);outline-offset:1px}",
		".odoo-sdd-list{overflow:auto;border:1px solid var(--dsw-alias-border-l2,#e5e7eb);border-radius:8px;min-height:120px;max-height:46vh}",
		".odoo-sdd-item{display:flex;align-items:center;gap:8px;width:100%;text-align:left;background:transparent;border:none;border-bottom:1px solid var(--dsw-alias-border-l2,#f0f1f3);padding:8px 10px;font:inherit;font-size:13px;color:var(--dsw-alias-label-primary,#1f2328);cursor:pointer;transition:background .15s}",
		".odoo-sdd-item:hover{background:var(--dsw-alias-bg-layer-2,#f7f8fa)}",
		".odoo-sdd-item:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4f6ef7);outline-offset:-2px}",
		".odoo-sdd-empty{padding:14px;color:var(--dsw-alias-label-tertiary,#8b93a1);font-size:12px}",
		".odoo-sdd-hint{margin-top:6px;color:var(--dsw-alias-label-tertiary,#8b93a1);font-size:12px;line-height:1.45}",
		// Voice preset picker: a grid of selectable cards (the seg control is a
		// one-line choice; a preset carries a name, badges and a caveat).
		".odoo-sdd-voices{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:8px;margin-top:6px}",
		// The card is a container: picking and listening are two separate
		// buttons, because a button cannot hold another one.
		".odoo-sdd-voice{display:flex;flex-direction:column;gap:6px;padding:9px 10px;border:1px solid var(--dsw-alias-border-l2,#e5e7eb);border-radius:10px;background:var(--dsw-alias-bg-layer-2,#f7f8fa);color:var(--dsw-alias-label-primary,#1f2328);font-size:12px;transition:border-color .15s,background .15s}",
		".odoo-sdd-voice:hover{border-color:var(--dsw-alias-border-l3,#b8bec7)}",
		".odoo-sdd-voice.is-on{border-color:var(--dsw-alias-brand-primary,#4f6ef7);background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4f6ef7) 7%,var(--dsw-alias-bg-layer-1,#fff))}",
		".odoo-sdd-voice-pick{display:flex;flex-direction:column;gap:4px;width:100%;padding:0;text-align:left;background:transparent;border:none;border-radius:6px;color:inherit;font:inherit;font-size:12px;cursor:pointer}",
		".odoo-sdd-voice-pick:disabled{opacity:.55;cursor:not-allowed}",
		".odoo-sdd-voice-pick:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4f6ef7);outline-offset:3px}",
		".odoo-sdd-voice-play{align-self:flex-start;display:inline-flex;align-items:center;gap:5px;min-height:26px;padding:3px 9px;font:inherit;font-size:11px;font-weight:600;border:1px solid var(--dsw-alias-border-l2,#d1d5db);border-radius:6px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-secondary,#6b7280);cursor:pointer;transition:border-color .15s,color .15s}",
		".odoo-sdd-voice-play:hover{border-color:var(--dsw-alias-border-l3,#b8bec7);color:var(--dsw-alias-label-primary,#1f2328)}",
		".odoo-sdd-voice-play:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4f6ef7);outline-offset:1px}",
		".odoo-sdd-voice-play svg{width:10px;height:10px;fill:currentColor}",
		".odoo-sdd-voice-name{font-weight:600;font-size:13px;display:flex;align-items:center;gap:6px;flex-wrap:wrap}",
		".odoo-sdd-voice-meta{display:flex;gap:4px;flex-wrap:wrap}",
		".odoo-sdd-voice-tag{font-size:10px;font-weight:600;padding:1px 6px;border-radius:5px;background:var(--dsw-alias-bg-layer-3,#eceef1);color:var(--dsw-alias-label-secondary,#6b7280)}",
		".odoo-sdd-voice-tag--rec{color:var(--dsw-alias-brand-primary,#4f6ef7);background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4f6ef7) 12%,transparent)}",
		".odoo-sdd-voice-tag--off{color:var(--dsw-alias-state-success-primary,#16a34a);background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#16a34a) 12%,transparent)}",
		".odoo-sdd-voice-note{color:var(--dsw-alias-label-tertiary,#8b93a1);line-height:1.4}",
		"@media (prefers-reduced-motion:reduce){.odoo-sdd-card,.odoo-sdd-input,.odoo-sdd-btn,.odoo-sdd-seg-btn,.odoo-sdd-item,.odoo-sdd-voice,.odoo-sdd-voice-play{transition:none}}"
	].join("");

	function injectCss() {
		try {
			if (typeof document === "undefined" || document.getElementById("odoo-sdd-css")) return;
			var el = document.createElement("style");
			el.id = "odoo-sdd-css";
			el.textContent = CSS;
			document.head.appendChild(el);
		} catch (e) { /* styling is non-fatal */ }
	}

	/** Remove the stylesheet this plugin injected (dispose/HMR hygiene). */
	function removeCss() {
		try {
			if (typeof document === "undefined") return;
			var el = document.getElementById("odoo-sdd-css");
			if (el && el.parentNode) el.parentNode.removeChild(el);
		} catch (e) { /* styling is non-fatal */ }
	}

	/** Current, normalized snapshot of our namespace (defensive). */
	/**
	 * Read the config-form snapshot. The snapshot is NOT the section itself:
	 * it is { status, value, base, user, revision, writable, mode } — the
	 * section lives under `value`. Reading the snapshot as if it were the
	 * section yields undefined fields (and therefore composition defaults),
	 * which is why writes appeared "not to persist".
	 *
	 * `form` is the namespace controller from `ctx.configForms.get(NS)`. It
	 * exposes the same read/write face the previous `settingsScope.bind()`
	 * returned (getSnapshot/subscribe/set), which is why only the transport
	 * changed: `status: "unavailable"` still means "the Host does not serve this
	 * namespace", and the section renders read-only in that case.
	 */
	function scopeState(form) {
		var raw = {};
		try { raw = (form && typeof form.getSnapshot === "function") ? (form.getSnapshot() || {}) : {}; } catch (e) { raw = {}; }
		var value = (raw && typeof raw === "object" && raw.value && typeof raw.value === "object") ? raw.value : {};
		return {
			value: value,
			writable: !(raw && raw.writable === false),
			status: (raw && raw.status) || "ready"
		};
	}

	/**
	 * The voice presets offered by the picker. This MIRRORS the catalog in
	 * src/video-voices.ts — the client bundle cannot import the compiled lib
	 * (it loads standalone via the ModuleLoader), so the contract is kept here
	 * and pinned by tests/client.mjs. Only the data lives here: the name is
	 * `voiceLabel_<id>` and the caveat `voiceNote_<noteKey>` in the
	 * dictionaries, so both follow the host's interface language.
	 */
	var VOICE_PRESETS = [
		{ id: "viral-male", style: "viral", gender: "male", cloud: true, recommended: true, noteKey: "viral" },
		{ id: "viral-female", style: "viral", gender: "female", cloud: true, recommended: true, noteKey: "viral" },
		{ id: "calm-male", style: "calm", gender: "male", cloud: true, noteKey: "calm" },
		{ id: "calm-female", style: "calm", gender: "female", cloud: true, noteKey: "calm" },
		{ id: "offline-piper", style: "offline", cloud: false, noteKey: "offline-piper" },
		{ id: "custom", style: "offline", cloud: false, noteKey: "custom" }
	];
	var VOICE_IDS = VOICE_PRESETS.map(function (p) { return p.id; });

	/**
	 * Preview samples for the cloud presets, per panel language (es, en).
	 * Embedded as data: URIs because the browser half cannot reach the
	 * plugin's TTS engine and the host's asset route serves images only, so
	 * playing one sends nothing anywhere. Piper and custom have no sample:
	 * their voice is the developer's own model or command.
	 */
	/* voice-samples:begin — generated by scripts/voice-samples.mjs; do not edit by hand. */
	var VOICE_SAMPLES = {
		"viral-male": {
			es: { voice: "es-MX-JorgeNeural", src: "data:audio/mpeg;base64,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VVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVU=" },
			en: { voice: "en-US-AndrewNeural", src: "data:audio/mpeg;base64,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" }
		},
		"viral-female": {
			es: { voice: "es-MX-DaliaNeural", src: "data:audio/mpeg;base64,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qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkxBTUUzLjEwMKqqqqqqqqqqqqr/8zTE6w26ATAACgsxqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkxBTUUzLjEwMKqqqqqqqqqqqqr/8zTExAAAAAAAAAAAqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkxBTUUzLjEwMKqqqqqqqqqqqqr/8zTExAAAA0gAAAAAqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkxBTUUzLjEwMKqqqqqqqqqqqqr/8zTExAAAA0gAAAAAqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkxBTUUzLjEwMKqqqqqqqqqqqqr/8zTExAAAA0gAAAAAqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkxBTUUzLjEwMKqqqqqqqqqqqqr/8zTExAAAA0gAAAAAqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkxBTUUzLjEwMKqqqqqqqqqqqqr/8zTExAAAA0gAAAAAqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkxBTUUzLjEwMKqqqqqqqqqqqqr/8zTExAAAA0gAAAAAqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkxBTUUzLjEwMKqqqqqqqqqqqqr/8zTExAAAA0gAAAAAqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkxBTUUzLjEwMKqqqqqqqqqqqqr/8zTExAAAA0gAAAAAqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkxBTUUzLjEwMKqqqqqqqqqqqqr/8zTExAAAA0gAAAAAqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkxBTUUzLjEwMKqqqqqqqqqqqqr/8zTExAAAA0gAAAAAqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkxBTUUzLjEwMKqqqqqqqqqqqqr/8zTExAAAA0gAAAAAqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkxBTUUzLjEwMKqqqqqqqqqqqqr/8zTExAAAA0gAAAAAqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkxBTUUzLjEwMKqqqqqqqqqqqqr/8zTExAAAA0gAAAAAqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkxBTUUzLjEwMKqqqqqqqqqqqqr/8zTExAAAA0gAAAAAqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkxBTUUzLjEwMKqqqqqqqqqqqqr/8zTExAAAA0gAAAAAqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkxBTUUzLjEwMKqqqqqqqqqqqqr/8zTExAAAA0gAAAAAqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkxBTUUzLjEwMKqqqqqqqqqqqqr/8zTExAAAA0gAAAAAqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkxBTUUzLjEwMKqqqqqqqqqqqqr/8zTExAAAA0gAAAAAqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkxBTUUzLjEwMKqqqqqqqqqqqqr/8zTExAAAA0gAAAAAqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkxBTUUzLjEwMKqqqqqqqqqqqqr/8zTExAAAA0gAAAAAqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkxBTUUzLjEwMKqqqqqqqqqqqqr/8zTExAAAA0gAAAAAqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkxBTUUzLjEwMKqqqqqqqqqqqqr/8zTExAAAA0gAAAAAqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqr/8zTExAAAA0gAAAAAqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqr/8zTExAAAA0gAAAAAqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqr/8zTExAAAA0gAAAAAqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqo=" },
			en: { voice: "en-US-AvaNeural", src: "data:audio/mpeg;base64,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" }
		},
		"calm-male": {
			es: { voice: "es-ES-AlvaroNeural", src: "data:audio/mpeg;base64,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wFoUBDCuVuVHCl7MeoCR/AzM33/vGvGN+UrdS6GMbQKAlapfobzUNoYzcuVTAxKPuFcNEQV9QMr/8zTE6w5gFhQAeYYBC7Eq2aNFFLa8dn/mCsGBjeqIrUcpgp0flKVal/8v1L9FDrcqIe7aKqOzliIkEhMc6CxnzOpZW//9UGv/8zTE5QgoDkW+EEYA1UxBTUUzLjEwMFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVU5FUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTE/xOyNfwAelABVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTE6w5p/dQAEMTsVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTE7A7KRUAIMIqUVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExgCABAAAyAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVU=" },
			en: { voice: "en-US-GuyNeural", src: "data:audio/mpeg;base64,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qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkxBTUUzLjEwMKqqqqqqqqqqqqr/8zTExAAAA0gAAAAAqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkxBTUUzLjEwMKqqqqqqqqqqqqr/8zTExAAAA0gAAAAAqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkxBTUUzLjEwMKqqqqqqqqqqqqr/8zTExAAAA0gAAAAAqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkxBTUUzLjEwMKqqqqqqqqqqqqr/8zTExAAAA0gAAAAAqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkxBTUUzLjEwMKqqqqqqqqqqqqr/8zTExAAAA0gAAAAAqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkxBTUUzLjEwMKqqqqqqqqqqqqr/8zTExAAAA0gAAAAAqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkxBTUUzLjEwMKqqqqqqqqqqqqr/8zTExAAAA0gAAAAAqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkxBTUUzLjEwMKqqqqqqqqqqqqr/8zTExAAAA0gAAAAAqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkxBTUUzLjEwMKqqqqqqqqqqqqr/8zTExAAAA0gAAAAAqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkxBTUUzLjEwMKqqqqqqqqqqqqr/8zTExAAAA0gAAAAAqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkxBTUUzLjEwMKqqqqqqqqqqqqr/8zTExAAAA0gAAAAAqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkxBTUUzLjEwMKqqqqqqqqqqqqr/8zTExAAAA0gAAAAAqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkxBTUUzLjEwMKqqqqqqqqqqqqr/8zTExAAAA0gAAAAAqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkxBTUUzLjEwMKqqqqqqqqqqqqr/8zTExAAAA0gAAAAAqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkxBTUUzLjEwMKqqqqqqqqqqqqr/8zTExAAAA0gAAAAAqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkxBTUUzLjEwMKqqqqqqqqqqqqr/8zTExAAAA0gAAAAAqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkxBTUUzLjEwMKqqqqqqqqqqqqr/8zTExAAAA0gAAAAAqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkxBTUUzLjEwMKqqqqqqqqqqqqr/8zTExAAAA0gAAAAAqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkxBTUUzLjEwMKqqqqqqqqqqqqr/8zTExAAAA0gAAAAAqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkxBTUUzLjEwMKqqqqqqqqqqqqr/8zTExAAAA0gAAAAAqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkxBTUUzLjEwMKqqqqqqqqqqqqr/8zTExAAAA0gAAAAAqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqr/8zTExAAAA0gAAAAAqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqr/8zTExAAAA0gAAAAAqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqr/8zTExAAAA0gAAAAAqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqo=" }
		},
		"calm-female": {
			es: { voice: "es-ES-ElviraNeural", src: "data:audio/mpeg;base64,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VUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTEyAtxyfw4EMRpVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTE1QpxaVgoEYRdVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExQBABAAAMAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVU=" },
			en: { voice: "en-US-AriaNeural", src: "data:audio/mpeg;base64,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VVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVU=" }
		}
	};
	/* voice-samples:end */

	/** The single sample playing right now, so a new one stops the last. */
	var currentSample = null;

	/**
	 * Play the preview of a preset in the panel language, falling back to
	 * English. Returns false when the preset has no sample.
	 */
	function playSample(presetId, lang) {
		var byLang = VOICE_SAMPLES[presetId];
		if (!byLang || typeof Audio === "undefined") return false;
		var sample = byLang[lang] || byLang.en;
		if (!sample) return false;
		try {
			if (currentSample) currentSample.pause();
			currentSample = new Audio(sample.src);
			var played = currentSample.play();
			if (played && typeof played.catch === "function") played.catch(function () { /* autoplay refused: silent */ });
		} catch (e) { return false; }
		return true;
	}

	/** Stop the playing sample (dispose/HMR hygiene). */
	function stopSample() {
		try { if (currentSample) currentSample.pause(); } catch (e) { /* noop */ }
		currentSample = null;
	}

	function readSnap(form) {
		var s = scopeState(form).value;
		var asStr = function (v, fb) { return typeof v === "string" ? v : fb; };
		var asList = function (v) { return Array.isArray(v) ? v.filter(function (x) { return typeof x === "string"; }) : []; };
		var asBool = function (v, fb) { return typeof v === "boolean" ? v : fb; };
		return {
			autonomy: asStr(s.autonomy, "supervised"),
			executeAllowlist: asList(s.executeAllowlist),
			methodAllowlist: asList(s.methodAllowlist),
			projectRoot: asStr(s.projectRoot, ""),
			specsMode: s.specsMode === "central" ? "central" : "project",
			specsRoot: asStr(s.specsRoot, ""),
			specsDir: asStr(s.specsDir, "specs"),
			specPolicyScope: s.specPolicyScope === "everywhere" ? "everywhere" : "odoo",
			communityRepoUrl: asStr(s.communityRepoUrl, "https://github.com/odoo/odoo"),
			communityRepoPath: asStr(s.communityRepoPath, ""),
			enterpriseRepoUrl: asStr(s.enterpriseRepoUrl, "https://github.com/odoo/enterprise"),
			enterpriseRepoPath: asStr(s.enterpriseRepoPath, ""),
			requireCheckpointBeforeMutation: asBool(s.requireCheckpointBeforeMutation, true),
			requireSpecForChanges: asBool(s.requireSpecForChanges, true),
			adoptProjectPointerHint: asBool(s.adoptProjectPointerHint, true),
			securityReviewRequired: asBool(s.securityReviewRequired, true),
			securityInterviewRequired: asBool(s.securityInterviewRequired, true),
			auditAllTools: asBool(s.auditAllTools, true),
			maxCheckpoints: typeof s.maxCheckpoints === "number" ? s.maxCheckpoints : 5,
			documentationPolicy: (s.documentationPolicy === "optional" || s.documentationPolicy === "off") ? s.documentationPolicy : "required",
			documentationLanguage: asStr(s.documentationLanguage, ""),
			manualsMode: ["specs", "docs", "module"].indexOf(s.manualsMode) >= 0 ? s.manualsMode : "specs",
			manualsDir: asStr(s.manualsDir, "docs/manuals"),
			videosDir: asStr(s.videosDir, "docs/videos"),
			ttsPreset: VOICE_IDS.indexOf(s.ttsPreset) >= 0 ? s.ttsPreset : "",
			ttsCommand: asStr(s.ttsCommand, ""),
			ttsVoice: asStr(s.ttsVoice, ""),
			videoMusic: asBool(s.videoMusic, true),
			videoSfx: asBool(s.videoSfx, true)
		};
	}

	function toForm(snap) {
		return {
			autonomy: snap.autonomy,
			allowlist: snap.executeAllowlist.join(", "),
			methods: snap.methodAllowlist.join(", "),
			communityUse: snap.communityRepoPath ? "path" : "url",
			communityUrl: snap.communityRepoUrl,
			specsMode: snap.specsMode,
			specsRoot: snap.specsRoot,
			specsDir: snap.specsDir,
			specPolicyScope: snap.specPolicyScope,
			communityPath: snap.communityRepoPath,
			enterpriseUse: snap.enterpriseRepoPath ? "path" : "url",
			enterpriseUrl: snap.enterpriseRepoUrl,
			enterprisePath: snap.enterpriseRepoPath,
			requireCheckpointBeforeMutation: snap.requireCheckpointBeforeMutation,
			requireSpecForChanges: snap.requireSpecForChanges,
			adoptProjectPointerHint: snap.adoptProjectPointerHint,
			securityReviewRequired: snap.securityReviewRequired,
			securityInterviewRequired: snap.securityInterviewRequired,
			auditAllTools: snap.auditAllTools,
			maxCheckpoints: String(snap.maxCheckpoints),
			documentationPolicy: snap.documentationPolicy,
			documentationLanguage: snap.documentationLanguage,
			manualsMode: snap.manualsMode,
			manualsDir: snap.manualsDir,
			videosDir: snap.videosDir,
			ttsPreset: snap.ttsPreset,
			ttsCommand: snap.ttsCommand,
			ttsVoice: snap.ttsVoice,
			videoMusic: snap.videoMusic,
			videoSfx: snap.videoSfx
		};
	}

	var SectionCard = function (props) {
		return h("section", { className: "odoo-sdd-card" },
			h("h3", { className: "odoo-sdd-title" }, props.title),
			props.hint ? h("p", { className: "odoo-sdd-sub" }, props.hint) : null,
			props.children);
	};

	/** Modal folder browser backed by the host directory service. */
	var DirPicker = function (props) {
		var t = props.t;
		var listDirectory = props.listDirectory;
		var st = react.useState({ path: props.initialPath || "", listing: null, loading: true, error: null, draft: props.initialPath || "" });
		var s = st[0];
		var set = st[1];

		var load = function (path) {
			if (typeof listDirectory !== "function") { set(function (v) { return Object.assign({}, v, { loading: false, error: t("pickUnavailable") }); }); return; }
			set(function (v) { return Object.assign({}, v, { loading: true, error: null }); });
			Promise.resolve().then(function () { return listDirectory(path || undefined); }).then(function (listing) {
				set(function (v) { return Object.assign({}, v, { listing: listing, loading: false, path: (listing && listing.path) || path || "", draft: (listing && listing.path) || path || "", error: null }); });
			}).catch(function (e) {
				set(function (v) { return Object.assign({}, v, { loading: false, error: (e && e.message) || t("pickError") }); });
			});
		};

		if (react.useEffect) {
			react.useEffect(function () { load(props.initialPath || ""); }, []);
			// Close on Escape for keyboard users.
			react.useEffect(function () {
				var onKey = function (ev) { if (ev.key === "Escape") props.onClose(); };
				if (typeof document !== "undefined") document.addEventListener("keydown", onKey);
				return function () { if (typeof document !== "undefined") document.removeEventListener("keydown", onKey); };
			}, []);
		}

		var listing = s.listing || {};
		var entries = Array.isArray(listing.entries) ? listing.entries : [];
		var crumbs = Array.isArray(listing.crumbs) ? listing.crumbs : [];
		var home = listing.home || null;

		var pickHere = function () { props.onPick(s.path); };

		return h("div", { className: "odoo-sdd-overlay", role: "dialog", "aria-modal": "true", "aria-label": t("pickTitle"), onClick: function (ev) { if (ev.target === ev.currentTarget) props.onClose(); } },
			h("div", { className: "odoo-sdd-modal" },
				h("div", { className: "odoo-sdd-modal-head" },
					h("h3", { className: "odoo-sdd-h1" }, t("pickTitle")),
					h("button", { type: "button", className: "odoo-sdd-btn odoo-sdd-btn--ghost odoo-sdd-btn--small", onClick: props.onClose }, t("pickClose"))),

				h("div", { className: "odoo-sdd-crumbs" },
					home ? h("button", { type: "button", className: "odoo-sdd-crumb", onClick: function () { load(home); } }, "~") : null,
					crumbs.map(function (c, i) {
						return h("button", { key: (c && c.path) || i, type: "button", className: "odoo-sdd-crumb", onClick: function () { load(c.path); } },
							(i > 0 ? " / " : "") + ((c && c.name) || (c && c.path) || ""));
					})),

				h("div", { className: "odoo-sdd-row" },
					h("label", { className: "odoo-sdd-label", htmlFor: "odoo-sdd-pick-path" }, t("pickPath")),
					h("input", {
						id: "odoo-sdd-pick-path", type: "text", className: "odoo-sdd-input odoo-sdd-input--mono",
						style: { flex: "1 1 240px" }, value: s.draft, spellCheck: false, autoComplete: "off",
						onChange: function (ev) { var val = ev.target.value; set(function (v) { return Object.assign({}, v, { draft: val }); }); },
						onKeyDown: function (ev) { if (ev.key === "Enter") load(s.draft); }
					}),
					h("button", { type: "button", className: "odoo-sdd-btn odoo-sdd-btn--ghost odoo-sdd-btn--small", onClick: function () { load(s.draft); } }, t("pickGo")),
					crumbs.length > 1 ? h("button", { type: "button", className: "odoo-sdd-btn odoo-sdd-btn--ghost odoo-sdd-btn--small", onClick: function () { var up = crumbs[crumbs.length - 2]; load((up && up.path) || home || ""); } }, t("pickUp")) : null),

				h("div", { className: "odoo-sdd-list" },
					s.loading ? h("div", { className: "odoo-sdd-empty" }, t("pickLoading"))
						: s.error ? h("div", { className: "odoo-sdd-empty", style: { color: "var(--dsw-alias-state-error-primary,#dc2626)" } }, s.error)
							: entries.length === 0 ? h("div", { className: "odoo-sdd-empty" }, t("pickEmpty"))
								: entries.map(function (en, i) {
									var name = (en && en.name) || "";
									var p = (en && en.path) || "";
									return h("button", { key: p || name || i, type: "button", className: "odoo-sdd-item", title: p, onClick: function () { load(p); }, onDoubleClick: function () { props.onPick(p); } },
										h("span", { style: { fontFamily: "var(--dsw-alias-font-mono,ui-monospace,monospace)", fontSize: "12px" } }, name));
								})),

				h("div", { className: "odoo-sdd-actions" },
					h("button", { type: "button", className: "odoo-sdd-btn odoo-sdd-btn--primary", disabled: !s.path || Boolean(s.error), onClick: pickHere }, t("pickHere")),
					h("button", { type: "button", className: "odoo-sdd-btn odoo-sdd-btn--ghost", onClick: props.onClose }, t("pickCancel"))))
		);
	};

	var SddSection = function (props) {
		var t = props.t;
		var formCtl = props.form;
		var prefix = props.idPrefix || "odoo-sdd";
		var sampleLang = typeof props.sampleLang === "function" ? props.sampleLang : function () { return "en"; };
		var listDirectory = props.listDirectory;
		var pickDirectory = props.pickDirectory;
		var ss = scopeState(formCtl);
		var canWrite = Boolean(formCtl) && typeof formCtl === "object" && typeof formCtl.set === "function" && ss.writable && ss.status !== "unavailable";

		var st = react.useState(function () { return { form: toForm(readSnap(formCtl)), dirty: false, status: "idle", picker: null }; });
		var model = st[0];
		var setModel = st[1];
		var form = model.form;

		if (react.useEffect && formCtl && typeof formCtl.subscribe === "function") {
			react.useEffect(function () {
				return formCtl.subscribe(function () {
					setModel(function (m) { return Object.assign({}, m, { form: toForm(readSnap(formCtl)), dirty: false, status: "idle" }); });
				});
			}, [formCtl]);
		}

		var edit = function (patch) {
			setModel(function (m) { return { form: Object.assign({}, m.form, patch), dirty: true, status: "idle", picker: m.picker }; });
		};
		var onField = function (name) { return function (e) { var p = {}; p[name] = e.target.value; edit(p); }; };

		var persist = function () {
			if (!canWrite) return;
			var snap = readSnap(formCtl);
			var parseList = function (v) { return String(v || "").split(",").map(function (x) { return x.trim(); }).filter(Boolean); };
			var target = {
				autonomy: form.autonomy,
				executeAllowlist: parseList(form.allowlist),
				methodAllowlist: parseList(form.methods),
				communityRepoUrl: form.communityUse === "url" ? form.communityUrl : "",
				// The project root is deliberately NOT written from the panel: it
				// is resolved from the session's folder. Only the specs LAYOUT is
				// a plugin setting.
				specsMode: form.specsMode === "central" ? "central" : "project",
				specsRoot: form.specsMode === "central" ? (form.specsRoot || "") : "",
				specsDir: form.specsDir || "specs",
				specPolicyScope: form.specPolicyScope === "everywhere" ? "everywhere" : "odoo",
				communityRepoPath: form.communityUse === "path" ? form.communityPath : "",
				enterpriseRepoUrl: form.enterpriseUse === "url" ? form.enterpriseUrl : "",
				enterpriseRepoPath: form.enterpriseUse === "path" ? form.enterprisePath : "",
				requireCheckpointBeforeMutation: form.requireCheckpointBeforeMutation === true,
				requireSpecForChanges: form.requireSpecForChanges === true,
				adoptProjectPointerHint: form.adoptProjectPointerHint === true,
				securityReviewRequired: form.securityReviewRequired === true,
				securityInterviewRequired: form.securityInterviewRequired === true,
				auditAllTools: form.auditAllTools === true,
				maxCheckpoints: Number(form.maxCheckpoints) > 0 ? Number(form.maxCheckpoints) : 5,
				documentationPolicy: form.documentationPolicy === "optional" || form.documentationPolicy === "off" ? form.documentationPolicy : "required",
				documentationLanguage: form.documentationLanguage || "",
				manualsMode: ["specs", "docs", "module"].indexOf(form.manualsMode) >= 0 ? form.manualsMode : "specs",
				manualsDir: form.manualsMode === "docs" ? (form.manualsDir || "docs/manuals") : "",
				videosDir: form.videosDir || "docs/videos",
				ttsPreset: VOICE_IDS.indexOf(form.ttsPreset) >= 0 ? form.ttsPreset : "",
				ttsCommand: form.ttsCommand || "",
				ttsVoice: form.ttsVoice || "",
				videoMusic: form.videoMusic === true,
				videoSfx: form.videoSfx === true
			};
			var ops = [];
			Object.keys(target).forEach(function (k) {
				var before = Array.isArray(snap[k]) ? snap[k].join(",") : String(snap[k]);
				var after = Array.isArray(target[k]) ? target[k].join(",") : String(target[k]);
				if (before !== after) ops.push([k, target[k]]);
			});
			if (ops.length === 0) { setModel(function (m) { return Object.assign({}, m, { dirty: false, status: "saved" }); }); return; }
			setModel(function (m) { return Object.assign({}, m, { status: "saving" }); });
			Promise.all(ops.map(function (pair) { return formCtl.set(pair[0], pair[1]); })).then(function () {
				setModel(function (m) { return Object.assign({}, m, { dirty: false, status: "saved", errorText: "" }); });
			}).catch(function (err) {
				var msg = (err && err.message) ? String(err.message) : "";
				setModel(function (m) { return Object.assign({}, m, { status: "error", errorText: msg }); });
			});
		};

		var seg = function (name, value, options) {
			return h("div", { className: "odoo-sdd-seg", role: "group" },
				options.map(function (o) {
					return h("button", {
						key: o.value, type: "button", disabled: !canWrite,
						className: "odoo-sdd-seg-btn" + (value === o.value ? " is-on" : ""),
						"aria-pressed": value === o.value,
						onClick: function () { var p = {}; p[name] = o.value; edit(p); }
					}, o.label);
				}));
		};

		/** Boolean toggle rendered as a Yes/No segmented control. */
		var boolSeg = function (name, value) {
			return h("div", { className: "odoo-sdd-seg", role: "group" },
				[{ v: true, l: t("yes") }, { v: false, l: t("no") }].map(function (o) {
					return h("button", {
						key: String(o.v), type: "button", disabled: !canWrite,
						className: "odoo-sdd-seg-btn" + (value === o.v ? " is-on" : ""),
						"aria-pressed": value === o.v,
						onClick: function () { var p = {}; p[name] = o.v; edit(p); }
					}, o.l);
				}));
		};

		/** A segmented control over an arbitrary set of string values. */
		var enumSeg = function (name, value, options) {
			return h("div", { className: "odoo-sdd-seg", role: "group" },
				options.map(function (o) {
					return h("button", {
						key: o.v, type: "button", disabled: !canWrite,
						className: "odoo-sdd-seg-btn" + (value === o.v ? " is-on" : ""),
						"aria-pressed": value === o.v,
						onClick: function () { var p = {}; p[name] = o.v; edit(p); }
					}, o.l);
				}));
		};

		/** One labelled policy row. */
		var policyRow = function (label, ctl, note) {
			return h("div", { className: "odoo-sdd-field" },
				h("span", { className: "odoo-sdd-label" }, label),
				ctl,
				note ? h("p", { className: "odoo-sdd-sub" }, note) : null);
		};

		var repo = function (which) {
			var use = form[which + "Use"];
			var urlVal = form[which + "Url"];
			var pathVal = form[which + "Path"];
			var id = prefix + "-" + which;
			var onToggle = function (next) { var p = {}; p[which + "Use"] = next; edit(p); };
			var onVal = function (e) { var p = {}; p[which + (use === "url" ? "Url" : "Path")] = e.target.value; edit(p); };
			// Prefer the host-native chooser (works when the composed picker
			// serves "native"); fall back to the in-app listing dialog when the
			// composition serves "browse" instead.
			var canNative = typeof pickDirectory === "function";
			var canBrowseInApp = typeof listDirectory === "function";
			var canBrowse = use === "path" && canWrite && (canNative || canBrowseInApp);
			var doBrowse = function () {
				var setPath = function (chosen) {
					if (!chosen) return;
					var p = {};
					p[which + "Use"] = "path";
					p[which + "Path"] = chosen;
					edit(p);
				};
				if (canNative) {
					Promise.resolve().then(function () { return pickDirectory(); }).then(function (chosen) {
						if (chosen) setPath(chosen);
						// null = the operator cancelled the OS dialog: do nothing.
					}).catch(function () {
						// Native unavailable (remote browser, no OS chooser): try
						// the in-app listing dialog, else surface the failure.
						if (canBrowseInApp) setModel(function (m) { return Object.assign({}, m, { picker: { which: which } }); });
						else setModel(function (m) { return Object.assign({}, m, { status: "error" }); });
					});
					return;
				}
				setModel(function (m) { return Object.assign({}, m, { picker: { which: which } }); });
			};
			return h("div", null,
				h("div", { className: "odoo-sdd-field" },
					h("label", { className: "odoo-sdd-label", htmlFor: id }, use === "url" ? t("useUrl") : t("usePath")),
					h("div", { className: "odoo-sdd-row" },
						h("div", { className: "odoo-sdd-seg", role: "group" },
							["url", "path"].map(function (mode) {
								return h("button", {
									key: mode, type: "button", disabled: !canWrite,
									className: "odoo-sdd-seg-btn" + (use === mode ? " is-on" : ""),
									"aria-pressed": use === mode,
									onClick: function () { onToggle(mode); }
								}, mode === "url" ? t("useUrl") : t("usePath"));
							})),
						h("input", {
							id: id, type: "text", disabled: !canWrite, className: "odoo-sdd-input odoo-sdd-input--mono",
							style: { flex: "1 1 240px" },
							value: use === "url" ? urlVal : pathVal,
							placeholder: use === "url" ? "https://github.com/odoo/odoo" : "/opt/odoo",
							onChange: onVal, spellCheck: false, autoComplete: "off"
						}),
						canBrowse ? h("button", {
							type: "button", className: "odoo-sdd-btn odoo-sdd-btn--ghost odoo-sdd-btn--small",
							"aria-label": t("browse"),
							onClick: doBrowse
						}, t("browse")) : null)));
		};

		/** A directory field: type it, or pick it with the host's OS chooser. */
		var dirField = function (name, label, placeholder) {
			var id = prefix + "-" + name;
			var canPick = typeof pickDirectory === "function" && canWrite;
			var doPick = function () {
				Promise.resolve().then(function () { return pickDirectory(); }).then(function (chosen) {
					// null = the operator cancelled the OS dialog: do nothing.
					if (!chosen) return;
					var patch = {}; patch[name] = chosen; edit(patch);
				}).catch(function () {
					// Native chooser unavailable: the field stays typable.
				});
			};
			return h("div", { className: "odoo-sdd-field" },
				h("label", { className: "odoo-sdd-label", htmlFor: id }, label),
				h("div", { className: "odoo-sdd-row" },
					h("input", {
						id: id, type: "text", disabled: !canWrite, className: "odoo-sdd-input odoo-sdd-input--mono",
						style: { flex: "1 1 240px" }, value: form[name] || "", placeholder: placeholder,
						spellCheck: false, autoComplete: "off", onChange: onField(name)
					}),
					canPick ? h("button", {
						type: "button", className: "odoo-sdd-btn odoo-sdd-btn--ghost odoo-sdd-btn--small",
						"aria-label": t("browse"), onClick: doPick
					}, t("browse")) : null));
		};

		/** A plain text field (the TTS command/voice inputs, shown conditionally). */
		var textField = function (name, label, placeholder, hint) {
			var id = prefix + "-" + name;
			return h("div", { className: "odoo-sdd-field" },
				h("label", { className: "odoo-sdd-label", htmlFor: id }, label),
				h("input", {
					id: id, type: "text", disabled: !canWrite, className: "odoo-sdd-input odoo-sdd-input--mono",
					value: form[name] || "", placeholder: placeholder, spellCheck: false, autoComplete: "off", onChange: onField(name)
				}),
				hint ? h("div", { className: "odoo-sdd-hint" }, hint) : null);
		};

		/**
		 * One voice preset card. Clicking the selected card DESELECTS it
		 * (ttsPreset back to ""), because "no voice chosen yet" is a real state
		 * the engine reports as NEEDS_TTS — the picker must be able to show it.
		 * Picking a cloud preset also plays its sample; the Listen button
		 * replays it without touching the selection (and works read-only).
		 */
		var voiceCard = function (p) {
			var on = form.ttsPreset === p.id;
			var hasSample = Boolean(VOICE_SAMPLES[p.id]);
			var listen = function () { playSample(p.id, sampleLang()); };
			return h("div", { key: p.id, className: "odoo-sdd-voice" + (on ? " is-on" : "") },
				h("button", {
					type: "button", disabled: !canWrite,
					className: "odoo-sdd-voice-pick",
					"aria-pressed": on,
					onClick: function () {
						var patch = {}; patch.ttsPreset = on ? "" : p.id; edit(patch);
						if (!on && hasSample) listen();
					}
				},
					h("span", { className: "odoo-sdd-voice-name" }, t("voiceLabel_" + p.id),
						p.recommended ? h("span", { className: "odoo-sdd-voice-tag odoo-sdd-voice-tag--rec" }, t("voiceRecommended")) : null),
					h("span", { className: "odoo-sdd-voice-meta" },
						h("span", { className: "odoo-sdd-voice-tag" + (p.cloud ? "" : " odoo-sdd-voice-tag--off") }, p.cloud ? t("voiceCloud") : t("voiceOffline")),
						p.gender ? h("span", { className: "odoo-sdd-voice-tag" }, t(p.gender === "male" ? "genderMale" : "genderFemale")) : null,
						h("span", { className: "odoo-sdd-voice-tag" }, t("voiceStyle_" + p.style))),
					h("span", { className: "odoo-sdd-voice-note" }, t("voiceNote_" + p.noteKey))),
				hasSample
					? h("button", {
						type: "button", className: "odoo-sdd-voice-play",
						"aria-label": t("voiceListen") + ": " + t("voiceLabel_" + p.id),
						onClick: listen
					},
						h("svg", { viewBox: "0 0 10 10", "aria-hidden": "true", focusable: "false" }, h("path", { d: "M2 1l7 4-7 4z" })),
						t("voiceListen"))
					: null);
		};
		var selectedVoice = VOICE_PRESETS.filter(function (p) { return p.id === form.ttsPreset; })[0] || null;

		var chips = String(form.allowlist || "").split(",").map(function (x) { return x.trim(); }).filter(Boolean);
		var methodChips = String(form.methods || "").split(",").map(function (x) { return x.trim(); }).filter(Boolean);
		var status = h("div", {
			className: "odoo-sdd-status" + (model.status === "saved" ? " odoo-sdd-status--ok" : model.status === "error" ? " odoo-sdd-status--err" : ""),
			role: "status", "aria-live": "polite"
		}, (model.status === "saved" ? t("saved") : model.status === "error" ? (t("error") + (model.errorText ? ": " + model.errorText : "")) : model.status === "saving" ? t("saving") : ""));

		var pickerNode = null;
		if (model.picker) {
			var which = model.picker.which;
			var initial = form[which + "Path"] || form[which + "Url"] || "";
			pickerNode = h(DirPicker, {
				t: t, listDirectory: listDirectory, initialPath: initial,
				onClose: function () { setModel(function (m) { return Object.assign({}, m, { picker: null }); }); },
				onPick: function (chosen) {
					if (chosen) { var p = {}; p[which + "Use"] = "path"; p[which + "Path"] = chosen; edit(p); }
					setModel(function (m) { return Object.assign({}, m, { picker: null }); });
				}
			});
		}

		return h("div", { className: "odoo-sdd-root" },
			pickerNode,
			h("div", { className: "odoo-sdd-head" },
				h("h2", { className: "odoo-sdd-h1" }, t("nav")),
				h("span", { className: "odoo-sdd-badge " + (canWrite ? "odoo-sdd-badge--on" : "odoo-sdd-badge--off") },
					canWrite ? t("editable") : t("readonly"))),
			!canWrite ? h("div", { className: "odoo-sdd-banner" }, h("span", null, t("readonlyHint"))) : null,

			h(SectionCard, { title: t("specs"), hint: t("specsHint") },
				policyRow(t("specsMode"), seg("specsMode", form.specsMode, [
					{ value: "project", label: t("specsModeProject") },
					{ value: "central", label: t("specsModeCentral") }
				])),
				form.specsMode === "central"
					? dirField("specsRoot", t("specsRoot"), "~/.dsh-odoo-sdd/specs")
					: h("div", { className: "odoo-sdd-field" },
						h("label", { className: "odoo-sdd-label", htmlFor: prefix + "-specsDir" }, t("specsSubdir")),
						h("input", {
							id: prefix + "-specsDir", type: "text", disabled: !canWrite,
							className: "odoo-sdd-input odoo-sdd-input--mono odoo-sdd-input--short",
							maxLength: 64, value: form.specsDir || "specs",
							placeholder: "specs", spellCheck: false, autoComplete: "off",
							onChange: onField("specsDir")
						})),
				h("p", { className: "odoo-sdd-hint" },
					form.specsMode === "central" ? t("specsCentralResolved") : t("specsProjectResolved"))),
			h(SectionCard, { title: t("delegation"), hint: t("delegationHint") },
				seg("autonomy", form.autonomy, [
					{ value: "supervised", label: t("supervised") },
					{ value: "autonomous", label: t("autonomous") }
				])),

			// The Odoo edition is NOT a plugin setting: it is answered per spec in
			// CLARIFY (sdd_phase operation=clarify licensed=...), because one
			// workspace can hold EE and CE projects at the same time. The card is
			// kept as an explanation rather than a control that would lie about
			// being plugin-wide.
			h(SectionCard, { title: t("license"), hint: t("licenseHint") },
				h("p", { className: "odoo-sdd-sub" }, t("licensePerSpec"))),

			h(SectionCard, { title: t("allowlist"), hint: t("allowlistHint") },
				h("div", { className: "odoo-sdd-field" },
					h("label", { className: "odoo-sdd-label", htmlFor: prefix + "-allow" }, t("allowlist")),
					h("input", { id: prefix + "-allow", type: "text", className: "odoo-sdd-input odoo-sdd-input--mono", value: form.allowlist, disabled: !canWrite, onChange: onField("allowlist"), placeholder: "my.model, other.model", spellCheck: false, autoComplete: "off" })),
				h("div", { className: "odoo-sdd-chips" },
					chips.length ? chips.map(function (c) { return h("span", { className: "odoo-sdd-chip", key: c }, c); })
						: h("span", { className: "odoo-sdd-sub" }, t("noModels")))),

			h(SectionCard, { title: t("methods"), hint: t("methodsHint") },
				h("div", { className: "odoo-sdd-field" },
					h("label", { className: "odoo-sdd-label", htmlFor: prefix + "-methods" }, t("methods")),
					h("input", { id: prefix + "-methods", type: "text", className: "odoo-sdd-input odoo-sdd-input--mono", value: form.methods, disabled: !canWrite, onChange: onField("methods"), placeholder: "my.model.my_method, other.model.other_method", spellCheck: false, autoComplete: "off" })),
				h("div", { className: "odoo-sdd-chips" },
					methodChips.length ? methodChips.map(function (c) { return h("span", { className: "odoo-sdd-chip", key: c }, c); })
						: h("span", { className: "odoo-sdd-sub" }, t("noMethods")))),

			h(SectionCard, { title: t("repoCommunity"), hint: t("repoHint") }, repo("community")),
			h(SectionCard, { title: t("repoEnterprise"), hint: t("repoHint") }, repo("enterprise")),

			h(SectionCard, { title: t("policy"), hint: t("policyHint") },
				policyRow(t("checkpointRequired"), boolSeg("requireCheckpointBeforeMutation", form.requireCheckpointBeforeMutation)),
				policyRow(t("specRequired"), boolSeg("requireSpecForChanges", form.requireSpecForChanges)),
				policyRow(t("specScope"), enumSeg("specPolicyScope", form.specPolicyScope, [
					{ v: "odoo", l: t("scopeOdoo") },
					{ v: "everywhere", l: t("scopeEverywhere") },
				]), t("specScopeHint")),
				policyRow(t("adoptHint"), boolSeg("adoptProjectPointerHint", form.adoptProjectPointerHint), t("adoptHintHint")),
				policyRow(t("securityReview"), boolSeg("securityReviewRequired", form.securityReviewRequired)),
				policyRow(t("securityInterview"), boolSeg("securityInterviewRequired", form.securityInterviewRequired)),
				policyRow(t("auditAll"), boolSeg("auditAllTools", form.auditAllTools)),
				policyRow(t("docPolicy"), enumSeg("documentationPolicy", form.documentationPolicy, [
					{ v: "required", l: t("docRequired") },
					{ v: "optional", l: t("docOptional") },
					{ v: "off", l: t("docOff") }
				])),
				h("div", { className: "odoo-sdd-field" },
					h("label", { className: "odoo-sdd-label", htmlFor: prefix + "-doclang" }, t("docLanguage")),
					h("input", { id: prefix + "-doclang", type: "text", className: "odoo-sdd-input odoo-sdd-input--short", maxLength: 12, value: form.documentationLanguage, placeholder: "en", disabled: !canWrite, spellCheck: false, onChange: onField("documentationLanguage") }),
					h("div", { className: "odoo-sdd-hint" }, t("docLanguageHint"))),
				h("div", { className: "odoo-sdd-field" },
					h("label", { className: "odoo-sdd-label", htmlFor: prefix + "-maxcp" }, t("maxCheckpoints")),
					h("input", { id: prefix + "-maxcp", type: "number", min: "1", inputMode: "numeric", className: "odoo-sdd-input odoo-sdd-input--short", value: form.maxCheckpoints, disabled: !canWrite, onChange: onField("maxCheckpoints") }))),

			h(SectionCard, { title: t("manuals"), hint: t("manualsHint") },
				policyRow(t("manualsMode"), enumSeg("manualsMode", form.manualsMode, [
					{ v: "specs", l: t("manualsSpecs") },
					{ v: "docs", l: t("manualsDocs") },
					{ v: "module", l: t("manualsModule") }
				]), t("manualsModeHint_" + (["specs", "docs", "module"].indexOf(form.manualsMode) >= 0 ? form.manualsMode : "specs"))),
				form.manualsMode === "docs"
					? dirField("manualsDir", t("manualsDir"), "docs/manuals")
					: null),

			h(SectionCard, { title: t("videos"), hint: t("videosHint") },
				policyRow(t("voice"),
					h("div", null,
						h("div", { className: "odoo-sdd-voices" }, VOICE_PRESETS.map(voiceCard)),
						h("p", { className: "odoo-sdd-hint" }, t("voiceSampleNote")),
						form.ttsPreset === ""
							? h("div", { className: "odoo-sdd-banner", style: { marginTop: "8px" } }, h("span", null, t("voiceNone")))
							: null)),
				selectedVoice && selectedVoice.cloud
					? h("p", { className: "odoo-sdd-hint" }, t("voicePrivacy"))
					: null,
				form.ttsPreset === "custom"
					? h("div", null,
						textField("ttsCommand", t("ttsCommand"), "piper -m {voice} -i {textFile} -f {out}", t("ttsCommandHint")),
						textField("ttsVoice", t("ttsVoice"), "es-ES-AlvaroNeural", t("ttsVoiceHint")))
					: form.ttsPreset === "offline-piper"
						? textField("ttsVoice", t("ttsVoice"), "/path/to/voice.onnx", t("ttsVoiceHint"))
						: null,
				policyRow(t("videoMusic"), boolSeg("videoMusic", form.videoMusic)),
				policyRow(t("videoSfx"), boolSeg("videoSfx", form.videoSfx)),
				dirField("videosDir", t("videosDir"), "docs/videos")),

			h(SectionCard, { title: t("pipeline"), hint: t("pipelineHint") }, null),

			h("div", { className: "odoo-sdd-actions" },
				h("button", { type: "button", className: "odoo-sdd-btn odoo-sdd-btn--primary", disabled: !canWrite || !model.dirty || model.status === "saving", onClick: persist },
					model.status === "saving" ? t("saving") : t("save")),
				h("button", { type: "button", className: "odoo-sdd-btn odoo-sdd-btn--ghost", disabled: !canWrite || !model.dirty || model.status === "saving", onClick: function () { setModel({ form: toForm(readSnap(formCtl)), dirty: false, status: "idle", picker: null }); } }, t("discard")),
				status)
		);
	};

	function apply(ctx) {
		try {
			// The interface language is the HOST'S global setting (Settings →
			// General, `locale.preference`), and the host ships `es` natively —
			// for its own copy and for the approval card. The plugin therefore
			// neither adds a language nor overrides host namespaces: it only
			// contributes its own dictionaries. A locale without one here walks
			// the host's fallback chain to `en`.
			ctx.effect(function () { ctx.locale.register(NS, { zh: zh, en: en, es: es }); }, "odoo-sdd: dictionaries");
			var t = ctx.locale.bind(NS);
			// Registered as an effect so dispose/HMR removes the stylesheet it
			// injected instead of leaking it into the document head forever.
			ctx.effect(function () { injectCss(); return removeCss; }, "odoo-sdd: stylesheet");
			// A sample still playing when the plugin unloads is stopped with it.
			ctx.effect(function () { return stopSample; }, "odoo-sdd: voice preview");

			/**
			 * The language of the voice samples: the host's active interface
			 * language when a sample exists for it, else English. Read on every
			 * click, so a language switch applies without a reload.
			 */
			var sampleLang = function () {
				try {
					var snap = ctx.locale && typeof ctx.locale.getSnapshot === "function" ? ctx.locale.getSnapshot() : null;
					var active = snap && typeof snap.active === "string" ? snap.active.toLowerCase().split("-")[0] : "en";
					return active === "es" ? "es" : "en";
				} catch (e) { return "en"; }
			};

			// Host folder picking (optional): native OS chooser first, then
			// the in-app listing dialog — depending on the composed picker.
			var listDirectory = null;
			var pickDirectory = null;
			try {
				if (ctx.uiWorkspace && typeof ctx.uiWorkspace.listDirectory === "function") {
					listDirectory = function (path) { return ctx.uiWorkspace.listDirectory(path); };
				}
				if (ctx.uiWorkspace && typeof ctx.uiWorkspace.pickDirectory === "function") {
					pickDirectory = function () { return ctx.uiWorkspace.pickDirectory(); };
				}
			} catch (e) { listDirectory = null; pickDirectory = null; }

			// `configForms` is a REQUIRED service (see `exports.inject`): without
			// it there is no namespace form to read or write. Failing loudly here
			// is deliberate — the previous contract made the whole section vanish
			// without a word, which is exactly how a host upgrade broke it.
			var configForms = ctx.configForms;
			if (!configForms || typeof configForms.get !== "function") {
				if (typeof console !== "undefined") {
					console.error(
						"[dsh-odoo-sdd] the `configForms` service is unavailable, so the \"Odoo SDD\" Settings section cannot be registered. " +
						"This host is older than the client contract (dsh >= 0.2.0-rc.1). The tools and the SDD pipeline keep working; " +
						"edit the configuration with `odoo_config mode=read|set` instead."
					);
				}
				return;
			}

			var sectionFor = function (form) {
				return function () {
					return h(SddSection, { t: t, form: form, listDirectory: listDirectory, pickDirectory: pickDirectory, sampleLang: sampleLang, idPrefix: "odoo-sdd-sec" });
				};
			};

			// The section is registered while the Host actually SERVES our
			// namespace, and disposed when it stops: a deployment that never
			// composed it shows no trace of the page. `whileServed` returns the
			// disposer and expects the caller to own it through `ctx.effect`.
			ctx.effect(function () {
				return configForms.whileServed([NS], function () {
					var form = configForms.get(NS);
					return ctx.slots.register({
						name: "settings.section",
						id: "odoo-sdd",
						order: 60,
						label: function () { return t("nav"); },
						locale: NS,
						inject: function () { return { t: t }; }
					}, sectionFor(form));
				});
			}, "odoo-sdd: settings section");

			// NOTE: deliberately NO `settings.plugin.item` registration — the
			// configuration lives in its own standalone Settings section (the
			// sidebar entry above), not as a card inside Settings → Plugins.
		} catch (e) {
			if (typeof console !== "undefined") console.error("[dsh-odoo-sdd] client apply failed:", e);
		}
	}

	exports.REQUIRED_PRIMITIVES = ["@deepseek-ai/dsh-client-ui-primitives"];
	exports.missingPrimitives = function (available) {
		var missing = [];
		for (var i = 0; i < exports.REQUIRED_PRIMITIVES.length; i++) {
			var nm = exports.REQUIRED_PRIMITIVES[i];
			if (!available || !available[nm]) missing.push(nm);
		}
		return missing;
	};
	var inject = ["slots", "locale", "theme", "uiWorkspace", "configForms"];
	exports.apply = apply;
	exports.inject = inject;
	exports.name = "odoo-sdd";

	return module.exports;
}});
