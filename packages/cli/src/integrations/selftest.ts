import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export interface TerminalTest {
  terminal: string;
  /** null 表示本机没有这个终端，跳过 */
  passed: boolean | null;
  detail?: string;
}

interface Candidate {
  name: string;
  command: string;
  buildArgs: (script: string) => string[];
}

function which(command: string): boolean {
  try {
    const probe = spawnSync(process.platform === "win32" ? "where" : "which", [command], {
      stdio: ["ignore", "ignore", "ignore"],
      timeout: 5000,
    });
    return probe.status === 0;
  } catch {
    return false;
  }
}

function quoteSh(p: string): string {
  return `'${p.replace(/'/g, "'\\''")}'`;
}

function commandCandidates(cmdPath: string): Candidate[] {
  const isWin = process.platform === "win32";
  const candidates: Candidate[] = [];
  if (isWin) {
    candidates.push({
      name: "Git Bash",
      command: "bash",
      buildArgs: () => ["-lc", `'${cmdPath}' ping`],
    });
    candidates.push({
      name: "cmd",
      command: "cmd.exe",
      // 分开传参交给 Node 处理引号（拼成单个字符串时 cmd 会把引号当命令名的一部分）
      buildArgs: (script) => ["/d", "/s", "/c", script, "ping"],
    });
    candidates.push({
      name: "PowerShell 5.1",
      command: "powershell.exe",
      buildArgs: () => [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `& '${cmdPath}' ping`,
      ],
    });
    candidates.push({
      name: "pwsh",
      command: "pwsh",
      buildArgs: () => ["-NoProfile", "-NonInteractive", "-Command", `& '${cmdPath}' ping`],
    });
  } else {
    candidates.push({
      name: "bash",
      command: "bash",
      buildArgs: () => ["-lc", `${quoteSh(cmdPath)} ping`],
    });
    candidates.push({
      name: "zsh",
      command: "zsh",
      buildArgs: () => ["-lc", `${quoteSh(cmdPath)} ping`],
    });
    candidates.push({
      name: "pwsh",
      command: "pwsh",
      buildArgs: () => ["-NoProfile", "-NonInteractive", "-Command", `& '${cmdPath}' ping`],
    });
  }
  return candidates;
}

/** 用本机的每种终端实际运行一遍启动脚本，检查输出。 */
export function runTerminalSelfTests(binDir: string): TerminalTest[] {
  const shPath = path.join(binDir, "memrelay");
  const cmdPath = process.platform === "win32" ? path.join(binDir, "memrelay.cmd") : shPath;
  const scriptPath = fs.existsSync(cmdPath) && process.platform === "win32" ? cmdPath : shPath;

  const results: TerminalTest[] = [];
  for (const candidate of commandCandidates(scriptPath)) {
    if (!which(candidate.command)) {
      results.push({ terminal: candidate.name, passed: null, detail: "未检测到" });
      continue;
    }
    try {
      const result = spawnSync(candidate.command, candidate.buildArgs(scriptPath), {
        encoding: "utf8",
        timeout: 30000,
        windowsHide: true,
      });
      const out = `${result.stdout ?? ""}${result.stderr ?? ""}`;
      if (result.status === 0 && out.includes("MEMRELAY-OK")) {
        results.push({ terminal: candidate.name, passed: true });
      } else {
        results.push({
          terminal: candidate.name,
          passed: false,
          detail: `退出码 ${result.status ?? "null"}；输出 ${out.slice(0, 200) || "(空)"}`,
        });
      }
    } catch (err) {
      results.push({
        terminal: candidate.name,
        passed: false,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return results;
}
