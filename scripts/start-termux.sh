#!/data/data/com.termux/files/usr/bin/bash
# Starts the backend on Android (Termux). Run with: bash ~/storage/shared/inverter-backend/start.sh
set -e
cd ~/inverter-backend
termux-wake-lock
exec node --preserve-symlinks --preserve-symlinks-main dist/server.js
