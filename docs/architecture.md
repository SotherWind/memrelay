# MemRelay 架构与开发方案

> 版本 v1，2026-10-13 定稿。本文只记录长期成立的设计和计划，开发进度不写在这里。

## 1. 定位

MemRelay 让开发者在多个 AI coding agent 之间接力同一个任务。比如在 Qoder 里做到一半，额度用完了，切到 Claude Code 后照常说一句"继续完成生成前端网站的任务"，它就能接着做，不用再描述需求和进度。

- **形态**：开源 npm 包 `memrelay`（MIT 许可），包括一个命令行工具和一个本地网页管理界面。
- **工作方式**：旧 agent 什么都不用做。MemRelay 直接读取各 agent 留在本机的会话记录，在续接时现场提炼出续接内容，交给新 agent。

### 1.1 目标

1. **任务续接**：在任意已接入的 agent 里照常说话就能接上，支持多次接力。
2. **原始对话**：跨工具浏览、搜索和归档会话。原工具会自动清理旧会话，归档后仍可查看。
3. **个人偏好**（已实现）：汇总各工具里的偏好，冲突由用户拍板，再统一下发到各工具。
4. **项目知识**（后续迭代）：汇总各工具里的项目级知识。

### 1.2 设计原则

| 原则 | 含义 |
|---|---|
| 旧 agent 零配合 | 不要求旧 agent 写交接文档。额度用完时，它也写不了 |
| 一次接入，照常使用 | 安装后运行一次 `memrelay setup`。之后不用特意提"memrelay"，也不用在每个工具里装东西 |
| 对其他工具只读 | 只写三类文件：各工具 skills 目录下的 `memrelay/`、自己的 `~/.memrelay/`、以及经用户同意的触发增强 hook（写进各工具的 hook 配置，只追加自己的条目，可撤销）。从不修改其他工具的会话、权限和其余配置 |
| 进度自动跟上 | 接入的工具通过 hook 在干活过程中自动更新索引；没装 hook 的工具照常可用，只是进度要等下一次扫描 |
| 不依赖大模型 | 续接内容按规则提炼，不需要 API Key。可以选配一个 OpenAI 兼容接口来做摘要 |
| 本地优先 | 数据不出本机，不做遥测 |
| 任何环境可用 | 覆盖 Windows、macOS、Linux，以及各种 Node 安装方式、终端和沙箱 |
| 最小实现，测试驱动 | 每个迭代都能单独使用；先写测试，再写实现 |

## 2. 术语

| 术语 | 含义 |
|---|---|
| agent / 工具 | Qoder、Claude Code、Codex、Cursor、Trae 等 AI coding 工具 |
| 来源工具 | 会话被 MemRelay 读取的旧工具 |
| 接手工具 | 用户切换过去、接着干活的新工具 |
| 会话 | 某个工具里的一次对话，对应一个原始会话文件或一条数据库记录 |
| 消息 / 片段 | 会话由多条消息组成。一条消息拆成多个片段，如文本、思考、工具调用、工具结果、文件改动、图片 |
| 对话树 | 回退、分叉和上下文压缩会让会话形成一棵树。"当前分支"是从最新的叶子回溯到根的那条路径 |
| 任务 / 接力链 | 跨工具接力的一组会话。单会话可独立成任务，接力时按续接标记自动串成链，也可手动拆分/合并 |
| 续接内容 | `memrelay resume` 打印给接手工具的 Markdown |
| 候选菜单 | 匹配结果不唯一时打印的会话列表，一行一个 |
| 适配器 | 负责读取某个工具会话格式的模块 |
| 启动脚本 | `~/.memrelay/bin/` 下的小脚本，负责找到 Node 和 MemRelay 并启动 |
| hook | 宿主工具在会话事件（启动 / 回合结束 / 会话结束）时运行的命令。MemRelay 用它实时索引会话：Stop / SessionEnd 增量索引刚写完的那一个文件，SessionStart 补扫变更并注入提示 |
| 接入 | 把 Skill、启动脚本和触发增强装进本机的各个工具 |

## 3. 使用流程

### 3.1 安装与接入

```bash
npm i -g memrelay   # 电脑上需要装有 Node 22.15 或更高版本；也可以用 pnpm、yarn、bun 全局安装
memrelay setup      # 检测已安装的工具 → 列出要写入的文件 → 用户确认一次 → 写入 → 在各终端自测
```

setup 结束时，会逐个工具显示 ✓ 或 ✗，失败的附上原因。setup 之后才装的工具，可以在 `memrelay ui` 里点"接入"，或者再运行一次 setup。

### 3.2 续接

```text
用户（在 Claude Code 里）：继续完成生成前端网站的任务
  → Skill 触发，agent 在终端运行：memrelay resume "生成前端网站"
  → MemRelay 在当前项目里找到 Qoder 中断的那个会话，打印续接内容
  → agent：「接的是 Qoder 里 10-12 15:30 的会话，已完成……，接下来做……」
  → agent 先查看 git 状态，再接着做
```

装了触发增强的工具（见 5.7），干活期间的进度由 hook 自动落库（Stop / SessionEnd 增量索引，SessionStart 补扫），所以 resume 能查到旧工具刚写下的进度；没装 hook 的工具，resume 会现场重读它变过的会话文件，结果一样，只是慢一点。

- 如果用户只说"继续"或"接着做"，就接当前项目里最近一个中断的任务；如果前两名都在最近（约 2 小时）内中断、分不出主次，就列候选让用户挑。
- 如果当前目录没有任何可读会话（典型：从 `C:\Windows\System32` 这类系统目录启动的 Codex 桌面端），而用户给了关键词，会在索引库里做一次全库兜底：只带出关键词命中的其他项目会话，并在结果里标注目标目录，提醒 agent 先 `cd` 过去；没有关键词时不做跨项目猜测。
- 遇到以下三种情况，agent 先停下来问用户：
  - 候选会话不唯一。
  - 旧会话几分钟前还有写入，旧 agent 可能还在运行。
  - 当前目录不是旧会话的目录，比如在另一个 worktree 里。
- 旧 agent 的待办清单，要搬进接手工具自己的待办工具里。

### 3.3 多次接力

按 Qoder → Claude Code → Codex 接力时，Codex 拿到的是整条链的进展。接手工具运行 `resume` 的记录会留在它自己的会话里，MemRelay 读到这条记录，就能把前后两段会话连起来。

### 3.4 管理

运行 `memrelay ui`，会在浏览器里打开本地管理界面，详见 5.8。

### 3.5 卸载

```bash
memrelay setup --undo    # 删除 MemRelay 写入的 Skill 和启动脚本，保留数据；加 --purge 会连数据一起删
npm uninstall -g memrelay
```

忘了先运行 `--undo` 也没关系。Skill 里写明了"命令不存在就忽略本 Skill"，残留的文件不会影响 agent。

## 4. 总体架构

```text
各工具的本地会话（只读）
  ~/.claude/projects  ~/.qoder/projects  ~/.codex/sessions  Cursor state.vscdb …
            │
            │ 适配器：每个工具一个，格式变化只影响它自己
            ▼
  统一会话模型：会话 → 消息 → 片段（保留对话树）
       │                                    │
       ▼                                    ▼
  续接引擎                                  索引器
  resume / search / show                    增量读取原始文件 → ~/.memrelay/memrelay.db
  直接读原始文件，只读、只打印                （SQLite，普通索引 + 中文索引）
       │                                    │
       ▼                                    ▼
  接手工具                                  本地服务 + 管理界面
  通过 Skill 调用启动脚本                    memrelay ui（127.0.0.1 + 访问令牌）
```

### 4.1 进程模型

- **没有常驻后台进程。**
- **agent 调用的命令在 agent 的沙箱里运行**，包括 `resume`、`search`、`show`。默认只读文件、只打印到终端，不访问网络和本地端口；开启语义检索 / 会话摘要后，`resume` 与 `search` 会按用户配置做有预算的查询前定向排空（≤3 会话 / ≤5s），失败静默回退。`--out` 把结果写到 agent 指定的文件里。
- **写入方有两类**：
  1. 用户自己运行的命令（`setup`、`doctor`、`ui`）；
  2. 触发增强装进各工具的 **hook 进程**（`memrelay hook`，由宿主工具调用，见 5.7）——Stop / SessionEnd 时增量索引刚写完的会话文件，SessionStart 时补扫变更。hook 静默、幂等、永不阻塞宿主（出错一律静默退出 0），与用户命令同时写库时靠 SQLite 的 busy_timeout 排队。
