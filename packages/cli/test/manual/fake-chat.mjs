// 本地伪 /chat/completions 服务（冒烟/界面实测用，不出网）：
//   node packages/cli/test/manual/fake-chat.mjs [端口]
// Ctrl+C 退出；返回确定性的短摘要，便于观察摘要展示效果。
import http from "node:http";

const port = Number(process.argv[2] ?? 39112);
let calls = 0;
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    calls++;
    let hint = "";
    try {
      const parsed = JSON.parse(body);
      hint = String(parsed.messages?.[1]?.content ?? "").replace(/\s+/g, " ").slice(0, 80);
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
server.listen(port, "127.0.0.1", () => {
  console.log(`fake chat listening on http://127.0.0.1:${port}/v1/chat/completions`);
});
