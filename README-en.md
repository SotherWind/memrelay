<h1 align="center">MemRelay</h1>

<p align="center">
  <strong>English</strong> ·
  <a href="README-de.md">Deutsch</a> ·
  <a href="README-es.md">Español</a> ·
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
  <strong>Cross-agent task relay.</strong><br>
  Done halfway in Codex but out of quota? Switch to Claude Code and just say
  "continue the XX task" — it picks up right where you left off,
  without you re-describing the requirements or progress.
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT"></a>
  <img src="https://img.shields.io/badge/Node-%E2%89%A5%2022.16-339933?logo=nodedotjs&logoColor=white" alt="Node >= 22.16">
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-blue" alt="macOS | Linux | Windows">
</p>

<p align="center">
  <a href="#installation">Install</a> ·
  <a href="#quick-start">Quick Start</a> ·
  <a href="#highlights">Highlights</a> ·
  <a href="#commands">Commands</a> ·
  <a href="#supported-sources">Supported Sources</a> ·
  <a href="#known-limitations">Known Limitations</a> ·
  <a href="#web-ui">Web UI</a> ·
  <a href="#development">Development</a>
</p>

## Why MemRelay

Switching AI tools should not mean losing progress.

You're halfway through in Codex when you run out of quota. You want to continue in Claude Code, but it has no idea what just happened. So you re-explain the requirements, re-describe the progress — or just give up.

MemRelay reads the session logs each tool keeps on your machine, and distills the handoff content on the spot when you say "continue". **The old agent does nothing special — no handoff docs, no copy-paste.**

## Highlights

- **Zero cooperation from the old agent** — no handoff document required; MemRelay reads its local session log directly and distills progress, todos and next steps.
- **Set up once, then just talk** — after `memrelay setup` you never need to mention memrelay; in tools with a Skill or session-start hint, "continue the XX task" triggers it automatically.
- **Progress keeps up** — with your consent it installs into your tools' hook systems, so progress lands in the local index in near real time and the next tool can pick up immediately.
- **Mainstream tools covered** — reads sessions from Claude Code, Qoder, Codex, Cursor, CodeBuddy, WorkBuddy, OpenCode, ZCode, Trae and DeepSeek Harness (Trae and CodeBuddy in both CLI and IDE formats).
- **No LLM required** — handoff content is distilled locally by rules; offline by default, no API key needed; semantic vector search, session summaries and preference tidy are optional opt-in enhancements (see below).
- **Local-first and undoable** — data stays in `~/.memrelay/`, no telemetry; other tools are read-only, and every write is tracked in a manifest and can be undone.

## Installation

Requires Node.js >= 22.16 (nvm / fnm / volta / mise all fine — the launcher finds a suitable Node itself):

```bash
npm i -g memrelay    # pnpm / yarn / bun global installs work too
memrelay setup
```

`setup` will: **detect** which tools are installed → **list** the files it will write (launch hints + real-time indexing) → **confirm once** → write → self-test in each terminal.

> [!NOTE]
> Want a no-trace trial? `memrelay setup --undo` reverts everything it wrote (data kept); add `--purge` to delete the data as well.

## Quick Start

```bash
npm i -g memrelay && memrelay setup
```

Then open a project you "left half-done with another tool" and say, in an integrated tool with a Skill or session-start hint:

> Continue the XX task

