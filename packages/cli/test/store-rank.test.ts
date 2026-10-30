import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { claudeCodeAdapter } from "../src/adapters/claude-code/index.js";
import { qoderAdapter } from "../src/adapters/qoder/index.js";
import { codexAdapter } from "../src/adapters/codex/index.js";
import type { SerializedJsonlAdapter } from "../src/adapters/jsonl-family/jsonl-adapter.js";
import { buildIndex } from "../src/store/indexer.js";
import { buildAllRanked, type RankedSession } from "../src/resume/select.js";
import { tryRankFromStore, tryRankGloballyFromStore } from "../src/resume/store-rank.js";
import { EMPTY_FILTERS } from "../src/core/filters.js";
import { isPathInside } from "../src/adapters/jsonl-family/parser.js";
import {
  makeTempHome,
  qoderSessionDir,
  wholeSecondDate,
  writeJsonlFile,
  type TempHome,
} from "./helpers.js";

/**
 * 查库快路径与读文件路径的等价性：
 * 同一批会话，两条路径排出来的候选（状态、内容量、调用方判定、关键词分）必须一致。
 */

const PROJECT = "D:\\webProject\\rank-demo";
const SID_A = "ab120000-0000-4000-8000-00000000000a";
const SID_B = "ab120000-0000-4000-8000-00000000000b";
const SID_C = "ab120000-0000-4000-8000-00000000000c";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

const adapters = (): SerializedJsonlAdapter[] => [
  claudeCodeAdapter(),
  qoderAdapter(),
  codexAdapter(),
];

function userRec(id: string, uuid: string, text: string, cwd = PROJECT): Record<string, unknown> {
  return {
    type: "user",
    uuid,
    timestamp: "2026-10-12T07:30:00.000Z",
    message: { role: "user", content: [{ type: "text", text }] },
    sessionId: id,
    cwd,
  };
}

function toolResultRec(id: string, uuid: string, callId: string, content: string): Record<string, unknown> {
  return {
    type: "user",
    uuid,
    timestamp: "2026-10-12T07:30:05.000Z",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: callId, content }] },
    sessionId: id,
    cwd: PROJECT,
  };
}

function assistantRec(
  id: string,
  uuid: string,
  parts: unknown[],
  cwd = PROJECT,
): Record<string, unknown> {
  return {
    type: "assistant",
    uuid,
    timestamp: "2026-10-12T07:31:00.000Z",
    message: { role: "assistant", content: parts },
    sessionId: id,
    cwd,
  };
}

/** 会话 A：官网首页任务，停在一个没结果的 Read 上（中断）。 */
function sessionARecords(): Array<Record<string, unknown>> {
  const write = path.join(PROJECT, "src", "pages", "Home.tsx");
  return [
    { type: "workspace-directories", sessionId: SID_A, directories: [PROJECT] },
    userRec(SID_A, "ab1200a0-0000-4000-8000-000000000001", "帮我设计一个公司官网首页，先出静态页再配通知"),
    assistantRec(SID_A, "ab1200a0-0000-4000-8000-000000000010", [
      { type: "text", text: "好，我先写首页静态页。" },
      { type: "tool_use", id: "call_rank_write1", name: "Write", input: { file_path: write, content: "<Home/>" } },
    ]),
    toolResultRec(SID_A, "ab1200a0-0000-4000-8000-000000000011", "call_rank_write1", "File created successfully"),
    assistantRec(SID_A, "ab1200a0-0000-4000-8000-000000000020", [
      { type: "text", text: "静态页完成，开始接通知数据。" },
      { type: "tool_use", id: "call_rank_read1", name: "Read", input: { file_path: path.join(PROJECT, "src", "api", "notice.ts") } },
    ]),
  ];
}

/** 会话 B：登录页任务，正常收尾（完成）。 */
function sessionBRecords(): Array<Record<string, unknown>> {
  return [
    { type: "workspace-directories", sessionId: SID_B, directories: [PROJECT] },
    userRec(SID_B, "ab1200b0-0000-4000-8000-000000000001", "帮我做一个登录页，邮箱加密码"),
    assistantRec(SID_B, "ab1200b0-0000-4000-8000-000000000010", [
      { type: "text", text: "登录页已写好，包含邮箱校验与记住我选项。" },
      { type: "tool_use", id: "call_rank_write2", name: "Write", input: { file_path: path.join(PROJECT, "src", "pages", "Login.tsx"), content: "<Login/>" } },
    ]),
    toolResultRec(SID_B, "ab1200b0-0000-4000-8000-000000000011", "call_rank_write2", "File created successfully"),
    assistantRec(SID_B, "ab1200b0-0000-4000-8000-000000000020", [
      { type: "text", text: "全部完成，可以验收了：邮箱校验、记住我都会生效，顺便补了错误提示样式。" },
    ]),
  ];
}

