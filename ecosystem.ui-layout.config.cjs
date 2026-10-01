// Start separately after the UI Builder publication flag and queue infrastructure
// have been enabled and verified in the target environment.
module.exports = {
  apps: [{
    name: "petyard-ui-layout-publish-worker",
    cwd: "/root/Petyard",
    script: "src/workers/uiLayoutPublish.worker.js",
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
    env: { NODE_ENV: "production", TZ: "Africa/Cairo" },
    env_production: { NODE_ENV: "production", TZ: "Africa/Cairo" },
  }],
};
