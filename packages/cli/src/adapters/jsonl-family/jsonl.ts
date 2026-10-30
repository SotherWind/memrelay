import fs from "node:fs";
import readline from "node:readline";

import { decodeBuffer, detectFileEncoding } from "../../core/text-encoding.js";

export interface JsonlRecord {
  line: number;
  value: Record<string, unknown>;
}

function readHeadBytes(filePath: string, bytes: number): Buffer {
  const fd = fs.openSync(filePath, "r");
  try {
    const buf = Buffer.alloc(bytes);
    const read = fs.readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, read);
  } finally {
    fs.closeSync(fd);
  }
}

function parseJsonlText(text: string, startLine = 0): JsonlRecord[] {
  const out: JsonlRecord[] = [];
  let line = startLine;
  for (const raw of text.split(/\r?\n/)) {
    line++;
    const value = safeParse(raw.trim());
    if (value) out.push({ line, value });
  }
  return out;
}

function safeParse(text: string): Record<string, unknown> | undefined {
  if (!text) return undefined;
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** 逐行读取 JSONL；最后一行不完整或解析失败时跳过该行，不报错。 */
export async function* readJsonl(
  filePath: string,
  opts?: { end?: number },
): AsyncGenerator<JsonlRecord> {
  const encoding = detectFileEncoding(readHeadBytes(filePath, 3));
  if (encoding === "utf16le" || encoding === "utf16be") {
    const text = decodeBuffer(fs.readFileSync(filePath));
    yield* parseJsonlText(text);
    return;
  }
  const start = encoding === "utf8-bom" ? 3 : 0;
  const stream = fs.createReadStream(filePath, {
    encoding: "utf8",
    start,
    end: opts?.end !== undefined ? opts.end - 1 : undefined,
  });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let line = 0;
  try {
    for await (const raw of rl) {
      const text = raw.trim();
      line++;
      if (!text) continue;
      const value = safeParse(text);
      if (value) yield { line, value };
    }
  } finally {
    rl.close();
    stream.destroy();
  }
}

export function readFileHead(filePath: string, bytes: number): string {
  return decodeBuffer(readHeadBytes(filePath, bytes));
}

export function readFileTail(filePath: string, bytes: number): string {
  const st = fs.statSync(filePath);
  const start = Math.max(0, st.size - bytes);
  const length = st.size - start;
  const fd = fs.openSync(filePath, "r");
  try {
    const buf = Buffer.alloc(length);
    const read = fs.readSync(fd, buf, 0, length, start);
    return decodeBuffer(buf.subarray(0, read));
  } finally {
    fs.closeSync(fd);
  }
}

/** 读文件末尾若干行（用于判断会话状态），容忍不完整的首行。 */
export function readLastJsonlRecords(filePath: string, maxBytes: number): Record<string, unknown>[] {
  let tail = readFileTail(filePath, maxBytes);
  const lines = tail.split(/\r?\n/).filter((l) => l.trim());
  const out: Record<string, unknown>[] = [];
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i]!.trim();
    if (!text) continue;
    try {
      const v = JSON.parse(text);
      if (v && typeof v === "object" && !Array.isArray(v)) out.push(v as Record<string, unknown>);
    } catch {
      /* 首行可能是被截断的，跳过 */
    }
  }
  return out;
}
