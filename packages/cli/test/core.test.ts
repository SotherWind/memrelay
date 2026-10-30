import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { cjkQueryTerms, keywordScore, splitCjkSegments } from "../src/core/cjk.js";
import { estimateTokens, truncateByTokens } from "../src/core/tokens.js";
import { containsSecrets, redactSecrets, SECRET_RULES_VERSION } from "../src/core/secrets.js";
import { EMPTY_FILTERS, loadFilters, saveFilters } from "../src/core/filters.js";
import { categorizeTool, extractFilePaths, isPlanTool } from "../src/core/tool-names.js";
import { projectSlug, projectSlugVariants, isPathInside } from "../src/adapters/jsonl-family/parser.js";
import { readJsonl } from "../src/adapters/jsonl-family/jsonl.js";
import { looksLikeContinuation } from "../src/resume/session-reader.js";

describe("中文相邻两字切分", () => {
  it("把连续中文切成两字组", () => {
    expect(splitCjkSegments("完成生成")).toEqual(["完成", "成生", "生成"]);
  });

  it("单字与奇数长度", () => {
    expect(splitCjkSegments("继续做")).toEqual(["继续", "续做"]);
    expect(splitCjkSegments("网")).toEqual(["网"]);
  });

  it("中英数混排", () => {
    const parts = splitCjkSegments("生成Home页面");
    expect(parts).toEqual(["生成", "H", "o", "m", "e", "页面"]);
    expect(parts).not.toContain("成H"); // 字母不与中文组合
  });

  it("查询词切分", () => {
    expect(cjkQueryTerms("继续完成")).toEqual(["继续", "续完", "完成"]);
    expect(cjkQueryTerms("fix login bug")).toEqual(["fix", "login", "bug"]);
  });

  it("关键词匹配度按命中比例", () => {
    expect(keywordScore("生成网站", "帮我生成一个公司网站")).toBeGreaterThan(0.5);
    expect(keywordScore("数据库", "帮我生成一个公司网站")).toBe(0);
  });

  it("英文按完整单词匹配，不拆成字母、不误命中子串", () => {
    expect(keywordScore("login", "please login now")).toBe(1);
    expect(keywordScore("login", "capital letter")).toBe(0);
    expect(keywordScore("api", "the capital city")).toBe(0);
  });
});

describe("token 估算", () => {
  it("一个汉字约 1 token，四个英文字符约 1 token", () => {
    expect(estimateTokens("中文四个字")).toBe(5);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
  });

  it("truncateByTokens 截断并报告被裁掉的量", () => {
    const text = "中".repeat(100);
    const { text: kept, truncatedTokens } = truncateByTokens(text, 30);
    expect(estimateTokens(kept)).toBeLessThanOrEqual(30);
    expect(truncatedTokens).toBeGreaterThanOrEqual(69);
    expect(kept.length).toBeLessThan(100);
  });

  it("预算内原样返回", () => {
    expect(truncateByTokens("短文本", 100)).toEqual({ text: "短文本", truncatedTokens: 0 });
  });
});

describe("密钥遮盖", () => {
  it("规则带版本号", () => {
    expect(SECRET_RULES_VERSION).toBeGreaterThanOrEqual(1);
  });

  it("遮盖 OpenAI / GitHub / AWS 密钥，保留可识别前缀", () => {
    const input =
      "key=sk-proj-abcdefghijklmnopqrstuvwxyz0123456789ABCDEF token=ghp_1234567890abcdefghijklmnopqrstuvwx aws=AKIAIOSFODNN7EXAMPLE";
    const { text, findings } = redactSecrets(input);
    expect(text).not.toContain("sk-proj-abcdefghijklmnopqrstuvwxyz0123456789ABCDEF");
    expect(text).not.toContain("ghp_1234567890abcdefghijklmnopqrstuvwx");
    expect(text).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(text).toContain("sk-");
    expect(text).toContain("ghp_");
    expect(findings.length).toBeGreaterThanOrEqual(3);
  });

  it("遮盖连接串里的密码", () => {
    const { text } = redactSecrets("DATABASE_URL=postgres://app:hunter2secret@db.internal:5432/prod");
    expect(text).not.toContain("hunter2secret");
    expect(text).toContain("postgres://app:***@");
  });

  it("遮盖 password= 赋值", () => {
    const { text } = redactSecrets('password = "MyLongSecret123"');
    expect(text).not.toContain("MyLongSecret123");
  });

  it("遮盖下划线命名的密钥；PWD 不当成口令", () => {
    const { text } = redactSecrets(
      "client_secret=abcdefghijklmnop access_token=zyxwvutsrqponmlk OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz PWD=/home/user/project",
    );
    expect(text).not.toContain("abcdefghijklmnop");
    expect(text).not.toContain("zyxwvutsrqponmlk");
    expect(text).not.toContain("sk-abcdefghijklmnopqrstuvwxyz");
    expect(text).toContain("PWD=/home/user/project");
  });

  it("遮盖 Stripe / Google / Basic / URL userinfo", () => {
    const googleKey = `AIza${"A".repeat(35)}`;
    const { text } = redactSecrets(
      `sk_live_abcdefghijklmnop1234 ${googleKey} Basic YWxhZGRpbjpvcGVuc2VzYW1l https://user:supersecret@example.com/path`,
    );
    expect(text).not.toContain("sk_live_abcdefghijklmnop1234");
    expect(text).not.toContain(googleKey);
    expect(text).not.toContain("YWxhZGRpbjpvcGVuc2VzYW1l");
    expect(text).not.toContain("supersecret");
    expect(text).toContain("https://user:***@");
  });

  it("不碰普通文本", () => {
    const { text, findings } = redactSecrets("这是一个普通的说明文本，没有密钥。");
    expect(text).toBe("这是一个普通的说明文本，没有密钥。");
    expect(findings).toHaveLength(0);
  });

  it("containsSecrets 快速判断", () => {
    expect(containsSecrets("GITHUB_TOKEN=ghp_1234567890abcdefghijklmnopqrstuvwx")).toBe(true);
    expect(containsSecrets("hello world")).toBe(false);
  });
});

