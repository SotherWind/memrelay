export interface TidyMaterial {
  tool: string;
  path: string;
  items: Array<{ heading: string | null; text: string }>;
}

export interface TidyConflict {
  topic: string;
  options: string[];
  question: string;
}

export interface TidyResult {
  entries: string[];
  conflicts: TidyConflict[];
}

/** 提示词版本：与 0.1.0 的发布线一致，统一为 v1。 */
export const TIDY_PROMPT_VERSION = 1;

/** 单次整理的输入上限：避免把整个记忆库一次性塞给模型。 */
export const TIDY_MAX_ITEMS = 300;
export const TIDY_MAX_ITEM_CHARS = 800;
const TIDY_MAX_INPUT_CHARS = 60_000;

export function buildTidyPrompt(materials: TidyMaterial[]): { system: string; user: string } {
  const sources: Array<{ tool: string; items: Array<{ heading: string | null; text: string }> }> = [];
  let budget = TIDY_MAX_INPUT_CHARS;
  let count = 0;
  for (const material of materials) {
    if (count >= TIDY_MAX_ITEMS || budget <= 0) break;
    const items: Array<{ heading: string | null; text: string }> = [];
    for (const item of material.items) {
      if (count >= TIDY_MAX_ITEMS || budget <= 0) break;
      const text = item.text.length > TIDY_MAX_ITEM_CHARS
        ? `${item.text.slice(0, TIDY_MAX_ITEM_CHARS)}…`
        : item.text;
      items.push({ heading: item.heading, text });
      budget -= text.length;
      count++;
    }
    if (items.length > 0) sources.push({ tool: material.tool, items });
  }

  const system = [
    "你是跨 AI 编程工具的偏好整理助手。输入是各工具全局记忆/规则中切出的条目。",
    "目标：合并成一份可以直接写进各工具全局规则文件的统一清单。",
    "输出两个部分：",
    "1. entries：已解决、可直接执行的长期规则。保留每一条独立约定；只合并同义或重复项；不要为了简洁删细节，不要编造；每条只表达一个规则；通常 20~60 条，每条不超过 160 字。",
    "2. conflicts：只有两条规则在同一情境下互斥、无法同时执行时才放这里。每个冲突只写一个决定；options 必须正好 2 个、互不相同、可直接选择；不要把无关规则、互补规则、历史沿革或同义重复放进 conflicts。",
    "丢弃：一次性事件（会议、分享、活动）、临时状态、项目进度、已完成计划。",
    "保留：跨工具的沟通语言、代码/UI/交付规范、工具链与环境约定。",
    "保持原文语言。只输出严格 JSON：",
    '{"entries":[{"text":"..."}],"conflicts":[{"topic":"...","options":["选项A","选项B"],"question":"..."}]}',
    '示例（正确的冲突）：{"topic":"默认回答语言","options":["始终使用中文","始终使用英文"],"question":"默认用哪种语言回答？"}',
    "反例（不要这样）：两个 option 内容相同；把“文档不要写临时状态”和“性能问题先量化”放进同一个 conflict。",
  ].join("\n");

  const user = JSON.stringify({ sources });
  return { system, user };
}

function stripFences(raw: string): string {
  const text = raw.trim();
  if (!text.startsWith("```")) return text;
  return text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
}

function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function parseTidyResult(raw: string): TidyResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripFences(raw));
  } catch {
    throw new Error("整理结果不是合法 JSON");
  }
  if (!parsed || typeof parsed !== "object") throw new Error("整理结果缺少 JSON 对象");
  const record = parsed as Record<string, unknown>;
  const rawEntries = Array.isArray(record["entries"]) ? record["entries"] : [];
  const entries: string[] = [];
  for (const item of rawEntries) {
    const text =
      typeof item === "string"
        ? item
        : item && typeof item === "object"
          ? String((item as { text?: unknown }).text ?? "")
          : "";
    const value = normalize(text);
    if (value.length < 3) continue;
    const clipped = value.length > 500 ? `${value.slice(0, 500)}…` : value;
    if (entries.some((entry) => entry.toLowerCase() === clipped.toLowerCase())) continue;
    entries.push(clipped);
    if (entries.length >= 200) break;
  }
  if (entries.length === 0) throw new Error("整理结果为空（模型没有给出可用的偏好条目）");

  const rawConflicts = Array.isArray(record["conflicts"]) ? record["conflicts"] : [];
  const conflicts: TidyConflict[] = [];
  for (const item of rawConflicts) {
    if (!item || typeof item !== "object") continue;
    const conflict = item as Record<string, unknown>;
    const topic = normalize(String(conflict["topic"] ?? "")).slice(0, 200);
    const question = normalize(String(conflict["question"] ?? "")).slice(0, 400);
    if (!topic && !question) continue;
    const options = Array.isArray(conflict["options"])
      ? conflict["options"].map((option) => normalize(String(option)).slice(0, 300)).filter(Boolean).slice(0, 6)
      : [];
    conflicts.push({ topic, options, question });
    if (conflicts.length >= 20) break;
  }
  return { entries, conflicts };
}
