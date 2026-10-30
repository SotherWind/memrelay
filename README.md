<h1 align="center">MemRelay</h1>

<p align="center">
  <a href="README-en.md">English</a> ·
  <a href="README-de.md">Deutsch</a> ·
  <a href="README-es.md">Español</a> ·
  <a href="README-fr.md">Français</a> ·
  <a href="README-ja.md">日本語</a> ·
  <a href="README-ko.md">한국어</a> ·
  <a href="README-fa.md">فارسی</a> ·
  <a href="README-pt-BR.md">Português</a> ·
  <a href="README-id.md">Bahasa Indonesia</a> ·
  <strong>简体中文</strong> ·
  <a href="README-zh-Hant.md">繁體中文</a>
</p>

<p align="center">
  <strong>跨 AI coding 工具的任务接力。</strong><br>
  在 Codex 中做到一半、额度用完了——切到 Claude Code，照常说一句"继续完成 XX 任务"，
  它就能接着做，不用再描述需求和进度。
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT"></a>
  <img src="https://img.shields.io/badge/Node-%E2%89%A5%2022.16-339933?logo=nodedotjs&logoColor=white" alt="Node >= 22.16">
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-blue" alt="macOS | Linux | Windows">
</p>

<p align="center">
  <a href="#安装">安装</a> ·
  <a href="#快速开始">快速开始</a> ·
  <a href="#亮点">亮点</a> ·
  <a href="#命令">命令</a> ·
  <a href="#支持的来源">支持的来源</a> ·
  <a href="#已知边界">已知边界</a> ·
  <a href="#管理界面">管理界面</a> ·
  <a href="#开发">开发</a>
</p>

## 为什么需要 MemRelay

切换 AI 工具，不该丢进度。

你在 Codex 中写了一半，额度用完；想换 Claude Code 接着做，它不知道刚才发生了什么。把需求再讲一遍、把进度再描述一遍——或者干脆放弃。

MemRelay 直接读各工具留在本机的会话记录，在你说"继续"时现场提炼出续接内容。**旧工具零配合，不用写交接文档，不用复制粘贴。**

## 亮点

- **旧 agent 零配合** — 不要求旧工具做任何事；续接时直接读它留在本机的会话记录，现场提炼进度、待办和下一步。
- **一次接入，照常说话** — `memrelay setup` 之后不用特意提 memrelay；在带 Skill 或启动提示的工具里，说"继续完成 XX 任务"就会自动触发。
- **进度自动跟上** — 经你同意后装在工具的 hooks 里，干活的进度实时写入本地索引，切到别的工具马上就能接上。
- **主流工具全覆盖** — Claude Code、Qoder、Codex、Cursor、CodeBuddy、WorkBuddy、OpenCode、ZCode、Trae、DeepSeek Harness 的会话都能读（Trae、CodeBuddy 支持 CLI 与 IDE 两种格式）。
- **不依赖大模型** — 续接内容按规则在本地提炼，默认不联网、不需要 API Key；向量语义检索、会话摘要与偏好整理都是可选的 opt-in 增强（见下）。
- **本地优先，可撤销** — 数据只存在本机 `~/.memrelay/`，不做遥测；对其它工具只读，所有写入均有清单、一键撤销。

## 安装

需要 Node.js ≥ 22.16（nvm / fnm / volta / mise 等版本管理器都行，入口程序会自己找可用的 Node）：

```bash
npm i -g memrelay    # pnpm / yarn / bun 全局安装同样可用
memrelay setup
```

`setup` 会：**检测**本机装了哪些工具 → **列出**将写入的文件（含启动提示与实时索引）→ **确认一次** → 写入 → 各终端自测。

> [!NOTE]
> 想先试试不想留痕迹？`memrelay setup --undo` 一键撤销写入（保留数据）；再加 `--purge` 连数据一起删。

## 快速开始

```bash
npm i -g memrelay && memrelay setup
```

然后打开一个"用别的工具做过一半"的项目，在带 Skill 或启动提示的已接入工具里说：

> 继续完成 XX 任务

Agent 会自动运行 `memrelay resume`，拿到续接内容（之前在哪个工具、进度到哪、接下来做什么），然后接着干。

## 命令

Agent 在会话里自动运行（只读、只打印）：

