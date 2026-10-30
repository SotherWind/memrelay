import fs from "node:fs";
import path from "node:path";

import { currentEnv, memrelayDir } from "../core/env.js";
import { VERSION } from "../core/version.js";
import { readManifest, sha256, skillContent, writeFileTracked } from "./setup.js";

interface RuntimeInfo {
  version?: string;
  skillHash?: string;
}

/**
 * 用户在自己终端里运行任意 memrelay 命令时，如果发现已写入的 Skill 版本较旧、
 * 且文件没被用户改过，就自动更新。agent 的命令（resume/show/hint）不写文件，不调用这里。
 */
export function maybeAutoUpdateSkills(quiet = false): string[] {
  const env = currentEnv();
  const manifest = readManifest(env);
  if (!manifest) return [];
  const skillFiles = manifest.files.filter((f) => f.kind === "skill");
  if (skillFiles.length === 0) return [];

  let runtime: RuntimeInfo | undefined;
  try {
    runtime = JSON.parse(
      fs.readFileSync(path.join(memrelayDir(env), "runtime.json"), "utf8"),
    ) as RuntimeInfo;
  } catch {
    runtime = undefined;
  }
  if (runtime?.version === VERSION) return [];

  const content = skillContent(env);
  const updated: string[] = [];
  for (const file of skillFiles) {
    let current: string;
    try {
      current = fs.readFileSync(file.path, "utf8");
    } catch {
      // 文件被用户删了：不重新放回，避免和用户的清理动作对抗
      continue;
    }
    if (sha256(current) !== file.hash) continue; // 用户改过，跳过
    try {
      writeFileTracked(file.path, content, "skill");
      updated.push(file.path);
    } catch {
      /* 权限问题：跳过，不影响主流程 */
    }
  }

  if (updated.length > 0) {
    try {
      const runtimeFile = manifest.files.find((f) => f.kind === "runtime");
      if (runtimeFile) {
        const info = { ...(runtime ?? {}), version: VERSION, skillHash: sha256(content) };
        writeFileTracked(runtimeFile.path, `${JSON.stringify(info, null, 2)}\n`, "runtime");
      }
    } catch {
      /* ignore */
    }
    if (!quiet) {
      console.error(`（已自动更新 MemRelay Skill：${updated.length} 个文件）`);
    }
  }
  return updated;
}

/** doctor 用：检查 Skill 是否需要更新（不写文件）。 */
export function skillsNeedUpdate(): boolean {
  try {
    const env = currentEnv();
    const runtimePath = path.join(memrelayDir(env), "runtime.json");
    const runtime = JSON.parse(fs.readFileSync(runtimePath, "utf8")) as RuntimeInfo;
    return runtime.version !== undefined && runtime.version !== VERSION;
  } catch {
    return false;
  }
}
