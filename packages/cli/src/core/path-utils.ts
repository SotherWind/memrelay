import path from "node:path";

const WINDOWS_ABSOLUTE = /^[A-Za-z]:[\\/]/;

/** 会话文件可能记录了另一台 Windows 机器的路径；POSIX 上 path.resolve 会把它拼成当前目录下的相对路径。 */
export function isWindowsAbsolutePath(p: string): boolean {
  return WINDOWS_ABSOLUTE.test(p);
}

export function resolvePathOnAnyPlatform(p: string): string {
  return isWindowsAbsolutePath(p) ? p : path.resolve(p);
}

export function normalizePathForCompare(p: string, platform: NodeJS.Platform): string {
  let out = resolvePathOnAnyPlatform(p).replace(/[\\/]+/g, "/").replace(/\/+$/, "");
  if (platform === "win32") out = out.toLowerCase();
  return out;
}
