import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * dsh 实时索引插件的挂载点计算。
 *
 * 机制（2026-10-16 实测）：dsh 的桌面端 profile 归 Electron 应用独占
 * （`dsh plugin --profile desktop …` 会被直接拒绝），但 cordis 的 profile patch
 * 层加载器接受 `file://` URL 并直接 import 插件入口——于是插件挂进 memrelay 已有的
 * home 级 `cordis.patch.yml` 块（与 hooks 桥同一块），不碰 profile 依赖、不需要 pnpm，
 * 任一 profile 都生效；插件文件缺失时加载器软失败（记日志、照常启动）。
 */

export const DSH_PLUGIN_NAME = "memrelay-dsh-plugin";

/** 随 memrelay 包分发的插件目录（与打包后的 cli 同级：<包根>/dsh-plugin）。 */
function cliEntryPath(): string {
  const override = process.env["MEMRELAY_CLI_PATH"];
  if (override) return override;
  const current = process.argv[1] ?? "";
  if (/cli\.(mjs|js)$/.test(current) && path.basename(current).startsWith("cli")) {
    return path.resolve(current);
  }
  return path.resolve("dist/cli.mjs");
}

export function dshPluginDir(): string {
  // 测试覆盖点：不必真的构建 dist / 真的存在插件目录
  const override = process.env["MEMRELAY_DSH_PLUGIN_DIR"];
  if (override) return path.resolve(override);
  return path.resolve(path.dirname(cliEntryPath()), "..", "dsh-plugin");
}

/** 插件入口的 file:// URL；插件文件不存在时返回 undefined（调用方跳过挂载）。 */
export function dshPluginEntryUrl(): string | undefined {
  const entry = path.join(dshPluginDir(), "lib", "index.js");
  if (!fs.existsSync(entry)) return undefined;
  return pathToFileURL(entry).href;
}
