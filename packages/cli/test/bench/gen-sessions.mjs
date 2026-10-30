// 迭代 3 的验收基准：生成 35 个会话（约 6MB）用于 resume 计时。
// 用法：node test/bench/gen-sessions.mjs <假 HOME 路径> <项目路径>
// 然后：MEMRELAY_HOME=<HOME>/.memrelay 下跑 doctor 建索引 → time resume "关键词"
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = process.argv[2];
const proj = process.argv[3];
const slug = proj.replace(/[\\/]+$/, "").replace(/[^A-Za-z0-9]/g, "-").replace(/^-+/, "").toLowerCase();
const dir = path.join(home, ".qoder", "projects", slug);
fs.mkdirSync(dir, { recursive: true });
const past = new Date(Date.now() - 30 * 60 * 1000);
past.setMilliseconds(0);
for (let i = 0; i < 35; i++) {
  const sid = `e${String(i).padStart(7, "0")}-0000-4000-8000-0000000000${String(i % 10)}0`;
  const lines = [];
  lines.push(JSON.stringify({ type: "workspace-directories", sessionId: sid, directories: [proj] }));
  lines.push(
    JSON.stringify({
      type: "user",
      uuid: `e${i}000000-0000-4000-8000-000000000001`,
      timestamp: "2026-10-13T02:00:00.000Z",
      message: { role: "user", content: [{ type: "text", text: `第 ${i} 个任务：做一个官网模块 ${i}` }] },
      sessionId: sid,
      cwd: proj,
    }),
  );
  for (let m = 0; m < 60; m++) {
    lines.push(
      JSON.stringify({
        type: "assistant",
        uuid: `e${i}${String(m).padStart(6, "0")}-0000-4000-8000-000000000010`,
        timestamp: "2026-10-13T02:01:00.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: `进展 ${i}-${m}：` + "项目内容填充细节说明文档段落".repeat(60) }],
        },
        sessionId: sid,
        cwd: proj,
      }),
    );
    lines.push(
      JSON.stringify({
        type: "user",
        uuid: `e${i}${String(m).padStart(6, "0")}-0000-4000-8000-000000000020`,
        timestamp: "2026-10-13T02:02:00.000Z",
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: `call_${i}_${m}`, content: "ok" }] },
        sessionId: sid,
        cwd: proj,
      }),
    );
  }
  lines.push(
    JSON.stringify({
      type: "assistant",
      uuid: `e${i}999999-0000-4000-8000-000000000030`,
      timestamp: "2026-10-13T02:03:00.000Z",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "继续做下一个模块。" },
          { type: "tool_use", id: `call_${i}_pend`, name: "Read", input: { file_path: proj + "/src/mod.ts" } },
        ],
      },
      sessionId: sid,
      cwd: proj,
    }),
  );
  const file = path.join(dir, `${sid}.jsonl`);
  fs.writeFileSync(file, lines.join("\n") + "\n", "utf8");
  fs.utimesSync(file, past, past);
}
console.log(`written 35 sessions to ${dir}`);
