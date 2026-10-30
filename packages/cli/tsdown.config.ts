import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/cli/index.ts"],
  outDir: "dist",
  format: "esm",
  platform: "node",
  target: "node22.13",
  dts: false,
  // 只清自己的入口产物：dist/ui 是 UI 包的产物，CLI 单独重建时不能删
  clean: ["dist/cli.mjs"],
  outExtensions: () => ({ js: ".mjs" }),
  external: [/^node:/],
  outputOptions: {
    entryFileNames: "cli.mjs",
    inlineDynamicImports: true,
  },
});
