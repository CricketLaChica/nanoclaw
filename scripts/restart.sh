#!/bin/bash
# Restart NanoClaw server
# Usage: ./scripts/restart.sh

set -e

echo "Restarting NanoClaw..."

# Check if running via pm2
if pm2 list | grep -q "nanoclaw"; then
    echo "Using pm2..."
    pm2 restart nanoclaw
    echo ""
    echo "✓ NanoClaw restarted via pm2"
    echo ""
    echo "Check logs:"
    echo "  pm2 logs nanoclaw"
else
    echo "Not running via pm2. Starting..."
    cd /Users/lachicalife/lucy/nanoclaw
    pm2 start npm --name "nanoclaw" -- run dev
fi
