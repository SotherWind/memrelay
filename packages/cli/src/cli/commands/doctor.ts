import fs from "node:fs";
import path from "node:path";

import { allAdapters } from "../../adapters/all.js";
import { currentEnv, memrelayDir } from "../../core/env.js";
import { TOOL_REGISTRY } from "../../core/tool-registry.js";
import { VERSION } from "../../core/version.js";
import { detectTools } from "../../integrations/inspect.js";
import { maybeAutoIntegrateHint } from "../../server/integrations.js";
import { dbPath, openReadOnly } from "../../store/db.js";
import { embeddingStatus } from "../../store/embeddings-store.js";
import { buildIndex, findParseDrifts } from "../../store/indexer.js";
import { drainWithCurrentConfig } from "../../store/semantic.js";
import { summaryStatus } from "../../store/summaries-store.js";
import { drainSummaryWithCurrentConfig } from "../../store/summarizer.js";
import { helpText } from "../help.js";

export async function runDoctor(rest: string[]): Promise<number> {
  if (rest.includes("--help") || rest.includes("-h")) {
    process.stdout.write(`${helpText()}\n`);
    return 0;
  }
  return doctor();
}

/** 自检：解析本机真实会话，只输出统计数字，不输出内容。 */
async function doctor(): Promise<number> {
  const env = currentEnv();
  const out = (line = "") => console.log(line);
  const problems: string[] = [];

  out(`MemRelay ${VERSION} doctor`);
  out(`数据目录：${memrelayDir(env)}`);
  out("");

  out("【环境】");
  const nodeVersion = process.version;
  const [major = 0, minor = 0] = nodeVersion.replace(/^v/, "").split(".").map(Number);
  const nodeOk = major > 22 || (major === 22 && minor >= 15);
  out(`  ${nodeOk ? "✓" : "✗"} Node ${nodeVersion}${nodeOk ? "" : "（需要 22.15 或更高）"}`);
  if (!nodeOk) problems.push("Node 版本过低");

  const binDir = path.join(memrelayDir(env), "bin");
  const shExists = fs.existsSync(path.join(binDir, "memrelay"));
  const cmdExists = fs.existsSync(path.join(binDir, "memrelay.cmd"));
  out(`  ${shExists ? "✓" : "–"} 启动脚本 memrelay${shExists ? "" : "（未找到；运行 memrelay setup 生成）"}`);
  if (process.platform === "win32") {
    out(`  ${cmdExists ? "✓" : "–"} 启动脚本 memrelay.cmd${cmdExists ? "" : "（未找到；运行 memrelay setup 生成）"}`);
  }
  const runtimePath = path.join(memrelayDir(env), "runtime.json");
  let runtimeNode = "";
  try {
    const runtime = JSON.parse(fs.readFileSync(runtimePath, "utf8")) as { node?: string };
    if (runtime.node) {
      runtimeNode = runtime.node;
      const ok = fs.existsSync(runtimeNode);
      out(`  ${ok ? "✓" : "✗"} runtime.json 记录的 Node：${runtimeNode}${ok ? "" : "（文件不存在）"}`);
      if (!ok) problems.push("runtime.json 记录的 Node 路径已失效");
    }
  } catch {
    out("  – runtime.json 不存在（运行 memrelay setup 生成）");
  }

  const chinese = "中文输出正常";
  const bytes = Buffer.from(chinese, "utf8");
  const roundTrip = bytes.toString("utf8") === chinese;
  out(`  ${roundTrip ? "✓" : "✗"} 中文 UTF-8 编码自检`);
  if (!roundTrip) problems.push("中文编码异常");

  out("");
  out("【本机会话解析与索引】（只输出统计数字）");
  const adapters = allAdapters();
  try {
    const stats = await buildIndex(env, {
      adapters,
      onProgress: (message) => out(`  …${message}`),
    });
    for (const [agentId, a] of Object.entries(stats.byAgent)) {
      const name = TOOL_REGISTRY.find((t) => t.id === agentId)?.name ?? agentId;
      if (a.sessions === 0 && a.failed === 0) {
        out(`  – ${name}：没有会话目录`);
        continue;
      }
      const failedNote = a.failed > 0 ? `；解析失败 ${a.failed} 个` : "；解析失败 0 个";
      out(
        `  ${a.failed === 0 ? "✓" : "✗"} ${name}：会话 ${a.sessions} 个、消息 ${a.messages} 条、片段 ${a.parts} 个（本次更新 ${a.updated} 个${failedNote}）`,
      );
      if (a.failed > 0) problems.push(`${name} 有 ${a.failed} 个会话解析失败`);
    }
    out(
      `  索引库：${dbPath(env)}（本次更新共 ${stats.updated} 个会话，耗时 ${(stats.durationMs / 1000).toFixed(1)}s）`,
    );

    // 解析完整性哨兵：工具升级改了记录格式时，"解析不报错但内容悄悄丢了"，这里能及早发现
    try {
      const db = openReadOnly(env);
      try {
        const drifts = findParseDrifts(db);
        if (drifts.length === 0) {
          out("  ✓ 解析完整性检查：最近 20 个会话解析正常");
        } else {
          out(
            `  ⚠ 解析完整性检查：${drifts.length} 个会话"原始记录多、解析出的内容少"，可能是对应工具升级后改了记录格式：`,
          );
          for (const d of drifts.slice(0, 3)) {
            const name = TOOL_REGISTRY.find((t) => t.id === d.agent)?.name ?? d.agent;
            out(`     - ${name}：${d.sessionId}（原始记录 ${d.rawRecords} 条，只解析出 ${d.messages} 条消息）`);
          }
          out("     如果这些任务实际干过活，说明该工具的适配器需要更新（先升级 memrelay）。");
          problems.push("有会话疑似解析不完整（可能是工具版本升级改了记录格式）");
        }
      } finally {
        db.close();
      }
    } catch {
      /* 哨兵失败不影响主流程 */
    }
  } catch (err) {
    out(`  ✗ 建立索引失败：${err instanceof Error ? err.message : err}`);
    problems.push("建立索引失败");
  }

  out("");
  out("【语义检索（向量，opt-in）】");
  let embeddingsEnabled = false;
  try {
    const db = openReadOnly(env);
    try {
      const status = embeddingStatus(db);
      embeddingsEnabled = status.enabled && status.configured;
      if (!status.enabled) {
        out("  – 未启用（在 memrelay ui 的配置页开启）");
      } else if (!status.configured) {
        out("  ⚠ 已开启但配置不全：需要接口地址、嵌入模型名与 API Key");
        problems.push("语义检索配置不全");
      } else {
        out(
          `  ✓ 模型 ${status.model} · 主机 ${status.host} · 已嵌 ${status.embeddedSessions} 会话 / ${status.embeddedChunks} 块 · 待嵌 ${status.pendingSessions}`,
        );
        if (status.staleChunks > 0) {
          out(`  ⚠ 有 ${status.staleChunks} 块旧指纹向量（换过模型/主机）：到配置页点「重建向量」清理并重嵌`);
        }
        if (status.rulesOutdated) {
          out("  ⚠ 密钥脱敏规则已更新：回填时会自动重嵌相关块");
        }
        if (status.lastError) {
          out(`  ⚠ 最近错误：${status.lastError}${status.lastErrorAt ? `（${status.lastErrorAt}）` : ""}`);
        }
      }
    } finally {
      db.close();
    }
  } catch {
    /* 库缺失等：上面索引部分已经报过 */
  }
  if (embeddingsEnabled) {
    // doctor 是 drain 的三处出口之一（设计文档 §3）：有预算地补一轮，输出进度
    const result = await drainWithCurrentConfig(env, {
      maxSessions: 20,
      maxMs: 60_000,
      onProgress: (message) => out(`  …${message}`),
    });
    if (result) {
      out(
        `  回填：嵌入 ${result.processed} 个会话、未变化跳过 ${result.skipped} 个、失败 ${result.failed} 个、剩余 ${result.remaining} 个。`,
      );
      if (result.paused) problems.push("向量回填连续失败已暂停（检查嵌入接口配置）");
    }
  }

  out("");
  out("【会话摘要（LLM 增强，opt-in）】");
  let summaryReady = false;
  try {
    const db = openReadOnly(env);
    try {
      const status = summaryStatus(db);
      summaryReady = status.enabled && status.configured;
      if (!status.enabled) {
        out("  – 未启用（在 memrelay ui 的配置页开启）");
      } else if (!status.configured) {
        out("  ⚠ 已开启但摘要接口配置不全：需要接口地址、模型名与 Key");
        problems.push("会话摘要配置不全");
      } else {
        out(
          `  ✓ 模型 ${status.model} · 主机 ${status.host} · 已摘要 ${status.summarizedSessions} 会话 · 待摘要 ${status.pendingSessions}`,
        );
        if (status.staleSessions > 0) {
          out(`  ⚠ 有 ${status.staleSessions} 条旧模型/主机的摘要：到配置页点「重建摘要」清理并重生成`);
        }
        if (status.lastError) {
          out(`  ⚠ 最近错误：${status.lastError}${status.lastErrorAt ? `（${status.lastErrorAt}）` : ""}`);
        }
      }
    } finally {
      db.close();
    }
  } catch {
    /* 库缺失等：上面索引部分已经报过 */
  }
  if (summaryReady) {
    const result = await drainSummaryWithCurrentConfig(env, {
      maxSessions: 5,
      maxMs: 30_000,
      onProgress: (message) => out(`  …${message}`),
    });
    if (result) {
      out(
        `  生成：摘要 ${result.processed} 个会话、未变化跳过 ${result.skipped} 个、失败 ${result.failed} 个、剩余 ${result.remaining} 个。`,
      );
      if (result.paused) problems.push("摘要生成连续失败已暂停（检查摘要接口配置）");
    }
  }

  out("");
  const detected = detectTools(env).filter((d) => d.installed);
  out(`【已检测到的工具】${detected.length === 0 ? "（无）" : ""}`);
  for (const d of detected) {
    const role = d.canBeSource ? "可作来源" : d.tool.encryptedSessions ? "仅可接手（会话加密）" : "仅可接手";
    out(`  - ${d.tool.name}（${role}）；会话文件约 ${d.sessionFileCount} 个；Skill 目录 ${d.skillDirs.length} 个`);
  }
  // 自动接入提示（设置开启时）：只列出「已安装但未接入」的工具，不写任何文件
  try {
    const db = openReadOnly(env);
    try {
      const hint = maybeAutoIntegrateHint(db, env);
      if (hint) out(`  提示：${hint}`);
    } finally {
      db.close();
    }
  } catch {
    /* 库缺失等：上面索引部分已经报过 */
  }

  out("");
  if (problems.length === 0) {
    out("结论：一切正常。");
    return 0;
  }
  out(`结论：发现 ${problems.length} 个问题：`);
  for (const p of problems) out(`  - ${p}`);
  return 1;
}
