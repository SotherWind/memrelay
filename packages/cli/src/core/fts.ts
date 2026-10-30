import { isCjkChar } from "./cjk.js";

/**
 * 把用户查询拆成两类：
 * - latin：英文/数字/代码词，走默认分词的 parts_fts
 * - cjk：连续中文切成相邻两字一组，走 parts_cjk_fts
 */
export function splitQuery(query: string): { latin: string[]; cjk: string[] } {
  const latin: string[] = [];
  const cjk: string[] = [];
  let latinRun = "";
  let cjkRun = "";

  const flushLatin = () => {
    if (!latinRun) return;
    // 去掉 FTS 语法里的引号/星号等，交给参数化转义
    const cleaned = latinRun.replace(/["*^:()\-]/g, "").trim();
    if (cleaned.length >= 1) latin.push(cleaned.toLowerCase());
    latinRun = "";
  };
  const flushCjk = () => {
    if (cjkRun.length > 1) {
      for (let i = 0; i + 1 < cjkRun.length; i++) cjk.push(cjkRun.slice(i, i + 2));
    } else if (cjkRun.length === 1) {
      cjk.push(cjkRun);
    }
    cjkRun = "";
  };

  for (const ch of query) {
    if (isCjkChar(ch)) {
      flushLatin();
      cjkRun += ch;
    } else if (/[A-Za-z0-9_]/.test(ch)) {
      flushCjk();
      latinRun += ch;
    } else {
      flushLatin();
      flushCjk();
    }
  }
  flushLatin();
  flushCjk();
  return { latin, cjk: [...new Set(cjk)] };
}

/** 生成 FTS5 MATCH 表达式：每个词加引号；默认 AND，中文 bigram 用 OR 提高召回。 */
export function buildMatch(terms: string[], operator: "AND" | "OR" = "AND"): string | undefined {
  if (terms.length === 0) return undefined;
  return terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(` ${operator} `);
}

/** 索引端：CJK 同时写入单字与相邻两字组（单字查询也能命中），其余原样。 */
export function toCjkIndexText(text: string): string {
  const out: string[] = [];
  let run = "";
  const flush = () => {
    if (run.length > 1) {
      for (const ch of run) out.push(ch);
      for (let i = 0; i + 1 < run.length; i++) out.push(run.slice(i, i + 2));
    } else if (run.length === 1) {
      out.push(run);
    }
    run = "";
  };
  for (const ch of text) {
    if (isCjkChar(ch)) run += ch;
    else {
      flush();
      out.push(ch);
    }
  }
  flush();
  return out.join(" ");
}
