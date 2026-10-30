import type { PartKind, ToolCategory } from "./types.js";

const READ_TOOLS = new Set([
  "read",
  "readfile",
  "read_file",
  "view",
  "viewimage",
  "notebookread",
  "readlints",
  "cat",
  "list_dir",
  "ls",
]);

const SEARCH_TOOLS = new Set([
  "grep",
  "glob",
  "search",
  "search_file",
  "find",
  "codebase_search",
  "search_codebase",
]);

const WRITE_TOOLS = new Set([
  "write",
  "writefile",
  "write_file",
  "create_file",
  "createfile",
  "edit",
  "multiedit",
  "notebookedit",
  "replace",
  "search_replace",
  "apply_patch",
  "str_replace_editor",
  "insert_edit_into_file",
  "delete_file",
  "rename_file",
]);

const SHELL_TOOLS = new Set([
  "bash",
  "sh",
  "shell",
  "run_command",
  "runcommand",
  "execute_command",
  "executecommand",
  "exec_command",
  "write_stdin",
  "terminal",
  "computer",
  "container.exec",
  "bashoutput",
  "killshell",
]);

const TASK_TOOLS = new Set([
  "todo_write",
  "todowrite",
  "task",
  "taskcreate",
  "taskupdate",
  "tasklist",
  "update_plan",
  "updateplan",
  "update_todo_list",
  "set_plan",
]);

const WEB_TOOLS = new Set(["webfetch", "websearch", "web_search", "fetch", "browser", "navigate"]);

const PLAN_TOOL_NAMES = new Set([
  "todo_write",
  "todowrite",
  "taskcreate",
  "taskupdate",
  "update_plan",
  "updateplan",
  "update_todo_list",
  "set_plan",
]);

export function categorizeTool(toolName: string | undefined): ToolCategory {
  if (!toolName) return "other";
  const name = toolName.toLowerCase();
  if (READ_TOOLS.has(name)) return "read";
  if (SEARCH_TOOLS.has(name)) return "search";
  if (WRITE_TOOLS.has(name)) return "write";
  if (SHELL_TOOLS.has(name)) return "shell";
  if (TASK_TOOLS.has(name)) return "task";
  if (WEB_TOOLS.has(name)) return "web";
  return "other";
}

export function isPlanTool(toolName: string | undefined): boolean {
  if (!toolName) return false;
  return PLAN_TOOL_NAMES.has(toolName.toLowerCase());
}

const FILE_PATH_KEYS = ["file_path", "filePath", "path", "filepath", "filename", "target_file"];

export function extractFilePaths(input: unknown): string[] {
  if (!input || typeof input !== "object") return [];
  const record = input as Record<string, unknown>;
  const out: string[] = [];
  for (const key of FILE_PATH_KEYS) {
    const v = record[key];
    if (typeof v === "string" && v) out.push(v);
  }
  if (Array.isArray(record["edits"])) {
    for (const edit of record["edits"]) {
      if (edit && typeof edit === "object") {
        for (const key of FILE_PATH_KEYS) {
          const v = (edit as Record<string, unknown>)[key];
          if (typeof v === "string" && v) out.push(v);
        }
      }
    }
  }
  return [...new Set(out)];
}

export function partKindForTool(toolName: string | undefined): PartKind {
  if (isPlanTool(toolName)) return "plan";
  const category = categorizeTool(toolName);
  if (category === "write") return "file_edit";
  return "tool_call";
}
