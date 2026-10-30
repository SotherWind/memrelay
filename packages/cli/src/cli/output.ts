import fs from "node:fs";
import path from "node:path";

export function writeOut(text: string, outFile?: string): void {
  if (outFile) {
    const resolved = path.resolve(outFile);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, text, "utf8");
    return;
  }
  process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
}

export function exitCodeFor(err: unknown): number {
  if (err && typeof err === "object" && "memrelayCode" in err) {
    const code = (err as { memrelayCode?: number }).memrelayCode;
    if (typeof code === "number") return code;
  }
  return 2;
}

export class UsageError extends Error {
  readonly memrelayCode = 1;
}

export class EnvironmentError extends Error {
  readonly memrelayCode = 2;
}
