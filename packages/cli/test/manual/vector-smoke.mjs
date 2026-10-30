// 真机冒烟：向量回填/搜索全链路。用法（仓库根目录）：
//   node packages/cli/test/manual/vector-smoke.mjs
// 只读复制 ~/.memrelay/memrelay.db 到临时目录操作；起本地伪 /embeddings 服务（不出网），
// 跑 embed 回填两轮（幂等）、embed --status、search（含纯语义关键词）。
// 注意：子进程必须异步 spawn——spawnSync 会阻塞父进程事件循环，伪嵌入服务就答复不了请求。
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const REPO = path.resolve(import.meta.dirname, "..", "..", "..", "..");
const CLI = path.join(REPO, "packages", "cli", "dist", "cli.mjs");
if (!fs.existsSync(CLI)) {
  console.error(`先构建：pnpm build（缺少 ${CLI}）`);
  process.exit(2);
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "memrelay-smoke-"));
const MR = path.join(TMP, "memrelay");
fs.mkdirSync(MR, { recursive: true });
const realDir = path.join(os.homedir(), ".memrelay");
for (const f of ["memrelay.db", "memrelay.db-wal", "memrelay.db-shm"]) {
  const src = path.join(realDir, f);
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(MR, f)); // 只读复制
}

// 伪嵌入：按文本哈希给确定性单位向量（离线、可复现）
function vecFor(text) {
  const h = crypto.createHash("sha256").update(text).digest();
  const x = (h[0] / 255) * 2 - 1;
  const y = (h[1] / 255) * 2 - 1;
  const z = (h[2] / 255) * 2 - 1;
  const n = Math.hypot(x, y, z) || 1;
  return [x / n, y / n, z / n];
}
let calls = 0;
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    calls++;
    let inputs = [];
    try {
      inputs = JSON.parse(body).input ?? [];
    } catch {
      /* 空请求 */
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ data: inputs.map((t, i) => ({ index: i, embedding: vecFor(t) })) }));
  });
});
await new Promise((resolve) => server.listen(39111, "127.0.0.1", resolve));

{
  const db = new DatabaseSync(path.join(MR, "memrelay.db"));
  const version = db.prepare("PRAGMA user_version").get().user_version;
  const sessions = db.prepare("SELECT COUNT(*) AS n FROM sessions").get().n;
  console.log(`[smoke] 库副本：user_version=${version}，会话 ${sessions} 个，临时目录 ${TMP}`);
  for (const [key, value] of Object.entries({
    "embed.enabled": "1",
    "embed.model": "smoke-embed",
    "embed.baseUrl": "http://127.0.0.1:39111/v1",
    "embed.apiKey": "k",
  })) {
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(key, value);
  }
  db.close();
}

function cli(args) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: REPO,
      env: { ...process.env, MEMRELAY_HOME: MR },
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => {
      console.log(`\n=== memrelay ${args.join(" ")}（exit ${code}，${Date.now() - started}ms）===`);
      console.log(out.trim().slice(0, 2800));
      if (err.trim()) console.log("[stderr]", err.trim().slice(0, 800));
      resolve(out);
    });
  });
}

await cli(["embed", "--status"]);
const first = await cli(["embed"]);
console.log(`\n[smoke] 回填期间伪嵌入服务收到 ${calls} 次请求`);
const second = await cli(["embed"]);
await cli(["embed", "--status"]);
await cli(["search", "zzz-nonexistent-terminal-9f3a"]);
await cli(["search", "登录页"]);

server.close();
for (const match of [first, second]) {
  const m = match.match(/回填完成：嵌入 (\d+) 个会话、未变化跳过 (\d+) 个、失败 (\d+) 个、剩余 (\d+) 个/);
  console.log("[smoke] 回填汇总:", m ? m.slice(1).join(" / ") : "（未匹配）");
}
console.log("（临时目录未清理，方便翻查；不需要时手动删除。）");
