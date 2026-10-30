import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { Env } from "./types.js";

/**
 * CodeBuddy CLI 的配置目录。固定用 ~/.codebuddy：WorkBuddy 桌面端会给子进程设
 * CODEBUDDY_CONFIG_DIR=~/.workbuddy，跟随它会把自己的 hook/会话写到 WorkBuddy 名下。
 */
export function codebuddyHome(env: Env): string {
  return path.join(env.home, ".codebuddy");
}

export function codebuddyProjectsRoot(env: Env): string {
  return path.join(codebuddyHome(env), "projects");
}

/** CodeBuddy IDE（国际版/CN）的用户数据目录候选。 */
const IDE_PRODUCT_DIRS = ["CodeBuddy CN", "CodeBuddy", "CodeBuddy IDE", "CodeBuddyCN"];
const LEGACY_HISTORY_DIR_NAME = "genie-history";

function isInsideHome(dir: string, home: string): boolean {
  const norm = (value: string) => value.replace(/[\\/]+/g, "/").replace(/\/+$/, "").toLowerCase();
  const base = norm(home);
  const target = norm(dir);
  return target === base || target.startsWith(`${base}/`);
}

function ideUserDataDirs(env: Env): string[] {
  const out: string[] = [];
  if (env.platform === "win32") {
    const appData = env.env["APPDATA"];
    // 测试/沙箱里 APPDATA 可能指向宿主机：不在当前 home 下就不用，避免读到真实用户数据
    const base =
      appData && appData.trim() && isInsideHome(appData, env.home)
        ? appData
        : path.join(env.home, "AppData", "Roaming");
    for (const product of IDE_PRODUCT_DIRS) out.push(path.join(base, product));
    return out;
  }
  if (env.platform === "darwin") {
    for (const product of IDE_PRODUCT_DIRS) {
      out.push(path.join(env.home, "Library", "Application Support", product));
    }
    return out;
  }
  const base = env.env["XDG_CONFIG_HOME"]?.trim() || path.join(env.home, ".config");
  for (const product of IDE_PRODUCT_DIRS) out.push(path.join(base, product));
  return out;
}

/** 扩展宿主数据目录（CodeBuddyExtension/Data）的父目录。 */
function ideLocalDataDirs(env: Env): string[] {
  if (env.platform === "win32") {
    const localAppData = env.env["LOCALAPPDATA"];
    const base =
      localAppData && localAppData.trim() && isInsideHome(localAppData, env.home)
        ? localAppData
        : path.join(env.home, "AppData", "Local");
    return [base];
  }
  if (env.platform === "darwin") {
    return [path.join(env.home, "Library", "Application Support")];
  }
  const base = env.env["XDG_DATA_HOME"]?.trim() || path.join(env.home, ".local", "share");
  return [base];
}

function subdirs(dir: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.filter((entry) => entry.isDirectory()).map((entry) => path.join(dir, entry.name));
}

