import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    outDir: "../cli/dist/ui",
    emptyOutDir: true,
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      // 开发时把 /api 转发到 memrelay ui 起的本地服务；cookie 按主机名生效，直接可用
      "/api": {
        target: process.env.MEMRELAY_API ?? "http://127.0.0.1:4823",
      },
    },
  },
});
