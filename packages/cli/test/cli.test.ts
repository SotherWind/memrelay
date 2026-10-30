import { describe, expect, it } from "vitest";

import { main } from "../src/cli/index.js";

describe("CLI 参数错误", () => {
  it("未知参数按用法错误退出 1", async () => {
    expect(await main(["search", "x", "--nope"])).toBe(1);
  });

  it("--limit 非正整数退出 1", async () => {
    expect(await main(["search", "x", "--limit", "abc"])).toBe(1);
    expect(await main(["search", "x", "--limit", "0"])).toBe(1);
  });

  it("--from 非整数退出 1", async () => {
    expect(await main(["show", "qoder:x", "--from", "2.5"])).toBe(1);
  });
});
