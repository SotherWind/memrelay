<p align="center">
  <a href="https://github.com/SotherWind/memrelay">
    <img src="https://raw.githubusercontent.com/SotherWind/memrelay/main/design/logo/memrelay-mark-minimal-light.png" alt="MemRelay" width="320">
  </a>
</p>

<h1 align="center">MemRelay</h1>

<p align="center">
  <a href="README-en.md">English</a> ·
  <a href="README-de.md">Deutsch</a> ·
  <strong>Español</strong> ·
  <a href="README-fr.md">Français</a> ·
  <a href="README-ja.md">日本語</a> ·
  <a href="README-ko.md">한국어</a> ·
  <a href="README-fa.md">فارسی</a> ·
  <a href="README-pt-BR.md">Português</a> ·
  <a href="README-id.md">Bahasa Indonesia</a> ·
  <a href="README.md">简体中文</a> ·
  <a href="README-zh-Hant.md">繁體中文</a>
</p>

<p align="center">
  <strong>Relevo de tareas entre herramientas de codificación con IA.</strong><br>
  ¿Te quedaste a mitad en Codex y se acabó la cuota? Cambia a Claude Code y di simplemente
  «continúa la tarea XX»: sigue justo donde lo dejaste,
  sin volver a describir requisitos ni progreso.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/memrelay"><img src="https://img.shields.io/npm/v/memrelay?color=cb3837&logo=npm&logoColor=white" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/memrelay"><img src="https://img.shields.io/npm/dm/memrelay?color=cb3837" alt="npm downloads"></a>
  <a href="https://github.com/SotherWind/memrelay/actions/workflows/ci.yml"><img src="https://github.com/SotherWind/memrelay/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/SotherWind/memrelay/blob/main/LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT"></a>
  <img src="https://img.shields.io/badge/Node-%E2%89%A5%2022.16-339933?logo=nodedotjs&logoColor=white" alt="Node >= 22.16">
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-blue" alt="macOS | Linux | Windows">
</p>

<p align="center">
  <a href="#instalación">Instalación</a> ·
  <a href="#inicio-rápido">Inicio rápido</a> ·
  <a href="#aspectos-destacados">Aspectos destacados</a> ·
  <a href="#comandos">Comandos</a> ·
  <a href="#fuentes-compatibles">Fuentes compatibles</a> ·
  <a href="#límites-conocidos">Límites conocidos</a> ·
  <a href="#interfaz-web">Interfaz web</a> ·
  <a href="#desarrollo">Desarrollo</a>
</p>

## Por qué MemRelay

Cambiar de herramienta de IA no debería costarte el progreso.

Estás a mitad en Codex cuando se agota la cuota. Quieres seguir en Claude Code, pero no tiene ni idea de lo que acaba de pasar. Así que vuelves a explicar los requisitos, a describir el progreso — o directamente lo dejas.

MemRelay lee los registros de sesión que cada herramienta guarda en tu máquina y, cuando dices «continúa», destila el contenido de traspaso en el momento. **La herramienta anterior no hace nada especial: sin documentos de traspaso ni copiar y pegar.**

## Aspectos destacados

- **Cero cooperación del agente anterior** — no exige nada a la herramienta anterior; lee su registro de sesión local y destila progreso, pendientes y próximos pasos.
- **Configúralo una vez y habla con normalidad** — tras `memrelay setup` nunca necesitas mencionar memrelay; en las herramientas con Skill o aviso de inicio, «continúa la tarea XX» lo activa automáticamente.
- **El progreso se mantiene al día** — con tu consentimiento se instala en los hooks de las herramientas, de modo que el progreso llega al índice local casi en tiempo real y la siguiente herramienta puede continuar de inmediato.
- **Las principales herramientas cubiertas** — lee sesiones de Claude Code, Qoder, Codex, Cursor, CodeBuddy, WorkBuddy, OpenCode, ZCode, Trae / Trae CN y DeepSeek Harness (Trae CN y CodeBuddy en formato CLI e IDE).
- **Sin LLM** — el traspaso se destila localmente por reglas; sin conexión por defecto y sin API key; la búsqueda semántica vectorial, los resúmenes de sesión y la organización de preferencias son mejoras opcionales opt-in (ver abajo).
- **Local primero y reversible** — los datos viven solo en `~/.memrelay/`, sin telemetría; las sesiones de las demás herramientas son de solo lectura y cada escritura de integración u organización de preferencias queda registrada en un manifiesto y se puede deshacer.