function writeSession(
  home: string,
  id: string,
  records: Array<Record<string, unknown>>,
  minutesAgo: number,
  project = PROJECT,
): string {
  const file = path.join(qoderSessionDir(home, project), `${id}.jsonl`);
  writeJsonlFile(file, records, wholeSecondDate(minutesAgo));
  return file;
}

async function rankBothWays(temp: TempHome, keyword: string): Promise<{
  fileRanked: RankedSession[];
  storeRanked: RankedSession[] | undefined;
  now: number;
}> {
  const now = Date.now();
  const rank = { keyword, gitChangedFiles: [] as string[], now };
  const allScans = (await Promise.all(adapters().map((a) => a.scanAll(temp.env)))).flat();
  const scans = allScans.filter((s) => isPathInside(s.cwd ?? "", PROJECT, temp.env.platform));
  const fileRanked = await buildAllRanked(adapters(), scans, { ...rank, cwd: PROJECT });
  const storeRanked = await tryRankFromStore({
    env: temp.env,
    projectRoot: PROJECT,
    filters: EMPTY_FILTERS,
    adapters: adapters(),
    rank,
  });
  return { fileRanked, storeRanked, now };
}

function expectSameRank(fileRanked: RankedSession[], storeRanked: RankedSession[] | undefined): void {
  expect(storeRanked).toBeDefined();
  expect(storeRanked!.map((r) => r.scan.id).sort()).toEqual(fileRanked.map((r) => r.scan.id).sort());
  for (const fr of fileRanked) {
    const sr = storeRanked!.find((r) => r.scan.id === fr.scan.id)!;
    expect(sr.status).toBe(fr.status);
    expect(sr.hasContent).toBe(fr.hasContent);
    expect(sr.isCaller).toBe(fr.isCaller);
    expect(sr.interruptedBonus).toBe(fr.interruptedBonus);
    expect(sr.fileOverlap).toBe(fr.fileOverlap);
    expect(sr.keyword).toBe(fr.keyword);
    expect(sr.total).toBe(fr.total);
    expect(sr.scan.cwd).toBe(fr.scan.cwd);
    expect(sr.chainFrom ?? null).toEqual(fr.chainFrom ?? null);
    expect(sr.scan.tail.lastTitle ?? null).toEqual(fr.scan.tail.lastTitle ?? null);
  }
}

