const CJK_RE =
  /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/;

export function isCjkChar(ch: string): boolean {
  return CJK_RE.test(ch);
}

/**
 * 把连续 CJK 字切成相邻两字一组：完成生成 -> 完成 成生 生成
 * 非 CJK 字符原样保留为独立片段。
 */
export function splitCjkSegments(text: string): string[] {
  const out: string[] = [];
  let run = "";
  const flush = () => {
    if (run.length > 1) {
      for (let i = 0; i + 1 < run.length; i++) {
        out.push(run.slice(i, i + 2));
      }
    } else if (run.length === 1) {
      out.push(run);
    }
    run = "";
  };
  for (const ch of text) {
    if (isCjkChar(ch)) {
      run += ch;
    } else {
      flush();
      out.push(ch);
    }
  }
  flush();
  return out;
}

/** 用于搜索的查询串：CJK 切成两字组，英文/数字按完整单词。 */
export function cjkQueryTerms(query: string): string[] {
  const terms: string[] = [];
  let cjkRun = "";
  let latinRun = "";
  const flushCjk = () => {
    if (cjkRun.length > 1) {
      for (let i = 0; i + 1 < cjkRun.length; i++) terms.push(cjkRun.slice(i, i + 2));
    } else if (cjkRun.length === 1) {
      terms.push(cjkRun);
    }
    cjkRun = "";
  };
  const flushLatin = () => {
    const word = latinRun.trim().toLowerCase();
    if (word) terms.push(word);
    latinRun = "";
  };
  for (const ch of query) {
    if (isCjkChar(ch)) {
      flushLatin();
      cjkRun += ch;
    } else if (/[A-Za-z0-9_]/.test(ch)) {
      flushCjk();
      latinRun += ch;
    } else {
      flushCjk();
      flushLatin();
    }
  }
  flushCjk();
  flushLatin();
  return [...new Set(terms)];
}

const LATIN_TERM_RE = /^[a-z0-9_]+$/;

/** 关键词匹配度：查询词在文本里出现的次数 / 查询词数。 */
export function keywordScore(query: string, text: string): number {
  const terms = cjkQueryTerms(query);
  if (terms.length === 0) return 0;
  const haystack = text.toLowerCase();
  let hits = 0;
  for (const term of terms) {
    if (LATIN_TERM_RE.test(term)) {
      // 英文按词匹配，避免 "api" 命中 "capital"
      const re = new RegExp(`(^|[^a-z0-9_])${term}([^a-z0-9_]|$)`);
      if (re.test(haystack)) hits++;
    } else if (haystack.includes(term)) {
      hits++;
    }
  }
  return hits / terms.length;
}
