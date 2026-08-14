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
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: "1G",
      // Graceful shutdown: give in-flight requests up to 10 s to complete
      // before PM2 force-kills the old process during a reload.
      kill_timeout: 10000,
      // Listen for SIGINT so the server can drain connections cleanly.
      listen_timeout: 8000,
      env: {
        ...env,
        NODE_ENV: "production",
      },
    },
  ],
};
