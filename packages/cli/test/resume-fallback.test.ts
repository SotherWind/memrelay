import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { runResume } from "../src/cli/commands/resume.js";
import { qoderAdapter } from "../src/adapters/qoder/index.js";
import { buildIndex } from "../src/store/indexer.js";
import {
  makeTempHome,
  qoderAssistantRec,
  qoderSessionDir,
  qoderUserRec,
  wholeSecondDate,
  writeJsonlFile,
  type TempHome,
} from "./helpers.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  while (cleanups.length) cleanups.pop()!();
});

function setupOtherProject(): { temp: TempHome; project: string; sid: string; cwd: string } {
  const temp = makeTempHome();
  cleanups.push(temp.cleanup);
  const project = "D:\\Desktop\\test\\thunder-fighter";
  const sid = "ab130000-0000-4000-8000-000000000001";
  const file = path.join(qoderSessionDir(temp.home, project), `${sid}.jsonl`);
  writeJsonlFile(
    file,
    [
      qoderUserRec(sid, "ab130000-0000-4000-8000-000000000001", "继续完成雷霆战机的开发", project),
      qoderAssistantRec(
        sid,
        "ab130000-0000-4000-8000-000000000010",
        [{ type: "text", text: "先补 render 模块的测试，再跑类型检查。" }],
        project,
      ),
    ],
    wholeSecondDate(30),
  );
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "memrelay-nowhere-"));
  cleanups.push(() => fs.rmSync(cwd, { recursive: true, force: true }));
  return { temp, project, sid, cwd };
}

describe("resume 全库兜底（当前目录不是项目）", () => {
  it("当前目录没有会话时，按关键词到其它项目里找，并提示先 cd", async () => {
    const { temp, project, cwd } = setupOtherProject();
    await buildIndex(temp.env, { adapters: [qoderAdapter()] });
    vi.stubEnv("MEMRELAY_TEST_HOME", temp.home);
    vi.spyOn(process, "cwd").mockReturnValue(cwd);

    const outFile = path.join(temp.home, "resume-global.md");
    const code = await runResume(["--out", outFile, "雷霆战机"], () => {});
    const output = fs.readFileSync(outFile, "utf8");

    expect(code).toBe(0);
    expect(output).not.toContain("当前目录没有找到 MemRelay 能读取的会话");
    expect(output).toContain("当前目录");
    expect(output).toContain("其他项目");
    expect(output).toContain(project);
  });

  it("全库也没有命中时，明确说明并给出下一步", async () => {
    const { temp, sid, cwd } = setupOtherProject();
    // 换掉会话里的关键词，避免命中
    const file = path.join(qoderSessionDir(temp.home, "D:\\Desktop\\test\\thunder-fighter"), `${sid}.jsonl`);
    writeJsonlFile(
      file,
      [
        qoderUserRec(sid, "ab130000-0000-4000-8000-000000000001", "做一个登录页", "D:\\Desktop\\test\\login-demo"),
        qoderAssistantRec(
          sid,
          "ab130000-0000-4000-8000-000000000010",
          [{ type: "text", text: "登录页已经开工。" }],
          "D:\\Desktop\\test\\login-demo",
        ),
      ],
      wholeSecondDate(30),
    );
    await buildIndex(temp.env, { adapters: [qoderAdapter()] });
    vi.stubEnv("MEMRELAY_TEST_HOME", temp.home);
    vi.spyOn(process, "cwd").mockReturnValue(cwd);

    const outFile = path.join(temp.home, "resume-none.md");
    const code = await runResume(["--out", outFile, "雷霆战机"], () => {});
    const output = fs.readFileSync(outFile, "utf8");

    expect(code).toBe(0);
    expect(output).toContain("全库也没有找到与关键词匹配的会话");
  });
});
