module.exports = {
  apps: [
    {
      name: "petyard",
      cwd: "/root/Petyard",
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
        NODE_ENV: "production",
        TZ: "Africa/Cairo",
      },
      env_production: {
        NODE_ENV: "production",
        TZ: "Africa/Cairo",
      },
    },
    {
      name: "petyard-notification-worker",
      cwd: "/root/Petyard",
      script: "src/workers/notificationBroadcast.worker.js",

      // Keep notification fan-out isolated from the API server.
      max_memory_restart: "512M",
      node_args: "--max-old-space-size=512",

      exp_backoff_restart_delay: 1000,
      max_restarts: 15,
      min_uptime: "5s",

      time: true,
      merge_logs: false,
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      max_size: "10M",

      kill_timeout: 30000,
      listen_timeout: 3000,
      watch: false,

      env: {
        NODE_ENV: "production",
        TZ: "Africa/Cairo",
      },
      env_production: {
        NODE_ENV: "production",
        TZ: "Africa/Cairo",
      },
    },
    {
      // Durable substitution/user notification delivery. Keep it separate from
      // the broadcast worker so an FCM retry cannot hold up API traffic.
      name: "petyard-notification-outbox-worker",
      cwd: "/root/Petyard",
      script: "src/workers/notificationOutbox.worker.js",

      max_memory_restart: "512M",
      node_args: "--max-old-space-size=512",
      exp_backoff_restart_delay: 1000,
      max_restarts: 15,
      min_uptime: "5s",

      time: true,
      merge_logs: false,
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      max_size: "10M",

      // A claimed delivery may still be in flight during shutdown.
      kill_timeout: 30000,
      listen_timeout: 3000,
      watch: false,

      env: {
        NODE_ENV: "production",
        TZ: "Africa/Cairo",
      },
      env_production: {
        NODE_ENV: "production",
        TZ: "Africa/Cairo",
      },
    },
    {
      // Retries provider/manual refund operations created by substitutions.
      name: "petyard-substitution-refund-worker",
      cwd: "/root/Petyard",
      script: "src/workers/substitutionRefund.worker.js",

      max_memory_restart: "512M",
      node_args: "--max-old-space-size=512",
      exp_backoff_restart_delay: 1000,
      max_restarts: 15,
      min_uptime: "5s",

      time: true,
      merge_logs: false,
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      max_size: "10M",

      kill_timeout: 30000,
      listen_timeout: 3000,
      watch: false,

      env: {
        NODE_ENV: "production",
        TZ: "Africa/Cairo",
      },
      env_production: {
        NODE_ENV: "production",
        TZ: "Africa/Cairo",
      },
    },
    {
      // Sweeps offer and additional-card expirations; polling prevents stale
      // reservations from surviving a process restart.
      name: "petyard-substitution-expiration-worker",
      cwd: "/root/Petyard",
      script: "src/workers/substitutionExpiration.worker.js",

      max_memory_restart: "512M",
      node_args: "--max-old-space-size=512",
      exp_backoff_restart_delay: 1000,
      max_restarts: 15,
      min_uptime: "5s",

      time: true,
      merge_logs: false,
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      max_size: "10M",

      kill_timeout: 30000,
      listen_timeout: 3000,
      watch: false,

      env: {
        NODE_ENV: "production",
        TZ: "Africa/Cairo",
      },
      env_production: {
        NODE_ENV: "production",
        TZ: "Africa/Cairo",
      },
    },
  ],
};
