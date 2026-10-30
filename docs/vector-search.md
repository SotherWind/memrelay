# MemRelay 向量检索设计

> 状态：已实现（2026-10-16）。本文为实现依据；实施中确定的细节见 §13，与本文的少量偏差已就地标注。

## 1. 定位

向量检索是**语义召回的增强通道**，与现有 FTS / 关键词检索**混合**使用，不替换：

- **语义召回，不是提速**。FTS5 本地毫秒级、零网络；向量查询反而多一次 embedding API 调用。它解决的是"问法和原文对不上"：搜"登录页"，而会话里写的是 "auth page"、"登录界面"。
- **opt-in**。默认关，配置并开启后生效；任何环节失败静默回退现有路径。
- **只做不说**。结果不标"语义命中"来源，搜索响应结构不变。
- **远程 API**（OpenAI 兼容 `/embeddings`）。本地模型不在首版范围；实现保持单模块边界，将来新增本地实现时上层不变。
- 与"本地优先"原则的衔接：开启时明确提示内容将发送到哪个主机；**嵌入输入一律先做密钥脱敏**（`core/secrets.ts` 的规则），正文与查询词两个方向都脱敏。

不做（本版）：任务列表排序、hook 提示语改写。

## 2. 使用点（两处都要接）

### 2.1 接力关键词匹配（核心）

`memrelay resume <关键词>` 现在是字面匹配：关键词按两字组切分后逐个子串比对（`resume/select.ts` 的 `rankFromSignals` 调用 `core/cjk.ts` 的 `keywordScore`）。缺口：目标会话用词不同就得 0 分，只能掉到"最近中断"兜底或弹菜单。

加语义通道后，融合进同一分数位：

```
keyword分量 = max(keywordScore, clamp((cos − 0.35) / (0.75 − 0.35)))
```

`total` 的其余项与 `decisive` / `menu` 阈值语义不变。

**融合常数是什么**：cos 的有效区间很窄（语义相关通常 0.45~0.85，无关 0.2~0.45，且随模型变化），而 keywordScore 是 0..1 的命中占比、decisive 要求 ≥ 0.6。直接把 cos 塞进公式，无关文本的 0.42 会冒充"部分命中"。0.35 / 0.75 是把余弦折算到同一标度的两个锚点：≤ 0.35 记 0 分（视为无关），≥ 0.75 记 1 分（明确命中），中间线性。实现后拿真实"查询 × 会话"分布校准（取命中对的低分位、未命中对的高分位）。

### 2.2 搜索

`memrelay search` 与 UI 会话页搜索共用 `store/search.ts` 的 `searchSessions`（UI 经 `server/conversations.ts`）。加向量路后按**会话级 RRF（k=60）**融合 FTS 榜与向量榜；向量独有命中的摘要从命中块文本生成；响应结构不变。

## 3. 数据流

**索引侧（写）**：indexer 完成一个会话 → 入队 `embed_queue`（仅写库）→ drain → 从库读消息（不碰源文件）→ 组装文本 → `redactSecrets` → 分块 → 批量调 `/embeddings` → 写 `embeddings` 表。

**查询侧（读）**：查询词 → `redactSecrets` → 一次 embedding 调用（3s 超时）→ 项目域预过滤 + 流式扫描余弦 → 融合进现有排序。

**hook 路径绝不做网络请求**（快 + 静默契约不变）。drain 的常驻入口有三处：`memrelay ui` 后台循环、`memrelay embed` 命令、`memrelay doctor`；另有 `resume` / `search` 的查询前定向排空（见 §6，有预算、失败静默）。

## 4. 嵌入内容

| 内容 | 处置 |
|---|---|
| user / assistant 的 text 正文 | ✅ 嵌入（约 1200 字符/块，200 重叠） |
| assistant reasoning | ❌ 思考噪声与敏感草稿 |
| tool_result 等其余 part | ❌ 首版排除（留"深度嵌入"开关以后再评估） |

参考量级：单机约 250 会话 / 5 万消息的库，正文合计约 2M 字符；reasoning 约 16M、tool_result 约 22M——只嵌正文让成本与噪声都可控。

## 5. 存储与检索

**单套向量：只存 message 级块**（user / assistant text 切分）。接力分 = 会话内分块的"新近加权聚合"（等价于过去只取"最后几段回复 + 最新进展"的意图，但不需要第二套向量）。

