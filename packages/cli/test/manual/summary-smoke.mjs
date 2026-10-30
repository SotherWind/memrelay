// 真机冒烟：会话摘要全链路。用法（仓库根目录）：
//   node packages/cli/test/manual/summary-smoke.mjs
// 只读复制 ~/.memrelay/memrelay.db 到临时目录操作；起本地伪 /chat/completions 服务（不出网），
// 跑 summarize 两轮（幂等）、--status、resume 与 search（验证消费点带摘要）。
// 注意：子进程必须异步 spawn——spawnSync 会阻塞父进程事件循环，伪服务就答复不了请求。
import { spawn } from "node:child_process";
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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "memrelay-summary-smoke-"));
const MR = path.join(TMP, "memrelay");
fs.mkdirSync(MR, { recursive: true });
const realDir = path.join(os.homedir(), ".memrelay");
for (const f of ["memrelay.db", "memrelay.db-wal", "memrelay.db-shm"]) {
  const src = path.join(realDir, f);
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(MR, f)); // 只读复制
}

let calls = 0;
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    calls++;
    let hint = "";
    try {
      const parsed = JSON.parse(body);
      hint = String(parsed.messages?.[1]?.content ?? "").replace(/\s+/g, " ").slice(0, 60);
    } catch {
      /* 空请求 */
    }
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        choices: [{ message: { content: `会话摘要冒烟 #${calls}：围绕「${hint}…」在推进，下一步继续落实。` } }],
      }),
    );
  });
});
await new Promise((resolve) => server.listen(39112, "127.0.0.1", resolve));

{
  const db = new DatabaseSync(path.join(MR, "memrelay.db"));
  const version = db.prepare("PRAGMA user_version").get().user_version;
  const sessions = db.prepare("SELECT COUNT(*) AS n FROM sessions").get().n;
  console.log(`[smoke] 库副本：user_version=${version}，会话 ${sessions} 个，临时目录 ${TMP}`);
  for (const [key, value] of Object.entries({
    "summary.enabled": "1",
    "summary.model": "summary-smoke",
    "summary.baseUrl": "http://127.0.0.1:39112/v1",
    "summary.apiKey": "k",
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
      console.log(out.trim().slice(0, 2200));
      if (err.trim()) console.log("[stderr]", err.trim().slice(0, 600));
      resolve(out);
    });
  });
}

const first = await cli(["summarize"]);
console.log(`\n[smoke] 生成期间伪对话服务收到 ${calls} 次请求`);
const callsAfterFirst = calls;
const second = await cli(["summarize"]);
console.log(`[smoke] 二轮后端调用增量：${calls - callsAfterFirst}（幂等应为 0）`);
await cli(["summarize", "--status"]);
await cli(["search", "登录页"]);
await cli(["resume", "登录页"]);

server.close();
for (const [label, out] of [
  ["首轮", first],
  ["二轮", second],
]) {
  const m = out.match(/生成完成：摘要 (\d+) 个会话、未变化跳过 (\d+) 个、失败 (\d+) 个、剩余 (\d+) 个/);
  console.log(`[smoke] ${label}汇总:`, m ? m.slice(1).join(" / ") : "（未匹配）");
}
console.log("（临时目录未清理，方便翻查；不需要时手动删除。）");
