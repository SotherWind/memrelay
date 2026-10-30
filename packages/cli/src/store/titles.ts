/**
 * 展示标题的启发式：任务名（AI/手动）优先；没有时从会话标题与首条指令里挑一个稳定的。
 * 纯函数、不碰库，供 indexer / server / names-store 共用。
 */

export const MAX_TITLE_CHARS = 80;
export const MAX_GENERATED_TITLE_CHARS = 40;

const CONTINUATION_PREFIX =
  /^继续\s*(?:执行|完成)?\s*(?:[a-z][a-z0-9-]*:\/\/threads\/)?[0-9a-f]{8}-[0-9a-f-]{20,}\s*(?:会话(?:中的任务)?)?[，,。.、\s]*/i;
const ACK_ONLY =
  /^(?:继续|接着|接着做|好|好的|可以|行|嗯|哦|收到|明白|没问题|开始吧|聊完了|执行完了|完了|搞定|结束|ok|okay|hello|hi|hey|你好|您好|嗨|哈喽|嘿嘿|哈哈)[\s!！。.、,，~～…👍]*$/i;

function stripAttachments(text: string): string {
  return text.replace(/附件引用：[\s\S]*$/, " ");
}

/** 清掉只用于显示/传输的噪声，保留任务原话。 */
export function cleanTitleText(text: string): string {
  return stripAttachments(
    text
      .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, " ")
      .replace(/<选中文本[^>]*>/g, " ")
      .replace(/<\/选中文本>/g, " ")
      .replace(/\[[^\]]*\]\(skill:\/\/[^)]*\)/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim();
}

export function stripContinuationPrefix(text: string): string {
  return text.replace(CONTINUATION_PREFIX, "").trim();
}

export function isContinuationMeta(text: string): boolean {
  return CONTINUATION_PREFIX.test(text);
}

export function isLowSignalTitle(text: string): boolean {
  const cleaned = cleanTitleText(text);
  if (!cleaned) return true;
  if (/^[\s\p{P}\p{S}]+$/u.test(cleaned)) return true;
  return ACK_ONLY.test(cleaned);
}

/** 列表标题：AI 名字 > 稳定标题/首条指令；Qoder 的 last-prompt 会漂移，优先首条指令。 */
export function displayTitle(opts: {
  agent: string;
  title: string | null | undefined;
  firstUser: string | null | undefined;
  generated?: string | null;
}): string | null {
  const generated = opts.generated?.trim();
  if (generated && !isLowSignalTitle(generated)) {
    return generated.slice(0, MAX_GENERATED_TITLE_CHARS);
  }

  const first = stripContinuationPrefix(cleanTitleText(opts.firstUser ?? ""));
  const title = cleanTitleText(opts.title ?? "");
  const candidates = opts.agent === "qoder" ? [first, title] : [title, first];
  for (const candidate of candidates) {
    if (candidate && !isLowSignalTitle(candidate)) return candidate.slice(0, MAX_TITLE_CHARS);
  }
  const fallback = first || title;
  return fallback ? fallback.slice(0, MAX_TITLE_CHARS) : null;
}
