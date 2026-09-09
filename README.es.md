# Spec-Driven Development para Odoo

*De una idea a un módulo Odoo probado — con o sin intervención humana.*

[English](README.md) | Español

<!-- Los badges se resuelven al publicar en npm y hacer público el repo en
     GitHub bajo fhidalgodev/dsh-odoo-sdd. Actualiza los enlaces si publicas
     bajo otro propietario. -->
<p align="center">
  <a href="https://www.npmjs.com/package/dsh-odoo-sdd"><img src="https://img.shields.io/npm/v/dsh-odoo-sdd.svg?style=flat-square&color=cb3837&labelColor=161b22&logo=npm&logoColor=white" alt="npm version"/></a>
  <a href="https://github.com/fhidalgodev/dsh-odoo-sdd/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/fhidalgodev/dsh-odoo-sdd/ci.yml?style=flat-square&label=ci&labelColor=161b22&logo=githubactions&logoColor=white" alt="CI"/></a>
  <a href="./LICENSE"><img src="https://img.shields.io/github/license/fhidalgodev/dsh-odoo-sdd.svg?style=flat-square&color=8b949e&labelColor=161b22" alt="license"/></a>
  <a href="https://www.npmjs.com/package/dsh-odoo-sdd"><img src="https://img.shields.io/npm/dm/dsh-odoo-sdd.svg?style=flat-square&color=3fb950&labelColor=161b22&label=downloads" alt="downloads"/></a>
  <a href="https://github.com/fhidalgodev/dsh-odoo-sdd/stargazers"><img src="https://img.shields.io/github/stars/fhidalgodev/dsh-odoo-sdd.svg?style=flat-square&color=dbab09&labelColor=161b22&logo=github&logoColor=white" alt="GitHub stars"/></a>
  <a href="https://github.com/fhidalgodev/dsh-odoo-sdd/graphs/contributors"><img src="https://img.shields.io/github/contributors/fhidalgodev/dsh-odoo-sdd.svg?style=flat-square&color=bc8cff&labelColor=161b22&logo=github&logoColor=white" alt="contributors"/></a>
  <a href="https://github.com/fhidalgodev/dsh-odoo-sdd/discussions"><img src="https://img.shields.io/github/discussions/fhidalgodev/dsh-odoo-sdd.svg?style=flat-square&color=58a6ff&labelColor=161b22&logo=github&logoColor=white" alt="Discussions"/></a>
</p>

