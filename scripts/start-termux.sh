#!/data/data/com.termux/files/usr/bin/bash
# Starts the backend on Android (Termux). Run with: bash ~/storage/shared/inverter-backend/start.sh
# Build, package.json and .env are pushed over adb to shared storage; dependencies are
# installed into ~/inverter-backend (shared storage can't hold node_modules).
set -e
SHARED=~/storage/shared/inverter-backend
APP=~/inverter-backend

mkdir -p "$APP"
cd "$APP"
ln -sfn "$SHARED/dist" dist

# Install dependencies on first run or when package.json changes.
if [ ! -d node_modules ] || ! cmp -s "$SHARED/package.json" package.json; then
  cp "$SHARED/package.json" package.json
  npm install --omit=dev
fi

export DOTENV_CONFIG_PATH="$SHARED/.env"
termux-wake-lock
exec node --preserve-symlinks --preserve-symlinks-main dist/server.js
