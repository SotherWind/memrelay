# MemRelay 会话摘要（LLM 增强）设计

> 状态：已实现（2026-10-16）。本文为实现依据；拍板结果与实施细节点见 §14。
> 修订记录：本文按"该实现的地方都要实现、架构一次选对"重写过一次——消费点从 2 处扩为 7 处全量落点；队列基建抽公共原语（两个队列共用）；补查询前定向生成。不做分期阉割。

## 1. 定位

用可选的大模型把会话"再压一层"，让接力与界面读起来更快：

- **可选增强，默认关**。骨架永远是规则提炼（现状不动）；LLM 摘要插在它上面，只做"更顺口的压缩"。
- **不参与判定**。摘要不改变 resume 的候选选择 / 排序 / 状态判定（那是信号系统与向量检索的职责），纯展示与可读性增强——任何失败、缺失、超时都退回现状，未开启时所有输出与现状**逐字一致**。
- **只做远程 API**：消费配置页「会话摘要」分组自己的 baseUrl + 对话模型 + apiKey；与语义检索互不影响，可指向不同上游。
- 与"本地优先"原则衔接：开启时明确提示发送到哪个主机；输入一律先过 `core/secrets.ts` 脱敏；hook 路径绝不做网络请求（生成只发生在用户进程 / agent 命令里，同向量检索）。
- 不做：偏好 / 规则文件整理（架构 §5.9，独立线）、任务自动改名（名字要稳定，摘要是活文本，两者解耦）、每日 / 周报。

## 2. 摘要对象与粒度

**会话级存储 + 任务级实时投影**：

- 存储以 `session_id` 为键——稳定、失效简单（按会话内容哈希），与向量检索同粒度；
- 任务（接力链）不落摘要表：任务列表 / 详情 / resume 都取"**最新一腿**的摘要"实时投影——任务的语义本来就是活的（合并、拆分、加新腿），投影策略与现有任务状态"查询时实时重算"的架构一致；
- 旧腿的摘要不浪费：会话浏览页、搜索结果各自用自己那条。

## 3. 输入（生成素材）

从**库里**取素材、不碰源文件：

| 内容 | 处置 |
|---|---|
| 标题 + 首个用户消息 + 最后约 20 条 user/assistant 正文 | ✅ 发送（总量上限约 8KB） |
| 状态信号一行（未答复 / pending 工具 / 未完成待办 / 最近报错） | ✅ 发送（帮助摘要点出"卡在哪"） |
| assistant reasoning、tool_result | ❌ 与向量检索同一隐私口径，不发（"深度摘要"以后再评估） |

- 全部先过 `redactSecrets` 再发送。
- 理由：原文信息全、实现就是一个 SQL + 拼装；8KB ≈ 3~4k token 输入，成本可控。

## 4. 数据流（生成触发完整覆盖）

**索引侧（写）**：indexer 完成一个会话 → 入队 `summary_queue`（仅写库，零网络；启用于否都入队）。

**drain 出口**（与向量检索对称）：
- `memrelay ui` 后台循环（与嵌入共用 tick，各自有预算）；
- `memrelay summarize` 命令（全量生成 / `--status`）；
- `memrelay doctor`（有预算补一轮）。

**查询前定向生成**（补"刚被打断就接力"的热场景，与向量检索的定向排空同模式）：
- `resume`：选定候选后、渲染前——该会话缺摘要时定向生成，**≤1 会话 / ≤6s**；失败就按无摘要渲染。
- `search`：先对本项目队列做有预算排空（**≤3 会话 / ≤5s**），让最近活跃的会话尽量有摘要；命中会话没摘要就不显示摘要行。
- **hint（SessionStart）不做生成**——hook 绝不做网络请求；只读现成摘要。

**查询侧（读）**：全部消费点只读现成摘要行——零网络、零阻塞；agent 命令的只读契约不变。

## 5. 存储与队列原语

schema v1 一次迁移加两表：

```sql
CREATE TABLE IF NOT EXISTS summaries (
  session_id TEXT PRIMARY KEY,
  content_hash TEXT NOT NULL,   -- sha256(素材 + prompt 版本 + model + host)
  model TEXT NOT NULL,
  host TEXT NOT NULL,
  text TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS summary_queue (
  session_id TEXT PRIMARY KEY,
  enqueued_at TEXT NOT NULL,
  claimed_at TEXT
);
```

**队列原语抽公共模块**（架构决策）：embed_queue 与 summary_queue 的 claim 租约模式逐字相同（入队 / 到期租约互斥 / 归还 / 出队 / 计数），抽成 `store/queue.ts` 小原语（表名白名单常量，防注入），embed 侧一并迁移——**修正一处 bug 只修一次**；drain 循环本身不抽象（两个管线的处理、预算、失败语义差异大，硬抽反而难读）。

## 6. 幂等与失效