describe("resume 查库快路径", () => {
  it("索引最新时：查库排序与读文件排序逐项一致", async () => {
    const temp = makeTempHome();
    cleanups.push(temp.cleanup);
    writeSession(temp.home, SID_A, sessionARecords(), 90);
    writeSession(temp.home, SID_B, sessionBRecords(), 120);
    await buildIndex(temp.env, { adapters: adapters() });

    const { fileRanked, storeRanked } = await rankBothWays(temp, "官网");
    expect(fileRanked).toHaveLength(2);
    expect(fileRanked.find((r) => r.scan.id.endsWith(SID_A))!.status).toBe("interrupted");
    expectSameRank(fileRanked, storeRanked);

    // 无关键词的选择也一致
    const plain = await rankBothWays(temp, "");
    expectSameRank(plain.fileRanked, plain.storeRanked);
  });

  it("文件过期时：现场重读那一个文件，结果与读文件路径一致", async () => {
    const temp = makeTempHome();
    cleanups.push(temp.cleanup);
    const fileA = writeSession(temp.home, SID_A, sessionARecords(), 90);
    writeSession(temp.home, SID_B, sessionBRecords(), 120);
    await buildIndex(temp.env, { adapters: adapters() });

    // 索引之后又写了一个回合（文件过期，库里还是旧进度）
    const extra = fs.readFileSync(fileA, "utf8") +
      JSON.stringify(assistantRec(SID_A, "ab1200a0-0000-4000-8000-000000000030", [
        { type: "text", text: "追记：接口超时来自上游通知服务，正在排查重试策略。" },
      ])) + "\n";
    fs.writeFileSync(fileA, extra, "utf8");

    const { fileRanked, storeRanked } = await rankBothWays(temp, "官网");
    const a = fileRanked.find((r) => r.scan.id.endsWith(SID_A))!;
    expect(a.status).toBe("in_progress"); // 刚写过 = 进行中
    expectSameRank(fileRanked, storeRanked);
  });

  it("库里还没有的新会话文件：现场扫描补进候选，与读文件路径一致", async () => {
    const temp = makeTempHome();
    cleanups.push(temp.cleanup);
    writeSession(temp.home, SID_A, sessionARecords(), 90);
    await buildIndex(temp.env, { adapters: adapters() });

    writeSession(temp.home, SID_C, [
      { type: "workspace-directories", sessionId: SID_C, directories: [PROJECT] },
      userRec(SID_C, "ab1200c0-0000-4000-8000-000000000001", "做一个联系人列表页"),
      assistantRec(SID_C, "ab1200c0-0000-4000-8000-000000000010", [{ type: "text", text: "联系人列表页开工，先搭表格骨架。" }]),
    ], 60);

    const { fileRanked, storeRanked } = await rankBothWays(temp, "联系人");
    expect(fileRanked.map((r) => r.scan.id).some((id) => id.endsWith(SID_C))).toBe(true);
    expectSameRank(fileRanked, storeRanked);
  });

  it("现场重读的文件太多（库大面积过期）时放弃快路径", async () => {
    const temp = makeTempHome();
    cleanups.push(temp.cleanup);
    await buildIndex(temp.env, { adapters: adapters() }); // 先建一个空库
    // 库里完全没有这 10 个文件 → 每个都要现场重读 → 超过上限，落回全量扫盘
    for (let i = 0; i < 10; i++) {
      const id = `ab1200d0-0000-4000-8000-00000000000${i}`;
      writeSession(temp.home, id, [
        { type: "workspace-directories", sessionId: id, directories: [PROJECT] },
        userRec(id, `ab1200d0-0000-4000-8000-00000000001${i}`, `第 ${i} 个任务`),
        assistantRec(id, `ab1200d0-0000-4000-8000-00000000002${i}`, [{ type: "text", text: `第 ${i} 个任务已开工。` }]),
      ], 100 + i);
    }

    const { storeRanked } = await rankBothWays(temp, "任务");
    expect(storeRanked).toBeUndefined(); // 10 个文件都要现场重读 → 落回全量扫盘
  });

  it("库缺失时返回 undefined（由调用方全量扫盘）", async () => {
    const temp = makeTempHome();
    cleanups.push(temp.cleanup);
    writeSession(temp.home, SID_A, sessionARecords(), 90);
    const result = await tryRankFromStore({
      env: temp.env,
      projectRoot: PROJECT,
      filters: EMPTY_FILTERS,
      adapters: adapters(),
      rank: { keyword: "", gitChangedFiles: [], now: Date.now() },
    });
    expect(result).toBeUndefined();
  });

  it("全库兜底：关键词命中其它项目时也能排出来（当前目录不是项目时用）", async () => {
    const temp = makeTempHome();
    cleanups.push(temp.cleanup);
    const otherProject = "D:\\Desktop\\test\\thunder-fighter";
    const sidThunder = "ab120000-0000-4000-8000-00000000000d";
    writeSession(temp.home, SID_A, sessionARecords(), 90);
    writeSession(
      temp.home,
      sidThunder,
      [
        userRec(sidThunder, "ab1200d0-0000-4000-8000-000000000001", "继续完成雷霆战机的开发", otherProject),
        assistantRec(
          sidThunder,
          "ab1200d0-0000-4000-8000-000000000010",
          [{ type: "text", text: "先补 render 模块的测试，再跑一遍类型检查。" }],
          otherProject,
        ),
      ],
      30,
      otherProject,
    );
    await buildIndex(temp.env, { adapters: adapters() });

    const ranked = await tryRankGloballyFromStore({
      env: temp.env,
      filters: EMPTY_FILTERS,
      rank: { keyword: "雷霆战机", gitChangedFiles: [], now: Date.now() },
    });
    expect(ranked).toBeDefined();
    const hit = ranked!.find((r) => r.scan.id.endsWith(sidThunder));
    expect(hit).toBeDefined();
    expect(hit!.scan.cwd).toBe(otherProject);
    expect(hit!.keyword).toBeGreaterThan(0);
    expect(hit!.hasContent).toBe(true);

    // 全库搜索不会把其它项目的无关会话也带出来
    expect(ranked!.some((r) => r.scan.id.endsWith(SID_A))).toBe(false);

    // 排除当前目录（调用方自己的会话通常落在这里）
    const excluded = await tryRankGloballyFromStore({
      env: temp.env,
      filters: EMPTY_FILTERS,
      rank: { keyword: "雷霆战机", gitChangedFiles: [], now: Date.now() },
      excludeProjectRoot: otherProject,
    });
    expect(excluded).toEqual([]);

    const missing = await tryRankGloballyFromStore({
      env: temp.env,
      filters: EMPTY_FILTERS,
      rank: { keyword: "完全不存在的任务词", gitChangedFiles: [], now: Date.now() },
    });
    expect(missing).toEqual([]);
  });
});