function readJson(file: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function folderUriToPath(uri: string): string | undefined {
  try {
    const parsed = new URL(uri);
    if (parsed.protocol !== "file:") return undefined;
    const decoded = decodeURIComponent(parsed.pathname);
    if (parsed.host) return `//${parsed.host}${decoded}`;
    return /^\/[A-Za-z]:\//.test(decoded) ? decoded.slice(1) : decoded || undefined;
  } catch {
    return undefined;
  }
}

/** IDE 历史目录名 = md5(平台规范化后的工作区绝对路径)，保留大小写。 */
export function codebuddyIdeWorkspaceHash(workspacePath: string, platform: NodeJS.Platform): string {
  const normalized =
    platform === "win32" ? path.win32.normalize(workspacePath) : path.normalize(workspacePath);
  return crypto.createHash("md5").update(normalized).digest("hex").toLowerCase();
}

/**
 * 工作区 hash → 绝对路径。来源：VS Code 的 workspaceStorage/<id>/workspace.json，
 * 以及 globalStorage/storage.json 里记录过的 folderUri。扩展自己只存 hash，没存路径。
 */
export function codebuddyIdeWorkspaceMap(env: Env): Map<string, string> {
  const out = new Map<string, string>();
  const addUri = (uri: unknown): void => {
    if (typeof uri !== "string" || !uri.startsWith("file:")) return;
    const workspacePath = folderUriToPath(uri);
    if (!workspacePath) return;
    // Windows 路径大小写不敏感：盘符/大小写和 IDE 记录不一致时也尽量命中
    const variants =
      env.platform === "win32"
        ? new Set([
            workspacePath,
            workspacePath.toLowerCase(),
            workspacePath.replace(/^([A-Za-z]):/, (_m, drive: string) => `${drive.toLowerCase()}:`),
          ])
        : new Set([workspacePath]);
    for (const variant of variants) {
      const hash = codebuddyIdeWorkspaceHash(variant, env.platform);
      if (!out.has(hash)) out.set(hash, workspacePath);
    }
  };

  for (const userData of ideUserDataDirs(env)) {
    const wsRoot = path.join(userData, "User", "workspaceStorage");
    for (const entry of subdirs(wsRoot)) {
      const data = readJson(path.join(entry, "workspace.json"));
      if (!data) continue;
      addUri(data["folder"]);
      addUri(data["workspace"]);
    }

    const storage = readJson(path.join(userData, "User", "globalStorage", "storage.json"));
    if (!storage) continue;
    const backup = asRecord(storage["backupWorkspaces"]);
    const folders = backup?.["folders"];
    if (Array.isArray(folders)) {
      for (const folder of folders) addUri(asRecord(folder)?.["folderUri"]);
    }
    const associations = asRecord(storage["profileAssociations"]);
    const workspaces = asRecord(associations?.["workspaces"]);
    if (workspaces) {
      for (const uri of Object.keys(workspaces)) addUri(uri);
    }
  }
  return out;
}

/**
 * CodeBuddy IDE 的对话历史根目录，两类布局都支持：
 * - 当前版本：<localData>/CodeBuddyExtension/Data/<uid>/CodeBuddyIDE/<uid>/history
 *   下面按 md5(工作区路径) 分目录，会话目录直接是 <hash>/<会话 id>/
 * - 旧版/兼容：<userData>/User/globalStorage/<扩展 id>/genie-history
 *   下面按 base64(工作区路径) 分目录，会话在 <工作区>/conversations/<会话 id>/
 */
export function codebuddyIdeHistoryRoots(env: Env): string[] {
  const out = new Set<string>();

  for (const localData of ideLocalDataDirs(env)) {
    const dataRoot = path.join(localData, "CodeBuddyExtension", "Data");
    for (const dataDir of subdirs(dataRoot)) {
      for (const ideDir of subdirs(path.join(dataDir, "CodeBuddyIDE"))) {
        const history = path.join(ideDir, "history");
        try {
          if (fs.statSync(history).isDirectory()) out.add(history);
        } catch {
          /* 没有 history 的 uid 目录跳过 */
        }
      }
    }
  }

  for (const userData of ideUserDataDirs(env)) {
    const globalStorage = path.join(userData, "User", "globalStorage");
    for (const extDir of subdirs(globalStorage)) {
      const root = path.join(extDir, LEGACY_HISTORY_DIR_NAME);
      try {
        if (fs.statSync(root).isDirectory()) out.add(root);
      } catch {
        /* 没有 genie-history 的扩展目录跳过 */
      }
    }
  }
  return [...out];
}

/**
 * 旧版目录名是工作区路径的 base64（`+`→`-`、`/`→`_`、尾部 `=`→`_`）。
 * 解码失败返回 undefined（例如 md5 目录、names 目录等非工作区条目）。
 */
export function decodeIdeWorkspaceDir(dirName: string): string | undefined {
  try {
    let text = dirName.replace(/-/g, "+");
    const padding = text.match(/_+$/)?.[0].length ?? 0;
    if (padding > 0) text = text.slice(0, -padding);
    text = text.replace(/_/g, "/");
    text += "=".repeat((4 - (text.length % 4)) % 4);
    const decoded = Buffer.from(text, "base64").toString("utf8").trim();
    if (!decoded) return undefined;
    if (/[\u0000-\u001f\uFFFD]/.test(decoded)) return undefined;
    // 工作区名一定是绝对路径；不是的话说明这个目录不是 base64 编码的工作区
    if (!/^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(decoded)) return undefined;
    return decoded;
  } catch {
    return undefined;
  }
}
