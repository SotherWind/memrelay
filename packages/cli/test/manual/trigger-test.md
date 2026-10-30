# Skill 触发测试表（手工验收）

架构文档 5.7 的"触发增强"和迭代 2 的验收项：确认"照常说话就能触发"在实际工具里是否成立。
测试后按结果决定要不要给某个工具启用 b 层（`hint` + hook）或 c 层（全局规则加一句话）。

## 怎么测

1. 在目标工具里打开一个**没有上下文的会话**（新开会话），项目选一个**有中断会话的仓库**（比如用 Qoder 做过一半的项目）。
2. 依次使用下面的说法，观察 agent 是否调用了 `memrelay resume`（或 search/show）。
3. 每个格子记录：✓ 直接触发 / △ 需要提示一次才触发 / ✗ 不触发。

## 触发测试矩阵

| 说法 \ 接手工具 | Qoder | Claude Code | Codex | Cursor | Trae CN |
|---|---|---|---|---|---|
| 继续完成生成前端网站的任务 | | | | | |
| 继续 | | | | | |
| 接着做 | | | | | |
| 继续上次那个任务 | | | | | |
| 把没做完的做完 | | | | | |
| continue the previous task | | | | | |
| resume the last task | | | | | |

补充观察：

- 触发后输出中文是否乱码（尤其 PowerShell 5.1 + GBK；乱码时应自动改用 `--out` 重读）。
- 首次运行命令时的确认弹窗：用户点"始终允许"后是否不再弹。
- 触发不稳时先记录样本，再评估启用 b 层：`memrelay hint` 已经可用（只读、极快、没有未完成任务时静默）。

## 实测记录（2026-10-13）

**Claude Code 2.1.198（本机实测）**

- 现象：说"你知道上一个任务做到哪里了吗"，未调用 memrelay。
- 根因：该版本给模型的技能清单只列**技能名，不含描述**（实测：引号包裹的描述也不显示；带 `disable-model-invocation: true` 的技能整条不显示）。a 层（纯 Skill）在此版本几乎无法自动触发。
- 处置：启用 **b 层**——`memrelay setup --enhance claude-code` 写入 SessionStart hook（跑 `memrelay hint`，一行未完成提示注入会话上下文）。已实测：有中断任务的目录能注入提示；无任务目录静默；命令探测里模型明确回答"会运行 `memrelay resume`"。
- 注意：Windows 上 Claude Code 的 hooks 经 **Git Bash** 执行（`%USERPROFILE%` 等变量不展开），hook 命令用 sh 形式：`"$HOME/.memrelay/bin/memrelay" hint 2>/dev/null || true`。

**Qoder（本机观察）**

- 技能清单**带描述**显示（a 层前提成立），"接着做"当天多次触发。仍需按下面的矩阵做正式验收。

## b / c 层启用决策

| 工具 | 触发表现 | 决定 | 备注 |
|---|---|---|---|
| Qoder | 清单带描述，暂未见问题 | 待矩阵验收 | 已装三件套（实时索引 + 提示） |
| Claude Code | 清单无描述，a 层不稳 | **已启用 b（2026-10-13）** | 实测注入生效；产品化后 `setup` **默认包含**，`--no-enhance` 跳过，`--undo` 撤销 |
| Codex | | | Windows 上 hooks 待测 |
| Cursor | | | 已知开局注入 bug |
| Trae CN | | | SOLO 模式待测 |


## 迭代 2 验收记录

- [ ] 一个任务经过三个工具接力（Qoder → Claude Code → Codex）后，接手工具能拿到整条链的进展
      （自动化覆盖见 `test/golden.test.ts` 的"三段接力"用例；工具内实测待补）
- [x] 两个字的中文词能搜到（`memrelay search 官网` 已验证；自动化见 store/golden 测试）

## 迭代 3 验收记录（实时索引，2026-10-14）

- [x] 本机 `memrelay setup` 安装三件套：Claude Code（sh 形式）与 Qoder CLI（cmd.exe exec 形式），
      均为 SessionStart / Stop / SessionEnd 三个事件；settings.json 已备份，`setup --undo` 可外科手术式撤销
- [x] 按宿主真实调用链实测：
  - Git Bash 形式（Claude Code 路径）：`echo '{...SessionStart...}' | bash -lc '"$HOME/.memrelay/bin/memrelay" hook'` → 输出未完成任务提示 ✓
  - cmd exec 形式（Qoder CLI 路径）：`cmd.exe /c <launcher.cmd> hook` + Stop payload → 静默索引，2MB 会话约 0.3~0.5s，sources 与文件大小一致 ✓
- [x] 35 会话基准（6.3MB 数据）：`resume` 0.30s（删库后的旧全量路径 0.41s）；本机真实数据（167 会话）
      从迭代 2 的 ~0.8s 降到 ~0.44s（其中还包含对正在写入的当前会话的现场重读）
- [x] 自动化覆盖：hook 端到端 6 例、快路径端到端 5 例、查库/读文件排序等价性 5 例
- [ ] 工具内观察待补：在 Claude Code / Qoder 里正常干几轮，确认 Stop 自动触发、几秒内落库（下次真实使用时看）
