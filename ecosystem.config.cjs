module.exports = {
  apps: [
    {
      name: "petyard",
      script: "src/app/server.js",

      // ── Memory Protection ─────────────────────────────────────
      // Auto-restart if memory exceeds 512 MB (adjust as needed)
      max_memory_restart: "512M",

      // ── Node.js GC / Heap Flags ───────────────────────────────
      // --max-old-space-size  : hard cap the V8 old-generation heap (MB)
      // --gc-interval=100     : force a GC check every 100 allocations
      // --expose-gc           : (optional) allows manual global.gc() calls
      node_args: "--max-old-space-size=512 --expose-gc",

      // ── Restart Policy ────────────────────────────────────────
      // Exponential backoff restart with 100ms base delay
      exp_backoff_restart_delay: 100,
      // Max 15 unstable restarts before PM2 stops retrying
      max_restarts: 15,
      // Consider stable after 5 seconds uptime
      min_uptime: "5s",

      // ── Logs ──────────────────────────────────────────────────
      // Prefix logs with timestamp
      time: true,
      // Merge stdout + stderr into one log stream (optional)
      merge_logs: false,
      // Rotate logs — keep last 10 log files, 10 MB each
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      // PM2 built-in log rotation (install pm2-logrotate for advanced control)
      max_size: "10M",

      // ── Misc ──────────────────────────────────────────────────
      // Graceful shutdown timeout (ms) — give the process time to close connections
      kill_timeout: 5000,
      // Listen for SIGINT for graceful shutdown
      listen_timeout: 3000,

      // Watch is off in production
      watch: false,

      // Environment
      env: {
        NODE_ENV: "development",
      },
      env_production: {
        NODE_ENV: "production",
      },
    },
  ],
};
