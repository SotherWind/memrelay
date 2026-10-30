import { describe, expect, it } from "vitest";

import {
  initialState,
  reduceKey,
  renderChecklist,
  type CheckItem,
} from "../src/integrations/checklist.js";

const items = (): CheckItem[] => [
  { id: "claude-code", label: "Claude Code（Skill + 启动提示）", checked: true },
  { id: "qoder", label: "Qoder（Skill）", checked: true },
  { id: "codex", label: "Codex（Skill）", checked: true },
];

describe("勾选列表（纯逻辑）", () => {
  it("默认全选，空格取消勾选/恢复", () => {
    let state = initialState(items());
    expect(state.items.every((i) => i.checked)).toBe(true);

    ({ state } = reduceKey(state, { name: "down" })); // 移到 Qoder
    ({ state } = reduceKey(state, { name: "space" }));
    expect(state.items[1]!.checked).toBe(false);

    ({ state } = reduceKey(state, { name: "space" }));
    expect(state.items[1]!.checked).toBe(true);
  });

  it("上下键循环移动", () => {
    let state = initialState(items());
    ({ state } = reduceKey(state, { name: "up" }));
    expect(state.cursor).toBe(2);
    ({ state } = reduceKey(state, { name: "down" }));
    expect(state.cursor).toBe(0);
  });

  it("a 键全选/全不选", () => {
    let state = initialState(items());
    ({ state } = reduceKey(state, { name: "space" })); // 取消一个
    ({ state } = reduceKey(state, { name: "a" })); // 此时不是全选 → 变全选
    expect(state.items.every((i) => i.checked)).toBe(true);
    ({ state } = reduceKey(state, { name: "a" }));
    expect(state.items.every((i) => !i.checked)).toBe(true);
  });

  it("至少要勾选一个：全不选时回车被拒绝并提示", () => {
    let state = initialState(items());
    ({ state } = reduceKey(state, { name: "a" })); // 全不选
    const result = reduceKey(state, { name: "return" });
    expect(result.action).toBe("none");
    expect(result.state.hint).toContain("至少要勾选一个");
    expect(renderChecklist(result.state).join("\n")).toContain("至少要勾选一个");
  });

  it("勾选后回车提交，返回当前勾选状态", () => {
    let state = initialState(items());
    ({ state } = reduceKey(state, { name: "down" }));
    ({ state } = reduceKey(state, { name: "space" })); // 取消 Qoder
    const result = reduceKey(state, { name: "enter" });
    expect(result.action).toBe("submit");
    expect(result.state.items.filter((i) => i.checked).map((i) => i.id)).toEqual([
      "claude-code",
      "codex",
    ]);
  });

  it("Ctrl+C 取消", () => {
    const state = initialState(items());
    const result = reduceKey(state, { name: "c", ctrl: true });
    expect(result.action).toBe("cancel");
  });

  it("渲染：指针指向当前行，状态用 [x]/[ ]", () => {
    const state = initialState(items());
    const lines = renderChecklist(state);
    expect(lines[0]).toContain("空格勾选");
    expect(lines[1]).toContain("> [x] Claude Code");
    expect(lines[2]).toContain("  [x] Qoder");
  });
});