- **`resume` 快路径优先查库**（见 5.5），对候选文件做 size+mtime 校验后才采信库里数据；文件变了就现场重读那一个文件。库缺失或大面积过期时，落回全量扫盘，结果口径不变。
  - 它需要的过滤信息另存在 `~/.memrelay/filters.json`，包括排除的目录、已删除的会话和手动设置的状态，由负责写入的一方同步更新。
  - 只有原工具已经删除的旧会话，才会回退到以只读方式查询数据库。

## 5. 模块设计

### 5.1 入口程序与启动脚本

**入口程序 `bin/memrelay.cjs`**

- 用老语法写（CommonJS，不用新 API），Node 14 以上都能运行。
- 先检查当前 Node 版本。低于 22.15 时，按以下顺序寻找可用的 Node：
  1. `~/.memrelay/runtime.json` 里记录的路径
  2. PATH
  3. 常见版本管理器的目录：nvm、nvm-windows、volta、fnm、asdf、mise、Homebrew
- 找到一个可用的 Node 后：**当前 Node 就可用的常见情况下，直接在入口程序里加载 CLI**（省一次进程启动）；需要换 Node 时，用它重新启动自己，原样转发参数、标准输入输出和退出码。
- 找不到时，打印一段写给 agent 看的说明（原因，以及让用户运行 `memrelay doctor`），以非零退出码结束。
- 版本检查通过后，加载打包好的 `dist/cli.mjs`。

**启动脚本 `~/.memrelay/bin/`**

- 由 setup 生成两个：`memrelay`（POSIX sh）和 `memrelay.cmd`（Windows）。
- 不生成 `.ps1`：Windows 默认禁止运行 PowerShell 脚本，而 PowerShell 可以直接调用 `.cmd`。
- 脚本里写着 setup 时记下的 Node 路径和入口路径，每种都记两个：
  - 真实路径（解析过符号链接）：nvm 切换版本后仍然有效。
  - 原始路径：Homebrew、pnpm 升级后真实路径会变，原始路径仍然有效。

  启动时先试真实路径，再试原始路径，最后用 PATH 里的 `node`。
- Windows 上的 `.cmd` 由 cmd 按系统代码页（比如 GBK）读取，所以脚本里不写中文字面路径。能用 `%USERPROFILE%`、`%APPDATA%`、`%LOCALAPPDATA%` 表示的部分，一律用环境变量。
- 全部失败时打印英文说明（避开代码页问题），提示用户重新运行 `npm i -g memrelay` 和 `memrelay setup`。
- `runtime.json` 同时记录版本号，自动更新 Skill 时用来比对。

### 5.2 适配器

每个工具对应一个适配器，接口统一：

```ts
interface Adapter {
  agent: AgentId;   // 'claude-code' | 'qoder' | 'codex' | …
  version: number;  // 解析器版本，变化时触发重新解析
  detect(env: Env): Promise<Detection>;                       // 是否安装、会话存在哪里
  listSessions(scope: ProjectScope): Promise<SessionRef[]>;   // 只读元数据：路径、cwd、时间、大小
  readSession(ref: SessionRef, opts?: { fromOffset?: number }): AsyncIterable<NormalizedEvent>;
}
```

- 必须容忍"文件正在被写入"：最后一行 JSON 不完整时跳过，不报错。
- 大文件只在需要时完整解析。列候选时，只读文件开头（cwd、标题、第一条指令）和文件末尾（用来判断状态）。
- 不认识的记录类型保留为 `system_event`，不丢弃，这样升级解析器后可以重新解析。
- Claude Code 和 Qoder 的目录名，是把路径里的非字母数字字符替换成 `-` 得到的，无法还原。适配器先用同样的规则粗筛目录，再读会话第一条记录里的 `cwd` 来确认。

各工具的情况（2026-10 调研，`~` 表示用户主目录）：

| 工具 | 作为来源 | 会话位置与格式 | 作为接手工具（Skill 目录） |
|---|---|---|---|
| Claude Code（命令行、VS Code 扩展） | 迭代 1 | `~/.claude/projects/<编码后的路径>/<会话 id>.jsonl`。JSONL 格式，`uuid` 和 `parentUuid` 构成对话树。默认约 30 天后自动清理 | `~/.claude/skills/` |
| Qoder（命令行、桌面版） | 迭代 1 | `~/.qoder/projects/<编码后的路径>/<会话 id>.jsonl`。与 Claude Code 结构相同，另有 `workspace-directories`、`runtime-config`、`active-leaf` 等记录类型 | `~/.qoder/skills/` |
| Codex（命令行、IDE 扩展、桌面版） | 迭代 2 | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`，可能被压缩成 `.jsonl.zst`。`state_*.sqlite` 的 `threads` 表里有标题、cwd、分支 | `~/.agents/skills/`，兼容旧位置 `~/.codex/skills/` |
| Cursor | 迭代 4 | 用户数据目录下的 `globalStorage/state.vscdb`（`cursorDiskKV` 表，明文，只读） | 它会读 `~/.cursor/skills`、`~/.agents/skills`、`~/.claude/skills`、`~/.codex/skills`，不用单独放 |
| Qoder IDE | 迭代 4 | `~/.qoder/projects/<编码后的路径>/*.jsonl`（IDE transcript 格式） | 与 Qoder 共用 `~/.qoder/skills/` |
| CodeBuddy | 迭代 6 | CLI：`~/.codebuddy/projects/<编码路径>/<会话 id>.jsonl`（与 WorkBuddy 同引擎、同记录类型）；IDE：`%LOCALAPPDATA%/CodeBuddyExtension/Data/<uid>/CodeBuddyIDE/<uid>/history/<md5(工作区)>/`，其下 `index.json`（会话列表）+ `<会话 id>/index.json` + `<会话 id>/messages/<消息 id>.json`；消息 `message`/`extra` 为 JSON 字符串，content 片段含 text/reasoning/tool-call/tool-result；工作区路径由 VS Code 的 `workspaceStorage/*/workspace.json` 反查（hash = md5(平台规范化路径)），映射丢失时从首条消息的 `<user_info> Workspace Folder` 兜底 | `~/.codebuddy/skills/`（CLI 与 IDE 共用） |
| WorkBuddy | 迭代 5 | `~/.workbuddy/projects/<编码路径>/<会话 id>.jsonl` + `workbuddy.db` 元数据（与 CodeBuddy CLI 同引擎） | `~/.workbuddy/skills/` |
| Trae / Trae CN | 已支持 | CLI 是 Codex 兼容的 rollout 格式；IDE 会话库加密，由 hook 事件（`hooks_env/memrelay-events`）重建会话 | `~/.trae-cn/skills/`；国际版 `~/.trae/skills/` |
| Hermes Agent | 留给社区 | `~/.hermes/state.db`（SQLite，有官方文档） | `~/.hermes/skills/` |
| ZCode | 已支持 | `~/.zcode/cli/db/db.sqlite`（OpenCode 系 SQLite，只读） | `~/.zcode/skills/`（兼容 Claude / Codex Skill） |
| DeepSeek Harness | 已支持（2026-10-15 本机实测） | `~/.dsh/sessions/<编码项目目录>/session-<id>/session.v4.jsonl.zstd`。多帧 zstd 追加写的 JSONL（每批事件一帧），事件式记录（user/message、assistant/message、tool/call、tool/result、turn/end…），项目目录名由 cwd 编码（分隔符折叠、特殊字符 `~XXXX` 转义） | `~/.dsh/skills/`（官方技能体系兼容 Claude 格式：SKILL.md + frontmatter，热加载）。实时索引走**进程内插件**：memrelay 包内置 `memrelay-dsh-plugin`，挂载在 home 级 `cordis.patch.yml` 的 memrelay 块里（`file://` 直指插件入口；桌面端 profile 归 Electron 应用独占，`dsh plugin add` 装不进去，patch 挂载是唯一不碰 profile 的扩展面）。插件在 harness 进程内订阅 `agent/turn-stopping`/`agent/created` 并派生普通子进程跑 `memrelay hook --flavor dsh`（payload 与 hooks 桥同形，`transcript_path` 恒空、按 session_id + cwd 回推文件）。官方 `dsh-hooks-claude-code` 桥同块挂载（`~/.dsh/hooks.json`）作启动提示与兼容。为什么不拿 hooks 做索引：dsh 的 hook 命令经 ACL 沙箱受限通道执行（Windows 桌面版受限子进程有已知初始化缺陷 0xC0000142，且受限令牌只能写工作区、写不了 `~/.memrelay`）；进程内插件不受这两条限制（官方文档：installed Host code executes in-process outside the workspace sandbox） |

