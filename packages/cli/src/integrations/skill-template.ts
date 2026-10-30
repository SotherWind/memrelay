export interface SkillRenderInput {
  version: string;
  /** 各终端的调用前缀（已含引号） */
  bashCmd: string;
  powershellCmd: string;
  cmdCmd: string;
}

export function renderSkill(input: SkillRenderInput): string {
  const cmdFor = {
    bash: input.bashCmd,
    powershell: input.powershellCmd,
    cmd: input.cmdCmd,
  };
  const example = "生成前端网站";
  const line = (kind: "bash" | "powershell" | "cmd", keyword: string) =>
    `${cmdFor[kind]} resume "${keyword}"`;
  const bare = (kind: "bash" | "powershell" | "cmd") => `${cmdFor[kind]} resume`;
  return `---
name: memrelay
description: Continue a task that was interrupted in another AI coding tool (Qoder, Claude Code, Codex, Cursor, Trae, CodeBuddy, DeepSeek Harness). Trigger when the user says 继续/接着做/继续完成 XX 任务/上一个任务做到哪了/之前做到哪一步/上次做到哪/continue/resume/where did we leave off, when the user names a specific earlier session/thread (including codex://threads/<id> links or other session URLs/IDs), or when they mention a previous task or prior progress this session has no context for.
---

# MemRelay 任务接力 / Cross-agent task relay

当用户说"继续""接着做""继续完成 XX 任务"这类话、而当前会话里没有对应的上下文时，
说明任务之前在别的工具（Qoder / Claude Code 等）里做过。运行 MemRelay 命令拿到续接内容。

## 怎么运行

按你所在终端选一条。任务关键词只写简短的一两个词，避免 \`&\`、\`|\`、\`%\`、引号等特殊字符：

- bash / zsh / Git Bash：\`${line("bash", example)}\`
- PowerShell：\`${line("powershell", example)}\`
- cmd：\`${line("cmd", example)}\`

用户没提关键词、只说"继续"时，运行不带关键词的版本（接当前项目里最近中断的任务）：

- bash / zsh / Git Bash：\`${bare("bash")}\`
- PowerShell：\`${bare("powershell")}\`
- cmd：\`${bare("cmd")}\`

## 用户给了具体的会话链接 / ID

如果用户贴的是 \`codex://threads/<id>\` 这类会话链接，先把它当作会话 id，用 MemRelay 读：

- 想直接接手这个会话：\`${cmdFor.bash} resume <agent>:<id>\`（强制选中并落链）
- 只想看内容：\`${cmdFor.bash} show <agent>:<id>\`；Codex 线程用 \`${cmdFor.bash} show codex:<id>\`

\`show\` 找不到时，按任务关键词运行 \`resume\`；仍然找不到，才用宿主自带的读会话工具（如 Codex 的 \`read_thread\`）。宿主能直接读会话时也先用 MemRelay：跨工具接力、接力链和统一任务状态只在 MemRelay 里有。

看指定会话时，先看输出顶部的「最后进展」；「接力来源」只是背景，不要把链根（更早的会话）当成当前任务从头重做。你要接的是这个会话最后几条记录里的进度。

## 看到什么

- 输出首行是 \`【MemRelay 续接】\`。看到它就按内容接手：
  1. 先用一两句话告诉用户：接的是哪个会话、进度如何、接下来做什么；
  2. 再运行 \`git status\` 和 \`git diff\`，以磁盘上的文件为准（旧工具可能写到一半被打断）；
  3. 把续接内容里的待办搬进你自己的待办工具，然后直接开工。
- 输出是候选菜单（一行一个会话）时：判断哪一个最像，或直接问用户选哪个；
  选定后**先运行 \`resume <会话 id>\`**（把菜单里的完整 id 原样带上，例如 \`${cmdFor.bash} resume claude-code:3f2a1b…\`）拿到正式续接内容——这一步会把 \`【MemRelay 续接】\` 标记带进当前会话，任务列表才能认出这条接力。不要只根据菜单直接开工。
  菜单里都不像时，换更贴切的关键词运行 search 再找一轮，例如 \`${cmdFor.bash} search "登录页"\`。
- 遇到这三种情况，先停下来问用户：
  1. 候选择不唯一；2. 旧会话几分钟前还有写入（旧 agent 可能还在运行）；3. 当前目录不是旧会话的目录。
- 想多了解细节时运行 show，例如 \`${cmdFor.bash} show qoder:3f2a1b --from 120\`。

## 注意

- 首行是乱码时，改用 \`--out <文件>\`，例如 \`${cmdFor.bash} resume "关键词" --out ./relay.md\`，然后用读文件工具读它。不要让输出经过 PowerShell 管道（如 \`| Out-String\`），中文会乱码。
- 命令不存在或报错时：告诉用户 MemRelay 不可用（可能需要重新运行 \`memrelay setup\`），然后照常处理用户的请求，不要卡住。
- 命令是只读的：只读本机会话文件与 git 状态、只打印结果，不访问网络、不访问本地端口。

<!-- memrelay-skill-version: ${input.version} -->
`;
}
