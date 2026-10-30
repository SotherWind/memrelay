import { VERSION } from "../core/version.js";
import { isIntegrated } from "../integrations/inspect.js";
import { runHookCommand } from "../integrations/hook.js";
import { maybeAutoUpdateSkills } from "../integrations/skill-update.js";
import { runDoctor } from "./commands/doctor.js";
import { runEmbed } from "./commands/embed.js";
import { runHint } from "./commands/hint.js";
import { runResume } from "./commands/resume.js";
import { runSearch } from "./commands/search.js";
import { runSetup } from "./commands/setup.js";
import { runShow } from "./commands/show.js";
import { runSummarize } from "./commands/summarize.js";
import { runTidyCommand } from "./commands/tidy.js";
import { runUi } from "./commands/ui.js";
import { helpText } from "./help.js";
import { EnvironmentError, UsageError, exitCodeFor } from "./output.js";

/** 用户自己运行的命令：顺手把过期的 Skill 升到当前版本（agent 命令保持只读）。 */
function userCommandPrelude(): void {
  try {
    maybeAutoUpdateSkills();
  } catch {
    /* 自动更新失败不影响主流程 */
  }
}

export async function main(argv: string[]): Promise<number> {
  const stdout = (text: string) => process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
  const [command, ...rest] = argv;

  try {
    switch (command) {
      case undefined:
      case "help":
      case "--help":
      case "-h": {
        stdout(helpText());
        if (!isIntegrated()) {
          stdout("（还没接入：运行 memrelay setup 把 Skill 装进各工具。）");
        }
        return 0;
      }
      case "--version":
      case "-v": {
        stdout(`memrelay ${VERSION}`);
        return 0;
      }
      case "ping": {
        stdout(`MEMRELAY-OK ${VERSION}`);
        return 0;
      }
      case "resume":
        return await runResume(rest, stdout);
      case "show":
        return await runShow(rest, stdout);
      case "search":
        return await runSearch(rest, stdout);
      case "hint":
        return await runHint(stdout);
      case "hook": {
        const flavorIndex = rest.indexOf("--flavor");
        const flavor = flavorIndex >= 0 ? rest[flavorIndex + 1] : undefined;
        return await runHookCommand(stdout, undefined, { flavor });
      }
      case "setup":
        userCommandPrelude();
        return await runSetup(rest);
      case "doctor":
        return await runDoctor(rest);
      case "embed":
        userCommandPrelude();
        return await runEmbed(rest, stdout);
      case "summarize":
        userCommandPrelude();
        return await runSummarize(rest, stdout);
      case "tidy":
        userCommandPrelude();
        return await runTidyCommand(rest, stdout);
      case "ui":
        userCommandPrelude();
        return await runUi(rest);
      default: {
        stdout(`未知命令：${command}\n\n${helpText()}`);
        return 1;
      }
    }
  } catch (err) {
    if (err instanceof UsageError) {
      stdout(err.message);
      return 1;
    }
    if (err instanceof EnvironmentError) {
      stdout(err.message);
      return 2;
    }
    const parseCode = (err as { code?: unknown } | null)?.code;
    if (typeof parseCode === "string" && parseCode.startsWith("ERR_PARSE_ARGS")) {
      const message = err instanceof Error ? err.message : String(err);
      stdout(`用法错误：${message}\n\n${helpText()}`);
      return 1;
    }
    const message = err instanceof Error ? err.message : String(err);
    stdout(`memrelay 运行出错：${message}`);
    return exitCodeFor(err);
  }
}

const isDirectRun =
  process.argv[1] !== undefined &&
  /cli(\.mjs|\.ts|\.js)$/.test(process.argv[1]);

if (isDirectRun) {
  const code = await main(process.argv.slice(2));
  process.exitCode = code;
}
