import crypto from "node:crypto";

export function generateToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

/** 长度不同直接 false；等长时用恒定时间比较，避免时序侧信道。 */
export function tokensEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

const ALLOWED_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** Host 头只接受本机回环名（可带端口），防 DNS 重绑定。 */
export function hostAllowed(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  let host = hostHeader.trim().toLowerCase();
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    if (end < 0) return false;
    host = host.slice(0, end + 1);
  } else {
    const colon = host.indexOf(":");
    if (colon >= 0) host = host.slice(0, colon);
  }
  return ALLOWED_HOSTS.has(host);
}

/** 浏览器写请求必须来自本机同源；无 Origin（curl/测试）放行。 */
export function originAllowed(
  origin: string | undefined,
  hostHeader: string | undefined,
): boolean {
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    if (!hostAllowed(parsed.host)) return false;
    return hostHeader !== undefined && parsed.host.toLowerCase() === hostHeader.trim().toLowerCase();
  } catch {
    return false;
  }
}

export function tokenFromCookie(cookieHeader: string | undefined): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    if (name === "memrelay_token") {
      try {
        return decodeURIComponent(part.slice(eq + 1).trim());
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

export const TOKEN_COOKIE_NAME = "memrelay_token";
export const TOKEN_HEADER_NAME = "x-memrelay-token";
