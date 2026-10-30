import { describe, expect, it } from "vitest";

import { MULTI_RECENT_WINDOW_MS, selectSession, type RankedSession } from "../src/resume/select.js";
import type { SessionStatus } from "../src/core/types.js";

function makeRanked(
  id: string,
  ageMin: number,
  status: SessionStatus,
  over: Partial<RankedSession> = {},
): RankedSession {
  const now = Date.now();
  return {
    scan: {
      id,
      agent: "qoder",
      sourcePath: `C:/tmp/${id}.jsonl`,
      mtimeMs: now - ageMin * 60_000,
      sizeBytes: 1024,
      tail: {
        statusInfo: {
          pendingToolCallIds: [],
          lastUserMessageUnanswered: false,
          quotaOrLimitDetected: false,
          errorDetected: false,
        },
        hasActiveLeaf: false,
        memrelayCalledRecently: false,
      },
    },
    keyword: 0,
    timeScore: 0,
    fileOverlap: 0,
    interruptedBonus: 0,
    total: 0,
    status,
    hasContent: true,
    isCaller: false,
    ...over,
  };
}

describe("无关键词时的选择", () => {
  it("只有一个中断会话 → 直接接它", () => {
    const ranked = [makeRanked("a", 30, "interrupted")];
    const result = selectSession(ranked, "");
    expect(result.mode).toBe("single");
    expect(result.chosen!.scan.id).toBe("a");
  });

  it("两个都在最近 2 小时内中断 → 出菜单让用户挑", () => {
    const ranked = [
      makeRanked("newer", 20, "interrupted"),
      makeRanked("older", 90, "interrupted"),
    ];
    const result = selectSession(ranked, "");
    expect(result.mode).toBe("menu");
    expect(result.menuReason).toBe("multi-recent");
    // 菜单按时间倒序
    expect(result.ranked.map((r) => r.scan.id)).toEqual(["newer", "older"]);
  });

  it("第二近的已经过时（超过 2 小时）→ 直接接最近的", () => {
    const ranked = [
      makeRanked("recent", 30, "interrupted"),
      makeRanked("stale", 300, "interrupted"),
    ];
    const result = selectSession(ranked, "");
    expect(result.mode).toBe("single");
    expect(result.chosen!.scan.id).toBe("recent");
  });

  it("恰好落在窗口边界内 → 出菜单", () => {
    const justInside = (MULTI_RECENT_WINDOW_MS - 60_000) / 60_000;
    const ranked = [
      makeRanked("a", 10, "interrupted"),
      makeRanked("b", justInside, "interrupted"),
    ];
    expect(selectSession(ranked, "").mode).toBe("menu");
  });

  it("完成状态的会话不参与最近中断的比较", () => {
    const ranked = [
      makeRanked("done-mid", 20, "done"),
      makeRanked("interrupted", 120, "interrupted"),
    ];
    const result = selectSession(ranked, "");
    expect(result.mode).toBe("single");
    expect(result.chosen!.scan.id).toBe("interrupted");
  });
});

describe("关键词不唯一", () => {
  it("命中接近 → 出菜单（ambiguous-keyword）", () => {
    const ranked = [
      makeRanked("a", 20, "interrupted", { keyword: 1, total: 2 }),
      makeRanked("b", 30, "interrupted", { keyword: 1, total: 1.9 }),
    ];
    const result = selectSession(ranked, "官网");
    expect(result.mode).toBe("menu");
    expect(result.menuReason).toBe("ambiguous-keyword");
  });

  it("第一名明显领先 → 直接给续接内容", () => {
    const ranked = [
      makeRanked("a", 20, "interrupted", { keyword: 1, total: 3 }),
      makeRanked("b", 200, "interrupted", { keyword: 0.2, total: 0.5 }),
    ];
    const result = selectSession(ranked, "官网");
    expect(result.mode).toBe("confident");
    expect(result.chosen!.scan.id).toBe("a");
  });
});