```sql
CREATE TABLE IF NOT EXISTS embeddings (
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,      -- 消息序号，用于映射回原文生成摘要
  chunk_ix INTEGER NOT NULL,
  content_hash TEXT NOT NULL,    -- sha256(脱敏后块文本)：幂等与失效判断
  model TEXT NOT NULL,
  dims INTEGER NOT NULL,
  host TEXT NOT NULL,            -- baseUrl 主机（指纹组成部分）
  vec BLOB NOT NULL,             -- float32 LE
  norm REAL NOT NULL,            -- 预存 L2 范数
  updated_at TEXT NOT NULL,
  UNIQUE(session_id, ordinal, chunk_ix)
);
CREATE TABLE IF NOT EXISTS embed_queue (
  session_id TEXT PRIMARY KEY,
  enqueued_at TEXT NOT NULL,
  claimed_at TEXT,               -- claim 租约（5 分钟）：并发 drain 互斥、断点可续跑
);
```

**存储格式与检索实现两层解耦**：

- 存储层稳定：plain 表 + float32 BLOB，不依赖任何扩展或索引结构。
- 检索层第一实现 = **项目域预过滤 + 流式扫描 + top-K 堆**。这是**终态**而非过渡：两个入口都限定"当前项目"，查询天然按项目分片，单项目 1 万块 ≈ 1200 万字，个人项目远达不到。真到单项目 5 万块的量级，在同一接口后换实现（如 sqlite-vec）是读路径变化——不动存储、不重嵌、不重烧 API。
- 不用 sqlite-vec 的真实原因：三平台原生二进制要随 npm 包分发、项目仍为 0.x、扩展加载有额外安全面。能力不是问题——`node:sqlite` 的 `loadExtension` 自 v22.13 起就有（engines 下限之内）。

## 6. 索引管线

- indexer 写完会话 → 入队（仅写库，零网络）。
- drain 幂等、可中断续跑（批处理 + 事务模式同 `backfillSessionStats`）；**claim 事务互斥**，ui 后台与 CLI 并发时不重复烧 API。
- **查询前定向排空**：resume / search 对本项目候选会话做有预算的 drain（≤3 会话 / 总计 ≤5s），补上"刚被打断就接力、最新会话还没嵌入"的热场景。
- 查询向量走进程内小 LRU：agent 重试、菜单重查同一关键词时不重复调 API。

## 7. 降级与错误

- 查询侧：embedding 超时（3s）或失败 → 静默回退关键词 / FTS，结果与未开启时一致。
- 回填侧：429 指数退避；连续失败暂停并在配置页状态区可见；`memrelay embed` 输出完整进度。
- provider 异常响应（批量不支持、维度不符）→ 明确报错并建议检查配置。

## 8. 指纹与生命周期

**指纹 = model + dims + host**。为什么要 host：同名模型不同源不保证同一向量空间；误混的代价是静默的质量崩坏，过度失效的代价只是一次重嵌，宁保守。

**铁律：查询只读当前指纹的行**（SQL 过滤），且换指纹时"先删旧、再填新"。由此所有过渡态天然安全：重嵌期间语义通道逐步恢复——已重嵌的会话可用，未完成的自动只剩关键词通道，任何时刻都不会出现两个空间的向量混合计算。

| 事件 | 查询侧行为 | 数据侧行为 | 成本 |
|---|---|---|---|
| 换 model / dims / host | 立即只认新指纹 | 确认提示（预估费用）后：删旧指纹行 + 全量入队 | 一次全量重嵌 |
| 重嵌进行中 | 按铁律自动降级 | drain 持续补齐 | 增量 |
| 关开关（enabled=false） | 立即回关键词 / FTS | 向量保留 | 0 |
| 清空模型字段 | 等同停用 | 向量保留（重新填回同一模型即恢复） | 0 |
| 重新开启 | 语义通道恢复 | 全量入队 + content_hash 对账：未变块零 API 成本跳过，只补停用期间新增/变化 | ≈0~增量 |
| 显式"删除全部向量" | 回关键词 / FTS | 真删（唯一清除路径） | 重开需全量重嵌 |
| 会话软删（已删除页） | 查询过滤（与 FTS 一致） | 保留 | 0 |
| 会话永久删（purge） | — | 向量行一并删 | 0 |
| SECRET_RULES_VERSION 变更 | 不变 | 状态区提示建议重嵌 | 可选重嵌 |