describe("工具名归类", () => {
  it("读写检索分类", () => {
    expect(categorizeTool("Read")).toBe("read");
    expect(categorizeTool("Grep")).toBe("search");
    expect(categorizeTool("Edit")).toBe("write");
    expect(categorizeTool("Write")).toBe("write");
    expect(categorizeTool("Bash")).toBe("shell");
    expect(categorizeTool("WebFetch")).toBe("web");
    expect(categorizeTool("SomethingElse")).toBe("other");
  });

  it("计划类工具", () => {
    expect(isPlanTool("TodoWrite")).toBe(true);
    expect(isPlanTool("update_plan")).toBe(true);
    expect(isPlanTool("TaskCreate")).toBe(true);
    expect(isPlanTool("Read")).toBe(false);
  });

  it("提取文件路径（含 edits 数组）", () => {
    expect(extractFilePaths({ file_path: "a.ts" })).toEqual(["a.ts"]);
    expect(
      extractFilePaths({ edits: [{ file_path: "a.ts" }, { file_path: "b.ts" }] }),
    ).toEqual(["a.ts", "b.ts"]);
  });
});

describe("项目路径编码", () => {
  it("Windows 路径编码规则：每个非字母数字字符各换成一个 -", () => {
    expect(projectSlug("D:\\webProject\\MemRelay")).toBe("D--webProject-MemRelay");
    expect(projectSlugVariants("D:\\webProject\\MemRelay")).toContain("d--webproject-memrelay");
  });

  it("同时覆盖 Qoder IDE 的合并横线变体", () => {
    expect(projectSlugVariants("D:\\webProject\\MemRelay")).toContain("d-webproject-memrelay");
  });

  it("POSIX 路径编码规则", () => {
    expect(projectSlug("/home/dev/projects/notes-app")).toBe("home-dev-projects-notes-app");
  });

  it("路径包含空格时也按非字母数字处理", () => {
    expect(projectSlug("C:\\Program Files\\Qoder IDE")).toBe("C--Program-Files-Qoder-IDE");
  });

  it("isPathInside 判断子目录", () => {
    expect(isPathInside("/a/b/c", "/a/b", "linux")).toBe(true);
    expect(isPathInside("/a/b", "/a/b", "linux")).toBe(true);
    expect(isPathInside("/a/bc", "/a/b", "linux")).toBe(false);
  });
});

describe("会话文件编码", () => {
  async function readAll(file: string): Promise<Array<Record<string, unknown>>> {
    const out: Array<Record<string, unknown>> = [];
    for await (const record of readJsonl(file)) out.push(record.value);
    return out;
  }

  it("UTF-8 BOM 与 UTF-16LE 都不会吞掉首行", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memrelay-encoding-"));
    try {
      const record = { type: "session_meta", payload: { id: "s1" } };
      const line = `${JSON.stringify(record)}\n`;
      const bomPath = path.join(dir, "bom.jsonl");
      const utf16Path = path.join(dir, "utf16.jsonl");
      fs.writeFileSync(bomPath, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(line)]));
      fs.writeFileSync(
        utf16Path,
        Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(line, "utf16le")]),
      );

      expect(await readAll(bomPath)).toEqual([record]);
      expect(await readAll(utf16Path)).toEqual([record]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("filters.json 损坏恢复", () => {
  it("主文件损坏时退回最近一次成功写入的副本", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "memrelay-filters-"));
    const env = { home, platform: process.platform, env: {} } as const;
    try {
      saveFilters(env, {
        ...EMPTY_FILTERS,
        excludedDirs: ["D:/webProject/secret"],
        deletedSessions: ["qoder:s1"],
      });
      fs.writeFileSync(path.join(home, ".memrelay", "filters.json"), "{ broken", "utf8");
      const loaded = loadFilters(env);
      expect(loaded.excludedDirs).toEqual(["D:/webProject/secret"]);
      expect(loaded.deletedSessions).toEqual(["qoder:s1"]);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("续接触发词", () => {
  it("英文按单词匹配，不把 discontinue/presume 当成续接", () => {
    expect(looksLikeContinuation("discontinue this")).toBe(false);
    expect(looksLikeContinuation("presume so")).toBe(false);
    expect(looksLikeContinuation("continue the task")).toBe(true);
    expect(looksLikeContinuation("继续完成登录页")).toBe(true);
  });
});