### 5.3 统一会话模型

```ts
type PartKind =
  | 'text' | 'reasoning'
  | 'tool_call' | 'tool_result'   // tool_result 带 status: 'ok' | 'error'
  | 'file_edit'                   // 文件路径 + diff 摘要
  | 'plan'                        // 待办或计划的快照：TodoWrite、TaskCreate/TaskUpdate、update_plan 等都统一成这一种
  | 'image' | 'compaction_summary' | 'system_event';

type ToolCategory = 'read' | 'write' | 'search' | 'shell' | 'task' | 'web' | 'other';

interface Session {
  id: string;                     // `${agent}:${原生 id}`
  agent: AgentId;
  sourcePath: string;
  cwd: string;
  projectRoot: string;
  gitBranch?: string;
  title?: string;
  firstUserMessage?: string;
  startedAt: string;
  endedAt: string;
  status: 'in_progress' | 'interrupted' | 'done' | 'abandoned' | 'unknown';
  parentSessionId?: string;       // 子 agent 的会话指向父会话
}

interface Message {
  sessionId: string;
  ordinal: number;
  nativeId?: string;              // 原生 id 和父 id，用来还原对话树
  nativeParentId?: string;
  role: 'user' | 'assistant' | 'tool' | 'system';
  createdAt: string;
  isSidechain: boolean;
  isCompactBoundary: boolean;
  parts: Part[];
}
```

- 字段命名尽量和 AgentsView 的表结构保持一致，方便对照和借鉴。
- **当前分支**：从最新的叶子沿父节点回溯到根。被回退掉的分支仍保留在库里，但不计入进度。Qoder 的 `active-leaf` 记录可能直接给出当前叶子，待验证。
- **子 agent**：执行过程不放进续接内容，只保留它最后交回的结果。

### 5.4 项目识别

- 项目就是 git 仓库的根目录。在仓库子目录里开的会话，也归到根目录名下。
- 同一仓库的其他 worktree，或者克隆到别处的副本：不合并，但在候选里标注"在另一个目录"。
- 不是 git 仓库时，按目录路径区分项目。
- 比较路径前先统一规范化：统一分隔符，解析符号链接；Windows 上不区分大小写。

### 5.5 续接引擎

**0）候选从哪里来（快路径三级流程）**

1. **查库排序**：从索引库取出当前项目各会话的投影（状态、标题、用户指令、最后几段回复、改过的文件、顺序），按下面的规则打分排序——毫秒级。
2. **size + mtime 校验**：对枚举到的会话文件逐个 `stat`，与库里记录的来源比对。不一致、或库里还没有的文件，才现场重读，而且只读那一个（文件变了、新会话出现都在这一步补上）。
3. **深读只做选中的**：最终选中哪一个，才完整解析它（以及接力链上的前几段）用于渲染。
4. **降级**：库缺失、打不开，或需要现场重读的文件超过阈值（说明库大面积过期）时，落回全量扫盘，行为与没建索引时完全一致。

两条路径的打分、状态判定、调用方识别共用同一套逻辑（有等价性测试保证逐项一致）。

**1）选会话**

1. 收集当前项目里所有来源工具的会话，去掉被用户删除或排除的。
2. 排除调用方自己。接手工具的当前会话也在被写入，最后一条记录通常是"正在调用 `memrelay resume`"，按这个特征排除。
3. 打分排序，参考四项：
   - 最近活动时间
   - 关键词匹配度（中文按相邻两字一组切分）
   - 会话改过的文件与当前 git 改动的重合度
   - 是否中断（中断的加分）
4. 输出：
   - 第一名明显领先：直接输出续接内容，末尾附 2 个备选。
   - 没有明显领先的：输出候选菜单，列最近 10 到 15 个会话，一行一个，写明工具、时间、标题、第一条指令、状态。菜单是**给 agent 的判断材料**，不是给人直接操作的表单：有关键词时，agent 选定后运行 `memrelay resume <会话 id>` 正式接续（强制选中、输出带接力标记，能落链）；多个候选都同样合理时只把 2–3 个最可能的转述给用户；无关键词的多候选（用户只说"继续"）信息不足以判断，仍先让用户挑。
   - 没给任务描述：选最近一个中断的会话；前两名都落在最近 2 小时内（分不出主次）时，改出候选菜单。
   - 全是"空壳"（只有提问、没有产出的被关掉会话）时不硬接，明确说明没有可续接的进展。

**2）判断状态**

按规则自动判断，用户可以在界面里手动修改。

- **进行中**：源文件在 3 分钟的新鲜度窗口内被写过。
- **中断**：满足任一条件即可。
  - 停在一个还没有结果的工具调用上。
  - 出现额度用完、限流或报错。
  - 最后一条是用户消息，但没有回复。
- **完成**：最后一条是 agent 的收尾正文（该助手消息没有工具调用、且有文本），并且待办全部完成。短回复也算完成；停在工具调用/工具结果上的不算。
- **放弃**：只能手动标记。
- 其他情况都算**未判定**。

界面（任务列表与会话列表）里的状态在查询时实时重算：索引时把判定信号（未回结工具调用、额度 / 限流、报错、末条用户消息未回应、待办未清、末条助手消息是否收尾正文、最后发言角色）落库，查询时结合最新 mtime（stat 校验）和当前时刻得出结论——"进行中"随文件不再被写自然降级，不需要重新索引；旧库在 buildIndex 时一次性回填信号（以 `sig_reply_len > 0` 表示末条助手是收尾正文）。

**3）提炼内容**

不调用大模型。

| 内容 | 来源 |
|---|---|
| 用户的全部指令（原话） | 当前分支上的用户消息 |
| 计划和待办（最终状态） | 最后一个 `plan` 片段 |
| 改过的文件 | 写入类工具调用和 `file_edit` 片段；再加上运行 `resume` 时执行的 `git status --porcelain` 和 `git diff --stat`（带 `--no-optional-locks`，不写 git 索引） |
| 最后进展 | 最后几轮对话、最后一次报错、旧 agent 说的最后一段话 |
| 接力历史 | 来源会话本身就是续接来的，就沿链把前几段的指令和进展合并进来 |

**4）输出格式**

```markdown
【MemRelay 续接】
接的是：Qoder · 2026-10-12 15:30 · D:\webProject\site · 会话 qoder:3f2a…（接力链：Qoder → Claude Code）
## 你的原始指令
## 计划和待办
## 改过的文件与当前 git 状态
## 最后进展
## 接手须知
- 先用一两句话告诉用户：接的是哪个会话、进度如何、接下来做什么，然后直接开工
- 以磁盘上的文件为准：旧 agent 可能写到一半就被打断了
- 把待办搬进你自己的待办工具
- 需要细节时运行：memrelay show qoder:3f2a… --from 120
```

- **第一行**固定为 `【MemRelay 续接】`。接手工具看到这一行是乱码，就改用 `--out`。
- **第二行**带机器可读的会话 id，接力链靠它建立。
- **长度**控制在约 8k tokens 以内，按一个汉字约 1 token、四个英文字符约 1 token 估算。
  - 超出时，按"头部 > 最后进展 > 计划 > 指令 > 文件"的优先级裁剪。
  - 裁掉的部分要注明省略了多少、怎么查看。
