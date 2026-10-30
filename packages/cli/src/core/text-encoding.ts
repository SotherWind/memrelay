/**
 * 会话文件编码兜底：Windows 工具/脚本可能写入 UTF-8 BOM 或 UTF-16。
 * 统一在这里剥 BOM 并转成 JS 字符串，避免首行（往往是最关键的 session_meta）被 JSON.parse 吞掉。
 */
export function decodeBuffer(buf: Buffer): string {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return buf.subarray(3).toString("utf8");
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return buf.subarray(2).toString("utf16le");
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const body = buf.subarray(2);
    const swapped = Buffer.from(body);
    swapped.swap16();
    return swapped.toString("utf16le");
  }
  return buf.toString("utf8");
}

export type FileEncoding = "utf8" | "utf8-bom" | "utf16le" | "utf16be";

export function detectFileEncoding(buf: Buffer): FileEncoding {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return "utf8-bom";
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return "utf16le";
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return "utf16be";
  return "utf8";
}
