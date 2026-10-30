import zlib from "node:zlib";

import type { DatabaseSync } from "node:sqlite";

import { sha256 } from "../core/hash.js";

export const MAX_INLINE_CHARS = 32 * 1024;
const HEAD_CHARS = 24 * 1024;
const TAIL_CHARS = 8 * 1024;

export interface PreparedText {
  /** 入库文本（超长时头尾各一段 + 省略标记） */
  text: string;
  truncated: boolean;
  /** 需要放进 blobs 的完整内容 */
  blobContent?: string;
}

/** 单个片段超过约 32 KB 时，库里只留开头和结尾各一段，中间换成省略标记。 */
export function prepareText(text: string | undefined): PreparedText {
  if (!text) return { text: "", truncated: false };
  if (text.length <= MAX_INLINE_CHARS) return { text, truncated: false };
  const head = text.slice(0, HEAD_CHARS);
  const tail = text.slice(text.length - TAIL_CHARS);
  const omitted = text.length - HEAD_CHARS - TAIL_CHARS;
  return {
    text: `${head}\n…[省略 ${omitted} 字符]…\n${tail}`,
    truncated: true,
    blobContent: text,
  };
}

/** 过长内容压缩后按内容哈希去重存进 blobs，返回 sha256。 */
export function storeBlob(db: DatabaseSync, content: string): string {
  const sha = sha256(content);
  const compressed = zlib.deflateSync(Buffer.from(content, "utf8"));
  db.prepare(
    "INSERT OR IGNORE INTO blobs (sha256, content, raw_size, created_at) VALUES (?, ?, ?, ?)",
  ).run(sha, compressed, content.length, new Date().toISOString());
  return sha;
}

export function loadBlob(db: DatabaseSync, sha: string): string | undefined {
  const row = db.prepare("SELECT content FROM blobs WHERE sha256 = ?").get(sha) as
    | { content: Uint8Array }
    | undefined;
  if (!row) return undefined;
  try {
    return zlib.inflateSync(Buffer.from(row.content)).toString("utf8");
  } catch {
    return undefined;
  }
}
