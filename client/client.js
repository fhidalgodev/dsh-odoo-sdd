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
	"voiceLabel_viral-co-male": "快节奏（哥伦比亚口音）— 男声",
	"voiceLabel_viral-co-female": "快节奏（哥伦比亚口音）— 女声",
	"voiceLabel_calm-male": "沉稳 — 男声",
	"voiceLabel_calm-female": "沉稳 — 女声",
	"voiceLabel_offline-piper": "离线 — Piper",
	"voiceLabel_custom": "自定义命令",
	"voiceNote_viral": "快节奏的神经网络音色，适合简短有力的旁白。",
	"voiceNote_viral-co": "带哥伦比亚口音的快节奏音色，用于西班牙文脚本；其他语言使用快节奏音色。",
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
		"voiceLabel_viral-co-male": "Viral (Colombian) — male",
		"voiceLabel_viral-co-female": "Viral (Colombian) — female",
		"voiceLabel_calm-male": "Calm — male",
		"voiceLabel_calm-female": "Calm — female",
		"voiceLabel_offline-piper": "Offline — Piper",
		"voiceLabel_custom": "Custom command",
		"voiceNote_viral": "Fast-paced neural voice for short, punchy narration.",
		"voiceNote_viral-co": "Fast-paced voice with a Colombian accent for Spanish scripts; other languages use the viral voice.",
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
		"voiceLabel_viral-co-male": "Viral colombiana — masculina",
		"voiceLabel_viral-co-female": "Viral colombiana — femenina",
		"voiceLabel_calm-male": "Pausada — masculina",
		"voiceLabel_calm-female": "Pausada — femenina",
		"voiceLabel_offline-piper": "Local — Piper",
		"voiceLabel_custom": "Comando propio",
		"voiceNote_viral": "Voz neuronal de ritmo rápido para narraciones cortas y directas.",
		"voiceNote_viral-co": "Voz de ritmo rápido con acento colombiano para guiones en español; en otros idiomas usa la voz viral.",
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
		{ id: "viral-co-male", style: "viral", gender: "male", cloud: true, noteKey: "viral-co" },
		{ id: "viral-co-female", style: "viral", gender: "female", cloud: true, noteKey: "viral-co" },
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
			es: { voice: "es-MX-JorgeNeural", src: "data:audio/mpeg;base64,SUQzBAAAAAAAIlRTU0UAAAAOAAADTGF2ZjYxLjcuMTAzAAAAAAAAAAAAAAD/84TAAAAAAAAAAAAASW5mbwAAAA8AAACGAAAmcAAICg4QEhUXGR0fISQmKCwuMDM1Nzs9P0JERkpMTlFTVVlbXWBiZGhqbG9xc3d5e36AhIaIi42Pk5WXmpyeoqSmqautsbO1uLq8wMLEx8nLz9HT1tja3uDi5efp7e/x9Pb4/P4AAAAATGF2YzYxLjE5AAAAAAAAAAAAAAAAJAJAAAAAAAAAJnCbGgKXAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD/8zTEAAAAA0gAAAAAAEr/9ojDwAgeTTMAARhBByZO2iHf/+HfhOSxcGgeGS7u//oiSHYCgLDKB9/+oEwfeUWCCw/V/gNoYQD/8zTEOwAAA0gAAAAAe/qNHg5gTX7JcIGEM5LnDQdAc49fNLOO0kExLPoU1IFZIEEWxA/QW6TJx/JwzBdyd/Tegt3Lo9iMUC7/8zTEdgBYBAAASAAAGA3//0EDN1GZoYpDjNSAPMj//tTQZBafmJxM2KzMoFIZ0be92leq2RyzAewcvW19C+6y5z9Zb71ma/b/8zTErwzJDXABRkAA97VtDs3ykD4PpJK2SOCDtainuWvA9VVCPnY7xn5FP/PWTX5i++82ryDy8ub/wcM+W+OMNnUEmlBJoAr/8zTEthgCYhABj2gAammcXMmJVaDJFX7dA21bHeqRp8PqPNx9lmMh+4tH9sVV5OEy3eSvT/TCW/9e+vtW9VIb48gXq/KV43b/8zTEkRPh1hQBzzABOX+zpVis/f/lbLwwHm0n5bZk3UZwQQyHrObgOQMAsEVWKx1ljQ9D38OkClGBUPInxgAgAQcHYKwXj/7/8zTEfBUCRhmUeYwA+bSUfRbq3dO7TLFwaBwYiY/rzr4iluEjd7g8t49lvvlEqXd9OYGj3tU4MPl4ENmwwlUjAcAGPPYAN4f/8zTEYxYp2iwTT0AAg04oQOU5uimBvGBlKLK9NI0JwDqMNXgBPC7PruyZeFkEoPsnv1pGi042hjQbBYBaCCCdP7smt0ECFMz/8zTERRfKUqQBk5gBmBP5KhcGGgf/f9IghWOm6BcYz////dAwZcjVkCFAKdgQpRFgNBVv3y/LGtAhBJkNTpCRfqyWPHb4tkP/8zTEIBPJctDJz2ADTMqRqNwkBY8K9kVnL25bP1y8zN+vMMCxkw9ptR2bWkNqV6Weyy7aPfj1pZYm6bKqESqzoAh4v8QRk+H/8zTECw+CRuTWWMS6ixtCroSXYhRMzbw1WemQVNxDz+dL1plSpR9Uv6Va+8z3WpW1Vv+l6ZG3dqE8/kI300EEwmgORjWDomb/8zTECA4iQtAsQEz9YmphlhmWPlvrKoQmI80///JxTX/++pfMH/xnJ5tBquWHvKRC+2oVhWbgDOgg5hBCSm44g0YIAIIUOsj/8zTECg06NuJaKAuHYySph9LL6u83p7d0//9kMFOv/3tvoqIKFRSios6CY9CRWNARgsYgiHmSyZ9vtrt9YfKElM5vg6tM6JH/8zTEEAyg5wZYGEauG1d2LApuErgYgAQSsTcEgAoBpCE6cpC8PyhlcofH/7vq/pUfb//DbWLseeoRksQQFHEHA7tQOft9W6//8zTEGAyhAxJYEBMCQwyu268j/DJz8EzAPioqogFLlDBKSPlHWf6Fkmt22UbQRMnaMJDRfajZQPq9Aq3gqFVlY19TZwkJdf3/8zTEIAzpAvpaYMSuShXIyHPp8QT13P8Ii3//1eqsaKrPPTz5h4jVM4LdDi+nUtTKHSvlbwEZyGDN5yNDGVrvks/JSQvHaB7/8zTEJwzQ7tZSwER8o1pqCwPkhX//+ypKqmZmiJiZfb7YADAb4fznNdeEnyH2FnD91PMpk4k91//3qfHukPtGpRKXs79vyn7/8zTELgxQ/y8eC8YGH/9zqtQWgtLKvWDZQbOVv9ZX///2IpCFZlRkVFaRiHPZgR5koII9FY+fFs7EaU7kGFj56gk5JJDASMf/8zTENwvSOtAAOARZM+sjaiw6uZPzOTjNtEDRp9TN///5f+90Q8H+qY/X/mT527vIpiFzbUFRldttoh2TaNeHRvLex06Hwtz/8zTEQgxaPvJaEEb/qpAFCTtn5U7HjUU1NUQhMZBYGHB0MFRSigqDbRCfDqaEuooVs2u3smjToC4VlYg4Zg16sV9moAWs6EX/8zTESwzQoxZ4MIxmDoHiYqwmAheBA+K3AJ3IKWwkWf3+E0ESrtnt/QqRNFMCL54IMpnemgkpYCLgCxalD2uXI+WcEVlAgZP/8zTEUgzYhwpcEEYC5Z80YQE9puxbz34sj55KxVHnempSaS27ey7/BGQPjRTZC0+lDiKuu6SFtpIM50xqVJAMEZSwu/lR17b/8zTEWQxQfspINkwMb0V/iuUJnmutR5k3vRT+/qoqAXbTjTlsAG4YIkSvFT7TJyLvojDlUca2Vil2aXYqQCNTnW3aTSMgQgb/8zTEYg4RBwZYelaOjX1VWF6qDY0JTudkb9BIEwZJN//IUV0CCRSSoYG4GAToIxedu4FHT5TcUGYJj4Zcww3D+t2d4wmNBtb/8zTEZA/ozs2+DhICJECgwFAgYAZSgaZsSgwGT38owg+Ex6Cn//yyIIJiAraaSdKKYMCtKJsXlUpYkjjSLyTgoZGhjjUUWCX/8zTEXw+olqmcRlIEpXlsZWLThqYhoPaCJ49Gp3RHxZgcPYSLL9b4aFNBYROzxyLsg9F2bRre8OAc4+3//+Jx9f+sJ0v0jPD/8zTEWxTZNqhUywyUeT30qZBkvB3ZbEKmHD80rm3eyfcODAtp04JlgUgS5gfO/9785u6UPZMjidHGxif0wyrW48Rjp4DANxf/8zTEQg4ZDrQAwwyQr8WwY1lAj4kQmapu8Zt//L99mka8NPSHAah1M7hVU19hR5tqtxzn3lqAJMCFWagAOoPgbiwmIbHJKq7/8zTERAxw8rgAw8Y8BQU5ZmFyFZUJhyURLpdm0mGWUWOWifUMimU7fTf3MLqB8fULkPqJLp7RYlAUNh62go3+1HVveue34hr/8zTETQ0YTsm+QkwE6yE7eEt9cd1rYoMxIAIX3X7/DTf914z39u2deCAgOI/////1qgE9ADynI2jaimKLIcEaIdngFgANi+z/8zTEUw8I/rjCwwysnR0w8tcn/5nVlYuHgDEUL0wuzrf/whdDxzGcPQQT+s+ldRwIBAcmufMfSOG1GVH6m3g6athi6dS6V9P/8zTEUQ3ZBtGQewY8l0DWruXA2ZKC3pypFTplz40AGBGxCteqeQKEwuqljUySHMAA3DFfEU6iDewm0YQ4rzL+hjh5MgUjFRH/8zTEVA2w7tmYekask15VbbQ50c7GY7f//ykJwZppce5F1m5alm9dquVB0eGWLmzAXRyVxViazca3aklfUMFNlyaGxXXBddP/8zTEWA0pcul+WMSSTsrEsIOfP/n89syy5i+pu2W9Y1LpHdgC1SL/SghYhnxbQi3QrOROtw+nsWMROwrctYpY5ShONSpzEvf/8zTEXgy4bvGYapIDe0Fw6cAYuLyKBKAqIsZHOqYQCgtsgsrtkEYVZPHqvP+hDz4SEtZYtYZAeVwJkwSET1wtEFYuk8072t3/8zTEZgzoivpYWwYudRZxjanA6CACoj7NFzSBPXiSjZQ+JGQreCP0uz6e8tKomBCTgoJjhdhRuDNKS6+Xt3P5PsI20LZjTX//8zTEbQ5AnsWQeJikoiIfLEYNCA0Nf8FVeEM6gTLDswaifqJSqgSiLr25+VcYWBPBY0A0B08RbDQuMa5avDXULKC9nZUAayf/8zTEbw4xBszweZKoz/yB2sCvQmKGUMUSyZjESuXKpPUrsY0MWUvV9WGUeBMFQkeaDISf/6CgNHXa1QC/KVFv9EQlfMfCeBv/8zTEcQyYltGYewYsYC8ZGYqTWE289z210WwutyBKJejFcx4Zp5ktUsR7f//1y0ZD0GAI087iqlRt4B0t+wYgPhPjCJQju5//8zTEeQwQxs2QekQ2DBUV0wu9HKEP4IEHRhKgwQROEkLnfKeVRT74yQIXIBE+c/+lFQAJdBHP+MKaKxBjPm+0JgZmN62FchD/8zTEgw3ZirWYysQ4EYZxaFUwMu2CGzusay+jt5fCQGCcizZ5e1V9vYhX5P9La+AEC7GeIyuJZXYVVEEejKif7TuqAIodlcD/8zTEhg0Y3qwIykZ0D8rGK+OFrgpX4yLhhgWU8YoZGPjl+GqX9UsKbHi4OILlu8PXd545m16/hqQrNAiGyhdCoCSv9RZA5RD/8zTEjBPRftZYewUogG7aAOeKPBB5Wsx8PBoBIo1VU+bNNWnJHXCioePLAT+VEoKle4egktFUjZo7EBO5db/8umCW+MAKMrD/8zTEdw6hBshQexI8EADXPCJVoSgkuYioZRX5/f9OzRJYRlVSVZxnapTNctNf//T+RHWeRpTKhUILIFuVIAoJQQADthyo0vj/8zTEdw0omtReMYYe8KFRq4dkCa7CBArYhEzc7A+BGgRQaDicX6rSpBDmHie/c7//+JxU11JCpA8Ip2oc7gsMzQXEwz4NMx3/8zTEfQ2aGshWGES7rCd27dlpw7RQhHhVK6YG5HNF4iONtt3rbGsRhDyowUWIsLEJGEMLoY/LAHEg2Qj47DYOSwyQkduW67n/8zTEgQzojsD+ekZIWZcl0NEYXAuGTgDRqSue6otJ3zUjxzpT///NcoXcfU23bLbZbJZZa4zWQAAFhkSuZ4mqq2SVKQppQ8r/8zTEiA2A/sRQewaQi2A4aTN1KxdZIocZSiALR1vE10NG1Wp6eKyhYvLRabfvcoPlKk9uY4qv4zKpK2ouRANG/6LFRCX1BBn/8zTEjQ1pYsg5TDgB/xxTy43oLR55l5qJmIH9kgA5yxescdvmUcAoHQlZ2iKA1FiO76lENy1qWIn6rwXE71Lh1AICwnB8ovD/8zTEkhe6NvpfjEACgsGSAfSyIBabb/bWyIh20Qlk33SzDXs9Cmwh0ZUBsjyREHWTBirefvFWeIHdSChgHDir5FE9vv87JUX/8zTEbg7AOysfxhgCm2/31liIhzjEQrRh4JUIHRvVw2xbtIhnV4n+uWWiiJIRbo6Mg3SCOR716pa0GaWfP4oBeiKfrcZS1l//8zTEbgyowvJYMEaunh2S1IYBFsFDCOemhUFQefHkVGRIx8ia290edq1UHBQCIE4REwt8liJ6JG///VXQiou6p6y4NbAfgn//8zTEdg45PvpaGkUmGgCXBPXkxsh03KTiYW89IryHhDbKYYuZp+mTOQiIkmpR9PSlxb6VCQlVqR8yIS3myiEFd0EDbpKNvhz/8zTEeAyg8w58SMo6ciBB2mmMfG1ryfl2KDc0Wa+5iW2XpSRRzNb/1q7B0/V7wzaqTqnThU+7AHFvN0fKClIt/xZukCHCvpf/8zTEgAzIovsYzgwk9P/dAmsRouJTaI16wy6VqAJgFgz4yDDzH09INLplq7WPXXb4GVqEhZxQ5CiVaksE3CjqqZ5mUBVsz+L/8zTEhw0JOsDAwgR8TlJIwzVLHDkhwIs0ppEobSWVS1UVyNUACLygdflVLhrMZ+VNC8Vnul9AdSNAh+fLFwq4I1mQqdLDmgz/8zTEjQzgnrgIyxJk54stxHwFK3/ICjQ0IixqgwoBfvlK58BBVaDLBiq174ksO7CWbjr7ZGEduq/lv7vy3uwYwEMpu99nSdn/8zTElA0IwwJYeYROOnuvRW9E///91cswSs3wYYdrC+LghZps4rb2255//l+FW2pF4UKhs6TqZE4nXlfrgBYAp7mZU/m+//D/8zTEmg0Yfro4wwYonphBFhJuL3fd9Q14g5P46jpDzJRoTO0vogIWqXP/Lqky4GjzzNMsnXqBIvNH4ciz7Ou3zdg3ZIGhET//8zTEoAzI7r2YeMpz28RlgANa1QCvmLbtoA18xoCR2ix4Uaclskzs6+ak2xqsb8joDB53xLCQVO/ukzolLPParaiTv0/xEgD/8zTEpw/BdqwAekZ0LcKrwBcgZV1glQMIJxYMjElPKfm1Hh6Gfdgoyo77QIU6t++wZx0QSekRfDuW9sO+z+RqAlS+3ah8BQj/8zTEowzg7rgAwMyMcPZNFIlCEIIdgJqzr4jmOP/zdoIBIJPu7tXVZQrKR9XLXkYkx5SPQc0w5xOHytVtm8brDJmUHAprOef/8zTEqgyoqtmeYYYqEGH/rvV/v563EfjUD1PfcQGAyoA8BZX1WxsDNhlgeCD/9qAN4B2i4wbGBmQ1X/QWm/ADAAgAFIADsUf/8zTEsgzQ4o2UewQsLgeh//+FzgpQSmQpFBxm7of///9RcJ9IjjSUBBfggUQ3kshcdl6RSRV69TY1+TSlNTSMR0HS0HYcQAf/8zTEuQ2JSn2ZSxAAwJSI7CdLpHqSNU/anU7iabFBwkCPySmxH/DiUHohySdaYPo3zre7Vb8kGmmUNUffLZqId///83WfB3//8zTEvRe6WnwBmJAB5LPi1Uwh9kQrhXwUZIKTLXFmRxAIjOY0v1Kobf6xLrRuURIkoJeG2gXQbo8yYZ0S+o+YMa2U7JNZfVr/8zTEmRhJ9qgBmFgBlubLU5gz3ZFSkJgdMkmZTOXzEvpk8vkuZ6JKHv8+388at//+EQAP05CpI0ABCJAADkBGiZGgf6QRKeb/8zTEchcByqQBmWgARZV2HyujMsDfYGmsJUgwgIB1Flm4sX+sXxV+s+8EyvG6RfzFzfUVU2w0dSNZgNyGpKmkq6+44pFt4fT/8zTEUReR0sW9j0AAG6zjA+XKY4BEAb5QalUhJomFR2zAIoATDKyzaopQskZ5CZ1E3aJE5nP/rZqJmvBRashOWh7YtkvmJzn/8zTELRbaQscfyTABdTj48v3933awJbGma6WOTbN91mN8123a8W+tCMxUPvjvbPsdnaZ7fM8s0Y8mwqpy3baWUFGGGO4CokT/8zTEDAypTu5aGAVigjOZislBw4sMKxZm2MSvv68aExLtpv0Sjhs1QR4kJUiGS6vjl6NFZ3eYiGZfA3qY5EJkug4V1pdYXUX/8zTEFAvY5wcYYEyyri7dIIjTBWQjRc1LsTCKTIxpqUmeS/kRKz/9Cik3Za5EoTJgyDBOACbAeCw2XBtCyB9+IBKOL3nWP37/8zTEHw0oEq5YCIQAJTBIVMRrWTx1eHQmWHwg9/Y23lTslX/w1DL+AJwDMxzkgEIT5xsZtqKzNzkU6EFPXwYXB5jp4Fk7t2j/8zTEJQxA/rjIeEx2iIIIQfB/a16nPLrp3wRAmhwoLs05ky3cnyv29PX/+X3oUoXAkiDsyTZfj7iWoe+z+1sVXOzqYDrzrmL/8zTELwyhfrwAwIx4aUFalSEpLGwi9gA+FFNKRJpUCeIice0Sbx4KuCTCBm4Qfqacf9z3FrqzoJCr5Io//+TcTUAgQQAFABH/8zTENw0gSuZWekwmiO5EAjP22OE3BGpel6PNyOCSIruZI8Zr7bbzUWv01zVH65MuNED3jqqxcOJ/VY0ACbSNAFgFYNKBayz/8zTEPQxA3tL4wkRIYsP2BMcRChhDsCDnAyRSHFbt4VIHg0VnREVeR2fqu/7fU4WJLevIKkptvtpHJJAB1YYUQygSkgjsyMf/8zTERwzIVspUa8QESTV9imbwEoMYZaOIzLdO+TMi6jkAVt/RT1xRwYUyx2RqABf+jC0aD4cHAWUgN2qty2JGiRW1c1hrOk3/8zTETgzQmv5eGEbC/1LgIKpdFXhAgSK8DWraNY60n//DR63MUGoBz/ZoCwYGHezxN4aTHEjHmgl1xkDDwhPofTxUiTVo4oD/8zTEVQzwyspQQEakgHlVECgEaY/RlxcKvE63///9FSCKpbAADPzYDR4EA3lgxYOu6b3pgMaeH5mtlMbhSPaUCCVloKquYqn/8zTEXAzYXtJUbgwISlL+wIcUPf5SbTsRCZMu9QAIYXsAH3CQGmZg8VGiAnE8BkE9yZcNx4Uj2msKO6Xm1MjwgQpgHdbXluz/8zTEYw3g7s5YwYR0e3SOpqsFBgxs3Mv/pHJBbAStFs7ebFnm8BuidF57qA9wra8VTAOD6gAI9Xuu0AXuSuCLuoIJCnMWRJ7/8zTEZhSZrr4OwkaSB0II7w6lUk5mRD9Q4sO1xUoOAuKK2df8rNPJst668hy4dDzyZlep/n7yZg7IvnX7hPXlpNyLQl7yOhT/8zTEThTRps43T0ACCRdlfRrqSbT37uu3/28ktljAAAVISgqLGArMhbMa8iCoATSLyY5eg4AWOKwMFibDwGpU9EM7u1KYQL3/8zTENReBiwZfiUADzjHXmCr4UonSV+RR9IxqVX6KNpu4IjmhT3CMEVHcD/1n/rj5EH/Km5xKXXSW2BLDGkctlKoAyi/x/NX/8zTEEhEZquZbxigC4rv2pnlKoqpXT1ZkRBhnusyaPX//9SOYpRgwXDVMqGK8SDwiJGccJQeaLIzqWJSc1PNVSbjlkkgAiJv/8zTECAwwmtZYCEYGobFslFpubp0yjnmUhwAKhwI0QDAfLvFRggUZC4p/95ujrMpQw7/2HrFuS222SAjDaHGP9SE/AziFgnz/8zTEEg8ZAuJYewZ6KwwFSpMjoq0Pl2drXw/b+u8fsg2SkwsCwd6MvZDDtGBeiZU3Oi7hCmf9Ctt/9ttqIN0AlRxkcyNLlDL/8zTEEA545xJYwkxiOGiS4G+tWR8eIFD0x+eoV+VEro1M4IoAMPMKC7BEii7MUfpnIHgRz//VCqEhvrNvXRds6daIEpIHbnL/8zTEEQzw6szwwYSQK7ievo7DM8TmzZqYQTSk6/NDe9a5ZBwCj+VHPCqPe0qhVzkJR/ZwuzqbxdHNesRgcI5xMhPtEKyipin/8zTEGAyoksjwekxglg44EGuE+ac4a5uhrVkSwKGDrHeJyaE/8qhCAKSctjk6bsJYM4+hzTOzZ1g1nR3w4cOBEEYmf/51vrP/8zTEIAyZQum4SMS61vkNWB5x/k/fsERtQhGtsUFCVQKkCYzRaWcjSFkqIMaQrpw1jAxICqrdmCgICBDhRoN1+z0rMfrcHQ7/8zTEKA0AerBEe8YIX3ddlF3U4fuQnsOvL3iDAo0FI7OqD/mRATP/WnOLe/q06IYqR0FwsFggLCqAwUmwXKKnxlMUFyZRjED/8zTELwxwjrTKMIaM8+mtA/6GjOLyIUKmFvNwWQnssGOkRwirvu/FZoaQClGbcQaGBRbLYsCur/Fw+/2uWsNK/mLvBVWZLuv/8zTEOA0QerGAfhJILhRSZxF5YqeRVQHUHBllyZktcA3Y+00r+vkgQJOldYdSp+J/T7S7g2Zsio1CW/9NERIB7BvbB2I4l6L/8zTEPg0ogpwAw9KIxQpVnLsdo5iqGXwV6tFE0BEmxhLXx0zG1y//9JxVraGiglMf3xdANdsFSRuSAASHScrClAJy89BUWl//8zTERAx5Aqx4eYRsG7hak3eWAUqZWTnD7vBTUtMS2NGhASqqUwUDq8rTp3e3oQHbXLdQz3krhSV7CZE4dcoHZYsexs75Be7/8zTETQzwkqh+YYpqonAOYX/ZTEY3IB+jxwDQ+89PKE71f9LSCgoUSpbbdqABtAOgO1AWDOLZBTRQQfKqlyCmTfUv61QLdej/8zTEVAxY/ph4YETsFNTX7lfsLBtYlOpQ7b2gq3/6qgny4xdv6mstMRhRveqRE2ICYtJWlkkSEi2vF/jQhh//OFC9uZCms/L/8zTEXQ0RSsJeAMQK59Q1Ae3NjI+lc1y6chryCWXVNQn4CQd6GOmIkSi5CSmT5ZPESwaaUOkvmyZvdw6pa+1OeV1eeDdqTzT/8zTEYw5JvoW4SEcMnDjLqCDFWWgXw/o5FHAUJK01E4BJgyyLbMErJWRARKeqRq+3sduyLJWY+md8V/+pB7APY1m0feu1LTH/8zTEZAtAjlQIekZQLzBkwrqXaDuo5S+r6Lh+l+3qXVfy+JZqtRf/mdEe4ZkQQnemjuhCECFCzbLiWwgf1KoXSmtLyySBFML/8zTEcgrwekAAe8wAhH3OQSiU9aKE0e1UXoDDjSWqIBASFgdJkhYe1828eD4qyRzdCbzxNrR489vepSioniNmaU25NbqD33v/8zTEgQqyRiTIOET8AgKFwOkXAwIE5gBcDSbU4FBWdrBWEzpY9LXb/JAqLnW9xH9dnvf/8RA0mgCIIBGq8tcmFNI1gsaiISz/8zTEkQsYMhwoSEYEsegtiURQVW4QgJ4aETpaTErvbUHcrWdyWe1B2s7TAN0C1gD1/1XzFDBQYQ7P////+iexiggRyO3/YxT/8zTEnwvABiAwSEQAMCOGXfFVTEFNRTMuMTAwVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVSkxBTUUzLjEwMKqqqqqqqqqqqqr/8zTEqwkgBh2MCMYAqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkxBTUUzLjEwMKqqqqqqqqqqqqr/8zTEwQt4SdngGEYoqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkxBTUUzLjEwMKqqqqqqqqqqqqr/8zTEzgiiAWheAAQ8qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkxBTUUzLjEwMKqqqqqqqqqqqqr/8zTExQAYBAAACAAAqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkxBTUUzLjEwMKqqqqqqqqqqqqr/8zTExAAAA0gAAAAAqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkxBTUUzLjEwMKqqqqqqqqqqqqr/8zTExAAAA0gAAAAAqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkxBTUUzLjEwMKqqqqqqqqqqqqr/8zTExAAAA0gAAAAAqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkxBTUUzLjEwMKqqqqqqqqqqqqr/8zTExAAAA0gAAAAAqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkxBTUUzLjEwMKqqqqqqqqqqqqr/8zTExAAAA0gAAAAAqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkxBTUUzLjEwMKqqqqqqqqqqqqr/8zTExAAAA0gAAAAAqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkxBTUUzLjEwMKqqqqqqqqqqqqr/8zTExAAAA0gAAAAAqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkxBTUUzLjEwMKqqqqqqqqqqqqr/8zTExAAAA0gAAAAAqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkxBTUUzLjEwMKqqqqqqqqqqqqr/8zTExAAAA0gAAAAAqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkxBTUUzLjEwMKqqqqqqqqqqqqr/8zTExAAAA0gAAAAAqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkxBTUUzLjEwMKqqqqqqqqqqqqr/8zTExAAAA0gAAAAAqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkxBTUUzLjEwMKqqqqqqqqqqqqr/8zTExAAAA0gAAAAAqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkxBTUUzLjEwMKqqqqqqqqqqqqr/8zTExAAAA0gAAAAAqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkxBTUUzLjEwMKqqqqqqqqqqqqr/8zTExAAAA0gAAAAAqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkxBTUUzLjEwMKqqqqqqqqqqqqr/8zTExAAAA0gAAAAAqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkxBTUUzLjEwMKqqqqqqqqqqqqr/8zTExAAAA0gAAAAAqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkxBTUUzLjEwMKqqqqqqqqqqqqr/8zTExAAAA0gAAAAAqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkxBTUUzLjEwMKqqqqqqqqqqqqr/8zTExAAAA0gAAAAAqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkxBTUUzLjEwMKqqqqqqqqqqqqr/8zTExAAAA0gAAAAAqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkxBTUUzLjEwMKqqqqqqqqqqqqr/8zTExAAAA0gAAAAAqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkxBTUUzLjEwMKqqqqqqqqqqqqr/8zTExAAAA0gAAAAAqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqr/8zTExAAAA0gAAAAAqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqr/8zTExAAAA0gAAAAAqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqr/8zTExAAAA0gAAAAAqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqo=" },
			en: { voice: "en-US-AndrewNeural", src: "data:audio/mpeg;base64,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" }
		},
		"viral-female": {
			es: { voice: "es-MX-DaliaNeural", src: "data:audio/mpeg;base64,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qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkxBTUUzLjEwMKqqqqqqqqqqqqr/8zTE6w1KDTQUCZPBqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkxBTUUzLjEwMKqqqqqqqqqqqqr/8zTExAAAAAAAAAAAqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkxBTUUzLjEwMKqqqqqqqqqqqqr/8zTExAAAA0gAAAAAqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkxBTUUzLjEwMKqqqqqqqqqqqqr/8zTExAAAA0gAAAAAqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkxBTUUzLjEwMKqqqqqqqqqqqqr/8zTExAAAA0gAAAAAqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkxBTUUzLjEwMKqqqqqqqqqqqqr/8zTExAAAA0gAAAAAqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkxBTUUzLjEwMKqqqqqqqqqqqqr/8zTExAAAA0gAAAAAqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkxBTUUzLjEwMKqqqqqqqqqqqqr/8zTExAAAA0gAAAAAqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkxBTUUzLjEwMKqqqqqqqqqqqqr/8zTExAAAA0gAAAAAqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkxBTUUzLjEwMKqqqqqqqqqqqqr/8zTExAAAA0gAAAAAqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkxBTUUzLjEwMKqqqqqqqqqqqqr/8zTExAAAA0gAAAAAqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkxBTUUzLjEwMKqqqqqqqqqqqqr/8zTExAAAA0gAAAAAqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkxBTUUzLjEwMKqqqqqqqqqqqqr/8zTExAAAA0gAAAAAqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkxBTUUzLjEwMKqqqqqqqqqqqqr/8zTExAAAA0gAAAAAqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkxBTUUzLjEwMKqqqqqqqqqqqqr/8zTExAAAA0gAAAAAqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkxBTUUzLjEwMKqqqqqqqqqqqqr/8zTExAAAA0gAAAAAqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkxBTUUzLjEwMKqqqqqqqqqqqqr/8zTExAAAA0gAAAAAqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkxBTUUzLjEwMKqqqqqqqqqqqqr/8zTExAAAA0gAAAAAqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkxBTUUzLjEwMKqqqqqqqqqqqqr/8zTExAAAA0gAAAAAqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkxBTUUzLjEwMKqqqqqqqqqqqqr/8zTExAAAA0gAAAAAqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkxBTUUzLjEwMKqqqqqqqqqqqqr/8zTExAAAA0gAAAAAqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkxBTUUzLjEwMKqqqqqqqqqqqqr/8zTExAAAA0gAAAAAqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkxBTUUzLjEwMKqqqqqqqqqqqqr/8zTExAAAA0gAAAAAqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkxBTUUzLjEwMKqqqqqqqqqqqqr/8zTExAAAA0gAAAAAqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqr/8zTExAAAA0gAAAAAqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqr/8zTExAAAA0gAAAAAqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqr/8zTExAAAA0gAAAAAqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqo=" },
			en: { voice: "en-US-AvaNeural", src: "data:audio/mpeg;base64,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+nELVuZYtxrCal10WAGGa/xCE+FcMQhCE+IRCEyEIJhCEIfDnhchWIQg//+5CchCF4Q/FU1FCrn/8zTELgxx4nxUCEb8bDt4UhTuEKozzDJ5Sl+v9ehjahhVZjUHVlQVnXSrl8Ragalj1YSnSKr5bho8JSyaMI3ChAAgsVJ1LNn/8zTENwrgvjgAaEQQgwHmh1rWz7J7j31dK0JYlB97brmuvd8Te1rbXW5iCqtzlZzViL13JruapvjrBVMK2rje/sv8o57m9/z/8zTERgowCi10aEQA/fWd/ueuiX7m3cM4zm9uPhlrDa2pagIcBZP9ggME4aGwAWHGC2lUYGRXQlLVzVPUqpEsgcmlLRfcw8T/8zTEWAyQBiAAiMQBPeKWpWkrQiql4GlAIU4KnQ0oGoSKuUHVHl8RSveOfb9R4S/36KuSln92qkWAQEx0KdOlgafLB1YTDUT/8zTEYAsQDilgeEQAowsPdUp4KprO+IgacDR7ER7xLzs9lnqKukqy2dwrCCWgXKYGpD////RP1T///3YwUMCOR21Zn+bJIFH/8zTEbgigFiQqMIQAQEegnhp+kJE1FhVMQU1FMy4xMDBVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTEhgt4IeQCGMYAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTEkwliDVg0AI00VVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTEqABgBAAAeAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVU=" }
		},
		"viral-co-male": {
			es: { voice: "es-CO-GonzaloNeural", src: "data:audio/mpeg;base64,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qkxBTUUzLjEwMKqqqqqqqqqqqqr/8zTExAAAA0gAAAAAqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkxBTUUzLjEwMKqqqqqqqqqqqqr/8zTExAAAA0gAAAAAqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkxBTUUzLjEwMKqqqqqqqqqqqqr/8zTExAAAA0gAAAAAqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkxBTUUzLjEwMKqqqqqqqqqqqqr/8zTExAAAA0gAAAAAqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkxBTUUzLjEwMKqqqqqqqqqqqqr/8zTExAAAA0gAAAAAqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkxBTUUzLjEwMKqqqqqqqqqqqqr/8zTExAAAA0gAAAAAqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkxBTUUzLjEwMKqqqqqqqqqqqqr/8zTExAAAA0gAAAAAqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkxBTUUzLjEwMKqqqqqqqqqqqqr/8zTExAAAA0gAAAAAqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkxBTUUzLjEwMKqqqqqqqqqqqqr/8zTExAAAA0gAAAAAqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkxBTUUzLjEwMKqqqqqqqqqqqqr/8zTExAAAA0gAAAAAqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkxBTUUzLjEwMKqqqqqqqqqqqqr/8zTExAAAA0gAAAAAqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkxBTUUzLjEwMKqqqqqqqqqqqqr/8zTExAAAA0gAAAAAqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkxBTUUzLjEwMKqqqqqqqqqqqqr/8zTExAAAA0gAAAAAqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkxBTUUzLjEwMKqqqqqqqqqqqqr/8zTExAAAA0gAAAAAqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkxBTUUzLjEwMKqqqqqqqqqqqqr/8zTExAAAA0gAAAAAqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkxBTUUzLjEwMKqqqqqqqqqqqqr/8zTExAAAA0gAAAAAqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkxBTUUzLjEwMKqqqqqqqqqqqqr/8zTExAAAA0gAAAAAqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkxBTUUzLjEwMKqqqqqqqqqqqqr/8zTExAAAA0gAAAAAqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkxBTUUzLjEwMKqqqqqqqqqqqqr/8zTExAAAA0gAAAAAqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkxBTUUzLjEwMKqqqqqqqqqqqqr/8zTExAAAA0gAAAAAqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqr/8zTExAAAA0gAAAAAqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqr/8zTExAAAA0gAAAAAqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqr/8zTExAAAA0gAAAAAqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqo=" },
			en: { voice: "en-US-AndrewNeural", src: "data:audio/mpeg;base64,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omkiVVWscSRfDy3nN/Y4GARJKp/okcSS3Xn+qokRn+mr/61VVa0zM5/+/9EiQMSSkV4KK/5vjBT/8zTE6hBo+nxRTzAANigoUN/ougjAKqAHKj9UCtyichYveYYn4nxeIQnyobqFEtMYz+Z/q3qbylqYKAtwrpU7SDVR795GJBD/8zTE4xfJ1owBmGgAoQE3QAmrU2KaRiQyblZHdHWPa9koy6VPaWtF7vt0vfta+z2sp7LJXlIeL7utEpZ1UstWeNqWCb3c18j/8zTEvhOhko0VxjABq8Hkfsp+u25r72tbetOecc43vYhT4estp9a3rW5hCzBr6bNZ351jkLeXKdbqDpWvbq9pXLs/s4otUk7/8zTEqgxxrlzuEER807Ulst96Lfs3SzP85/1Y4c9ueSSW61zjnON52/9Ozbk1rdUGAVERIleBUVQk+u46wVGljzyw/qBrSCr/8zTEsw3yLh1qWEQddESxgNnREPip5r1DlqEtNZUQkhKYrLUMqDoAvACwNYmeRRLHqgZOw6qsY9mVOxEDXiLWGj1QdUDR36H/8zTEtgxQBhwAWEQBYKh2Hazq6izyp3PRLZMKxCD5C+YcW2tSo+Vk/0DClaWpW/ylK2pS+BCkNlK2hjPKXQ2GOXUpW/zUN1H/8zTEvwwIBiAAUEYBLPYxQ8EQsQF2dn+7GKYapHZ2qiL+iLt/2MUYhyP6f0Vf////uayiIRoPEaBt2xkFqH+rAwaLVUxBTUX/8zTEyQx4AhDAGIAAMy4xMDBVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTE0gtoAeGACISUVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTE3wu6LYgACATgVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTE6w1KAOAAKkfBVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVU=" }
		},
		"viral-co-female": {
			es: { voice: "es-CO-SalomeNeural", src: "data:audio/mpeg;base64,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oAsYoYEcj6KiHZ//0Vdx0nB5A8CoUgkDrLD9XX//8Q+rpzUkVUH1bXIpKPZfuaooGP+qlVWqtUz/8zTE7A1QBjDsEMQBQU1FMy4xMDBVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTE8Q/xwhTUGIclVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTE7A8h3dVKGIbsVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTE6g3htTwUAJbRVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVU=" },
			en: { voice: "en-US-AvaNeural", src: "data:audio/mpeg;base64,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QKgANfpxC1bmWLcawmpddFgBhmv8QhPhXDEIQhPiEQhMhCCYQhCHw54XIViEIP//uQnIQheEPxX/8zTEKgxx4nxUCEb8TUUKuWw7eFIU7hCqM8wyeUpfr/XoY2oYVWY1B1ZUFZ10q5fEWoGpY9WEp0iq+W4aPCUsmjCNwoQAILH/8zTEMwrgvjgAaEQQUnUs2YMB5oda1s+ye499XStCWJQfe265rr3fE3ta211uYgqrc5Wc1Yi9dya7mqb46wVTCtq43v7L/KP/8zTEQgowCi10aEQAnub3/P31nf7nrol+5t3DOM5vbj4Zaw2tqWoCHAWT/YIDBOGhsAFhxgtpVGBkV0JS1c1T1KqRLIHJpS3/8zTEVAyQBiAAiMQBF9zDxD3ilqVpK0IqpeBpQCFOCp0NKBqEirlB1R5fEUr3jn2/UeEv9+irkpZ/dqpFgEBMdCnTpYGnywf/8zTEXAsQDilgeEQAVhMNRKMLD3VKeCqazviIGnA0exEe8S87PZZ6irpKstncKwgloFymBqQ////0T9U///92MFDAjkdtWZ//8zTEagigFiQqMIQA5skgUUBHoJ4afpCRNRYVTEFNRTMuMTAwVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTEggt4IeQCGMYAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTEjwliDVg0AI00VVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTEpABgBAAAeAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVU=" }
		},
		"calm-male": {
			es: { voice: "es-ES-AlvaroNeural", src: "data:audio/mpeg;base64,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wFoUBDCuVuVHCl7MeoCR/AzM33/vGvGN+UrdS6GMbQKAlapfobzUNoYzcuVTAxKPuFcNEQV9QMr/8zTE6w5gFhQAeYYBC7Eq2aNFFLa8dn/mCsGBjeqIrUcpgp0flKVal/8v1L9FDrcqIe7aKqOzliIkEhMc6CxnzOpZW//9UGv/8zTE5QgoDkW+EEYA1UxBTUUzLjEwMFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVU5FUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTE/xOyNfwAelABVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTE6w5p/dQAEMTsVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTE7A7KRUAIMIqUVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExgCABAAAyAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVU=" },
			en: { voice: "en-US-GuyNeural", src: "data:audio/mpeg;base64,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VVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVU=" }
		},
		"calm-female": {
			es: { voice: "es-ES-ElviraNeural", src: "data:audio/mpeg;base64,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VUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTEyAtxyfw4EMRpVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTE1QpxaVgoEYRdVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExQBABAAAMAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVU=" },
			en: { voice: "en-US-AriaNeural", src: "data:audio/mpeg;base64,SUQzBAAAAAAAIlRTU0UAAAAOAAADTGF2ZjYxLjcuMTAzAAAAAAAAAAAAAAD/84TAAAAAAAAAAAAASW5mbwAAAA8AAACIAAAnAAAICg4QERUXGRweICQmKSstMTM0ODo8QEFFR0lMTlBUVlhbXV9jZGhqbHBxc3d5e36AhIaIi42Pk5SWmpyeoaOnqauusLK2uLm9v8PExsrMztHT1dnb3ODi5ujp7e/x9Pb4/P4AAAAATGF2YzYxLjE5AAAAAAAAAAAAAAAAJAJAAAAAAAAAJwDryBP+AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD/8zTEAAAAA0gAAAAAhIH0Uwwg5F//Rmcip/92Z/KYYQf///yNsHyQDJNU2mn//9UGmHAguRf9FQosBBDC4beQMZAd7wAVzw7/8zTEOwAAA0gAAAAA9AzKi0EA3eQtv0QKgHN+Fpk9Z0wTf/a7ew/muTpMdQKAgYhBRimPUOu+9ijlBv2j3whbC6zF/aQN1SD/8zTEdgvCRVAMEEtsjKE/i7fnq6OQJm/PYJk++k2/dMWhA2cOUYOKbi9+/79O9te8cHm3nL12u7J3BkISmz67pp2LAY+8tvH/8zTEghbyQaQASNI4F2nGXdsgen7u6iU/4wmeeuEHJk09yz/fu7bGMAY+DSdQQpE+kRILBue4uPSq4IBQHgudY6eARWosa1D/8zTEYRYyMeAAYZD9hQ8TwByzicEts1cVSsqTJdab7zYaYzmp7m9Ob8tMZEPOwcahEk2escz3sl0gcvEXfWfoNUtlFOVEbRH/8zTEQxV6OgjKYMwpStK3+w9fNQRtNODns/YAieEXHBgeh2oLFhktMmWNTclDveyKGYsU77SrXpU1toCQkpeWTLmxEfrbGMT/8zTEKArIBiFIMIYA0SK11Rh+wA9jquUFEBttuqVnNt++37OEsIgwtjJPCUWPA8AOUwjOaMK4UoZnbB0ElMRHEs1cOwGrTcX/8zTENxUaNhBNSRgB21iZRYZ/Ow8IyDnASYPrngrQ4JzMEoIiNEBKHSMK7dlr7h7UFM+/WpDGAgcI5nvTYZ/mKuAEynj5Tyz/8zTEHRORyjABmkAAaSVNN/E1oHY0S2f/x3P+w5DHP+5+JjuEiWkfDjueri4lf+Z6qyKg+8nI7BRQRz59QypohiRMtIx92SX/8zTECQ9oyoABm0gATO7UOJAgIB0oCAsygFAoE6mEMOvXc7d6H2Q0h/2uqkQRfJljw/BYcXrTZwlwK8VZVy/f/1UgpyOM3Yb/8zTEBg1AppZZ2hAAm7cApyjEct0n1fpYur2M2aWSqSprX1b/9/C/qodnw6NVBO6CJgWa7Selml3//+hb/ACM+iC70B4+wzH/8zTEDAzQLqAUDhgAAmOA58QOEEoGCgY0UgMPid+XJ5RySggcIPVE6wfD/gmBDn1n/wwH1dW+Nl2D7Frnvl+iFAyIyAh1nlz/8zTEEwwJKsQAeFKUdGsdDszLJ2TrBQDYXNwudQhsLkxDPa75f//xwReq+kZBZIoIVEkS5KNshA8hIbzQX4SNJPJQvSCcAxP/8zTEHQvxNtgAaEywQP/9fNiPOTqBpZZ3/5Bzw4MHLhT0x7GEu8AB9IiiQERY/URRI+cAhaf9H+UqN6fqZ2F5eqfu01HVhAH/8zTEKAvpUvpeOYTAv6rP7khydL2ISOuONqSAAX6R8JYtK1O4xxQpmcgEK1ZnAS/Yz/zjcVo42wFeIuRKrrp350ODWDSOox//8zTEMwzw7vJeOIZ6rRS2Y9MGD8TKIwChFA3hlVh1c1bUmR8gxnXqm2rqDtbvM0pcS//4s+YuMDhsSqWCgKLUAKm1jl4l0EL/8zTEOgx4irpQCkYIyO5wIDOvUjaCVPKPCAOjzyqhQitrDsGlQ8kewwz/Q1e+tuhehtPaDNURL6XZ2lscAdi9MlC2RpjFaD7/8zTEQwwIbq5QCAYAB38EZwypyXMkid7eudF7VBNjycZY6wYnV/9gw//ZbpXXO71dlCbwLA2kax7eC2/0yF+Obf+bSiK/U+T/8zTETQxg1sJ8AYYUB4RmRVu5afQh/Qh60qc5f9v//9VQo9BBb1jlgEotrH+QJgXD/5LHm18u9N+jkObPbDzYBgowAEBZStj/8zTEVgyx0rAAwgR80C4PONi6AZcn//a4NpHKgCaASIDe9wgCsDqZ8wbsaHWHM7AFvfQT0vJmUvJmjdIUKYMO7eaU87aarEv/8zTEXgxY4sAAggxY9f/rBUVb99UAsxxwqSiWQWiQvtkWnLjwQCVppS0M6WppX00dTGKWlT00v/XGgyTJUj3/9C4q2zIld2n/8zTEZwzI1sGSO8Yockutt0krQLqwUIR6ctGOCI0d3yOmkSWvtHXY2GAJoXUHxAJ6E08mgMk0hwR0pd20mQT//1IlwySSOJj/8zTEbgzBOrpYAwQMgH+mjv/NCfDqHAxdFEotBvdx6fU+vdXcEJYgZm4mOEyhmQSCBmSQe23folv93qoKQFZq/wWEAFl+XcL/8zTEdg0out5aCYYGKEjHqYDgWjUd3LFQ22jAhA6TCkGeWU0ta29SkAObTYzIyYQfbozI8f6aWFnf//VVAtRDQcANxnwZY2z/8zTEfA0g8rZaGEbggBdFrCplrJs2Uf7t6fJu5YRBkFsilonFhC3mFGz201Nqe2mDJsuklbkOgYghTnptpZ4+0Cu6xxhy+z//8zTEgg7JKq4gekxUxbFSNKqKuuvklG/CINW7Ab7jrogWE6p9wGVRRsm+ZQ9KEv0mQ8yZmAfBkmk6UBMCwgIkQIhySVWzz4b/8zTEgRKJKrosk8yQ+NmzuoJyZ08WnwiloQegQUWhdSba735EH5gAHrOBJD+YBeF3DoF+eVAWNrkMwsa1rotyZt26UGWYco3/8zTEcRJxGvY4K8w+HigdUGoFlDxcOrPxXqFg6TaVPKPxDQ/iGToOyioAjgAHWJ21Y4wfWUTQixS4HgDNaoYj7WglfmLfglH/8zTEYhAgruo+atKkOvkbr2G7Kp520VqlTiHSAv/pJAWyc4kBwDnqKmM0JcwbAE0DTlTjhFTvBnlZugghNOohuGQ1a4glxkb/8zTEXA8RGt42asSU6pyhCbkT8mNRRu+K/QeuQ67soqddQ5X52mpkU2ZdkkhrBS9QdARXXZNZnmkHvQhb01LTtUJWyfFJHnv/8zTEWg4REtJMU9Qo6+vNO1GjY8/JV1bfqqOwdnZFiJmoaSCm6KRdAHBrUM8JPiIBmm49xViws7UEpvyKZCxB0wvv/TnfQK7/8zTEXAwxItJoaw5QL1npH/8hHHpCh772BJgGcg7/eIXMO3/JL53aAANvsHnf8NmL4Ok8vyTfY0x6s3Orn+uK28owJ50kPwD/8zTEZgyw+xcYisRyv4c/8zKV/6Joi6ZlkAwWAAbWFc1ZPFvvwjkCbaKMa95C9v490SQymW8biGdNh3M/oKxHf8eHthgfvrL/8zTEbg6w+spUC9IM5TvgjhrvSj/6mCn+44mPN67QBgTAAZUJ7Ffqd+WLbeW8R7RG8QEs6UBViHRkXXFYiRzSJCVGBsnc1v//8zTEbhBA7t5+a9hwG/08QVdOyP//lwE/+G5MxYAYCgWgAPzq2asFVVHECJoJ6iJ61mva6+GlSRkhMI+pUrSw6msAfqf//4j/8zTEaA8ozuJeC9IMRv+VWEmklREipGU97cAA6D1QFurDAUoNDJtsMqkdKk0Nf/5SFAzPDUDBUZdOyvr9bnLO+0NCISsEqhT/8zTEZgxQysl+MxBImy3KNCNGv2FwwiBoCIBN8rlTe5XBg9g+0mZzZVrSLKbgxcXUbbmF3jv+nEp130+1tZ7qShNQ+GzDIlD/8zTEbwyYyspeAMYCZJxOBsVkAdNMKQhqtgBUCCQAEECCn0exwQ0+84xn1tX/+L5T+B3zKv/lxmSVvdWIoaJYwr/09syRDmT/8zTEdwxY1kgASFLAOT6kANWHHEK380WfK4GFEgREAZ4UCw76CfGiVhtjmHv/yCFNIWWITiP/7fkVKxobkww5n/t/GYKYcoj/8zTEgAxYukwBSRgAoFwmzdv/9/+UBcAuMnz6FYDD//ANWttSmW5WXLGcjQ2HGLQdKFoF63UaUmyKU5lgXQXEgegiKArEQ+//8zTEiRdaWoQBmaAAsyCxeLnZbSFW4Sbq89xK+DgmEYw/REqb/4SIp1iDBcro4ORHXc8xN2j2n/+iB4eligypVVOCU7pNZBL/8zTEZheiAsT1z0ABAAY//NADUi1+VjeUUrkKm1SE+Me9YrUiIn13w4M6zqDt2YaFomZXSZSenUpmmMHO3v///UOLhMEzdnj/8zTEQhEJkwr+egUiiraqgg70h8BJgAA/0QQqXObK4EREMZ4UoM1AL0PFj4pncZFExWqNbKLQcN2aGxsgkj2fj1A/Fe6EomP/8zTEOBDoztJeC9YcX/olRVsj1QIokIh1Yg49IOXcfulhLL4es7mg7ay4PsSyPpdW+yCw4v0XYQgNvzLIFXKTOAzeZvf1T5P/8zTELw5xHsZAwwqQiIqfJ1/4df1/JGWACsmUmSgAKuxmAriKW6ysBKi3vUTgcR+AmF/2KDesEhyCs/2AQD0EeDbFsCVCDTL/8zTEMA0A3s2+agSsv+S/6gsGS9bYChgwCCuMKCVAmxMMleAxJsWzFXzlN8DQBQFjmujVtRht8wuCqFAzp3OUIdPU5hhm0kT/8zTENwx4rrA4eZBk6MktXrLK23dxaJa4d+ImhWZz9KkpmId9h04i95mWyidGUAEb+3tGe1gAMj8ACqs/rrrZNl8Axbel0ND/8zTEQAyhDqwAwMx1aPbIvzFNoVX0pQob5e1QuEy0Uu3vzCL7fLFgaAw5IOH1NejSqgzL8C/BRdo0Fv5IGxkpm+EWp0AQz1P/8zTESAxhCxJYKw4qACaQODSpQWKqeQaLispBRyv/oZFD4qRt/0NNzqk1YGJb+9cV/SkMyVkcnQu5k6MghGdAxMwgVSggflj/8zTEUQzZFsGIDgoIq8EN9YKegq5LOWPFw07/yQWOjRtKSlkIDFdH5AWi5eQzQGNGk2xuOQIbi0kws+5dZeY37PMjGf+pS2f/8zTEWAxotuL4U8Yk0W7r//5tRrXdd364VYLrVSCABBo5QPEFnhkpiMX1uLBKW7RavKAmVPIGCpUq0RIRRFFJWLFQ17qrVbz/8zTEYQypjrm4E8oNqMF1iu/d4d9sNwAE6Q9sKe0woK3AosHSdgdKDYxxO8PlBY5s92trv9j+n+oElAM/II5zOsQnA33vjEr/8zTEaQwgiogAywZMU5FLHTgfCrP4boIpTIDOVhCZ7iEugQnkqZIkFAYjRQAgYi3+uSZ4Cgx7mQOmyuZFQwrkFRAC6Dn/F9v/8zTEcwt4RvJ+CkQKkwK7JbI43BQB6yIF4ak4A/IqQ5xqmdIm+44FLlEcxnx8kAaiZEeb/2FV7tCVzhT7bTQc5/BMkMNC4rD/8zTEgBGBLqAAwNKwvycKyK2kIOCRjFXBcn+VOH/h//dZ/dIHVJxOb1UodFEA8BBv/6YGn26RFNygAf/4T5Tl5pzBWzrorpT/8zTEdRfxuu5em9MqoGS+aF+RuM5RQFF+EQ4KcBhT39+giYmdwZD22q24BhZZNblBdY7O37bl55zf+a+s+DlWtEAnDOgg7yr/8zTEUBRRwvZeeUzv1yrCB325gCPgAfnThYD49asPKgdnag4VDlATtmDH6BRiLDL5rdeUolINJgaodKho6SXgW3apIhcIjwb/8zTEOQ8w7t5eYYRogaPXLkCJba/lgazjKmFQlc7gKTGO1Vc5mKbZU8E8sCCKFXuSJHAwg+Qm86Hlf/e5zVXs/L5c+coMju3/8zTENwzgirm0eYRMkN8/U6aTrclVNcbqt+f5pDEmdjNzFfYEI8o+hhZOp9msdXESYYz1FHX/oghdwI2/4tx86MPEVSS3fPH/8zTEPg/xRq2KwJKYZTIij+NuBRAAN/9qAOSTnRNpFoxpzaBRU6EXU5BXU3nRFeQSVf+3ViqYABht7UmbekD0aWXCe+r6uhP/8zTEOQ45RsJWeIy4isv1tsKcH4Ow4jGetyeAVVTBQgB0S2pFZoeBSgRSD7AoDwu0an2+IDoStY0vf+U7EK5J4ZmapyjgDKj/8zTEOww4WvZYC9IKnreRUByy3hEdD1kBgkIBMwk8PvqDCgOtbxjtdIaRj1ggzt5JylIb//01TIc220AEwAGUBZdlJDax2Ln/8zTERQzYWw5+C8YK3XPgBSRPzL5fn7+7lovorBBcaFhd7DgoNa9r//gwBTRHrbGU7Y3UcAAnLgmDLKoNf0hJcTE28FL9pbv/8zTETAyw4upeCwYMa2QVJZvlIg5QMrEUFrl5ooWf/62GzKaPsVMzKLLEjBKABPIiv8S1mAz8gwCh3vG6pYbyOFEVRaqUcwL/8zTEVAxwuvpWSEbmAOr5v//3NiXKU/9wndUvyqm5+TKJPuslHf5AREfPbggTuA5vzvzLizOTEoBoCBkCwpSjE8jU5v61QHr/8zTEXQyxJvr+WcTGiJlD/3XX3KUAqEIb1gKEqPkWFb23iTDskwtsbWzqsfy33GHpEeTEIGWy1oVt5nsn75qhQiLNK/7GGHD/8zTEZQxhHrAAwgqUOJC62T8ALZgJsHlM4I0UpiJaWPR1l09otl1Ly6ChS/5kqb/MhjZgI31//r/o3+sivSaEIknZ1mApEpH/8zTEbgyBFrFwekR0FexqxgL+W80hSIRRmLdRr55FsRh/x8x1CvbalwYnRIYBEkxsETiNzLt2z4//Spdd5fDu1sZe/Lic8W3/8zTEdxTiSrW+aJ78Pr3563ytNcuf///Xz0U+cQV/6uVU4IDgT6y5OKljxGdAnYNNOIMbI/j3NdEpMgpMj1fDtUDe4wtqclD/8zTEXhbaSpGyMd+IKLLJYRxio6TspDfpr/sh70EUCABsOD5BJh4qJPbL5cmEpMBG05dX/7q5rkhtnSwyGf7Gfr0VGsEDl/L/8zTEPQ3ZhtJYKFNmSAAFBBcQrkfnvOiMJBUjqCp2ogmNDpYJDAWKlvK/CpjnlCWJTESkjwTEQGHIJkkH6D/ggDtPgGwHIXD/8zTEQAzwGpW8CIQAWGcu4m5cxwAB1unNg6RDLP0nykTiOYF/p5POFy/+XU7/0CoKq19i1Y/auUJqRKuYzDooNOMUfmtKgCP/8zTERwzQdpGSK8wIUz8s6VdFLjEAKDfO9EUyggfA9rOUy9oeA740X0fq+iNr0I1BNRhhoiBBioo9h6QZsW+w+QoUV6NsGxb/8zTEThQxhowA0VMMrpBBAAtttttk6QDyfwS4CRa0Y+cT6x03dSM52aBCbO7alALhR4XGAU15oPnwcPXyW/z/vr02/C/9k3j/8zTEOBNJlrZYbhZwQGYOTjRvZuzdu2y2uDMdK1HzS+HrKoUZGleQAKx5FYwg2PYJKOmNmAkt5SPtyfAK5QFAE34f6F0FdfP/8zTEJRCh6rmWesRze/9fLzdRPpyt15Wq7q9fXdybshGCACN3IHDI8inKQ4VlWgCv4socqp8I5nW6MW9f41nGYOt4fEdDGnL/8zTEHRMCPqheeJ79H5vNR//MBNL/49l//9mdzkdjL+16Hbs/vC3PD+q4ePD8zMzwm5kSIh5/HgXd/dcOtyRaMAl65q9RGbn/8zTEDA9iPpW4MFM12p+/753z7WPONBFFvd2+G27AuPCv/8hP//kJv2+S/+puMrdjf1e1Z/E9ZeKJgKhboJo/uSNyRp9AgPz/8zTECQyA3rm4KEZSaTKpY6Q7JmMYmLZKZ5eqW403yBMByLLHBNpYSoe8G/p9wqlO6z02im4uWS2SWQJgF2DNCUAFOcL9a5D/8zTEEgyI6sZcKYZCKkZbvzBuzmVP0cJ2Lk4LF65pNsVHrT/+suo679zVoXXVA/ur8J3tBaZmGaieIUTfWC0UygQsFndDLBr/8zTEGg0iMrGQMES8GNQoLtHAYJtc2b2R////rjKcjf6LrVv0djiFH//3oMbM8Z24N3plj0KN1hzJQBKVuzLqKPLH12gNG+D/8zTEIA2RKs2QA9ARgGivbBwAoHp1SLi83G59fu1fUKOu4hUWGzqIAb2cQIJk3HJIKyKAvwMYMDSCFODOdn1AMvnFJkePi/r/8zTEJA3JMtZQkw6oD4NN1BeS8fbz255j6j5L7KXfyioDlqX7WSTX+Q/r08NCibQWLKLVK5zIAEwfvgexNfym39Ay/0HX+mT/8zTEJwxAzyr4A9YSaMVfD1Qx/oj/6Q9MnXAKdAA+y7lLmlyjnp5cYItZ6hAhtQrguLbT7Ck2X4hCIM1Cw/g8/+yLb/+tlLr/8zTEMQz4ovpWA9gKpuklE1r6WqMl3EaR71qH2knOrOmUe4/sFhP7SdkGIEt97W6emisuAjzhetvkTRMdACLlP4QxUAARALT/8zTEOAvgqv4wA8wSQr2ORG5gQFQdW+GrXqXuqfMJ40AZuEjQ8NXpqtqQ5n4Xe0Ci7gC8UT/kVm4gIuhMEhkJqbn4dX4iewj/8zTEQwy4nuV2A8wORxz419nMPFBSQODEjjzXETDkzI06g3S09+VKKQgcmRFqcndQN9ulQEh02EMrOg4J84PAk5pedp/g36X/8zTESwwgltYYC8wEhSUIJBxCg8qkklpo8aR+piVXMWNKuAu0Zx3dUJImbwSIdH5URvcvdNvEdvorG+q4NoQtUerEMddLV8j/8zTEVQw4jtY4CwwQK3Kkbknr6kc/O65GSuURiD0CADHehDwIWxTrPrujYRfged7WM+YtLUZbbLgzrYVqqfJWzypVRZrEdgH/8zTEXwxgoqzQw9g4BvpPLpUACpkiK2i0AQsxAYxaSwBS91TizT1lWQMxjKxtRFsvHwEHTmBRwDKme/MgFfyu93/1/9iAH0T/8zTEaAxgpqAYHhIICJgU+jbcVTBk0N2xQMnFq5wCL5UXvHjaidkOR6DZWcJliM1F/HnRCC/Tt+Vd//V/dq/rAPaFl+HoAFH/8zTEcQy4mqpeewpEWZUZlFYaKoW5sYR9UNPIB+8LZdD9f5dRzowKen6Po13djFoY1RqTn/5lx8UCb/7lVSpGjK4bdjW4YFD/8zTEeQ2BKngA3k4oFYCw4Y+GNCzZ6mbTacKXfcjN5aw+32qVJ5k2i/vBgVWJimhZ9TxO/ZeMeoXVVANMjPENzURbskyaOOn/8zTEfg4JIpG+wkpo5zdA0OpL90DRIxND7/QZRpNThTPpfmiE0WmaklRQP/2MzdN2TSMTBA+Spv/3QHOboIGBKD0JE3STJUf/8zTEgA2QUmgZWxAACIIF5CE//NEH0PxKROwnZdKZqcM1drttllkZcCDcG2bOG62qMLlRVLlnzu7lMrO4czKU/Q5SiyDkedH/8zTEhBdiYpQBjGgAzTNv6NYpAhCz3/9u7fb/9EAg0VG1u+sAkDurHhI2DAHaGNXUiGAJ2i03TEs5ZkxKM1e/5VGQYScF4Kv/8zTEYQ/B1tZdxhACXpW5+xrMdxgRLpW4r2uqNhr1Hs6DIciV0KCYUEoESJRe8acq8RNpge1VeQuiWzUNfaGxFPpkMHaCEoL/8zTEXQ+5MqG8EEYgdSZ5qej6vOQq0N/09HsWiQYksl3+1w1biwclquJgzAAGEJE1/pAwo0Oih0adlrLN0o/ZbgMBAMUkXgv/8zTEWQ5RqnzCMMTsJc4jQHfr6FFnrKnSL9jM9UoKxLUIU2nEApHQXOMVpQAzULSxQs6DL9ubleuaklbbcYCvh21qsFWUUfv/8zTEWgyYxng8OMQUGKC3YBEAY0gqAoiHAyEnPz0tltcSkX9/8s/dUDXVyLL2MufX3M1VEH1UmbRjDrCECqcbKDjihW0PEhr/8zTEYgn4wkwAeZAE1hdTInN5E8puPiwu1205iwSnjZ8LmRjFCTJm0CE5GllgB5RO1sSUVVb6pe+ki5jqev4DNFKFuV5D88n/8zTEdQlYEkA0SEYAvs20VRCAHPLHFC65ouG1ILLuMpppCZAgiBkI6iLA852lD6xnehylmW4yPsC7lOC5dCoSRmZlCfnhTz//8zTEigv4ChwgOEYA+GXD9Ul9V+M30KGvg1Eup+o6Hb9ZJl5HW4RYiAuDT1uqyE+Io30KArnVgsVWEg7JA0qGpbhqITr+s7L/8zTElQiIBi2UEEQAz6BEkqdz0qCod2RLLD6gaPQVhRV/qqeplVOYoYKDCHZ+q//8yqz/Vf1RP1RDs7OUwUGR2//oikdv7sb/8zTErQtIChikMEQAChg61UxBTUUzLjEwMFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTEugpQ6fwAMEY8VVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTEywsAScQACEYEVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTE2gsaQRwCAAQNVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVX/8zTExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVU=" }
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
