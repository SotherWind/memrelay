import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  TIDY_BLOCK_BEGIN,
  parseMemoryItems,
  stripTidyBlock,
} from "../src/core/memory-sources.js";
import { parseTidyResult } from "../src/core/tidy-plan.js";
import { openWritable } from "../src/store/db.js";
import { runTidy, undoTidy, applyExistingTidyPlan } from "../src/store/tidy-runner.js";
import { tidyStatus, readTidyPlan, writeTidyPlan } from "../src/store/tidy-store.js";
import { makeTempHome } from "./helpers.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function write(home: string, rel: string, content: string): void {
  const file = path.join(home, ...rel.split("/"));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
}

function read(home: string, rel: string): string {
  return fs.readFileSync(path.join(home, ...rel.split("/")), "utf8");
}

function configure(db: ReturnType<typeof openWritable>): void {
  const put = (key: string, value: string) =>
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(key, value);
  put("tidy.enabled", "1");
  put("tidy.baseUrl", "https://api.example.com/v1");
  put("tidy.model", "chat-x");
  put("tidy.apiKey", "k");
}

function fakeProvider(response: string): {
  calls: string[];
  provider: { model: string; complete(system: string, user: string): Promise<string> };
} {
  const calls: string[] = [];
  return {
    calls,
    provider: {
      model: "chat-x",
      async complete(_system, user) {
        calls.push(user);
        return response;
      },
    },
  };
}

describe("偏好整理：解析", () => {
  it("按列表项切分、去重、去掉 frontmatter 与本功能标记块", () => {
    const content = `---
name: demo
---
# 偏好
- 使用中文回答
- 使用中文回答

## 工程
- 改完先跑测试
`;
    expect(parseMemoryItems(content)).toEqual([
      { heading: "偏好", text: "使用中文回答" },
      { heading: "工程", text: "改完先跑测试" },
    ]);
    const withBlock = `A\n\n${TIDY_BLOCK_BEGIN}\n- 自动生成\n<!-- memrelay:tidy:end -->\nB`;
    expect(stripTidyBlock(withBlock)).not.toContain("自动生成");
  });

  it("模型结果校验：去重、去围栏、空结果报错", () => {
    expect(
      parseTidyResult('```json\n{"entries":[{"text":"使用中文"},{"text":"使用中文"}],"conflicts":[]}\n```'),
    ).toEqual({ entries: ["使用中文"], conflicts: [] });
    expect(() => parseTidyResult('{"entries":[]}')).toThrow("整理结果为空");
    expect(() => parseTidyResult("not json")).toThrow("合法 JSON");
  });

  it("重复选项不构成冲突；冲突被过滤完时状态归一为 applied", () => {
    const temp = makeTempHome();
    cleanups.push(temp.cleanup);
    const db = openWritable(temp.env);
    cleanups.push(() => db.close());
    writeTidyPlan(db, {
      status: "conflict",
      content: "- 使用中文回答",
      conflicts: [{ topic: "语言", options: ["中文", "中文"], question: "用哪种？" }],
      inputs: {},
      model: "m",
      host: "h",
    });
    const plan = readTidyPlan(db);
    expect(plan?.conflicts).toEqual([]);
    expect(plan?.status).toBe("applied");
  });
});

