#!/bin/bash
# Restart NanoClaw server
# Usage: ./scripts/restart.sh

set -e

echo "Restarting NanoClaw..."

# Check if running via launchctl
if launchctl list | grep -q "com.nanoclaw"; then
    echo "Using launchctl..."
    launchctl kickstart -k "gui/$(id -u)/com.nanoclaw"
    echo ""
    echo "✓ NanoClaw restarted via launchctl"
    echo ""
    echo "Check logs:"
    echo "  tail -f logs/nanoclaw.log"
else
    echo "Not running via launchctl. Starting manually..."
    npm run dev
fi