## Instalación

Requiere Node.js ≥ 22.16 (nvm / fnm / volta / mise funcionan; el lanzador busca un Node válido por su cuenta):

```bash
npm i -g memrelay    # la instalación global con pnpm / yarn / bun también funciona
memrelay setup
```

`setup` hará: **detectar** qué herramientas tienes → **listar** los archivos que escribirá (indicaciones de inicio + indexación en tiempo real) → **confirmar una vez** → escribir → autoprueba en cada terminal.

> [!NOTE]
> ¿Quieres probarlo sin dejar rastro? `memrelay setup --undo` revierte todo lo escrito (conserva los datos); añade `--purge` para borrar también los datos.

## Inicio rápido

```bash
npm i -g memrelay && memrelay setup
```

Luego abre un proyecto que dejaste «a medias con otra herramienta» y di, en una herramienta integrada con Skill o aviso de inicio:

> continúa la tarea XX

El agente ejecuta `memrelay resume` automáticamente, obtiene el traspaso (qué herramienta, por dónde iba, qué toca después) y continúa.

## Comandos

Ejecutados automáticamente por el agente (solo lectura, solo impresión):

| Comando | Qué hace |
|---|---|
| `memrelay resume "palabra clave"` | Encuentra la tarea interrumpida e imprime el traspaso; las cadenas de relevo entre herramientas se incluyen |
| `memrelay resume` | Sin palabra clave: toma la tarea interrumpida más reciente del proyecto actual |
| `memrelay resume <id de sesión>` | Continúa exactamente esa sesión tras elegirla en el menú; la salida lleva la marca de relevo para que la nueva sesión se una a la cadena |
| `memrelay search "palabra clave"` | Busca en las sesiones del proyecto actual (el texto CJK es buscable) |
| `memrelay show <id de sesión> --from N` | Recorre los registros originales de una sesión |

Ejecutados por ti:

| Comando | Qué hace |
|---|---|
| `memrelay doctor` | Autocomprobación + creación/actualización incremental del índice de sesiones (`~/.memrelay/memrelay.db`) |
| `memrelay ui` | Interfaz web local (ver abajo) |
| `memrelay embed [--status]` | Relleno vectorial: embebe el texto y lo guarda en local (activa antes la búsqueda semántica en Ajustes); `--status` muestra el progreso |
| `memrelay summarize [--status]` | Resúmenes de sesión: comprime la cola de cada sesión en un resumen de progreso de 2–4 frases mediante el endpoint de resumen; `--status` muestra el progreso |
| `memrelay tidy [--status\|--apply\|--undo]` | Organización de preferencias entre herramientas: importa la memoria/reglas globales de cada herramienta, las fusiona y escribe un bloque marcador de MemRelay |
| `memrelay setup --undo` | Deshace la integración (conserva los datos); añade `--purge` para borrarlos también |

## Fuentes compatibles

Las sesiones se leen directamente: la herramienta de origen no tiene que hacer nada:

