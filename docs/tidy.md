# 跨工具偏好整理（tidy）

> 状态：已实现（2026-10-23）。只做全局偏好；项目知识沿用同一套数据模型，后续接入。

## 1. 定位

用户同时用多个 AI 编程工具，每个工具都有一份自己的全局记忆/规则。内容会漂移、重复、互相矛盾，换工具后偏好不生效。MemRelay 把这些来源**只读导入**，用一次对话模型合并成统一偏好，再写回各工具的规则文件。

与架构 §5.9 的差异：首版为了自动运行，由 MemRelay 使用自己的整理接口（独立配置、可关闭），而不是交给宿主 agent 执行。

## 2. 来源（只读）

| 工具 | 位置 | 形态 |
|---|---|---|
| Qoder | `~/.qoder/memory/*.md` | 只导入 frontmatter `metadata.type` 为 `feedback` 或 `reference` 的记忆；跳过 `MEMORY.md`、`memrelay-preferences.md`、`user`（身份/活动）与 `project`（项目知识） |
| Codex | `~/.codex/AGENTS.override.md`（存在时优先）否则 `~/.codex/AGENTS.md` | 全局指令；`memories_1.sqlite` 本版不导入（当前为空） |
| Trae CN | `~/.trae-cn/user_rules/*.md` + `~/.trae-cn/memory/user_profile.md` | 全局规则目录 + 全局记忆 |
| Claude Code | `~/.claude/CLAUDE.md` | 用户级全局记忆；项目 `CLAUDE.md` 与 `~/.claude/projects/<project>/memory` 属项目知识，后续接入 |
| ZCode | `~/.zcode/AGENTS.md` | 全局规则 |
| OpenCode | `~/.config/opencode/AGENTS.md` | 全局规则 |
| DeepSeek Harness | `~/.dsh/AGENTS.md`（默认 `$DSH_HOME`） | 全局规则 |
| WorkBuddy | `~/.workbuddy/user-<uid>-personal/MEMORY.md` | 用户级全局记忆（`USER.md` 是用户档案，不导入；项目 `<workspace>/.workbuddy/memory/` 属项目知识） |

Cursor 不纳入：User Rules 存在 Cursor 设置数据库（`state.vscdb`），没有可写的全局文件；项目 `.cursor/rules` 属项目知识。

导入时去掉本功能写入的标记块；只有标题/空内容、或只剩标记块的文件不算来源，避免自己创建的下发文件形成回环。

## 3. 流程

1. 扫描来源，按文件指纹（去掉标记块、归一化空白后的 sha256）判断变化。
2. 把变化的文件切成条目：有列表项按列表项，否则按段落；标题作为上下文。条目去重、限长。
3. 发送前对正文做密钥脱敏；不发送文件的绝对路径。
4. 用整理接口合并：模型返回严格 JSON `{entries, conflicts}`；重复项由模型合并，无法裁决的冲突放进 `conflicts`。
5. 写入目标文件的 MemRelay 标记块，记录备份与下发清单。
6. 源指纹 + 模型/主机未变时零请求跳过；提示词带版本号（当前 v1），改动后会强制重算一次；已下发的块被工具重写掉时自动补回（撤销后不补）。

整理页把「已下发的统一偏好」与「待拍板（未写入下发块）」分成两张卡：前者是可直接使用的最终条目，后者只放模型不敢裁决的真实互斥项；冲突为空时不显示第二张卡。

自动模式在 `memrelay ui` 运行期间每 30 秒检查一次；也可用 `memrelay tidy` 手动运行。整理接口单次超时 150 秒、最多 2 次尝试；模型失败退避 5 分钟。

模型返回的冲突会做基础校验：选项去重后不足两个不同选项的不算冲突；冲突被过滤完时计划按“已下发”展示。

## 4. 下发目标与安全

| 工具 | 目标 | 方式 |
|---|---|---|
| Qoder | `~/.qoder/memory/memrelay-preferences.md` | 独立记忆文件（本功能所有） |
| Qoder | `~/.qoder/memory/MEMORY.md` | 追加带标记的索引行 |
| Codex | `~/.codex/AGENTS.md` | 追加/替换标记块 |
| Trae CN | `~/.trae-cn/user_rules/memrelay.md` | 全局规则目录里的独立规则文件；旧版写进 `memory/user_profile.md` 的块会自动迁走 |
| Claude Code | `~/.claude/CLAUDE.md` | 不存在时创建；追加/替换标记块 |
| ZCode | `~/.zcode/AGENTS.md` | 追加/替换标记块 |
| OpenCode | `~/.config/opencode/AGENTS.md` | 追加/替换标记块 |
| DeepSeek Harness | `~/.dsh/AGENTS.md` | 追加/替换标记块 |
| WorkBuddy | `~/.workbuddy/user-<uid>-personal/MEMORY.md` | 追加/替换全局记忆里的标记块（动态发现目录） |

Cursor 首版不写回。

- 只维护 `memrelay:tidy` 标记块，原文其他内容不动；写前备份到 `~/.memrelay/backups/tidy/`。
- `--undo` / 界面「撤销下发」：移除标记块；本功能创建且移除后只剩生成标题的文件直接删除，用户追加的内容保留。Qoder 的独立记忆文件由本功能全权管理。
- 以上目标均已实现写入；Cursor 的全局用户规则存在其设置数据库里，首版不写回。

## 5. 数据（schema v1）

未发版，整理表已并入 v1 建库（`IF NOT EXISTS` 幂等补齐）：

- `memory_sources`：来源文件、指纹、导入时间。
- `memory_items`：切分后的条目（标题上下文 + 正文 + 内容哈希）。
- `memory_plan`：当前计划（状态、合并结果、冲突、输入指纹、模型/主机）。
- `memory_exports`：已下发文件、块哈希、备份路径、是否由本功能创建。

## 6. 配置

配置页「偏好整理（自动）」：开关 + 独立 `baseUrl / model / apiKey`。未配置或关闭时不扫描、不请求。

## 7. 边界

- 只做全局偏好；项目知识需要按项目扫描与分层，留到后续。
- 冲突不自动裁决：仍写入已合并的条目，冲突在整理页展示，等用户改来源或后续拍板。
- 自动下发只写标记块，可一键撤销；不会删除或改写用户原有规则内容。