- 打印前先遮盖密钥，见 5.6。

### 5.6 存储（迭代 2）

- **位置**：`~/.memrelay/memrelay.db`，SQLite，WAL 模式，使用 Node 自带的 `node:sqlite`。可以用环境变量 `MEMRELAY_HOME` 改位置，测试时就靠它隔离。
- **原则**：原始文件是唯一的准绳，库里的数据随时可以从原始文件重建。例外是原工具已经删除的会话，这部分只存在库里。

主要的表：

| 表 | 作用 | 关键字段 |
|---|---|---|
| `sources` | 记录读过的原始文件，用来增量读取 | agent、path、size、mtime、hash、last_offset、adapter_version |
| `sessions` | 会话 | id、agent、project_root、cwd、git_branch、title、first_user_message、started_at、ended_at、status、status_source（自动或手动）、parent_session_id、deleted_at |
| `messages` | 消息 | session_id、ordinal、native_id、native_parent_id、role、created_at、is_sidechain、is_compact_boundary、on_current_branch |
| `parts` | 片段 | message_id、idx、kind、text、json、tool_name、tool_category、tool_call_id、status、blob_sha256、truncated |
| `blobs` | 过长的内容 | sha256、压缩后的内容 |
| `tasks`、`task_sessions` | 任务与接力链 | 任务名、状态、会话顺序、自动或手动关联 |
| `parts_fts`、`parts_cjk_fts` | 全文索引 | 见下文 |
| `secret_findings` | 检测到的密钥 | 片段位置、规则 id 与版本、遮盖后的预览（不存原文） |
| `tombstones` | 预留的删除墓碑 | 原始文件路径、原生 id、内容哈希（当前删除以 `filters.json` + `sessions.deleted_at` 为准） |
| `settings` | 配置 | 语义检索 / 会话摘要 / 偏好整理各自独立的接口与开关；排除目录、自动接入开关在 `filters.json` |

- **过长内容**：单个片段超过约 32 KB 时，库里只留开头和结尾各一段，中间换成省略标记。完整内容压缩后放进 `blobs`，按内容哈希去重。
- **中文搜索**：SQLite 的默认分词会把一整段中文当成一个词，所以搜不到；trigram 分词搜不到两个字的词。这两点已在 Node 22 和 24 上实测。因此建两个索引：
  - `parts_fts` 用默认分词，负责英文、路径和代码。
  - `parts_cjk_fts` 存放预处理过的文本：连续中文同时写入单字与相邻两字组，查询词做同样切分，两字组之间用 OR 提高召回。切分用纯 JS 实现，不依赖原生扩展。
- **两个版本号**：
  - 表结构：用 `PRAGMA user_version` 记录，配合按顺序执行的迁移脚本。遇到由更新版本程序写入的数据库，拒绝打开，提示用户升级。
  - 解析器：每个适配器的 `version` 一变，就重新解析它负责的来源。
- **增量索引**：按 `sources` 里记下的大小、修改时间和偏移量，只读新增的部分。文件被截断或改写时，整个文件重读。
- **何时写入**：`memrelay ui` 启动时和运行期间（每 30 秒做一次增量重扫，让进行中的回合和新会话也能进列表），用户运行 `setup`、`doctor` 时，以及触发增强装进各工具的 hook（`memrelay hook`：Stop / SessionEnd 增量索引单个会话文件，SessionStart 补扫变更）。agent 调用的 `resume` / `show` / `search` 只以只读方式打开数据库。
- **自动接力链**：同项目的会话可直接按续接标记接线；跨项目必须在会话首条指令里明确说"继续 / 接着做"才接。否则只在本项目里测试 `memrelay resume` 的会话也会被误接进别的项目任务链（续接标记出现在工具输出里，不能单独作为依据）。
- **删除**：软删除，写 `filters.json` 的 `deletedSessions` 并把 `sessions.deleted_at` 置位；扫描到该会话时保留软删除标记、不再入队 AI 任务。在"已删除"列表里可以恢复，只要原文件还在就能重建。`tombstones` 为后续对账预留。

### 5.7 接入（setup）

**流程**

1. 检测已安装的工具。
2. 列出勾选清单（默认全选；空格取消勾选；至少要勾选一个；勾选即代表同意，不再二次确认）。
3. 列出将要写入的文件（含启动提示及其备份/撤销说明），写入。
4. 用本机的每种终端实际运行一遍，输出每个工具的 ✓ 或 ✗。

- 取消勾选的工具 = 不接入；之前装过的话同时移除（哈希一致才删，用户改过的保留并提示）。
- 非交互场景（`--yes` 或管道）：默认全装；`--skip <工具>` 跳过指定工具，`--no-enhance` 跳过启动提示。
- 写入清单（`integrations.json`）在跳过/移除后保留其余记录，随时可以重新 setup 把工具接回来。

**写入的内容**

- `~/.memrelay/bin/memrelay`、`~/.memrelay/bin/memrelay.cmd`、`~/.memrelay/runtime.json`。
- 每个检测到的 Skill 目录下的 `memrelay/SKILL.md`。同一个物理目录只写一次：先解析符号链接，以兼容 skillshare 这类同步工具。
- `~/.memrelay/integrations.json`：记录写入的每个文件及其哈希，供撤销和更新使用。

**SKILL.md 的要点**

- `description` 用中英双语，覆盖"继续 / 接着做 / continue / resume"加上"当前会话里没有上下文的任务"这类说法。
- 正文按终端分别给出命令。setup 写进去的是实际路径，例如：
  - bash / zsh / Git Bash：`'/c/Users/张三/.memrelay/bin/memrelay' resume "<任务关键词>"`
  - PowerShell：`& "$env:USERPROFILE\.memrelay\bin\memrelay.cmd" resume "<任务关键词>"`
  - cmd：`"%USERPROFILE%\.memrelay\bin\memrelay.cmd" resume "<任务关键词>"`
- 说明怎么用输出：先告诉用户接的是哪个会话；查看 git 状态，以磁盘上的文件为准；搬待办；遇到 3.2 里的三种情况先问用户。
- 任务描述只写简短的关键词，避免 `&`、`|`、`%`、引号这类特殊字符。
- 不要让输出经过 PowerShell 管道（比如 `| Out-String`），否则中文会乱码。看到首行是乱码时，改用 `--out <文件>`，再用读文件工具读。
- 命令不存在或报错时，告诉用户 MemRelay 不可用，然后照常处理用户的请求。

**更新与撤销**

- 用户在自己的终端里运行任意 memrelay 命令时，如果发现已写入的 Skill 版本较旧、且文件没被用户改过，就自动更新。
- `memrelay setup --undo` 只删除哈希仍和记录一致的文件。被用户改过的文件，先询问再处理。
- 发现自己运行在 npx 或 pnpm dlx 的临时目录里时，不写入任何文件，并提示改用全局安装。

**触发增强**

按工具逐个启用，需要用户同意，可以撤销。现在的形态是"三件套"+ 启动提示：

| 事件 | 做什么 |
|---|---|
| SessionStart | 增量补扫变更过的会话文件，输出一行未完成任务提示（注入会话上下文；没有则静默） |
| Stop / SessionEnd | 按事件 payload 里的 `transcript_path` 增量索引刚写完的那个会话文件 |

| 层级 | 做法 | 适用范围 |
|---|---|---|
| a | 只靠 Skill | 默认，所有工具 |
| b | 装上面的三件套：实时索引 + 启动提示 | a 触发不稳、并且支持 hooks 的工具：Claude Code、Qoder CLI、Trae CN（事件采集形态）、Codex、CodeBuddy（CLI + IDE）、WorkBuddy、ZCode；OpenCode 是插件形态（回合结束事件里调 `memrelay hook --flavor opencode` 精准索引单会话） |
| c | 在工具的全局规则文件里加一句话 | a 触发不稳、又不支持 hooks 的工具 |

