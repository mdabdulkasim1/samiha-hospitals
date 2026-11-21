#!/bin/bash
set -e

# ==========================================
# Configuration
# ==========================================
APP_NAME="samiha-polyclinic-diagnosis"
ECOSYSTEM_CONFIG="ecosystem.config.js"

echo "=========================================="
echo "   Samiha Hospital PM2 Linux Deploy       "
echo "=========================================="

# Check for .env file
if [ ! -f .env ]; then
  if [ -f .env.production ]; then
    echo "[*] Using .env.production as .env..."
    cp .env.production .env
  elif [ -f .env.local ]; then
    echo "[*] Using .env.local as .env..."
    cp .env.local .env
  elif [ -f .env.example ]; then
    echo "[!] No .env file found. Creating default .env from .env.example..."
    cp .env.example .env
  else
    echo "[-] Error: No .env or .env.production file found!"
    echo "[!] Please create .env or .env.production."
    exit 1
  fi
fi

# Ensure required runtime directories exist
mkdir -p logs data data/backups

echo "[1/5] Installing npm dependencies..."
# Check if PM2 is installed globally
if ! command -v pm2 > /dev/null 2>&1; then
  echo "[!] PM2 not found in PATH. Installing PM2 globally..."
  npm install -g pm2 || true
fi

npm install
chmod -R +x node_modules/.bin 2>/dev/null || true

# Database migration & schema setup
echo "[2/5] Running database migrations..."
if [ -f "src/db/migrate.js" ]; then
  node src/db/migrate.js || {
    echo "[-] Warning: Database migration failed. Continuing with caution..."
  }
else
  echo "[*] Skipping migration (src/db/migrate.js not found)..."
fi

# Database seeding & online booking setup
echo "[3/5] Checking initial database records and online booking schedules..."
if [ -f "scripts/enable-online-booking.js" ]; then
  echo "[*] Ensuring online booking departments and doctor schedules are active..."
  node scripts/enable-online-booking.js || true
fi
if [ "${RUN_SEED:-false}" = "true" ] && [ -f "src/db/seed.js" ]; then
  echo "[*] Manual seeding triggered (RUN_SEED=true)..."
  node src/db/seed.js || true
else
  echo "[*] Auto-seed is handled on boot by server when database is empty."
fi

# Build step (skipped for pure Node.js / Express static server)
if grep -q '"build":' package.json 2>/dev/null; then
  echo "[4/5] Building application..."
  npm run build
else
  echo "[4/5] Skipping build step (Express serves static assets directly)..."
fi


# PM2 process management
echo "[5/6] Reloading PM2 process..."

if pm2 describe "$APP_NAME" > /dev/null 2>&1; then
  echo "[*] Restarting existing process: $APP_NAME"
  pm2 restart "$APP_NAME" --update-env
else
  echo "[*] Starting new process: $APP_NAME"
  pm2 start "$ECOSYSTEM_CONFIG" --env production
fi

pm2 save

# 6. cPanel Apache Reverse Proxy Check & Config (Idempotent)
echo "[6/6] Checking cPanel Apache reverse proxy configuration for port 3011..."
CPANEL_USER="samihahospitals"
DOMAIN="app.samihahospitals.com"
PORT="3011"
STD_DIR="/etc/apache2/conf.d/userdata/std/2_4/${CPANEL_USER}/${DOMAIN}"
SSL_DIR="/etc/apache2/conf.d/userdata/ssl/2_4/${CPANEL_USER}/${DOMAIN}"

if [ -d "/etc/apache2/conf.d/userdata" ]; then
  echo "[*] Configuring cPanel Apache reverse proxy for ${DOMAIN} -> http://127.0.0.1:${PORT}/..."
  mkdir -p "${STD_DIR}" "${SSL_DIR}" 2>/dev/null || true

  cat <<EOF > "${STD_DIR}/proxy.conf"
<IfModule mod_proxy.c>
    ProxyPreserveHost On
    ProxyPass / http://127.0.0.1:${PORT}/
    ProxyPassReverse / http://127.0.0.1:${PORT}/
    RequestHeader set X-Forwarded-Proto "http"
</IfModule>
EOF

  cat <<EOF > "${SSL_DIR}/proxy.conf"
<IfModule mod_proxy.c>
    ProxyPreserveHost On
    ProxyPass / http://127.0.0.1:${PORT}/
    ProxyPassReverse / http://127.0.0.1:${PORT}/
    RequestHeader set X-Forwarded-Proto "https"
    RequestHeader set X-Forwarded-Port "443"
</IfModule>
EOF

  if [ -x "/scripts/rebuildhttpdconf" ]; then
    echo "[*] Rebuilding Apache HTTPD configuration..."
    /scripts/rebuildhttpdconf 2>/dev/null || true
    systemctl restart httpd 2>/dev/null || systemctl reload httpd 2>/dev/null || true
  fi
fi

echo "=========================================="
echo " Deployment successful! PM2 service live. "
echo " Check status with: pm2 status            "
echo " View logs with:   pm2 logs $APP_NAME     "
echo "=========================================="

