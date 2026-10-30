import fs from "node:fs";
import path from "node:path";

const pkgDir = path.resolve(import.meta.dirname, "..", "packages", "cli");
const root = path.resolve(import.meta.dirname, "..");

for (const name of ["README.md", "LICENSE"]) {
  fs.copyFileSync(path.join(root, name), path.join(pkgDir, name));
}
