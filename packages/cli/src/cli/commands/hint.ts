import { interruptedHint } from "../../resume/hint.js";

/** hint 命令：没有中断任务时什么都不打印。 */
export async function runHint(stdout: (text: string) => void): Promise<number> {
  const line = await interruptedHint();
  if (line) stdout(line);
  return 0;
}