- 启用方式：`memrelay setup` 在写入计划里**默认包含**需要它的工具的增强。确认一次后生效；`--no-enhance` 可整体跳过，`setup --undo` 外科手术式移除（用户其它配置不动），迭代 4 的界面里再做成逐工具开关。
- 各宿主调用方式的差异（均为实测结论）：
  - Claude Code：hooks 经 **Git Bash（sh）** 执行，命令用 sh 形式（`"$HOME/.memrelay/bin/memrelay" hook 2>/dev/null || true`），不能用 `%USERPROFILE%`。
  - Qoder CLI：事件名与 payload 与 Claude Code 一致，Windows 上用 **exec 形态**直调启动脚本（`{command: "cmd.exe", args: ["/c", <launcher.cmd>, "hook"]}`），不经 shell 解析。
  - Codex：hooks 在 `~/.codex/hooks.json`，事件名与 payload 与 Claude Code 一致；Windows 上 `command` 经 **PowerShell** 执行，所以同时给 `commandWindows`（Windows 优先用它）。未信任的 hook 不执行：setup 写 hook 时同时把三条的 `trusted_hash` 预置进 `~/.codex/config.toml` 的 `hooks.state`（与桌面端点"允许"等价），不再需要首次手动 `/hooks` 审查；哈希按 Codex 的 handler 规范化算法计算，命令被改过会失配并重新触发审查。
  - CodeBuddy：CLI 与 IDE 共用 `~/.codebuddy/settings.json` 的 `hooks`（IDE 也读同一份用户级设置；项目级 hooks 在未信任工作区会被跳过）。事件名与 payload 与 Claude Code 一致，命令经 **sh（Git Bash）** 执行；CLI 的 `transcript_path` 指向 `~/.codebuddy/projects/*.jsonl`，IDE 的指向会话 `conversations/<id>/index.json`——同一个 hook 按路径自动分派给两个适配器。IDE 的 SessionStart stdout 会被包成 `<system_reminder>` 注入下一轮请求，启动提示与 CLI 等效。
  - WorkBuddy：Agent 引擎是 CodeBuddy CLI，hooks 读 `~/.workbuddy/settings.json`（GUI 的 configDir），命令经 **sh（Git Bash）** 执行，payload 与 Claude Code 兼容（`transcript_path` 指向 `~/.workbuddy/projects`）。
  - OpenCode：走 v2 插件（`~/.config/opencode/plugins/memrelay.js`，`{ id, setup(ctx) }` 定义）；订阅 `session.execution.*`，回合结束调 `hook --flavor opencode` 按 `session_id` 单会话索引（库明文可读，不需要事件重建）。
  - ZCode：用户级 hooks 存 `~/.zcode/cli/config.json` 的 `hooks.events.*`（桌面端逐会话执行，不需要工作区信任；没有 SessionEnd）；`command`（shell 字符串）形态在桌面内核里执行不动，必须用 **`process` 形态**（cmd.exe /c 启动脚本，直启不经 shell）；payload 同时带 snake_case 与 camelCase 两套字段。
  - Trae CN：IDE 会话库加密，自成一个"事件型来源"（见 5.2）；hooks 经 PowerShell 执行（`~/.trae-cn/hooks.json` 或项目 `.trae/hooks.json`）。配置文件必须带 `version: 1`；Agent 模式设置页虽然没有 Hooks 入口，但运行时会执行全局/项目 hooks。**hook 命令不能调 `memrelay.cmd`**：Trae 默认「沙箱运行」会拦掉 `memrelay.cmd` 的 CreateProcess 和对 `~/.memrelay` 的写入（实测 0xC000012F / 0xC0000022）。因此 hook 直接把原始 payload 写到 Trae 自己的 `ModularData/ai-agent/hooks_env/memrelay-events`（沙箱允许写），`trae-events` 适配器读取并规范化；不需要用户改运行方式。Windows 用 PowerShell，macOS/Linux 用 `node -e` 内联脚本，userData 路径分别是 `%APPDATA%` / `~/Library/Application Support` / `$XDG_CONFIG_HOME`（缺省 `~/.config`）。
- **hook 的约定**：静默、幂等、永不阻塞宿主。任何失败（坏 payload、读不到文件、库被占用）都静默退出 0；漏掉的更新由下一次 SessionStart 补扫兜住。事件 payload 里的路径先取磁盘真实路径再索引，避免同一文件因大小写差异写两行来源。

**不做的事**：不安装 MCP；不修改权限配置，首次运行时由用户在工具里点一次"始终允许"；不使用 npm 安装脚本。

### 5.8 管理界面与本地服务（迭代 4）

**页面**

1. **仪表盘**（默认首页）：状态计数（进行中 / 中断 / 完成 / 放弃 / 未判定，零值也显示）、已删除数量、待接力的中断任务、最近任务、近 14 天活动（悬浮显示当天会话数）、工具与目录分布；状态卡点击进入任务列表并带上对应筛选，已删除卡进入回收站；与任务列表同一套状态与分组口径，每 30 秒静默刷新。
2. **任务列表**：按项目目录分组、目录可折叠（默认露出前 10 个目录，可继续展开）；组内按最近活动倒序，每目录分页懒加载（滚动到底自动续页），计数与状态每 30 秒静默刷新；服务端同时每 30 秒做一次增量重扫，正在进行、尚未触发 Stop 的回合也能出现在「进行中」。显示状态（进行中 / 中断 / 完成 / 放弃）和最近用过的工具。
3. **接力时间线**：一个任务跨工具的完整链路。
4. **原始对话**：按当前分支浏览，可以展开工具调用和被回退的分支；支持全局搜索。
5. **手动修正**：改任务名；标记完成或放弃，之后它不再出现在续接候选里；拆开或合并接力链。
6. **续接预览**和"复制续接提示词"。后者给不能运行命令的环境用，比如网页版对话。
7. **接入管理**：各工具的接入状态、一键接入或撤销、触发自测、新装工具提示。
8. **隐私**：按目录排除；查看检测到的密钥。
9. **删除**：可以删除单个会话、整个任务或整个项目的数据，在"已删除"里可以恢复。只删 MemRelay 里的数据，不动原工具的文件。
10. **配置**：语义检索与会话摘要（各自独立接口，可选）；是否自动接入新工具（默认关）。界面语言与主题在侧栏底部菜单切换（简洁 / 漫画 / 像素 × 浅色 / 深色 / 跟随系统；动效开启 / 关闭 / 跟随系统）。

**本地服务**

- 只监听 `127.0.0.1`。
- 默认固定端口 `4823`（被占用时退回随机端口）。界面主题、动效与语言保存在浏览器 localStorage（`memrelay-style` / `memrelay-mode` / `memrelay-motion` / `memrelay-lang`），默认简洁 / 浅色 / 动效开启，下次启动优先读取；固定端口保证浏览器 origin 不变，偏好才能跨启动沿用。
- 启动时生成随机访问令牌，打开浏览器时通过 URL 传入，之后每个请求都要带上。
- 校验 `Host` 头，只接受 `127.0.0.1` 或 `localhost`，防止 DNS 重绑定。不开放跨域。
- 接口按资源划分：仪表盘总览、项目、任务、会话与消息（分页）、搜索、续接预览、删除与恢复、接入、配置。
- 前端打包后放进 npm 包，由本地服务直接提供。
- 视觉方向已定稿为三套可切换皮肤（简洁 / 漫画 / 像素，2026-10-22），实现以 `docs/design.md` 与 `design/` 为准。

### 5.9 偏好与项目知识（全局偏好已实现，2026-10-23）

首版已实现**全局偏好**的导入、合并与下发（见 `docs/tidy.md`）：来源为 Qoder memory、Codex `AGENTS.md`、Trae CN 用户画像、Claude Code `CLAUDE.md`；由独立接口的整理模型合并，写入各工具规则文件的 MemRelay 标记块，可撤销。项目知识沿用同一套数据模型，后续接入。

