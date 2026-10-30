import crypto from "node:crypto";
import fs from "node:fs";

export function sha256(text: string): string {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

/** 读取整个文件做哈希（只在整文件重读时调用）。 */
export function sha256File(filePath: string): string {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}