停用时保留向量不构成新的隐私面：会话原文本来就明文存在同一个库里——隐私风险在"发送"环节，不在本地留存。

## 9. 配置与界面

- settings 新增 embedding 块：`{ enabled, baseUrl, model, apiKey }`。三字段都属于语义检索自己，不跨功能继承——与摘要各用各的接口，可指向不同上游；未填全时语义通道不生效，搜索回退关键词。
- 回填队列默认 3 路并发；任一成功即清零连败计数，连续多轮全败才暂停（并发下不会因一轮 429 就误停）。
- 配置页新增分组：开关 + 三个字段 + 状态行（已嵌 N 会话 / 待嵌 M / 指纹 / 最近错误）+ "立即回填"按钮 + 显式"删除全部向量"。
- 隐私文案（开启时显示）："user/assistant 正文（已做密钥脱敏）将发送到 {host}"。

## 10. 成本与性能（参考量级）

以约 250 会话 / 5 万消息、正文 2M 字符的库为例：

- 全量回填（按 text-embedding-3-small 价）≈ $0.03，落库 15-20MB，几分钟。
- 单次查询 +100-500ms（一次 API）+ < 10ms（本地余弦）。
- 深度模式（以后含工具输出）：+22M 字符 ≈ $0.25、+约 180MB。

## 11. 代码落点（实施时）

| 文件 | 动作 |
|---|---|
| `core/embeddings.ts`（新） | provider 客户端（/embeddings、batch、退避）、指纹、余弦、切块、查询 LRU |
| `store/embeddings-store.ts`（新） | 表读写、入队、drain（幂等、claim 租约互斥）、状态 / 清除 / 重建、向量打分 |
| `store/semantic.ts`（新） | 查询侧编排：运行时（配置解析 + 3s 超时 provider）、定向排空、两个入口的取数 |
| `store/indexer.ts` | 索引完成 → 入队（仅写库零网络） |
| `resume/select.ts` | `fuseRankedSemantics`：语义分融合进 keyword 分量。后置执行（余弦要等候选集齐后统一算），公式与 §2.1 一致；未走 `rankFromSignals` 可选参数——但全部 `RankedSession` 在进入 `selectSession` 前都经过该函数 |
| `store/search.ts` | 向量路 + 会话级 RRF（k=60）融合；向量独有命中的摘要从命中块文本生成 |
| `cli/commands/embed.ts`（新） | `memrelay embed`（回填 / `--status`） |
| `server/server.ts` | settings 扩展（开启转换自动全量入队）+ 状态 / 回填（含 rebuild）/ 清除三个端点；UI 搜索接语义通道 |
| `cli/commands/ui.ts` / `doctor.ts` | 后台 drain 循环（30s tick、防重入）/ 状态 + 有预算 drain |
| `ui` SettingsPage | 配置分组、状态行、回填 / 重建 / 删除按钮、隐私文案 |

TDD 要点：provider 用伪实现注入（离线可测）；融合函数是纯函数单测；回填幂等测试；降级路径测试（API 失败时结果与现状逐字一致）。

## 12. 里程碑（0.4）

1. provider + 存储 + 回填 + 接力融合（核心场景先通）
2. 搜索混合 + UI 配置 / 状态 / 回填
3. 隐私文案与 README 更新

## 13. 实施时确定的参数（2026-10-16 落地）

- 融合常数 0.35 / 0.75：按 §2.1 落地（`core/embeddings.ts` 的 `semanticToKeyword`）；**待有真实向量环境后**按"命中对的低分位 / 未命中对的高分位"校准——本机冒烟用的是伪嵌入，不足以定标。
- "新近加权聚合"权重：**块权重 = 0.6 + 0.4 × (ordinal / 会话内最大 ordinal)**（最早的块 0.6、最新的 1.0、中间线性）；会话分 = max(cos × 权重)。切块 1200 / 重叠 200，批次 16 条/请求，查询超时 3s（查询侧不重试），回填 30s（429/网络指数退避 3 次）。
- 默认推荐的嵌入模型：配置页占位提示 `text-embedding-3-small`（不预填、不强制）。
- 本机冒烟口径（真实库副本 + 本地伪嵌入）：245 会话入队 → 238 会话 / 9007 块落库、699 次请求；二轮全量 hash 对账零 API；纯语义关键词（FTS 零命中）能出 10 个会话。
