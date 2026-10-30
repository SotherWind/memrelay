import os from "node:os";
import path from "node:path";

import type { Env } from "./types.js";

export function currentEnv(): Env {
  return {
    // 测试用覆盖点：自动化测试里伪造主目录
    home: process.env["MEMRELAY_TEST_HOME"] || os.homedir(),
    platform: process.platform,
    env: process.env as Record<string, string | undefined>,
  };
}

export function memrelayDir(env: Env = currentEnv()): string {
  const override = env.env["MEMRELAY_HOME"];
  if (override) return path.resolve(override);
  return path.join(env.home, ".memrelay");
}

export function artifactsRepo(): string {
  return "https://github.com/SotherWind/memrelay";
}