| 命令 | 作用 |
|---|---|
| `memrelay resume "关键词"` | 找到中断的任务，打印续接内容；跨工具接力链会一并带上 |
| `memrelay resume` | 不带关键词：接当前项目里最近中断的任务 |
| `memrelay resume <会话 id>` | 从候选菜单选定后强制续接该会话；输出带接力标记，新会话会落链 |
| `memrelay search "关键词"` | 在当前项目的会话里搜索（中文两字词可搜） |
| `memrelay show <会话 id> --from N` | 翻看某个会话的原始记录 |

你自己运行的：

| 命令 | 作用 |
|---|---|
| `memrelay doctor` | 自检 + 建立/增量更新会话索引（`~/.memrelay/memrelay.db`） |
| `memrelay ui` | 本地管理界面（见下） |
| `memrelay embed [--status]` | 向量回填：把正文嵌入并落库（需先在配置页开启语义检索）；`--status` 看进度 |
| `memrelay summarize [--status]` | 会话摘要生成：用配置页填写的摘要接口压缩成 2~4 句进展摘要；`--status` 看进度 |
| `memrelay tidy [--status\|--apply\|--undo]` | 跨工具偏好整理：导入各工具全局记忆/规则，合并后写回 MemRelay 标记块 |
| `memrelay setup --undo` | 撤销接入（保留数据）；加 `--purge` 连数据一起删 |

## 支持的来源

直接读取会话记录，不需要该工具做任何配合：

