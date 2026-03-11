#!/bin/bash
# Watches for trigger files in data/workspace/ and runs pm2 commands
WORKSPACE="/Users/lachicalife/lucy/nanoclaw/data/workspace"

while true; do
  for trigger in "$WORKSPACE"/pm2-restart-*; do
    [ -f "$trigger" ] || continue
    service=$(basename "$trigger" | sed 's/pm2-restart-//')
    rm "$trigger"
    echo "[$(date)] pm2 restart $service"
    pm2 restart "$service"
  done
  sleep 2
done
