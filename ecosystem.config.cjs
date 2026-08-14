const fs = require("fs");
const path = require("path");

// Parse .env file into an object
function loadEnv(filePath) {
  try {
    const content = fs.readFileSync(filePath, "utf8");
    const env = {};
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const idx = trimmed.indexOf("=");
      if (idx === -1) continue;
      const key = trimmed.slice(0, idx).trim();
      const val = trimmed.slice(idx + 1).trim().replace(/^["']|["']$/g, "");
      env[key] = val;
    }
    return env;
  } catch {
    return {};
  }
}

const envFile = path.join(__dirname, "artifacts/api-server/.env");
const env = loadEnv(envFile);

module.exports = {
  apps: [
    {
      name: "rocketfi-api",
      script: "./artifacts/api-server/dist/index.mjs",
      node_args: "--enable-source-maps",
      // Cluster mode: 2 workers so PM2 reload can roll one at a time.
      // Worker 0 starts background jobs (adapters, enrichment, backfill).
      // Worker 1 handles HTTP only — no duplicate indexing.
      exec_mode: "cluster",
      instances: 2,
      autorestart: true,
      watch: false,
      max_memory_restart: "1G",
      // Graceful shutdown: let in-flight requests finish (≤ 10 s) before
      // PM2 force-kills the worker being replaced during a rolling reload.
      kill_timeout: 10000,
      // Time PM2 waits for a new worker to start listening before giving up.
      listen_timeout: 8000,
      env: {
        ...env,
        NODE_ENV: "production",
        PLATFORM_TREASURY_ADDRESS: "JBCqngc3TYcz3Rtv5Md3CZyw8X6AxLik7gswCCttRS5E",
      },
    },
  ],
};