| Herramienta | Dónde viven sus sesiones |
|---|---|
| Claude Code | `~/.claude/projects/<encoded-path>/*.jsonl` |
| Qoder | `~/.qoder/projects/<encoded-path>/*.jsonl` (incluye el formato transcript del IDE) |
| Codex | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl[.zst]` (metadatos desde `state_*.sqlite` de solo lectura) |
| Cursor | `%APPDATA%/Cursor/User/globalStorage/state.vscdb` (KV en texto plano, solo lectura) |
| CodeBuddy | CLI: `~/.codebuddy/projects/…/*.jsonl`; IDE: `%LOCALAPPDATA%/CodeBuddyExtension/Data/…/CodeBuddyIDE/…/history/<md5 del espacio de trabajo>/<sesión>` (un archivo JSON por mensaje) |
| WorkBuddy | `~/.workbuddy/projects/…/*.jsonl` + metadatos de `workbuddy.db` |
| OpenCode | `~/.local/share/opencode/opencode.db` |
| ZCode | `~/.zcode/cli/db/db.sqlite` |
| Trae / Trae CN | La CLI de Trae usa un formato compatible con Codex; el almacén de sesiones del IDE de Trae CN está cifrado y se reconstruye desde eventos de hook (Trae internacional: solo CLI) |
| DeepSeek Harness | `~/.dsh/sessions/<encoded-project-dir>/session-<id>/session.v4.jsonl.zstd` (zstd multiframe, solo lectura) |

> [!NOTE]
> Las rutas siguen el directorio de datos predeterminado de cada plataforma: las filas de Cursor / CodeBuddy de arriba son rutas de Windows; en macOS son `~/Library/Application Support/…` y en Linux `~/.config/…`. OpenCode usa `~/.local/share/opencode` en todas las plataformas, y `~` es el directorio personal del usuario actual.

La integración tiene dos capas, todo registrado en un manifiesto y reversible: **Skill** (enseña a una herramienta a llamar a memrelay cuando dices «continúa») se instala en los directorios de skills de Claude Code / Qoder / Codex / Cursor / CodeBuddy / WorkBuddy / Trae / Trae CN / DeepSeek Harness; **indexación en tiempo real** (el progreso entra al índice en segundos) se instala en Claude Code / Qoder / Codex / CodeBuddy / WorkBuddy / ZCode / Trae CN (el trío de hooks; la CLI y el IDE de CodeBuddy comparten la misma configuración de usuario) y en OpenCode / DeepSeek Harness mediante sus mecanismos oficiales de plugins — dsh usa un plugin en proceso para la indexación en tiempo real (evita las restricciones de procesos de su sandbox) y además instala un puente oficial de compatibilidad de hooks para las indicaciones de inicio y la compatibilidad.

## Límites conocidos

- **La activación automática depende de un Skill o un aviso de inicio**: OpenCode actualmente solo tiene el plugin de indexación en tiempo real, sin aviso de inicio, así que allí hay que ejecutar `memrelay resume` manualmente.
- **El almacén de sesiones del IDE de Trae CN está cifrado**: solo se reconstruye a partir de eventos de hook cuando la indexación en tiempo real está activada; con solo el Skill y sin indexación en tiempo real, sus sesiones pasadas no se pueden leer.
- **Solo sesiones locales**: sin sincronización entre máquinas; las herramientas no compatibles, o las sesiones cifradas sin flujo de eventos, no se pueden leer.

## Interfaz web

```bash
memrelay ui
```

Abre una interfaz local que solo escucha en `127.0.0.1` (token de un solo uso; los datos no salen de tu máquina). Usa el puerto fijo `4823` por defecto (aleatorio si está ocupado); el tema y el idioma se guardan en localStorage del navegador y se restauran en el siguiente arranque.

- **Panel**: resumen de estado, tareas listas para continuar, tareas recientes, actividad de los últimos 14 días y distribución por herramienta/carpeta
- **Lista de tareas**: las cadenas de relevo entre herramientas se unifican en una tarea; agrupadas por carpeta y ordenadas por actividad reciente, con estado en tiempo real
- **Detalle de tarea**: carril de relevo vertical + vista previa del traspaso + copia del prompt de traspaso con un clic
- **Organizar**: organización de preferencias entre herramientas; tarjetas separadas para lo aplicado y lo pendiente, reversible
- **Ajustes**: interfaces e interruptores de resúmenes, organización y búsqueda semántica, integración automática de nuevas herramientas y estado de ejecución
- **Tres skins**: minimalista / cómic / píxel × claro / oscuro / sistema; el tema y el idioma se recuerdan
- **11 idiomas de interfaz**: chino simplificado / English / chino tradicional / 日本語 / 한국어 / Español / Français / Deutsch / فارسی / português (BR) / bahasa indonesio
- **Exploración y búsqueda de sesiones**: búsqueda de texto completo (incluido CJK), salto a la coincidencia resaltada
- **Integraciones / exclusiones de privacidad / papelera / correcciones manuales** (renombrar, marcar como hecha, dividir y fusionar cadenas)

## Mejoras opcionales

La búsqueda semántica, los resúmenes de sesión y la organización de preferencias están desactivados por defecto. Cada función tiene su propia configuración de endpoint en `memrelay ui` (son independientes y pueden apuntar a distintos upstreams). Las claves se censuran antes de enviar; si la búsqueda semántica o los resúmenes fallan, vuelven a la destilación por reglas existente; si falla la organización, no se escribe nada.

- **Búsqueda semántica**: añade un canal semántico, de modo que buscar «página de inicio de sesión» también encuentra sesiones que dicen "auth page". Solo se embebe el texto de user/assistant y solo se admiten `/embeddings` remotos compatibles con OpenAI. Orden de magnitud: ~250 sesiones ≈ 2 M de caracteres ≈ 0,03 USD. El contenido sin cambios se omite mediante conciliación por hash; al cambiar de modelo/host se puede reconstruir con un clic. [Diseño](docs/vector-search.md)
- **Resúmenes de sesión**: genera un resumen de progreso de 2–4 frases por sesión, que aparece en la salida del relevo (`## 任务摘要（AI 生成）`), en la lista y el detalle de tareas y en la exploración de sesiones. El material se limita al título, las señales de estado y los últimos ~20 mensajes del final de la sesión (≤8 KB); el razonamiento y la salida de herramientas no se envían. ~1 M de tokens para 250 sesiones. El material sin cambios se omite; al cambiar de modelo/host se puede reconstruir con un clic. [Diseño](docs/llm-summary.md)
- **Organización de preferencias**: importa en modo de solo lectura la memoria/reglas globales de cada herramienta, fusiona duplicados y contradicciones y vuelve a escribir un bloque marcador de MemRelay. Solo toca bloques marcadores o archivos dedicados, hace copia de seguridad antes de escribir, se puede deshacer y muestra los conflictos en lugar de resolverlos automáticamente; los cambios en las fuentes se comprueban automáticamente mientras `memrelay ui` está en marcha. [Diseño](docs/tidy.md)

Mantenimiento: `memrelay embed` / `memrelay summarize` / `memrelay tidy` para un relleno completo (interrumpible y reanudable); `memrelay ui` rellena/comprueba en segundo plano mientras se ejecuta.

## Privacidad y seguridad

- Los datos viven solo en `~/.memrelay/` en tu máquina; sin telemetría; sin servicios en la nube por defecto.
- Las sesiones de otras herramientas son de solo lectura; las escrituras se limitan a las integraciones que apruebas (Skills, configuración de hooks / plugins), los bloques marcados de MemRelay o archivos dedicados que escribe la organización de preferencias y `~/.memrelay/`, todas registradas en un manifiesto y reversibles.
- Las claves (API keys, tokens, claves privadas, cadenas de conexión) se detectan y enmascaran antes de indexar y de mostrar.
- Si activas la búsqueda semántica, los resúmenes de sesión o la organización de preferencias, los textos/memorias correspondientes (con claves censuradas) se envían a los hosts que configures (cada función tiene su propio endpoint); las tres están desactivadas por defecto.
- El servidor de la interfaz solo escucha en `127.0.0.1`, exige un token de acceso y valida la cabecera Host; las solicitudes de escritura además rechazan orígenes cruzados.
- Los hooks del IDE de Trae CN se ejecutan en el sandbox de Trae y solo pueden dejar eventos en bruto en `hooks_env` de Trae; las claves habituales (`sk-`, tokens de GitHub, claves de AWS, campos `password/token`) se enmascaran primero dentro del sandbox, pero el contenido fuera de esas reglas puede quedar en esa copia. Deshacer la integración elimina esos archivos. Si esto te preocupa, activa solo el Skill de Trae CN y omite la indexación en tiempo real.

## Desarrollo

El repositorio es un workspace de pnpm: `packages/cli` es el paquete principal de CLI (el artefacto publicado) y `packages/ui` la interfaz web (el build se integra en `dist/ui` del CLI).

```bash
pnpm install
pnpm typecheck     # tsc --noEmit para ambos paquetes
pnpm test          # pruebas unitarias + de integración con vitest (las e2e van aparte, ver abajo)
pnpm build         # primero tsdown → packages/cli/dist/cli.mjs, luego la interfaz en packages/cli/dist/ui
cd packages/cli && npm link   # opcional: poner memrelay en el PATH (equivale a npm i -g memrelay)
node packages/cli/test/e2e/bootstrap.mjs   # extremo a extremo del lanzador
```

Diseño y planes de iteración: [docs/architecture.md](docs/architecture.md).

## License

[MIT](LICENSE)
