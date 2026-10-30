#!/usr/bin/env node
/*
 * 入口程序（bin/memrelay.cjs）的端到端测试：
 * 1. 当前 Node 可用时直接启动 CLI（ping）；
 * 2. runtime.json 记录的 Node 失效时回退 PATH；
 * 3. CLI 包不存在时给出英文说明并以 2 退出。
 * 用法：node test/e2e/bootstrap.mjs
 */
import assert from "node:assert";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..", "..");
const bin = path.join(root, "bin", "memrelay.cjs");
const cli = path.join(root, "dist", "cli.mjs");

if (!fs.existsSync(cli)) {
  console.error("dist/cli.mjs 不存在——先运行 pnpm build");
  process.exit(1);
}

function runEntry(args, env = {}) {
  return spawnSync(process.execPath, [bin, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: 60000,
  });
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "memrelay-bootstrap-"));
}

// 1. 正常运行
{
  const home = tempDir();
  const result = runEntry(["ping"], { MEMRELAY_TEST_HOME: home, MEMRELAY_HOME: path.join(home, ".memrelay") });
  assert.strictEqual(result.status, 0, `expected status 0, got ${result.status}: ${result.stderr}`);
  assert.match(result.stdout, /MEMRELAY-OK /, `unexpected stdout: ${result.stdout}`);
  fs.rmSync(home, { recursive: true, force: true });
  console.log("✓ 正常启动");
}

// 2. runtime.json 指向失效的 Node，应回退 PATH
{
  const home = tempDir();
  const memrelayHome = path.join(home, ".memrelay");
  fs.mkdirSync(memrelayHome, { recursive: true });
  fs.writeFileSync(
    path.join(memrelayHome, "runtime.json"),
    JSON.stringify({ node: path.join(home, "missing-node.exe"), nodeReal: path.join(home, "missing-node.exe") }),
  );
  const result = runEntry(["ping"], { MEMRELAY_TEST_HOME: home, MEMRELAY_HOME: memrelayHome });
  assert.strictEqual(result.status, 0, `expected status 0, got ${result.status}: ${result.stderr}`);
  assert.match(result.stdout, /MEMRELAY-OK /);
  fs.rmSync(home, { recursive: true, force: true });
  console.log("✓ runtime.json 失效时回退 PATH");
}

// 3. CLI 包不存在
{
  const home = tempDir();
  const memrelayHome = path.join(home, ".memrelay");
  fs.mkdirSync(memrelayHome, { recursive: true });
  const brokenRoot = tempDir();
  fs.mkdirSync(path.join(brokenRoot, "bin"), { recursive: true });
  fs.copyFileSync(bin, path.join(brokenRoot, "bin", "memrelay.cjs"));
  const result = spawnSync(process.execPath, [path.join(brokenRoot, "bin", "memrelay.cjs"), "ping"], {
    encoding: "utf8",
    env: { ...process.env, MEMRELAY_TEST_HOME: home, MEMRELAY_HOME: memrelayHome },
    timeout: 60000,
  });
  assert.strictEqual(result.status, 2, `expected status 2, got ${result.status}`);
  assert.match(result.stderr, /CLI bundle not found/);
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(brokenRoot, { recursive: true, force: true });
  console.log("✓ 包缺失时给出英文说明并退出码 2");
}

console.log("bootstrap e2e 全部通过");
