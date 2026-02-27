#!/bin/bash
# Toggle between GLM-5 (via proxy) and Claude Pro (OAuth)
# Usage: ./scripts/toggle-model.sh [glm|claude|status]
#
# For Claude Pro: Uses your existing CLAUDE_CODE_OAUTH_TOKEN (no API key needed)
# For GLM-5: Routes through local proxy at http://localhost:8787

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$PROJECT_DIR/.env"
STATE_FILE="$PROJECT_DIR/.model-provider"

cd "$PROJECT_DIR"

# Get current provider
get_current_provider() {
    if [[ -f "$STATE_FILE" ]]; then
        cat "$STATE_FILE"
    else
        # Detect from .env
        if grep -q "ANTHROPIC_BASE_URL" "$ENV_FILE" 2>/dev/null; then
            echo "glm"
        else
            echo "claude"
        fi
    fi
}

# Show current provider
show_status() {
    local current
    current=$(get_current_provider)
    echo ""
    echo "=========================================="
    echo "  Current model provider: $current"
    echo "=========================================="
    echo ""
    if [[ "$current" == "glm" ]]; then
        echo "Using: GLM-5 via local proxy (http://localhost:8787)"
        echo "Auth: ANTHROPIC_API_KEY (dummy key for proxy)"
    else
        echo "Using: Claude Pro direct API"
        echo "Auth: CLAUDE_CODE_OAUTH_TOKEN (your Claude subscription)"
    fi
    echo ""
}

# If no argument, show status
if [[ -z "$1" ]]; then
    show_status
    echo "Usage: ./scripts/toggle-model.sh [glm|claude|status]"
    exit 0
fi

case "$1" in
    status)
        show_status
        ;;
    glm)
        echo "Switching to GLM-5 (via proxy)..."

        # Read current .env and modify it
        if [[ -f "$ENV_FILE" ]]; then
            # Remove existing ANTHROPIC_BASE_URL lines and add new one
            grep -v "ANTHROPIC_BASE_URL" "$ENV_FILE" > "$ENV_FILE.tmp" 2>/dev/null || true

            # Add GLM proxy config
            cat >> "$ENV_FILE.tmp" << 'EOF'

# GLM-5 proxy configuration
ANTHROPIC_BASE_URL=http://host.docker.internal:8787
EOF

            mv "$ENV_FILE.tmp" "$ENV_FILE"
        else
            # Create new .env
            cat > "$ENV_FILE" << 'EOF'
# GLM-5 proxy configuration
ANTHROPIC_API_KEY=sk-dummy-key-for-proxy
ANTHROPIC_BASE_URL=http://host.docker.internal:8787
EOF
        fi

        echo "glm" > "$STATE_FILE"
        echo ""
        echo "✓ Switched to GLM-5 mode"
        echo ""
        echo "IMPORTANT: Restart NanoClaw for changes to take effect:"
        echo "  launchctl kickstart -k gui/\$(id -u)/com.nanoclaw"
        echo "  # or if running manually:"
        echo "  npm run dev"
        echo ""
        ;;
    claude)
        echo "Switching to Claude Pro (direct API)..."

        # Remove ANTHROPIC_BASE_URL to use direct API
        if [[ -f "$ENV_FILE" ]]; then
            # Remove ANTHROPIC_BASE_URL lines
            grep -v "ANTHROPIC_BASE_URL" "$ENV_FILE" > "$ENV_FILE.tmp" 2>/dev/null || true
            grep -v "^ANTHROPIC_API_KEY=sk-dummy" "$ENV_FILE.tmp" > "$ENV_FILE.tmp2" 2>/dev/null || true
            mv "$ENV_FILE.tmp2" "$ENV_FILE"
            rm -f "$ENV_FILE.tmp"
        fi

        echo "claude" > "$STATE_FILE"
        echo ""
        echo "✓ Switched to Claude Pro mode"
        echo ""
        echo "Your CLAUDE_CODE_OAUTH_TOKEN will be used for authentication."
        echo "No API key needed - uses your Claude Pro subscription."
        echo ""
        echo "IMPORTANT: Restart NanoClaw for changes to take effect:"
        echo "  launchctl kickstart -k gui/\$(id -u)/com.nanoclaw"
        echo "  # or if running manually:"
        echo "  npm run dev"
        echo ""
        ;;
    *)
        echo "Unknown option: $1"
        echo "Usage: ./scripts/toggle-model.sh [glm|claude|status]"
        exit 1
        ;;
esac
