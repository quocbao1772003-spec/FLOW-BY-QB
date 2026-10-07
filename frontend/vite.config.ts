import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { execSync } from "node:child_process";

// Commit the running code was started from — the sidebar compares it with
// the newest commit on GitHub to offer "update available". Empty when this
// folder isn't a git checkout (zip download); the badge then just links.
function git(args: string): string {
  try {
    return execSync(`git ${args}`, { cwd: __dirname, stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return "";
  }
}

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_COMMIT__: JSON.stringify(git("rev-parse HEAD")),
    __APP_COMMIT_DATE__: JSON.stringify(git("log -1 --format=%cI")),
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:8101",
      "/media": "http://localhost:8101",
      "/ws": {
        target: "ws://localhost:8101",
        ws: true,
      },
    },
  },
});
