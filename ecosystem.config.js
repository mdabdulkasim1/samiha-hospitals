
module.exports = {
  apps: [
    {
      name: 'samiha-polyclinic-diagnosis',
      cwd: '/home/samihahospitals/public_html/app.samihahospitals.com',
      script: 'src/server.js',

      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      kill_timeout: 5000,

      env: {
        NODE_ENV: 'production',
        PORT: 3011,
      },

      env_production: {
        NODE_ENV: 'production',
        PORT: 3011,
      },

      error_file: './logs/err.log',
      out_file: './logs/out.log',
      log_file: './logs/combined.log',
      time: true,
    },
  ],
};