- drain 前对账：`content_hash` 一致 → 零 API 跳过（重开开关、重跑命令都不重复花钱）。
- **换模型 / 换主机**：查询只认当前 `model + host` 的行（SQL 过滤），旧摘要自动失效、显示回退；配置页提示"重建摘要"（先删旧、再全量入队）。
- 关开关：摘要保留、不生成不显示；重开：全量入队 + hash 对账（未变零成本）。
- 显式"删除全部摘要"：唯一清除路径。
- 会话软删（已删除页）：所有读路径过滤（与搜索 / 向量一致）；库随 `setup --purge` 整体删除，无需专门处理。
- prompt 迭代：版本号进 content_hash，升级自动重生成。

## 7. 降级与错误

- 生成侧：429 / 网络错误指数退避（3 次）；有界并发（默认 3 路），任一成功即清零连败计数，连续多轮全败才暂停并在状态区可见（同向量检索）；provider 异常响应（非 JSON、缺 choices）明确报错写状态区，不污染摘要表。
- 读取侧：任何环节失败静默——消费点拿不到摘要行就按现状渲染。
- **默认关 / 出错时，各消费点输出与现状逐字一致**（golden 测试基线成立）。

## 8. 配置与界面

- settings 新增：`summary.enabled`（开关）与 `summary.baseUrl / summary.model / summary.apiKey`（摘要自己的接口三字段；`summary.lastError / lastErrorAt / lastSuccessAt` 为状态键）。
- 配置页：
  - 「会话摘要（可选）」分组：开关 + 三个接口字段 + 状态行（已摘要 N 会话 / 待摘要 M / 指纹 model@host / 最近错误）+ 按钮（立即生成 / 重建摘要 / 删除全部摘要〔确认〕）+ 隐私文案（开启时）："会话正文（已做密钥脱敏）将发送到 {host}"；
  - 不再有共享的「模型服务」分组：语义检索与会话摘要各自维护接口，换上游互不影响。
- 开启条件：开关 + 自己三字段完整；缺字段时状态区提示（与嵌入同款交互）。未配置或关闭只影响该增强功能，所有消费点回退规则提炼。

## 9. 消费点（完整覆盖，7 处）

| # | 位置 | 形态 | 说明 |
|---|---|---|---|
| 1 | resume 正文 | `## 任务摘要（AI 生成）` 独立段 | 排在"最后进展"之前；有摘要才加；计入 token 预算（reserved 里预留） |
| 2 | resume 菜单 | 每条候选的标题行后加 `摘要：…` 一行 | 只在有现成摘要时显示；菜单是"选哪个"的关键场景 |
| 3 | hint 一行提示 | 摘要替代标题片段 | 有摘要用摘要（更能说明"卡在哪"），没有回退现状的标题；只读不生成 |
| 4 | CLI search 结果 | 每个会话加 `摘要：…` 一行 | 有则显示，帮助判断"是不是这个" |
| 5 | UI 任务列表 | 行内摘要（次行，单行截断） | 缓解"任务名是长句首条消息"的可扫性问题；名字保持稳定不动 |
| 6 | UI 任务详情 | 头部摘要卡片（带 AI 角标） | 3 秒看懂任务现状，不必读完整接预览 |
| 7 | UI 会话列表 / 搜索 | 行内摘要 | 会话页与搜索结果同样受益 |

投影规则：任务相关（5/6）取最新一腿的摘要；其余按会话自身。所有位置摘要统一经 `redactSecrets` 输出（与现有输出口径一致）。

## 10. Prompt 草案

```
你是任务接力助手。根据下面的会话尾部内容，输出任务进展摘要。
要求：
- 2~4 句；跟随内容的主要语言（中文内容用中文，英文内容用英文）
- 覆盖：在做什么、进行到哪、有无阻塞 / 待办、下一步建议
- 只输出摘要正文；不要标题、markdown、引号或任何解释
- 长度不超过 200 个汉字（或 500 个字符）

任务名：{title}
状态：{signals}
会话尾部：
{excerpt}
```

参数（输入窗口 20 条 / 8KB、输出上限、system prompt）整体进 content_hash 的"prompt 版本"组成，迭代后自动重生成。

## 11. 成本（参考量级）

- 单会话：输入 ≈ 3~4k token、输出 ≤ 200 token；250 会话全量 ≈ 1M token。
- 便宜对话模型（gpt-4o-mini / glm-4-flash 级）≈ 几分到几毛钱；之后只有内容变化才重生成，日常增量几乎为零。
- 摘要落库极小（每条几百字节）；查询侧零成本、零网络。

## 12. 代码落点（实施时）

