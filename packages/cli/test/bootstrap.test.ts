import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

const BIN = path.resolve(process.cwd(), "bin", "memrelay.cjs");
const CLI = path.resolve(process.cwd(), "dist", "cli.mjs");
const hasBuild = fs.existsSync(CLI);

const isWindows = process.platform === "win32";
const fakeNodeName = isWindows ? "node.cmd" : "node";

/** 造一个假 node（版本号是假的），放进 PATH 最前面。 */
function makeFakeNode(dir: string, versionOutput = "v18.0.0"): string {
  const binDir = path.join(dir, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  const file = path.join(binDir, fakeNodeName);
  if (isWindows) {
    fs.writeFileSync(file, `@echo off\r\necho ${versionOutput}\r\n`);
  } else {
    fs.writeFileSync(file, `#!/bin/sh\necho ${versionOutput}\n`, { mode: 0o755 });
  }
  return binDir;
}

function runEntry(args: string[], env: Record<string, string>): { stdout: string; stderr: string; status: number } {
  try {
    const stdout = execFileSync(process.execPath, [BIN, ...args], {
      encoding: "utf8",
      env: { ...process.env, ...env },
      timeout: 60000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { stdout, stderr: "", status: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return { stdout: String(e.stdout ?? ""), stderr: String(e.stderr ?? ""), status: e.status ?? 1 };
  }
}

describe.skipIf(!hasBuild)("入口程序（bin/memrelay.cjs）", () => {
  it("当前 Node 可用时直接运行 CLI", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "memrelay-boot-"));
    cleanups.push(() => fs.rmSync(home, { recursive: true, force: true }));
    const result = runEntry(["ping"], {
      MEMRELAY_TEST_HOME: home,
      MEMRELAY_HOME: path.join(home, ".memrelay"),
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("MEMRELAY-OK");
  });

  it("runtime.json 失效、PATH 里是低版本时，继续从常见位置找到可用 Node", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "memrelay-boot-"));
    cleanups.push(() => fs.rmSync(home, { recursive: true, force: true }));
    const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), "memrelay-fakenode-"));
    cleanups.push(() => fs.rmSync(fakeDir, { recursive: true, force: true }));
    const fakeBin = makeFakeNode(fakeDir);

    const memrelayHome = path.join(home, ".memrelay");
    fs.mkdirSync(memrelayHome, { recursive: true });
    // runtime.json 指向失效路径，应回退到其它候选
    fs.writeFileSync(
      path.join(memrelayHome, "runtime.json"),
      JSON.stringify({ node: path.join(home, "missing.exe"), nodeReal: path.join(home, "missing.exe") }),
    );

    // PATH 最前面放低版本假 node，保留系统 PATH（where 等工具还在）
    const sep = isWindows ? ";" : ":";
    const pathValue = [fakeBin, path.dirname(process.execPath), process.env["PATH"] ?? ""].join(sep);
    const result = runEntry(["ping"], {
      MEMRELAY_TEST_HOME: home,
      MEMRELAY_HOME: memrelayHome,
      MEMRELAY_FAKE_NODE_VERSION: "18.0.0",
      PATH: pathValue,
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("MEMRELAY-OK");
  });

  it("找不到可用 Node 时打印纯英文说明并退出码 2", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "memrelay-boot-"));
    cleanups.push(() => fs.rmSync(home, { recursive: true, force: true }));
    const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), "memrelay-fakenode-"));
    cleanups.push(() => fs.rmSync(fakeDir, { recursive: true, force: true }));
    const fakeBin = makeFakeNode(fakeDir, "v16.20.0");
    const memrelayHome = path.join(home, ".memrelay");
    fs.mkdirSync(memrelayHome, { recursive: true });

    // runtime.json 指向失效路径；NVM_HOME 指到假目录，避免扫描到真实 nvm 安装
    fs.writeFileSync(
      path.join(memrelayHome, "runtime.json"),
      JSON.stringify({ node: path.join(home, "missing.exe") }),
    );
    const result = runEntry(["ping"], {
      MEMRELAY_TEST_HOME: home,
      MEMRELAY_HOME: memrelayHome,
      MEMRELAY_FAKE_NODE_VERSION: "16.20.0",
      MEMRELAY_BOOT_NO_SYSTEM: "1",
      PATH: fakeBin,
      NVM_SYMLINK_DIR: "-",
      NVM_DIR: fakeDir,
      NVM_HOME: fakeDir,
      APPDATA: fakeDir,
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("no suitable Node");
    expect(/[\u4e00-\u9fff]/.test(result.stderr)).toBe(false);
  });
});