**Autor:** [Franyer Hidalgo](https://github.com/fhidalgodev) — `fhidalgo.dev@gmail.com`

## Resumen

`dsh-odoo-sdd` convierte DeepSeek Harness en un pipeline de desarrollo Odoo
guiado por especificación (SDD) construido sobre dos principios fundamentales:

- **Bucle de feedback cerrado**: el agente instala/actualiza módulos, lee
  tracebacks del servidor y reintenta contra una instancia Odoo **real y en
  marcha**. Este plugin NUNCA levanta Docker ni procesos `odoo-bin`: el
  desarrollador provee la URL y credenciales de una instancia existente
  (dev/staging) mediante un `.env` gitignored, y las tools hablan JSON-RPC
  estándar.
- **Seguridad del pipeline**: las fases se persisten en disco (`state.json` +
  grafo KB), los gates son fail-closed con marcador `APPROVED` explícito, tres
  fallos consecutivos fuerzan un paso de diagnóstico profundo, las iteraciones
  verify/fix están acotadas, `stop.md` detiene todo, y los veredictos son
  honestos: una verificación fallida persiste como FAILED y nunca puede
  reportarse como éxito.

Lo que NO es: un orquestador de infraestructura, un gestor de credenciales por
chat, ni un auto-committer.

## Postura de seguridad y red

- **Sin teléfono a casa**: las ÚNICAS llamadas de red salientes del plugin van
  a la URL de la instancia que el desarrollador puso en `.env`. Sin
  telemetría, sin comprobaciones de actualización, sin endpoints de terceros.
- **Guard de transporte (fail-closed)**: `http://` solo se acepta para hosts
  loopback (`localhost`, `127.x`, `::1`, `*.localhost`); cualquier otro
  destino debe ser `https://`, o la carga de credenciales se rechaza (http
  plano a un host remoto enviaría la API key en texto claro).
- **Contención del secreto**: el secreto se lee una sola vez en
  `credentials.ts` y solo se inyecta en los parámetros RPC. Toda salida de
  tool pasa por redacción de dos capas (secreto conocido + formas genéricas
  `password=` / `Bearer` / `api_key=` / `session_id`) y enmascaramiento del
  home (`/home/usuario/...` → `~/...`) antes de mostrarse al modelo o
  persistirse en el KB.
- **Las cookies de sesión nunca llegan al modelo**: `odoo_session` escribe la
  cookie en `.sdd/session.json` (chmod 600) y devuelve solo la ruta.
- **Sin scripts de build**: el paquete no ejecuta scripts de instalación (el
  default pnpm ≥10 del market se mantiene); distribuye fuente + paso de build
  documentado.
- **Requisito de host declarado dos veces**, siguiendo las convenciones de
  descubrimiento de dsh-market: `engines.dsh` (`>=0.1.2-rc.1`) y rangos peer
  opcionales lockstep sobre `@deepseek-ai/{cordis,dsh-tools,schemastery}`.
  Ante un host sin el servicio `tools`, el plugin se niega a montar con un
  error explícito en lugar de arrancar roto (fail-closed, como el propio
  market).

## Usar este paquete

### 1. Configurar credenciales (una vez por proyecto)

La vía más fácil es la tool de onboarding: al iniciar el pipeline, el agente
ejecuta `odoo_setup mode=check` y ofrece tres opciones — **configurar ahora**
(recoge solo los campos NO secretos y escribe un scaffold chmod 600; el
desarrollador completa `ODOO_PASSWORD` a mano), **configurar después** (se
vuelve a preguntar antes de la fase VERIFY) o **saltar** (sin instancia; las
capas RPC/UI pasan a verificación manual). La decisión se persiste por
proyecto y no se vuelve a preguntar.

Las credenciales se resuelven con una **cascada de ubicaciones** (gana la
primera existente):

1. `ODOO_SDD_ENV_FILE` (override explícito de entorno)
2. `<proyecto>/.sdd/.env` — scope proyecto, directorio oculto del plugin
3. `~/.config/dsh-odoo-sdd/.env` (respeta `$XDG_CONFIG_HOME`) — scope usuario,
   el default genérico: un solo juego de credenciales sirve a todos los
   proyectos
4. `<proyecto>/.env` — ubicación legacy, sigue soportada (se reporta como tal)

Configuración manual (alternativa a la tool):

```bash
mkdir -p ~/.config/dsh-odoo-sdd && cd ~/.config/dsh-odoo-sdd
cp <plugin>/.env.example .env
chmod 600 .env
# El desarrollador completa: ODOO_URL, ODOO_DB, ODOO_USERNAME, ODOO_PASSWORD
# (se recomienda una API key de Odoo en vez de la contraseña de la cuenta)
```

El plugin **rechaza** un `.env` legible por grupo/otros, **enmascara** el
secreto en todo log/salida de tool, y **nunca** devuelve cookies de sesión al
modelo (se guardan en `.sdd/session.json`, modo 600, referenciadas solo por
ruta).

### 2. Componer el plugin en un perfil DSH

```jsonc
// ~/.dsh/profiles/odoo/package.json
{
  "name": "dsh-profile-odoo",
  "private": true,
  "dsh": { "profile": { "bundles": [
    "@deepseek-ai/dsh-base",
    "@deepseek-ai/dsh-web-app",
    "dsh-odoo-sdd"
  ], "patchReload": "live" } }
}
```

```bash
dsh plugin --profile odoo add <ruta-o-paquete>
dsh --profile odoo --dump-config   # inspeccionar la composición sin arrancar
```

Configuración opcional vía la capa de parches (`cordis.patch.yml`):
`projectRoot` (raíz del workspace) y `specsDir` (carpeta de specs, por defecto
`specs/`).

### 3. Tools registradas (model-facing)

| Tool | Propósito |
|---|---|
| `odoo_connect` | Sonda la instancia: versión del servidor + autenticación. Reporte enmascarado; distingue los estados `NEEDS_SETUP` / `NEEDS_SECRET` / `DEFERRED` / `SKIPPED` (nunca pide secretos por chat). |
| `odoo_setup` | Onboarding: `check` (cascada + gitignore + modo de delegación), `interactive` (scaffold chmod 600 sin secreto), `later`, `skip`, `reset`, `autonomy` (supervised | autonomous). Los secretos nunca se aceptan como parámetros. |
| `odoo_module` | `info` / `install` / `upgrade` sobre `ir.module.module` (`button_immediate_*`). Devuelve la salida o el traceback del servidor, redactado — el bucle de feedback cerrado. |
| `odoo_execute` | CRUD/RPC genérico (`execute_kw`) con allowlist fail-closed: lecturas para modelos listados; mutaciones (`create`/`write`/`unlink`) exigen `confirm_destructive=true` Y el modelo en `executeAllowlist`. No requiere instancia para evaluar denegaciones. |
| `odoo_validate` | Validación LOCAL del módulo sin instancia: `__manifest__.py` + depends, los XML declarados existen, `security/ir.model.access.csv` cuando hay modelos. Devuelve findings file:line. |
| `odoo_errors` | Lee errores recientes del servidor (`ir.logging`) — el equivalente remoto de obtener los logs del entorno. |
| `odoo_session` | Mintea una sesión web sin contraseña (patrón `connect_as_user`) guardada en `.sdd/session.json` (chmod 600) para pruebas UI con Playwright. La cookie nunca se devuelve. |
| `sdd_phase` | Máquina de fases: `init`, `status` (incluye resumen del logbook), `mark_spec_loaded`, `advance` (gates fail-closed + provenance `approval_source`), `fail` (escalera de fallos + veredicto FAILED), `succeed` (veredicto PASSED). |

### 3b. Modo de delegación (de una idea, supervisado o autónomo)

El plugin empieza preguntando cuánto del pipeline delegar — se registra una vez
por proyecto con `odoo_setup mode=autonomy decision=...`:

- **Supervisado** (default): cada fase con gate pide `APPROVED` al humano.
- **Autónomo** (de la idea a la arquitectura sin intervención humana): un
  agente **proxy humano** (`agents/human-proxy.md`) responde los gates,
  emitiendo solo un `APPROVED` fail-closed de inicio de línea o `NEEDS_REVISION`.
  El humano hace la entrevista inicial y se va; `create_goal` continúa rondas
  sin atención hasta `DONE` o `BLOCKED`. Se mantienen los frenos (stop.md,
  techos de iteración, escalera de diagnóstico); `BLOCKED` es la única forma
  de citar a un humano.

### 3c. Capas de Context Engineering

| Capa | Componente |
|---|---|
| **identity** | `agents/*.md` — personas arquitécto, desarrollador, QA, consultor, proxy humano (rol + límites) |
| **odoo_connection** | `odoo-client.ts` — JSON-RPC auth, execute_kw, sesión |
| **executors** | `odoo_module`, `odoo_execute`, `odoo_validate`, `odoo_errors` |
| **schemas** | plantillas con secciones obligatorias; `transition()` rechaza una fase cuyo entregable carezca de ellas |
| **knowledge** | skills de patrones Odoo pinneados por versión (delegados, verificados por el skill) |
| **skills** | `SKILL.md` — el flujo de orquestación en 5 fases |
| **logbook** | `kb.json` — decisiones, descartadas, blockers; se lee antes de proponer |
| **audit** | `.sdd/audit.jsonl` — log de actividad append-only sanitizado |
| **test** | `tests/smoke.mjs` — suite de invariantes sin instancia |


### 4. Protocolo de trabajo

El skill [`skills/odoo-sdd-workflow/SKILL.md`](skills/odoo-sdd-workflow/SKILL.md)
define el protocolo de 5 fases que el agente debe seguir:

1. **READ_SPEC** — asimila `spec.md` (inmutable); prohibido escribir código; gate `APPROVED`.
2. **ARCHITECTURE** — diseña modelos/vistas/seguridad en `architecture.md` + `test-plan.md`; busca primero funcionalidad existente; gate `APPROVED`.
3. **WRITE_CODE** — implementa con patrones Odoo pinneados por versión; gates estáticos primero (pre-commit, pylint, ruff).
4. **VERIFY** — pirámide ascendente: estático → install/upgrade vía `odoo_module` → RPC/datos → UI (Playwright + `odoo_session`) solo para flujos críticos.
5. **FIX_LOOP** — corrige causa raíz; 3 fallos ⇒ diagnóstico consultor obligatorio; 5 iteraciones ⇒ `BLOCKED` y escalado al humano.

Artefactos por spec (todo en disco, reanudable):

```
specs/<NNN>-<slug>/
├── spec.md · architecture.md · test-plan.md
├── verify-verdict.txt   # veredicto honesto persistido
├── state.json           # fase, fallos, iteraciones
└── kb.json              # decisiones, blockers, diagnósticos, learnings
```

## Experiencia del modelo

El agente ve 5 tools con descripciones autocontenidas. El flujo típico:
`sdd_phase init` → leer spec → `odoo_connect` → fases con gate mediante
`APPROVED` → código → `odoo_module install` → si hay traceback, `odoo_errors`
+ `sdd_phase fail` (puede exigir diagnóstico) → corregir → re-verificar →
`sdd_phase succeed` → `DONE`. Las respuestas son texto accionable: tracebacks
del servidor, razones de rechazo de gates e instrucciones de remediación.

## Limitaciones conocidas y trabajo diferido

- **Tests remotos**: sin acceso shell a la instancia no se puede ejecutar
  `--test-enable`; la capa 2 es pruebas vía RPC/UI. Pendiente: una tool
  opcional `odoo_run_tests` si el desarrollador expone un runner.
- **Rollback de datos**: las pruebas escriben en la BD conectada; no hay
  clonación efímera (decisión de diseño: la BD la provee y gestiona el
  desarrollador). Mitigación documentada: usar BD desechable.
- **Multi-instancia**: un solo target por proyecto (`.env`). Pendiente:
  perfiles de instancia (`dev`, `staging`).
- Sin renderer rico `presentCall`/UI en la GUI web de DSH (solo texto).

## Star History

<a href="https://www.star-history.com/?repos=fhidalgodev%2Fdsh-odoo-sdd&type=date&legend=top-left">
  <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=fhidalgodev/dsh-odoo-sdd&type=date&legend=top-left" />
</a>

> Gráfico generado en vivo por la API de [star-history.com](https://star-history.com).

## Agradecimientos

Construido para la comunidad de desarrolladores de Odoo, este plugin descansa
sobre dos ecosistemas:

- **[Odoo Community Association (OCA)](https://github.com/OCA)** — las
  convenciones de código, la estructura de módulos y los gates de calidad que
  este pipeline aplica.
- **[DeepSeek Harness (DSH)](https://github.com/deepseek-ai)** — la
  arquitectura de plugins (tools/plugins Cordis, skills, subagentes) sobre la
  que corre.

Gracias a todos los que aportan patrones, revisiones e ideas que dan forma al
flujo SDD. Contribuidores:

<p align="center">
  <a href="https://github.com/fhidalgodev/dsh-odoo-sdd/graphs/contributors">
    <img src="https://contrib.rocks/image?repo=fhidalgodev/dsh-odoo-sdd&max=100&columns=12" alt="Contributors to fhidalgodev/dsh-odoo-sdd" width="480"/>
  </a>
</p>

---

## Licencia

MIT
