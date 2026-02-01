/**
 * PM2 Ecosystem Configuration for clawdrooms
 */

module.exports = {
  apps: [
    {
      name: 'room-orchestrator',
      script: 'scripts/room-orchestrator.js',
      cwd: '/root/clawdrooms',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '500M',
      env: {
        NODE_ENV: 'production'
      }
    },
    {
      name: 'x-cadence',
      script: 'scripts/x-cadence.js',
      cwd: '/root/clawdrooms',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'production'
      }
    },
    {
      name: 'website',
      script: 'website/server.js',
      cwd: '/root/clawdrooms',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '300M',
      env: {
        NODE_ENV: 'production',
        PORT: 3000
      }
    },
    {
      name: 'market-maker',
      script: 'scripts/market-maker.js',
      cwd: '/root/clawdrooms',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '200M',
      env: {
        NODE_ENV: 'production'
      }
    },
    {
      name: 'sustainability',
      script: 'scripts/sustainability-daemon.js',
      args: 'run',
      cwd: '/root/clawdrooms',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '200M',
      env: {
        NODE_ENV: 'production',
        SUSTAINABILITY_ENABLED: 'true'
      }
    }
  ]
};
