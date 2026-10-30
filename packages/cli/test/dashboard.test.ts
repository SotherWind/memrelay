import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { claudeCodeAdapter } from "../src/adapters/claude-code/index.js";
import { codexAdapter } from "../src/adapters/codex/index.js";
import { qoderAdapter } from "../src/adapters/qoder/index.js";
import type { SerializedJsonlAdapter } from "../src/adapters/jsonl-family/jsonl-adapter.js";
import { buildIndex } from "../src/store/indexer.js";
import { openReadOnly, openWritable } from "../src/store/db.js";
import { getDashboard, listTaskSummary } from "../src/server/task-list.js";
import { deleteSessions } from "../src/server/deletions.js";
import { makeTempHome, type TempHome } from "./helpers.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function backdate(file: string, minutes: number): void {
  const past = new Date(Date.now() - minutes * 60 * 1000);
  fs.utimesSync(file, past, past);
}

function setupHome(): TempHome {
  const temp = makeTempHome();
  cleanups.push(temp.cleanup);

  const files: Array<[string, string, number]> = [
    [
      path.join(".qoder", "projects", "d--webproject-demo-site", "11111111-1111-4111-8111-111111111111.jsonl"),
      "qoder/demo-site.jsonl",
      90,
    ],
    [
      path.join(".qoder", "projects", "d--webproject-ops-check", "long-secrets.jsonl"),
      "qoder/long-secrets.jsonl",
      80,
    ],
    [
      path.join(".claude", "projects", "d--webproject-notes-app", "notes-app.jsonl"),
      "claude-code/notes-app.jsonl",
      70,
    ],
    [
      path.join(".claude", "projects", "d--webproject-relay-target", "caller-resume.jsonl"),
      "claude-code/caller-resume.jsonl",
      60,
    ],
    [
      path.join(".codex", "sessions", "2026", "10", "11", "rollout-basic.jsonl"),
      "codex/rollout-basic.jsonl",
      50,
    ],
  ];
  for (const [target, fixture, minutes] of files) {
    const file = path.join(temp.home, target);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.copyFileSync(path.resolve("test", "fixtures", fixture), file);
    backdate(file, minutes);
  }
  return temp;
}

function adapters(): SerializedJsonlAdapter[] {
  return [claudeCodeAdapter(), qoderAdapter(), codexAdapter()];
}

async function indexed(): Promise<TempHome> {
  const temp = setupHome();
  await buildIndex(temp.env, { adapters: adapters() });
  return temp;
}

describe("仪表盘总览", () => {
  it("空索引也返回完整结构", () => {
    const temp = makeTempHome();
    cleanups.push(temp.cleanup);
    const db = openWritable(temp.env);
    try {
      const dash = getDashboard(db, temp.env);
      expect(dash.total).toBe(0);
      expect(dash.recent).toEqual([]);
      expect(dash.attention).toEqual([]);
      expect(dash.tools).toEqual([]);
      expect(dash.trash).toBe(0);
      expect(dash.activity).toHaveLength(14);
      expect(dash.lastWriteAt).toBeNull();
    } finally {
      db.close();
    }
  });

  it("任务数与状态计数和任务列表完全一致", async () => {
    const temp = await indexed();
    const db = openReadOnly(temp.env);
    try {
      const summary = listTaskSummary(db, temp.env);
      const dash = getDashboard(db, temp.env);
      expect(dash.total).toBe(summary.total);
      expect(dash.total).toBe(4);
      expect(dash.counts).toEqual(summary.counts);
      expect(dash.recent.length).toBeLessThanOrEqual(6);
      expect(dash.recent.length).toBe(Math.min(6, summary.total));
      for (let i = 1; i < dash.recent.length; i++) {
        expect(dash.recent[i - 1]!.lastActiveAt).toBeGreaterThanOrEqual(
          dash.recent[i]!.lastActiveAt,
        );
      }
    } finally {
      db.close();
    }
  });

  it("跨工具任务的工具链按接力顺序带出", async () => {
    const temp = await indexed();
    const db = openReadOnly(temp.env);
    try {
      const dash = getDashboard(db, temp.env);
      const chain = dash.recent.find((task) => task.tools.length > 1);
      expect(chain).toBeDefined();
      expect(chain!.tools).toEqual(["qoder", "claude-code"]);
      expect(chain!.messageCount).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });

  it("已删除计数：删除的会话计入回收站，任务总数同步减少", async () => {
    const temp = await indexed();
    const db = openReadOnly(temp.env);
    try {
      const before = getDashboard(db, temp.env);
      expect(before.trash).toBe(0);
      expect(deleteSessions(temp.env, ["codex:c0de0001-1111-4111-8111-111111111111"])).toBe(1);
      const after = getDashboard(db, temp.env);
      expect(after.trash).toBe(1);
      expect(after.total).toBe(before.total - 1);
      expect(
        after.recent.some((task) => task.id === "codex:c0de0001-1111-4111-8111-111111111111"),
      ).toBe(false);
    } finally {
      db.close();
    }
  });

  it("工具与目录分布：会话计数、活跃目录排序", async () => {
    const temp = await indexed();
    const db = openReadOnly(temp.env);
    try {
      const dash = getDashboard(db, temp.env);
      const byTool = new Map(dash.tools.map((tool) => [tool.tool, tool]));
      expect(byTool.get("qoder")?.sessions).toBe(2);
      expect(byTool.get("claude-code")?.sessions).toBe(2);
      expect(byTool.get("codex")?.sessions).toBe(1);

      expect(dash.projects.total).toBeGreaterThanOrEqual(3);
      expect(dash.projects.top.reduce((sum, project) => sum + project.count, 0)).toBe(dash.total);
      for (let i = 1; i < dash.projects.top.length; i++) {
        expect(dash.projects.top[i - 1]!.lastActiveAt).toBeGreaterThanOrEqual(
          dash.projects.top[i]!.lastActiveAt,
        );
      }

      expect(dash.lastWriteAt).not.toBeNull();
    } finally {
      db.close();
    }
  });

  it("近 14 天活动：按本地日期分桶，长度可配置", async () => {
    const temp = await indexed();
    const db = openReadOnly(temp.env);
    try {
      const dash = getDashboard(db, temp.env);
      expect(dash.activity).toHaveLength(14);
      const today = new Date();
      const pad = (n: number) => String(n).padStart(2, "0");
      expect(dash.activity.at(-1)!.date).toBe(
        `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`,
      );
      // 夹具里的 5 个会话都在最近写入过，各自只落进一个日期桶
      expect(dash.activity.reduce((sum, day) => sum + day.sessions, 0)).toBe(5);

      const week = getDashboard(db, temp.env, { days: 7 });
      expect(week.activity).toHaveLength(7);
    } finally {
      db.close();
    }
  });

  it("待接力只含中断任务，按最近活动倒序", async () => {
    const temp = await indexed();
    const db = openReadOnly(temp.env);
    try {
      const dash = getDashboard(db, temp.env);
      expect(dash.attention.every((task) => task.status === "interrupted")).toBe(true);
      for (let i = 1; i < dash.attention.length; i++) {
        expect(dash.attention[i - 1]!.lastActiveAt).toBeGreaterThanOrEqual(
          dash.attention[i]!.lastActiveAt,
        );
      }
      const limited = getDashboard(db, temp.env, { attentionLimit: 1 });
      expect(limited.attention.length).toBeLessThanOrEqual(1);
    } finally {
      db.close();
    }
  });
});
