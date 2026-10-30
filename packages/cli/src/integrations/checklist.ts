import readline from "node:readline";

export interface CheckItem {
  id: string;
  /** 显示名，例如 "Claude Code（Skill + 启动提示）" */
  label: string;
  checked: boolean;
}

export interface ChecklistState {
  items: CheckItem[];
  cursor: number;
  /** 输入有误时的提示行（如"至少要勾选一个工具"） */
  hint?: string;
}

export function initialState(items: CheckItem[]): ChecklistState {
  return { items: items.map((i) => ({ ...i })), cursor: 0 };
}

export interface KeyLike {
  name?: string;
  sequence?: string;
  ctrl?: boolean;
}

export type ChecklistAction = "none" | "submit" | "cancel";

/** 纯状态机：便于单测。上下移动、空格切换、回车提交（至少勾一个）、Ctrl+C 取消。 */
export function reduceKey(state: ChecklistState, key: KeyLike): { state: ChecklistState; action: ChecklistAction } {
  const items = state.items.map((i) => ({ ...i }));
  let cursor = state.cursor;
  let hint: string | undefined;

  if (key.ctrl && key.name === "c") {
    return { state: { ...state, hint: undefined }, action: "cancel" };
  }
  switch (key.name) {
    case "up":
    case "k":
      cursor = (cursor - 1 + items.length) % items.length;
      break;
    case "down":
    case "j":
      cursor = (cursor + 1) % items.length;
      break;
    case "space":
      items[cursor]!.checked = !items[cursor]!.checked;
      break;
    case "a":
      // 全选/全不选
      const allChecked = items.every((i) => i.checked);
      for (const i of items) i.checked = !allChecked;
      break;
    case "return":
    case "enter": {
      if (items.every((i) => !i.checked)) {
        hint = "至少要勾选一个工具（空格勾选，Ctrl+C 取消）";
        return { state: { items, cursor, hint }, action: "none" };
      }
      return { state: { items, cursor, hint: undefined }, action: "submit" };
    }
    default:
      break;
  }
  return { state: { items, cursor, hint }, action: "none" };
}

/** 渲染为多行文本（不含 ANSI）。 */
export function renderChecklist(state: ChecklistState): string[] {
  const lines: string[] = ["请选择要接入的工具（↑/↓ 移动 · 空格勾选 · a 全选/全不选 · 回车确认）："];
  state.items.forEach((item, index) => {
    const pointer = index === state.cursor ? ">" : " ";
    lines.push(`${pointer} [${item.checked ? "x" : " "}] ${item.label}`);
  });
  if (state.hint) lines.push(`  ⚠ ${state.hint}`);
  return lines;
}

/**
 * 交互式勾选列表。只应在 stdin 是 TTY 时调用。
 * 返回勾选结果；用户按 Ctrl+C 取消时返回 undefined。
 */
export async function runChecklist(items: CheckItem[]): Promise<CheckItem[] | undefined> {
  let state = initialState(items);
  const stdout = process.stdout;
  const stdin = process.stdin;

  let renderedLines = 0;
  const draw = () => {
    if (renderedLines > 0) {
      stdout.write(`\x1b[${renderedLines}A`);
    }
    const lines = renderChecklist(state);
    for (const line of lines) {
      stdout.write(`\x1b[2K${line}\n`);
    }
    // 清掉上一次可能多出来的行
    for (let i = lines.length; i < renderedLines; i++) {
      stdout.write("\x1b[2K\n");
    }
    if (renderedLines > lines.length) {
      stdout.write(`\x1b[${renderedLines - lines.length}A`);
    }
    renderedLines = lines.length;
  };

  readline.emitKeypressEvents(stdin);
  if (stdin.isTTY) stdin.setRawMode(true);
  draw();

  return await new Promise<CheckItem[] | undefined>((resolve) => {
    const onKey = (_str: string | undefined, key: KeyLike | undefined) => {
      if (!key) return;
      const { state: next, action } = reduceKey(state, key);
      state = next;
      if (action === "submit") {
        cleanup();
        resolve(state.items);
        return;
      }
      if (action === "cancel") {
        cleanup();
        resolve(undefined);
        return;
      }
      draw();
    };
    const cleanup = () => {
      stdin.removeListener("keypress", onKey);
      if (stdin.isTTY) stdin.setRawMode(false);
      stdin.pause();
    };
    stdin.on("keypress", onKey);
    stdin.resume();
  });
}
