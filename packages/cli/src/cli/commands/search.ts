import { parseArgs } from "node:util";

import { currentEnv } from "../../core/env.js";
import { redactSecrets } from "../../core/secrets.js";
import { resolveContext } from "../../resume/context.js";
import { formatLocalTime, statusLabel } from "../../resume/session-reader.js";
import { openReadOnly, StoreMissingError, StoreTooNewError } from "../../store/db.js";
import { searchSessions } from "../../store/search.js";
import { semanticHitsForSearch } from "../../store/semantic.js";
import { getSessionSummaries } from "../../store/summaries-store.js";
import { searchSummaryDrain } from "../../store/summarizer.js";
import { helpText } from "../help.js";
import { writeOut } from "../output.js";

interface SearchOptions {
  keyword: string;
  limit?: number;
  out?: string;
}

export async function runSearch(rest: string[], stdout: (text: string) => void): Promise<number> {
  const { values, positionals } = parseArgs({
    args: rest,
    options: {
      limit: { type: "string" },
      out: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: true,
  });
  if (values.help) {
    stdout(helpText());
    return 0;
  }
  const keyword = positionals.join(" ").trim();
  if (!keyword) {
    stdout('用法：memrelay search <关键词>\n在当前项目的会话里搜索（需要先由用户运行 memrelay doctor 建索引）。');
    return 1;
  }
  const limitRaw = values.limit;
  const limit = limitRaw === undefined ? undefined : Number(limitRaw);
  if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
    stdout("--limit 需要一个正整数。");
    return 1;
  }
  const opts: SearchOptions = {
    keyword,
    limit,
    out: values.out,
  };

  const env = currentEnv();
  const ctx = resolveContext();

  let db;
  try {
    db = openReadOnly(env);
  } catch (err) {
    if (err instanceof StoreMissingError) {
      writeOut(
        `${err.message}\n让用户运行 memrelay doctor（或 memrelay ui）建好索引后再搜。`,
        opts.out,
      );
      return 0;
    }
    if (err instanceof StoreTooNewError) {
      writeOut(err.message, opts.out);
      return 2;
    }
    throw err;
  }

  try {
    // 两个可选通道并行：语义检索（本项目定向排空 + 查询词嵌入）与会话摘要（本项目定向排空）；
    // 未启用 / 失败都返回空 → 行为与未开启时逐字一致。
    const [semantic] = await Promise.all([
      semanticHitsForSearch(env, opts.keyword, {
        projectRoot: ctx.project.projectRoot,
        limit: opts.limit ?? 10,
      }),
      searchSummaryDrain(env, ctx.project.projectRoot),
    ]);
    const results = searchSessions(db, {
      projectRoot: ctx.project.projectRoot,
      query: opts.keyword,
      limitSessions: opts.limit ?? 10,
      env,
      semantic,
    });
    if (results.length === 0) {
      writeOut(
        `没有在项目 ${ctx.project.projectRoot} 里搜到「${opts.keyword}」。可以换个关键词，或让用户运行 memrelay doctor 更新索引。`,
        opts.out,
      );
      return 0;
    }

    const summaries = getSessionSummaries(
      db,
      results.map((r) => r.session.id),
    );
    const lines: string[] = [];
    lines.push(
      `搜索「${opts.keyword}」· 项目 ${ctx.project.projectRoot} · 命中 ${results.length} 个会话`,
    );
    lines.push("");
    results.forEach((r, i) => {
      const s = r.session;
      const title = s.title ? ` · ${s.title}` : "";
      lines.push(
        `${i + 1}. ${s.id} · ${statusLabel(s.status)} · ${formatLocalTime(s.startedAt ?? undefined)}${title}`,
      );
      const summary = summaries.get(s.id);
      if (summary) lines.push(`   摘要：${summary.replace(/\s+/g, " ")}`);
      for (const m of r.matches) {
        lines.push(`   片段：${m.snippet}`);
        const from = Math.max(0, m.ordinal - 2);
        lines.push(`   翻看：memrelay show ${s.id} --from ${from}`);
      }
      lines.push("");
    });
    lines.push("拿到结果后可以直接 memrelay show 看细节；确定要继续的任务就照常开工。");

    const { text } = redactSecrets(lines.join("\n"));
    writeOut(text, opts.out);
    return 0;
  } finally {
    db.close();
  }
}