1. **导入**：以只读方式导入各工具的记忆和规则文件，放进"待整理"列表。比如 Qoder、Claude Code 的记忆目录，Codex、Trae 的记忆文件。
2. **整理**：交给整理的对话模型去重、找出矛盾、给出建议（首版由 MemRelay 调独立接口；架构原设想由宿主 agent 用自己的模型）。
3. **拍板**：冲突不自动裁决，在「整理」页展示；用户改来源或后续拍板。
4. **来源变化**：拍板之后某个来源变了，按新内容自动重算；已下发的块被工具重写时自动补回。
5. **分层生效**：全局 → 工具专属 → 项目 → 任务，越具体越优先。首版只做全局。
6. **下发**：结果写进各工具全局规则文件里的一个 MemRelay 专属区块。以后导入时跳过这个区块，避免同一条内容被来回导入。

项目知识走同一套流程，只是作用范围换成项目。

## 6. 命令行接口

| 命令 | 使用者 | 作用 | 迭代 |
|---|---|---|---|
| `memrelay resume [关键词|<会话 id>] [--out <文件>]` | agent | 打印续接内容或候选菜单；给会话 id 时强制选中并落链 | 1 |
| `memrelay show <会话 id> [--from N]` | agent | 分页查看原始记录 | 1 |
| `memrelay search <关键词>` | agent | 在当前项目的会话里搜索 | 2 |
| `memrelay hint` | hook | 输出一行未完成任务的提示 | 2（按需） |
| `memrelay hook` | hook | 从 stdin 读宿主事件的 JSON：Stop / SessionEnd 按 `transcript_path` 增量索引那一个会话文件；SessionStart 补扫变更并输出提示。静默、幂等、永不阻塞宿主 | 3 |
| `memrelay setup [--undo] [--purge]` | 用户 | 接入或撤销 | 1 |
| `memrelay doctor` | 用户 | 自检：各工具的会话能否解析（只输出统计数字）、中文输出是否正常、Node 和启动脚本的路径是否有效 | 1 |
| `memrelay ui [--port N]` | 用户 | 打开管理界面（默认固定端口 4823，主题/语言偏好随 origin 留在浏览器） | 4 |
| `memrelay ping` | setup 自测 | 打印固定标记和版本号 | 1 |
| `memrelay`（不带参数） | 所有人 | 打印帮助；还没接入时，提示运行 setup | 1 |

- 帮助信息写给 agent 看，第一次见到这个命令的 agent 也能自己学会用。
- 输出一律是不带 BOM 的 UTF-8。
- 退出码：0 表示成功，输出候选菜单也算成功；1 表示用法错误；2 表示环境错误，比如找不到 Node、读不到会话目录。
- 参数解析用 Node 自带的 `util.parseArgs`。

## 7. 环境兼容

| 维度 | 覆盖范围 | 做法 |
|---|---|---|
| 操作系统 | Windows 10 及以上、macOS、Linux | 路径按系统区分；Windows 上比较路径时不区分大小写 |
| Node 版本 | 运行需要 22.15 及以上；电脑上同时装着低版本也行 | 入口程序会自动找到可用的版本 |
| Node 安装方式 | 官方安装包、nvm、nvm-windows、volta、fnm、asdf、mise、Homebrew、系统包管理器 | 启动脚本同时记录真实路径和原始路径，前者失效时回退到后者 |
| 全局安装方式 | npm、pnpm、yarn、bun | setup 记录实际的入口路径；不接受 npx 临时目录 |
| 终端 | PowerShell 5.1、pwsh、cmd、Git Bash、bash、zsh | Skill 按终端分别给出命令；不生成 `.ps1` |
| 编码 | 系统代码页不是 UTF-8 的 Windows（比如 GBK） | 输出 UTF-8，首行是固定的中文标记，备用 `--out`；`.cmd` 里不写中文字面路径 |
| 用户名 | 带空格或中文 | 命令里的路径一律加引号，尽量用环境变量表示 |
| 沙箱 | Codex、Qoder、Trae 等只允许写工作区、禁止访问本地端口 | agent 调用的命令只读、只打印，不访问网络和端口 |
| 确认弹窗 | 首次运行新命令时，要求用户确认 | 不改权限配置；setup 的自测结果会列出哪些工具会弹窗 |
| 输出上限 | Codex 单条命令约 1 万 tokens，Claude Code 约 3 万字符 | 续接内容控制在约 8k tokens 以内 |
| 第一版不覆盖 | WSL、容器、SSH 远程环境与主机之间互相续接 | 在这些环境里另装一份，环境内部可以互相续接 |

## 8. 安全与隐私

- 数据只存在本机的 `~/.memrelay/`，不做遥测。唯一的对外发送，是用户自己配置的可选 AI 接口（语义检索 / 会话摘要各自独立），而且只发送续接内容。
- 对其他工具只读。唯一的写入是 Skill 文件和 `~/.memrelay/`，全部记在清单里，可以撤销。
- 入库和输出之前都检测密钥，包括 API Key、令牌、私钥、连接串、`password=` 等，规则带版本号。输出时一律遮盖，库里只存遮盖后的预览。
- 界面服务只监听 127.0.0.1，带访问令牌，并校验 Host 头；写请求还会拒绝与本机地址不同源的 Origin。
- 可选 AI 接口的 Key 存在 `~/.memrelay/memrelay.db` 的 `settings` 表，目录权限仅限当前用户。
- 支持按目录排除。被排除的项目不归档，也不会出现在续接候选里。

## 9. 工程结构与技术栈

```text
memrelay/                            仓库是 pnpm workspace；发布物只有 packages/cli
├─ packages/
│  ├─ cli/                          命令行主包（npm 上的 memrelay）
│  │  ├─ bin/memrelay.cjs           入口程序（老语法）
│  │  ├─ src/
│  │  │  ├─ cli/                    命令分发；commands/ 下每个用户命令一个文件
│  │  │  ├─ core/                   统一模型、项目识别、中文切分、token 估算、密钥规则
│  │  │  ├─ adapters/
│  │  │  │  ├─ jsonl-family/        记录模型、解析工具与 JSONL 适配器基类
│  │  │  │  ├─ claude-code/
│  │  │  │  ├─ qoder/               复用 claude-code 的解析，另外处理额外的记录类型
│  │  │  │  └─ codex/ …
│  │  │  ├─ resume/                 选会话、判断状态、提炼、渲染、接力链、hint 引擎
│  │  │  ├─ store/                  SQLite、迁移、索引器、全文索引
│  │  │  ├─ integrations/           工具清单、Skill 模板、启动脚本、setup 与撤销、hook 入口
│  │  │  └─ server/                 本地服务接口
│  │  ├─ test/                      fixtures/ golden/ e2e/ manual/（手工验收） bench/
│  │  └─ dist/                      构建产物（含界面 dist/ui；npm 包只带 bin + dist）
│  └─ ui/                           管理界面（React；产物构建进 packages/cli/dist/ui）
├─ docs/                            长期设计文档（architecture.md、design.md）
└─ .github/  README.md  LICENSE
```

| 方面 | 选择 |
|---|---|
| 语言 | TypeScript（strict 模式） |
| 包管理 | pnpm |
| 命令行打包 | tsdown，打成单个 `dist/cli.mjs`，依赖全部内联 |
| 管理界面 | React 19 + Vite + Tailwind CSS v4 + shadcn/ui + Motion，构建进 `packages/cli/dist/ui`（先 tsdown 后界面构建；tsdown 只清 `dist/cli.mjs`，不碰 `dist/ui`） |
| 本地服务 | Node 自带的 `http`，加一个轻量路由（比如 Hono），和命令行一起打包 |
| 数据库 | `node:sqlite` |
| 测试 | Vitest |
| CI 与发布 | GitHub Actions：三个平台跑测试；打 tag 后发布到 npm，附带 provenance |
| `package.json` | `packages/cli` 的 `engines.node` 为 `>=22.15`；`bin.memrelay` 指向 `bin/memrelay.cjs`；`files` 包含 `bin`、`dist`、`dsh-plugin` |

## 10. 测试策略

- **先写测试，再写实现**：每个功能都从一个失败的测试开始。
- **适配器**：每个工具一组手写样例，覆盖以下情况：
  - 普通对话、工具调用、待办变化
  - 回退与分叉、上下文压缩、子 agent
  - 额度用完导致中断、最后一行只写了一半
  - 超长的工具输出、中文、包含密钥

  样例照真实格式手写，不提交任何真实会话。
