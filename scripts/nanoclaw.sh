#!/bin/bash
# NanoClaw service management scripts
# Usage: ./scripts/nanoclaw.sh [status|start|stop|restart|logs]

set -e

SERVICE_NAME="com.nanoclaw"
PLIST_PATH="$HOME/Library/LaunchAgents/com.nanoclaw.plist"

# Check if service is installed
is_installed() {
    [[ -f "$PLIST_PATH" ]]
}

# Check if service is running
is_running() {
    launchctl list | grep -q "$SERVICE_NAME"
}

case "${1:-status}" in
    status)
        echo ""
        echo "=========================================="
        echo "  NanoClaw Service Status"
        echo "=========================================="
        echo ""
        if is_installed; then
            echo "Installed: ✓ ($PLIST_PATH)"
        else
            echo "Installed: ✗ (no launchctl service)"
        fi

        if is_running; then
            echo "Running: ✓"
            echo ""
            echo "To view logs:"
            echo "  tail -f logs/nanoclaw.log"
        else
            echo "Running: ✗"
            echo ""
            echo "To start:"
            echo "  ./scripts/nanoclaw.sh start"
        fi
        echo ""
        ;;
    start)
        echo "Starting NanoClaw..."
        if is_installed; then
            launchctl load "$PLIST_PATH" 2>/dev/null || true
            launchctl kickstart -k "gui/$(id -u)/$SERVICE_NAME"
            echo "✓ Started via launchctl"
        else
            echo "No launchctl service found. Running manually..."
            npm run dev
        fi
        ;;
    stop)
        echo "Stopping NanoClaw..."
        if is_running; then
            launchctl unload "$PLIST_PATH" 2>/dev/null || true
            echo "✓ Stopped"
        else
            echo "NanoClaw is not running"
        fi
        ;;
    restart)
        echo "Restarting NanoClaw..."
        if is_installed; then
            launchctl kickstart -k "gui/$(id -u)/$SERVICE_NAME"
            echo "✓ Restarted via launchctl"
        else
            echo "No launchctl service. Starting manually..."
            npm run dev
        fi
        ;;
    logs)
        echo "Tailing NanoClaw logs (Ctrl+C to exit)..."
        echo ""
        tail -f logs/nanoclaw.log
        ;;
    install)
        if [[ ! -f "com.nanoclaw.plist" ]]; then
            echo "Error: com.nanoclaw.plist not found in project root"
            exit 1
        fi
        echo "Installing NanoClaw as launchctl service..."
        cp com.nanoclaw.plist "$PLIST_PATH"
        launchctl load "$PLIST_PATH"
        echo "✓ Installed. NanoClaw will start automatically on login."
        ;;
    uninstall)
        echo "Uninstalling NanoClaw service..."
        if is_running; then
            launchctl unload "$PLIST_PATH"
        fi
        rm -f "$PLIST_PATH"
        echo "✓ Uninstalled"
        ;;
    *)
        echo "NanoClaw Service Manager"
        echo ""
        echo "Usage: ./scripts/nanoclaw.sh [command]"
        echo ""
        echo "Commands:"
        echo "  status    Show service status (default)"
        echo "  start     Start NanoClaw"
        echo "  stop      Stop NanoClaw"
        echo "  restart   Restart NanoClaw"
        echo "  logs      Tail the log file"
        echo "  install   Install as launchctl service"
        echo "  uninstall Remove launchctl service"
        ;;
esac