| 文件 | 动作 |
|---|---|
| `store/queue.ts`（新） | 队列公共原语（enqueue / claim 租约 / release / dequeue / count；表名白名单） |
| `store/embeddings-store.ts` | 迁移到公共原语（行为不变、测试保证） |
| `core/llm.ts`（新） | OpenAI 兼容 `/chat/completions` 客户端（超时、429 退避、失败即抛） |
| `store/summaries-store.ts`（新） | 表读写、入队、drain（照搬同款模式）、状态 / 清除 / 重建、素材组装与脱敏、按会话取数 |
| `store/schema.ts` | schema v1：summaries + summary_queue（开发期曾按 v5 记录，0.1.0 统一并入 v1） |
| `store/indexer.ts` | 会话索引完成 → 入队 |
| `resume/command.ts` + `resume/render.ts` | 定向生成（选定后 ≤1 会话 / ≤6s）+ `## 任务摘要（AI 生成）` 段 |
| `resume/menu.ts` | 候选项摘要行（传入 map） |
| `resume/hint.ts` | 最近中断任务的摘要（只读 DB，无网络） |
| `cli/commands/search.ts` | 定向排空（≤3 会话 / ≤5s）+ 结果摘要行 |
| `server/task-list.ts` | 任务 DTO 带最新一腿摘要（列表 + 详情） |
| `server/conversations.ts` | 会话 DTO 带摘要（列表 + 搜索） |
| `cli/commands/summarize.ts`（新） | `memrelay summarize`（全量）/ `--status` |
| `server/settings-store.ts` + `server/server.ts` | summary 状态 / 回填 / 清除端点；摘要自己的接口配置 |
| `ui`：SettingsPage / TasksPage / TaskDetailPage / ConversationsPage | 配置分组与状态区；三处界面消费点 |
| `cli/commands/ui.ts` / `doctor.ts` | 后台循环加摘要 drain（与嵌入同 tick）/ 状态 + 有预算 drain |

TDD 要点：`core/llm.ts` 伪 fetch 注入（离线可测）；素材组装 / 截断 / prompt 拼装是纯函数；hash 对账幂等；定向生成的预算与失败回退；**降级路径逐字一致**（API 挂 → resume / 菜单 / hint / search / 列表输出与未开启相同）；队列原语迁移后 embed 侧测试全绿。

## 13. 里程碑

1. 队列公共原语重构（embed 迁移，测试全绿）→ schema v1 + `core/llm.ts` + `summaries-store` + drain + `memrelay summarize`
2. 全消费点接入（resume 段 / 菜单 / hint / search / UI 三处）+ 定向生成
3. 配置页分组与状态、隐私文案、README 与 docs 更新

## 14. 拍板记录与实施结果（2026-10-16）

**拍板（用户确认）**：
1. Prompt 输出上限：**200 个汉字 / 500 个字符**（已进 prompt 与存储硬截断 `SUMMARY_MAX_CHARS`）。
2. AI 标注：保留——resume 段标题「任务摘要（AI 生成）」+ UI 任务详情卡片「AI 摘要」角标。
3. 定向生成预算：先按设计（resume ≤1 会话 / ≤6s；search ≤3 会话 / ≤5s），真实场景实测后再校准。

**实施要点（与本文落点一致）**：
- 新增 `store/queue.ts`（队列公共原语，embed_queue 一并迁移，见 §5）、`core/llm.ts`、`store/summaries-store.ts`、`store/summarizer.ts`、`cli/commands/summarize.ts`；schema v1。
- 7 处消费点全部接通；server 三端点（status / backfill{rebuild} / clear）+ settings `summary` 块（开启转换自动全量入队）；ui 后台循环与 doctor 均接摘要 drain（各自预算、连败退避）。
- 当时测试 260 全绿（新增 summaries 15 个、server HTTP +2）；真机冒烟（`test/manual/summary-smoke.mjs`，真实库副本 + 本地伪对话服务）：schema v4→v5 迁移 OK；236 会话生成（236 次请求，约 1.3s 本地耗时）、二轮 hash 对账零调用；search / resume 输出均带摘要行。
- ⚠ 实测校准项：伪服务无法验证真实模型下的摘要质量与定向生成耗时，待用户用自己的模型跑真实场景后回看 §14.3 的预算。

## 15. 修订：接口按功能独立 + 有界并发（2026-10-23）

**拍板**：删除共享的「模型服务」分组；语义检索与会话摘要各自维护 `baseUrl / model / apiKey`，可指向不同上游、互不抢配额。**迁移**：0.1.0 首个对外版本的 schema 为 **v1**（开发期 v1-v6 的结构已压缩为一次建库）；开发期共享的 `model.*` 配置已迁入摘要/语义检索并删除，发布后不再保留兼容分支。迁移后指纹 `model@host` 不变，已生成的摘要与向量继续有效，不会触发重建。

**实现**：
- 配置键：`summary.*` 三字段归摘要；`embed.*` 三字段归语义检索且不再继承；`model.*` 不再读取。任务命名与查询侧定向生成跟随摘要配置。
- 回填：两个 drain 队列都改为有界并发（默认 3 路，`concurrency` 可调）；连败判定按轮计——任一成功即清零，连续 3 轮全败才暂停，避免并发下一轮 429 就误停。
- 兜底不变：关闭或未填全时，摘要/任务名回退规则提炼、语义检索回退关键词，所有消费点与未开启时逐字一致。