- **续接输出**：和标准答案文件比对，覆盖单个会话、多次接力、候选菜单、超出预算时的裁剪。
- **实时索引与快路径**：hook 的 Stop / SessionEnd 单文件索引、SessionStart 补扫与提示、静默契约（坏 payload、未知事件不报错）、半截文件容错；查库快路径与读文件路径的排序等价性（同一批会话两条路径逐项一致）；候选来自库（保持 size+mtime 不变的同尺寸改写也按库续接）、过期文件现场重读、新会话补进候选、库缺失降级；两条宿主调用链（sh 形式与 exec 形式）的手工验收。
- **端到端**：用临时目录伪造 `HOME`、`USERPROFILE`、`MEMRELAY_HOME`，放进样例，然后调用打包后的命令。
- **环境矩阵**（GitHub Actions），覆盖以下维度：
  - 系统：Windows、macOS、Linux
  - Node：22.15、22 最新版、24；另外测"当前生效的是 Node 18、电脑上另有 24"时，入口程序能不能自动切换
  - 安装方式：官方安装包、nvm 或 nvm-windows、volta、fnm、pnpm 全局安装
  - 终端：PowerShell 5.1、pwsh、cmd、Git Bash、bash、zsh
  - 主目录：带空格、带中文
  - 参数：带 `&`、引号等特殊字符

  每个组合都先跑 setup，再用各种终端调用 Skill 里的命令，检查输出是否正确。
- **本机检查**：`memrelay doctor` 解析本机的真实会话，只输出统计数字，不输出内容。工具升级改了格式时，能及早发现。
- **触发测试表**（手工验收）：在每个接手工具里，用几种说法测 Skill 会不会触发，比如"继续完成 XX 任务""继续""接着做"。记录结果，决定要不要启用 b 或 c。

## 11. 迭代计划

每个迭代结束时，都能单独使用。

### 迭代 1：一句话续接（从 Qoder、Claude Code 切到任意工具）

1. 工程骨架：pnpm、TypeScript、Vitest、tsdown；入口程序；`memrelay`、`ping` 和帮助信息
2. 统一模型与文本工具：中文切分、token 估算、密钥遮盖
3. Claude Code 适配器
4. Qoder 适配器
5. 项目识别
6. `resume`：
   - 选会话：直接扫描文件，不建库，并排除调用方自己的会话
   - 判断状态、提炼内容、渲染输出
   - 长度预算、`--out`
   - 接力链：沿链读取前几段会话
7. `show`
8. 接入：工具检测、Skill 模板、启动脚本、写入清单、`setup` 与 `--undo`、各终端自测
9. `doctor`
10. CI 环境矩阵

验收标准：
- 在 Qoder 里做到一半的任务，切到 Claude Code、Codex、Cursor、Trae CN，照常说"继续完成 XX 任务"就能接上。从 Claude Code 切到其他工具也一样。
- 在 PowerShell 5.1 + GBK 环境下，中文不乱码。
- 三个平台的 CI 全部通过。
- 完成触发测试表。

### 迭代 2：Codex、数据库、搜索

- Codex 适配器，包括 `.jsonl.zst`
- 存储与增量索引、中文全文索引
- `search`
- 完善候选菜单的打分
- 接力链入库
- 根据触发测试表，给触发不稳的工具启用 b（`hint` + hook）或 c

验收标准：一个任务经过三个工具接力后，接手工具能拿到整条链的进展；两个字的中文词能搜到。

### 迭代 3：实时索引（hook 写库 + 查库优先）（已完成 2026-10-14）

1. `memrelay hook`：Stop / SessionEnd 按 payload 的 `transcript_path` 增量索引单个会话文件；SessionStart 增量补扫并输出提示。静默、幂等、永不阻塞宿主。
2. `resume` 快路径：查库排序 → 候选文件 size+mtime 校验 → 深读只做选中的会话；库缺失 / 大面积过期落回全量扫盘，没装 hook 的工具行为不变。
3. `setup` 触发增强扩展：Claude Code 从单条 SessionStart 提示扩成三件套；Qoder CLI 同样装上（exec 形态）；撤销时外科手术式移除。
4. 入口程序（5.1）：当前 Node 可用时在进程内加载 CLI，省一次进程启动。

验收标准：
- 在 Claude Code / Qoder 里正常干活，不敲任何 memrelay 命令，库里进度自动更新（Stop 后几秒内）。
- 在 Codex 干到一半直接杀进程 → 切到其他工具说"继续" → 立刻拿到进度（补扫把半截文件接上）。
- 35 个会话的项目上 `resume` 进入 0.3 秒量级。
- 老流程（没装 hook 的工具、没有索引库）一切照旧。

### 迭代 4：管理界面

实现 5.8 的全部页面。开工前，先用 frontend-design 确定视觉方向。

验收标准：所有页面功能可用；删除后能恢复；访问令牌和 Host 校验都有测试。

### 迭代 5：更多来源与更多 hook

- Cursor、Qoder IDE、WorkBuddy 的适配器
- Trae：CLI 明文会话的适配器 + IDE 侧用 hook payload 采集会话（IDE 会话库加密，研究结论见开发记录）
- 把 WorkBuddy 作为接手工具接入
- 为 Codex / Trae / Cursor 实测并接入 b 层三件套
- hooks 轮（来源之外的实时捕获）：Codex（`~/.codex/hooks.json`，PowerShell/`commandWindows` + 预置 `hooks.state.trusted_hash`）、WorkBuddy（`~/.workbuddy/settings.json`）、OpenCode（v2 插件单会话索引）、ZCode（用户级 `~/.zcode/cli/config.json`，process 形态）四家已接入并真机触发验证；Trae CN 事件采集此前已完成。
Cursor 会自动导入 `~/.claude/settings.json` 的 hooks（第三方兼容，默认开），不额外安装、维持扫盘兜底
- dsh 实时索引走进程内插件：memrelay 包内置 `memrelay-dsh-plugin`，挂载在 memrelay 已有的 home 级 `cordis.patch.yml` 块里（`file://` 直指插件入口，`setup --undo` 随块撤销）——不碰 dsh 的 profile 依赖（桌面端 profile 归 Electron 应用独占，`dsh plugin add` 装不进去）。插件在 harness 进程内订阅 `agent/turn-stopping` / `agent/created` 并派生 `memrelay hook --flavor dsh`；hooks 桥保留作启动提示与兼容——它的命令经 dsh 的 ACL 沙箱受限通道执行，受限子进程存在已知初始化缺陷（0xC0000142）且受限令牌只能写工作区，进程内插件不受这两条限制

### 迭代 6：CodeBuddy（CLI + IDE）

- CLI 与 WorkBuddy 同引擎，复用同一套 JSONL 解析（`adapters/codebuddy/cli.ts` 的工厂同时供 WorkBuddy 使用）
- IDE 历史按 `<history>/<工作区 md5>/<会话 id>/{index.json,messages/*.json}` 解析（旧的 `genie-history/<base64 工作区>/conversations/` 布局也兼容）；tool-call / tool-result / reasoning 从消息 content 片段归一化，标题与时间取工作区 `index.json`；消息时间兼认 `createdAt` 与 `createTime`
- 两者共用一个 agent id `codebuddy`：来源是 `~/.codebuddy/projects/*.jsonl` 与 IDE 的 history 根；hook 一次安装写进 `~/.codebuddy/settings.json`，CLI 与 IDE 都会执行（IDE 的 `transcript_path` 指向会话 `index.json`，同一入口按路径分派；适配器用 `acceptsPath` 判断多来源归属）
- 接手 Skill 写入 `~/.codebuddy/skills`，CLI 与 IDE 共用

### 之后

1. 项目知识
2. 社区适配器：Hermes Agent
3. 本地模型嵌入 / sqlite-vec 检索后端

## 12. 第一版不做

- 跨电脑同步，以及团队成员之间的交接
- WSL、容器、SSH 远程环境与主机之间互相续接
- MCP 服务
- 修改其他工具的会话、权限和配置
- 桌面应用。以后可以用 Tauri 把网页界面包一层