| 工具 | 会话在本机的位置 |
|---|---|
| Claude Code | `~/.claude/projects/<编码路径>/*.jsonl` |
| Qoder | `~/.qoder/projects/<编码路径>/*.jsonl`（含 IDE transcript 格式） |
| Codex | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl[.zst]`（元数据只读 `state_*.sqlite`） |
| Cursor | `%APPDATA%/Cursor/User/globalStorage/state.vscdb`（本地明文 KV，只读） |
| CodeBuddy | CLI：`~/.codebuddy/projects/…/*.jsonl`；IDE：`%LOCALAPPDATA%/CodeBuddyExtension/Data/…/CodeBuddyIDE/…/history/<工作区 md5>/<会话>`（逐条消息 JSON） |
| WorkBuddy | `~/.workbuddy/projects/…/*.jsonl` + `workbuddy.db` 元数据 |
| OpenCode | `~/.local/share/opencode/opencode.db` |
| ZCode | `~/.zcode/cli/db/db.sqlite` |
| Trae / Trae CN | CLI 是 Codex 兼容格式；IDE 会话库加密，由 hook 事件实时重建 |
| DeepSeek Harness | `~/.dsh/sessions/<编码项目目录>/session-<id>/session.v4.jsonl.zstd`（多帧 zstd，只读） |

> [!NOTE]
> 路径按各平台默认数据目录解析：Cursor / CodeBuddy 上表为 Windows 路径，macOS 为 `~/Library/Application Support/…`，Linux 为 `~/.config/…`；OpenCode 在各平台都使用 `~/.local/share/opencode`，`~` 指当前用户主目录。

接入分两层，全部走清单、可撤销：**Skill**（工具知道说"继续"时要调 memrelay）写入 Claude Code / Qoder / Codex / Cursor / CodeBuddy / WorkBuddy / Trae / Trae CN / DeepSeek Harness 的技能目录；**实时索引**（干活进度秒级入库）装在 Claude Code / Qoder / Codex / CodeBuddy / WorkBuddy / ZCode / Trae CN（hooks 三件套；CodeBuddy 的 CLI 与 IDE 共用同一份用户设置）与 OpenCode / DeepSeek Harness（各自的官方插件机制）——dsh 的实时索引用进程内插件（绕开它沙箱对 hook 进程的限制），另装官方 hooks 兼容桥负责启动提示与兼容。

## 已知边界

- **自动触发依赖 Skill 或启动提示**：OpenCode 目前只有实时索引插件，不会在会话开始自动提示，需要手动运行 `memrelay resume`。
- **Trae IDE 的会话库加密**：只有开启实时索引后才会用 hook 事件重建会话；只启用 Skill、不启用实时索引时，读不到它的历史会话。
- **只处理本机会话**：不做跨机同步；未支持的工具，或加密且没有事件流的会话，无法读取。

## 管理界面

```bash
memrelay ui
```

打开一个只监听 `127.0.0.1` 的本地界面（带一次性令牌，数据不出本机）。默认使用固定端口 `4823`（被占用时随机）；主题与语言保存在浏览器 localStorage，下次启动沿用。

- **仪表盘**：状态总览、待接力任务、最近任务、近 14 天活动与工具/目录分布
- **任务列表**：跨工具的接力链合成一个任务，按目录分组、最近活动排序，状态实时更新
- **任务详情**：竖向接力轨 + 续接预览 + 一键复制续接提示词
- **三套皮肤**：简洁 / 漫画 / 像素 × 浅色 / 深色 / 跟随系统，主题与语言选择会记住
- **11 种界面语言**：简体中文 / English / 繁體中文 / 日本語 / 한국어 / Español / Français / Deutsch / فارسی / Português (BR) / Bahasa Indonesia
- **会话浏览与搜索**：全文检索（中文可搜），从命中处高亮跳入
- **接入管理 / 隐私排除 / 回收站 / 手动修正**（改名、标记完成、拆分合并接力链）

## 可选增强

语义检索、会话摘要与偏好整理默认关闭，都在 `memrelay ui` 配置页单独填写接口（三者互不影响，可指向不同上游）；发送前会做密钥脱敏；语义检索与摘要失败时自动回退到现有规则提炼，偏好整理失败时不写回。

- **语义检索**：多一条语义通道，搜「登录页」也能命中写 "auth page" 的会话；只嵌 user/assistant 正文，只接 OpenAI 兼容的远程 `/embeddings`，参考量级约 250 会话 ≈ 200 万字符 ≈ $0.03。未变化的内容用哈希对账跳过，换模型/主机可一键重建向量。[设计](docs/vector-search.md)
- **会话摘要**：为每个会话生成 2~4 句进展摘要，显示在接力输出（`## 任务摘要（AI 生成）`）、任务列表与详情、会话浏览；素材只取标题、状态信号和会话尾部约 20 条正文（≤8KB），思考与工具输出不发送，250 会话全量约 100 万 token。素材未变则跳过，换模型/主机可一键重建摘要。[设计](docs/llm-summary.md)
- **偏好整理**：只读导入各工具的全局记忆/规则，合并重复与矛盾后写回 MemRelay 标记块；只写标记块、写前备份、可撤销，冲突不自动裁决；`memrelay ui` 运行期间自动检查来源变化。[设计](docs/tidy.md)

维护：`memrelay embed` / `memrelay summarize` / `memrelay tidy` 可全量补齐（可中断续跑）；`memrelay ui` 运行期间后台自动补。

## 隐私与安全

- 数据只存在本机的 `~/.memrelay/`，不做遥测；默认不依赖任何云端服务。
- 对其它工具的本机文件只读；写入仅限 Skill / hooks 配置与 `~/.memrelay/`，且都有清单可撤销。
- 入库与输出前都做密钥检测与遮盖（API Key、令牌、私钥、连接串等）。
- 语义检索、会话摘要与偏好整理开启后，相关正文/记忆（已做密钥脱敏）会发送到你在配置里指定的接口主机（三者各自独立的接口）；默认关。
- 界面服务只监听 `127.0.0.1`，带访问令牌并校验 Host 头；写请求另外拒绝跨源 Origin。
- Trae IDE 的 hook 运行在它自己的沙箱里，只能把原始事件先写到 Trae 的 `hooks_env`；常见密钥（`sk-`、GitHub token、AWS key、`password/token` 字段）会在沙箱内先遮盖，但规则未覆盖的内容仍可能留在该副本里，撤销接入时会删除这些文件。介意这一点的环境可以只启用 Trae 的 Skill、不启用实时索引。

## 开发

仓库是 pnpm workspace：`packages/cli` 是命令行主包（发布物），`packages/ui` 是管理界面（构建产物并入 CLI 的 `dist/ui`）。

```bash
pnpm install
pnpm typecheck     # 两个包的 tsc --noEmit
pnpm test          # vitest 单元 + 集成测试（端到端用例单独运行，见下）
pnpm build         # 先 tsdown → packages/cli/dist/cli.mjs，再构建界面到 packages/cli/dist/ui
cd packages/cli && npm link   # 可选：把 memrelay 命令装进 PATH（等效 npm i -g memrelay）
node packages/cli/test/e2e/bootstrap.mjs   # 入口程序端到端
```

设计与迭代计划见 [docs/architecture.md](docs/architecture.md)。

## License

[MIT](LICENSE)
