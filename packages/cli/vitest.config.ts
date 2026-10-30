import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["test/e2e/**"],
    testTimeout: 60000,
    // forks 池在 Windows 退出阶段会偶发 onTaskUpdate RPC 超时（测试全绿但退出码非 0）；
    // 用例不依赖进程级隔离（无 chdir / 全局 env 改写），线程池下同一套用例干净通过。
    pool: "threads",
  },
});