## 13. 风险与待验证

| 风险或待验证事项 | 应对 | 何时验证 |
|---|---|---|
| 各工具的会话格式没有公开文档，升级后可能变化 | 每个工具一个适配器；适配器版本一变就重新解析；doctor 自检时做解析完整性检查（原始记录多、解析出的消息极少就报警，能发现"不报错但内容丢了"）；不认识的记录保留下来 | 持续 |
| 各工具对 Skill 的触发效果不同 | 触发测试表，加上 b、c 两层补救 | 迭代 1 |
| 识别接手工具自己的当前会话，以便排除 | 按"最后一条是 memrelay 调用"来识别；样例覆盖各工具写入记录的时机 | 迭代 1 |
| 旧 agent 还在运行，两边同时改文件 | 检测最近的写入时间，发现可疑就先问用户 | 迭代 1 |
| Cursor 从多个目录读取 Skill，可能显示两份同名 Skill | 两份内容相同；如果有问题，改为只写一个目录 | 迭代 1 |
| PowerShell 5.1 + GBK 下中文乱码 | 首行中文标记，加上 `--out` | 迭代 1 |
| 在沙箱里以只读方式打开 WAL 模式的 SQLite | 实测；如果不行，`resume` 只读 `filters.json`，不碰数据库 | 迭代 2 |
| Codex 的 `.jsonl.zst` 需要 zstd 解压（Node 22.15 起自带，待确认） | 在较低版本上跳过这类文件并给出提示 | 迭代 2 |
| Codex 的 hooks 在 Windows 上能否使用；Cursor 开局注入的已知 bug；Trae 的 hooks 在 SOLO 模式下是否生效 | 实测后决定这些工具能否用 b 层。结论：Codex 已接入（Windows 经 PowerShell，`commandWindows` 字段给 Windows 专用命令；未信任的 hook 不跑，setup 预置 `hooks.state.trusted_hash` 后无需手动放行）；Cursor 会自动导入 `~/.claude/settings.json` 的 hooks，不另装；Trae 官方文档确认 hooks 适用于所有模式（含 SOLO/对话），但要求 `version: 1` 且在 设置 > Hooks 里启用——此前只做了手工模拟，真实 UI 触发待启用后复测 | 迭代 2 → 迭代 5 已定 |
| Cursor 的记录缺少工具输出，IDE 和命令行分开存储 | 适配器分别处理；缺失的部分在续接内容里注明 | 迭代 4 |
| Claude Code 默认约 30 天后清理旧会话 | 及时归档到 `memrelay.db` | 迭代 2 |
| hook 在各工具里是否真正触发、stdout 是否注入上下文 | 两个宿主（Claude Code / Qoder CLI）的调用链已在本机按真实方式实测；即使 hook 不生效，resume 会现场重读变更文件，功能零缺失 | 迭代 3 |
| hook 与用户命令并发写库（SQLITE_BUSY） | 写入方设 busy_timeout 排队；hook 失败静默，下一次 SessionStart 补扫兜住 | 迭代 3 |
| 宿主给的 `transcript_path` 与扫盘路径大小写/分隔符不一致（Windows） | hook 先取磁盘真实路径再索引，保证同一文件只有一行来源记录 | 迭代 3 |
| hook 每回合结束都要写库，大文件会话会拖慢宿主 | 单文件索引目前整文件重读（2MB 会话约 0.2-0.4s，已设 hook 超时且失败静默）；后续可按 `last_offset` 只解析新增部分 | 迭代 5 |

## 14. 关键决策

| 决策 | 选择 | 理由 | 放弃的方案 |
|---|---|---|---|
| 怎么拿到旧任务的进度 | 读取各工具的本地会话记录 | 额度用完时，旧 agent 无法配合；安装 MemRelay 之前的会话也能续接 | 让旧 agent 边做边写交接文档 |
| 新 agent 怎么调用 | 全局命令，加上自动分发的 Skill | 不用在每个工具里装 MCP；命令是只读的，在沙箱里也能跑；新工具开箱即用 | MCP 服务；全局规则文件 |
| 怎么接入 | 安装后运行一次 `memrelay setup` | 用户看得到改了什么，可以撤销；在所有包管理器下表现一致 | npm 安装脚本：输出会被隐藏，pnpm 和 bun 默认不执行，没有卸载钩子，还会被安全扫描标红 |
| 续接内容怎么生成 | 按规则提炼，大模型只作可选项 | 不需要 API Key；结果可测试、可预期 | 必须配大模型；只给最后 N 轮对话 |
| 怎么找到对应的任务 | 当前项目 + 时间 + 关键词 + 改过的文件，生成候选菜单，再由 agent 判断 | 接手的 agent 本身就是大模型；向量检索要下载模型，在沙箱里断网，启动也慢 | 只用关键词或只用向量；关键词加向量的混合检索 |
| 存储 | 自建 SQLite，表结构向 AgentsView 看齐 | 能打包进 npm 包；有片段这一层；能归档原工具已清理的会话 | 直接用 AgentsView（Go 写的，60 多张表，没有片段层）；不建库 |
| `resume` 是否依赖数据库 | 优先查库（快路径）：候选文件做 size+mtime 校验，变了就现场重读那一个；库缺失或大面积过期时全量扫盘兜底 | 要毫秒级拿到候选，又不能让过期索引给出错进度；两条路径输出口径一致（有等价性测试） | 完全依赖库（过期就错）；完全扫盘（每次整读所有会话文件） |
| 怎么保证任何环境都能运行 | 固定位置的启动脚本，按终端给出命令，装完当场自测 | 写死的路径在不同的 Node 安装方式、终端和编码下会失效 | 在 Skill 里写死绝对路径；依赖 PATH |
| 首次运行时的确认弹窗 | 不改权限配置，由用户点一次"始终允许" | 权限配置比较敏感，写错了会削弱用户原有的安全设置 | setup 自动把命令加进免确认名单 |
| 删除的范围 | 只删 MemRelay 里的数据，可以恢复 | 对其他工具只读，是用户敢放心安装的前提 | 连原工具的会话文件一起删 |
| 界面形式 | 本地网页 | 做得最快；不绑定任何工具；以后可以包成桌面应用 | 桌面应用、IDE 插件、终端界面 |
| 偏好冲突 | 用户拍板，记住指纹，来源变化时自动采用较新的并提示 | 冲突一定要让用户看见；拍过板的不再重复问 | 以最后写入的为准；只汇总、不下发 |

## 15. 参考

借用下列开源代码时，按其许可证注明出处。

- AgentsView（MIT）：覆盖 20 多个工具的统一会话表结构。https://github.com/kenn-io/agentsview/blob/main/internal/db/schema.sql
- cli-continues（MIT）：续接内容的数据结构。https://github.com/yigitkonur/cli-continues/blob/main/src/types/index.ts
- Hermes Agent：SQLite 全文索引里的中文处理。https://github.com/NousResearch/hermes-agent/blob/main/hermes_state_fts.py
- Codex：JSONL 原始记录加 SQLite 索引，以及超长输出的截断。https://github.com/openai/codex/tree/main/codex-rs/rollout/src
- OpenCode：会话 / 消息 / 片段三层模型。https://github.com/anomalyco/opencode/blob/dev/packages/schema/src/session-message.ts
- claude-mem issue #3982：默认分词下中文搜不到的反面例子。https://github.com/thedotmack/claude-mem/issues/3982
- 各工具的 hooks / 插件文档：
  - Qoder：https://docs.qoder.com/cli/hooks
  - Claude Code：https://code.claude.com/docs/en/hooks
  - Codex：https://learn.chatgpt.com/docs/hooks
  - Trae：https://docs.trae.ai/ide/hook-configuration-reference
  - Cursor：https://cursor.com/docs/hooks
  - WorkBuddy / CodeBuddy：https://www.workbuddy.ai/docs/zh/cli/hooks-guide
  - OpenCode 插件（v2）：https://opencode.ai/v2/docs/build/plugins
  - ZCode：https://docs.zcode.z.ai
