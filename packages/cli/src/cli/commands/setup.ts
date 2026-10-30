import { parseArgs } from "node:util";

import { runSetupCommand } from "../../integrations/setup.js";
import { helpText } from "../help.js";

export async function runSetup(rest: string[]): Promise<number> {
  const { values } = parseArgs({
    args: rest,
    options: {
      undo: { type: "boolean" },
      purge: { type: "boolean" },
      yes: { type: "boolean", short: "y" },
      enhance: { type: "string", multiple: true },
      "no-enhance": { type: "boolean" },
      skip: { type: "string", multiple: true },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: true,
  });
  if (values.help) {
    process.stdout.write(`${helpText()}\n`);
    return 0;
  }
  return runSetupCommand({
    undo: values.undo ?? false,
    purge: values.purge ?? false,
    yes: values.yes ?? false,
    enhance: values.enhance ?? [],
    noEnhance: values["no-enhance"] ?? false,
    skip: values.skip ?? [],
  });
}
