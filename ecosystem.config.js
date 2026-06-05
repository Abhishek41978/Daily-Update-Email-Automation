module.exports = {
  apps: [{
    name: 'daily-task-report',
    script: 'index.js',
    watch: false,
    autorestart: true,
    max_restarts: 5,
    env: { NODE_ENV: 'production' },
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    error_file: 'pm2-error.log',
    out_file: 'pm2-out.log',
  }],
};