Agent runs `memrelay resume` automatically, gets the handoff (which tool, how far along, what's next), and continues.

## Commands

Run automatically by the agent (read-only, print-only):

| Command | What it does |
|---|---|
| `memrelay resume "keyword"` | Finds the interrupted task and prints the handoff; cross-tool relay chains are included |
| `memrelay resume` | Without a keyword: picks the most recently interrupted task in the current project |
| `memrelay resume <session id>` | Force-continues that exact session after picking from the menu; the output carries the relay marker so the new session joins the chain |
| `memrelay search "keyword"` | Searches sessions in the current project (CJK text is searchable) |
| `memrelay show <session id> --from N` | Pages through a session's raw records |

Run by you:

| Command | What it does |
|---|---|
| `memrelay doctor` | Self-check + build/incrementally update the session index (`~/.memrelay/memrelay.db`) |
| `memrelay ui` | Local web UI (see below) |
| `memrelay embed [--status]` | Vector backfill: embeds message text into the local store (enable semantic search in Settings first); `--status` shows progress |
| `memrelay summarize [--status]` | Session summaries: compresses each session tail into a 2–4 sentence progress summary via the summary endpoint; `--status` shows progress |
| `memrelay tidy [--status\|--apply\|--undo]` | Cross-tool preference tidy: imports each tool's global memory/rules, merges them, and writes a MemRelay marker block back |
| `memrelay setup --undo` | Undo the integration (data kept); add `--purge` to delete data too |

## Supported Sources

Sessions are read directly — no cooperation from the source tool required:

| Tool | Where its sessions live |
|---|---|
| Claude Code | `~/.claude/projects/<encoded-path>/*.jsonl` |
| Qoder | `~/.qoder/projects/<encoded-path>/*.jsonl` (including IDE transcript format) |
| Codex | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl[.zst]` (metadata from read-only `state_*.sqlite`) |
| Cursor | `%APPDATA%/Cursor/User/globalStorage/state.vscdb` (plaintext KV, read-only) |
| CodeBuddy | CLI: `~/.codebuddy/projects/…/*.jsonl`; IDE: `%LOCALAPPDATA%/CodeBuddyExtension/Data/…/CodeBuddyIDE/…/history/<workspace md5>/<session>` (one JSON file per message) |
| WorkBuddy | `~/.workbuddy/projects/…/*.jsonl` + `workbuddy.db` metadata |
| OpenCode | `~/.local/share/opencode/opencode.db` |
| ZCode | `~/.zcode/cli/db/db.sqlite` |
| Trae / Trae CN | CLI uses a Codex-compatible format; the IDE's session store is encrypted and reconstructed from hook events |
| DeepSeek Harness | `~/.dsh/sessions/<encoded-project-dir>/session-<id>/session.v4.jsonl.zstd` (multi-frame zstd, read-only) |

> [!NOTE]
> Paths follow each platform's default data directory: the Cursor / CodeBuddy rows above are Windows paths; on macOS use `~/Library/Application Support/…`, on Linux `~/.config/…`. OpenCode uses `~/.local/share/opencode` on every platform, and `~` is the current user's home directory.

Integration has two layers, all tracked and undoable: **Skill** (teaches a tool to call memrelay when you say "continue") is installed into the skill directories of Claude Code / Qoder / Codex / Cursor / CodeBuddy / WorkBuddy / Trae / Trae CN / DeepSeek Harness; **hooks for real-time indexing** are installed in Claude Code / Qoder / Codex / CodeBuddy / WorkBuddy / ZCode / Trae CN, with OpenCode using its official plugin and DeepSeek Harness using an in-process indexing plugin (its hooks bridge handles session-start hints only). CodeBuddy CLI and IDE share the same user-level hook settings.

## Known Limitations

- **Auto-trigger relies on a Skill or session-start hint**: OpenCode currently has only the real-time indexing plugin, with no session-start hint, so run `memrelay resume` manually there.
- **Trae IDE's session store is encrypted**: it is only reconstructed from hook events when real-time indexing is enabled; with just the Skill and no real-time indexing, its past sessions cannot be read.
- **Local sessions only**: no cross-machine sync; unsupported tools, or encrypted sessions without an event stream, cannot be read.

## Web UI

```bash
memrelay ui
```

Serves a local UI bound to `127.0.0.1` only (one-time token; data never leaves your machine). Uses a fixed default port `4823` (falls back to a random port if taken); theme and language choices are stored in browser localStorage and restored on the next launch.

- **Dashboard**: status overview, tasks ready to resume, recent tasks, 14-day activity and tool/folder distribution
- **Task list**: relay chains across tools become a single task; grouped by folder and sorted by recent activity, with live status
- **Task detail**: vertical relay rail + handoff preview + one-click copy of the handoff prompt
- **Three skins**: minimal / comic / pixel × light / dark / system; theme and language choices are remembered
- **11 UI languages**: Simplified Chinese / English / Traditional Chinese / Japanese / Korean / Spanish / French / German / Persian / Portuguese (BR) / Indonesian
- **Session browsing & search**: full-text search (CJK included), jump to matches with highlighting
- **Integrations / privacy exclusions / trash / manual fixes** (rename, mark done, split & merge chains)

## Optional Enhancements

Semantic search, session summaries and preference tidy are off by default. Each one has its own endpoint settings in `memrelay ui` (they are independent and can point to different upstreams). Secrets are redacted before sending; if semantic search or summaries fail, they fall back to the existing rule-based distillation; if tidy fails, nothing is written back.

- **Semantic search**: adds a semantic channel, so searching "login page" also finds sessions that say "auth page". Only user/assistant text is embedded, and only OpenAI-compatible remote `/embeddings` is supported. Scale reference: ~250 sessions ≈ 2M chars ≈ $0.03. Unchanged content is skipped via hash reconciliation; switching models/hosts offers a one-click rebuild. [Design](docs/vector-search.md)
- **Session summaries**: writes a 2–4 sentence progress summary per session, shown in resume output (`## 任务摘要（AI 生成）`), the task list & detail, and conversation browsing. Material is limited to the title, status signals and the last ~20 messages of the session tail (≤8KB); reasoning and tool output are not sent. ~1M tokens for 250 sessions. Unchanged material is skipped; switching models/hosts offers a one-click rebuild. [Design](docs/llm-summary.md)
- **Preference tidy**: imports each tool's global memory/rules read-only, merges duplicates and conflicts, then writes a MemRelay marker block back. It only touches marker blocks, backs up before writing, is undoable, and surfaces conflicts instead of auto-resolving them; source changes are checked automatically while `memrelay ui` runs. [Design](docs/tidy.md)

Maintenance: `memrelay embed` / `memrelay summarize` / `memrelay tidy` for a full backfill (interruptible and resumable); `memrelay ui` fills/checks in the background while running.

## Privacy & Security

- Data lives only in `~/.memrelay/` on your machine; no telemetry; no cloud services by default.
- Other tools' files are read-only; writes are limited to skill/hook configs and `~/.memrelay/`, all tracked in a manifest and undoable.
- Secrets (API keys, tokens, private keys, connection strings) are detected and redacted before indexing and output.
- When semantic search, session summaries, or preference tidy are enabled, related text/memory (secrets redacted) is sent to the hosts you configure (each feature has its own endpoint); all three are off by default.
- The UI server binds to `127.0.0.1` only, requires an access token and validates the Host header; write requests also reject cross-origin Origins.
- Trae IDE hooks run inside Trae's own sandbox and can only stage raw events under Trae's `hooks_env`; common secrets (`sk-`, GitHub tokens, AWS keys, `password/token` fields) are masked inside the sandbox first, but content outside those rules may remain in that copy. Undoing the integration removes those files. If that matters, enable only the Trae Skill and skip real-time indexing.

## Development

The repo is a pnpm workspace: `packages/cli` is the CLI package (the published artifact) and `packages/ui` is the web UI (built into the CLI's `dist/ui`).

```bash
pnpm install
pnpm typecheck     # tsc --noEmit for both packages
pnpm test          # vitest unit + integration tests (e2e is separate, below)
pnpm build         # tsdown → packages/cli/dist/cli.mjs, then the UI into packages/cli/dist/ui
cd packages/cli && npm link   # optional: put the memrelay command on PATH (same as npm i -g memrelay)
node packages/cli/test/e2e/bootstrap.mjs   # launcher end-to-end
```

Design and iteration plans: [docs/architecture.md](docs/architecture.md).

## License

[MIT](LICENSE)