describe("偏好整理：端到端", () => {
  it("导入 → 合并 → 写标记块 → 源不变跳过 → 撤销", async () => {
    const temp = makeTempHome();
    cleanups.push(temp.cleanup);
    const db = openWritable(temp.env);
    cleanups.push(() => db.close());

    const qoderMemory = "# Qoder 偏好\n- 使用中文回答\n- 改完先跑测试\n";
    const qoderIndex = "- [Qoder 偏好](a.md)\n";
    const codexAgents = "# 全局 Codex 指令\n- 默认使用简体中文回答\n- 不要自动提交\n";
    write(temp.home, ".qoder/memory/a.md", qoderMemory);
    write(temp.home, ".qoder/memory/MEMORY.md", qoderIndex);
    write(
      temp.home,
      ".qoder/memory/env.md",
      "---\nname: env\nmetadata:\n  type: reference\n---\n# 本机环境\n- Windows 终端编码为 GBK\n",
    );
    write(
      temp.home,
      ".qoder/memory/profile.md",
      "---\nname: profile\nmetadata:\n  type: user\n---\n# 身份\n- npm scope 用 yzguang\n",
    );
    write(temp.home, ".codex/AGENTS.md", codexAgents);
    // 旧版把块写进 Trae 的 memory 文件；新版应迁到 user_rules/memrelay.md
    write(
      temp.home,
      ".trae-cn/memory/user_profile.md",
      `${TIDY_BLOCK_BEGIN}\n## legacy\n<!-- memrelay:tidy:end -->\n`,
    );
    const zcodeAgents = "# ZCode 规则\n- zcode rule\n";
    const opencodeAgents = "# OpenCode 规则\n- opencode rule\n";
    const dshAgents = "# DSH 规则\n- dsh rule\n";
    write(temp.home, ".zcode/AGENTS.md", zcodeAgents);
    write(temp.home, ".config/opencode/AGENTS.md", opencodeAgents);
    write(temp.home, ".dsh/AGENTS.md", dshAgents);
    const workBuddyMemory =
      "# 长期记忆（用户级，跨项目）\n## 个人偏好\n- 用户姓名：张三\n- 饮食偏好：不喜欢辣椒\n";
    write(temp.home, ".workbuddy/user-test-personal/MEMORY.md", workBuddyMemory);
    configure(db);

    const fake = fakeProvider(
      JSON.stringify({
        entries: [
          { text: "使用中文回答" },
          { text: "改完先跑测试" },
          { text: "不要自动提交" },
        ],
        conflicts: [{ topic: "默认语言", options: ["中文", "英文"], question: "默认用哪种语言？" }],
      }),
    );
    const result = await runTidy(db, temp.env, { provider: fake.provider });
    expect(result).toMatchObject({ ran: true, entries: 3, conflicts: 1, written: 9 });
    expect(fake.calls).toHaveLength(1);

    // 只新增标记块，原文保留
    expect(read(temp.home, ".qoder/memory/a.md")).toBe(qoderMemory);
    expect(read(temp.home, ".qoder/memory/MEMORY.md")).toContain("- [Qoder 偏好](a.md)");
    expect(read(temp.home, ".qoder/memory/MEMORY.md")).toContain("memrelay-preferences.md");
    expect(read(temp.home, ".qoder/memory/memrelay-preferences.md")).toContain(TIDY_BLOCK_BEGIN);
    expect(read(temp.home, ".codex/AGENTS.md")).toContain("# 全局 Codex 指令");
    expect(read(temp.home, ".codex/AGENTS.md")).toContain(TIDY_BLOCK_BEGIN);
    expect(read(temp.home, ".claude/CLAUDE.md")).toContain(TIDY_BLOCK_BEGIN);
    // Trae：旧 memory 块被迁走，新规则文件落在 user_rules/
    expect(fs.existsSync(path.join(temp.home, ".trae-cn/memory/user_profile.md"))).toBe(false);
    expect(read(temp.home, ".trae-cn/user_rules/memrelay.md")).toContain(TIDY_BLOCK_BEGIN);
    expect(read(temp.home, ".zcode/AGENTS.md")).toContain(TIDY_BLOCK_BEGIN);
    expect(read(temp.home, ".config/opencode/AGENTS.md")).toContain(TIDY_BLOCK_BEGIN);
    expect(read(temp.home, ".dsh/AGENTS.md")).toContain(TIDY_BLOCK_BEGIN);
    // WorkBuddy 全局记忆：动态发现 user-*-personal/MEMORY.md
    expect(read(temp.home, ".workbuddy/user-test-personal/MEMORY.md")).toContain(TIDY_BLOCK_BEGIN);
    expect(read(temp.home, ".workbuddy/user-test-personal/MEMORY.md")).toContain("用户姓名：张三");
    // 模型看到的素材不含绝对路径，且内容已脱敏（此处仅验证路径未出现）
    expect(fake.calls[0]).not.toContain(temp.home);

    const status = tidyStatus(db);
    expect(status.plan?.status).toBe("conflict");
    expect(status.plan?.conflicts).toHaveLength(1);
    expect(status.exports).toHaveLength(9);
    // qoder/a.md + qoder/env.md + codex + zcode + opencode + dsh + workbuddy
    expect(status.sources).toHaveLength(7);
    expect(status.sources.some((source) => source.path.endsWith("env.md"))).toBe(true);
    expect(status.sources.some((source) => source.path.endsWith("profile.md"))).toBe(false);
    expect(status.sources.some((source) => source.path.includes("user-test-personal"))).toBe(true);

    // 源未变化：零请求跳过
    const second = fakeProvider("{}");
    const skipped = await runTidy(db, temp.env, { provider: second.provider });
    expect(skipped).toMatchObject({ ran: false, skipped: "unchanged" });
    expect(second.calls).toHaveLength(0);

    // 提示词版本变化：来源没变也强制重跑
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('tidy.promptVersion', '0')").run();
    const forced = fakeProvider(JSON.stringify({ entries: [{ text: "使用中文回答" }], conflicts: [] }));
    const forcedRun = await runTidy(db, temp.env, { provider: forced.provider });
    expect(forcedRun).toMatchObject({ ran: true, entries: 1 });
    expect(forced.calls).toHaveLength(1);

    // 撤销：删除本功能文件与标记块，原文恢复
    const undone = undoTidy(db, temp.env);
    expect(undone.removed).toHaveLength(9);
    expect(fs.existsSync(path.join(temp.home, ".qoder/memory/memrelay-preferences.md"))).toBe(false);
    expect(fs.existsSync(path.join(temp.home, ".claude/CLAUDE.md"))).toBe(false);
    expect(fs.existsSync(path.join(temp.home, ".trae-cn/user_rules/memrelay.md"))).toBe(false);
    expect(read(temp.home, ".qoder/memory/MEMORY.md")).toBe(qoderIndex);
    expect(read(temp.home, ".codex/AGENTS.md")).toBe(codexAgents);
    expect(read(temp.home, ".zcode/AGENTS.md")).toBe(zcodeAgents);
    expect(read(temp.home, ".config/opencode/AGENTS.md")).toBe(opencodeAgents);
    expect(read(temp.home, ".dsh/AGENTS.md")).toBe(dshAgents);
    expect(read(temp.home, ".workbuddy/user-test-personal/MEMORY.md")).toBe(workBuddyMemory);
    expect(read(temp.home, ".qoder/memory/a.md")).toBe(qoderMemory);
    expect(tidyStatus(db).exports).toHaveLength(0);
  });

  it("撤销时不删除用户后来追加的内容", async () => {
    const temp = makeTempHome();
    cleanups.push(temp.cleanup);
    const db = openWritable(temp.env);
    cleanups.push(() => db.close());
    write(temp.home, ".qoder/memory/a.md", "# 偏好\n- 使用中文回答\n");
    configure(db);
    const fake = fakeProvider(JSON.stringify({ entries: [{ text: "使用中文回答" }], conflicts: [] }));
    await runTidy(db, temp.env, { provider: fake.provider });

    const claudeFile = path.join(temp.home, ".claude/CLAUDE.md");
    expect(fs.existsSync(claudeFile)).toBe(true);
    fs.appendFileSync(claudeFile, "\n- 用户自己的规则\n", "utf8");

    undoTidy(db, temp.env);
    expect(fs.existsSync(claudeFile)).toBe(true);
    const rest = fs.readFileSync(claudeFile, "utf8");
    expect(rest).not.toContain(TIDY_BLOCK_BEGIN);
    expect(rest).toContain("- 用户自己的规则");
  });

  it("写入失败时计划标记 error，可手动重新下发", () => {
    const temp = makeTempHome();
    cleanups.push(temp.cleanup);
    const db = openWritable(temp.env);
    cleanups.push(() => db.close());
    writeTidyPlan(db, {
      status: "ready",
      content: "- 使用中文回答",
      conflicts: [],
      inputs: {},
      model: "m",
      host: "h",
    });
    // 让 .claude 变成普通文件，apply 创建 .claude/CLAUDE.md 时失败
    fs.writeFileSync(path.join(temp.home, ".claude"), "not a dir", "utf8");

    const result = applyExistingTidyPlan(db, temp.env);
    expect(result.error).toBeTruthy();
    expect(readTidyPlan(db)?.status).toBe("error");
  });

  it("未启用/未配置时不产生任何请求", async () => {
    const temp = makeTempHome();
    cleanups.push(temp.cleanup);
    const db = openWritable(temp.env);
    cleanups.push(() => db.close());
    const fake = fakeProvider("{}");
    expect(await runTidy(db, temp.env, { provider: fake.provider })).toBeUndefined();
    expect(fake.calls).toHaveLength(0);
  });
});
