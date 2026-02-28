#!/bin/bash
# Refresh CLAUDE_CODE_OAUTH_TOKEN from Keychain
# Run this when you get 401 errors or after using `claude` CLI locally
#
# Usage: ./scripts/refresh-token.sh [--restart]

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$PROJECT_DIR/.env"

cd "$PROJECT_DIR"

echo "🔐 Refreshing Claude OAuth token from Keychain..."

# Get fresh token from Keychain
TOKEN_JSON=$(security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null)

if [[ -z "$TOKEN_JSON" ]]; then
    echo "❌ No token found in Keychain. Run 'claude /login' first."
    exit 1
fi

FRESH_TOKEN=$(echo "$TOKEN_JSON" | python3 -c "import json,sys; print(json.load(sys.stdin)['claudeAiOauth']['accessToken'])" 2>/dev/null)

if [[ -z "$FRESH_TOKEN" ]]; then
    echo "❌ Failed to extract token from Keychain."
    exit 1
fi

echo "   Token: ${FRESH_TOKEN:0:30}..."

# Check if token exists in .env
if grep -q "CLAUDE_CODE_OAUTH_TOKEN=" "$ENV_FILE" 2>/dev/null; then
    # Update existing token
    OLD_TOKEN=$(grep "CLAUDE_CODE_OAUTH_TOKEN=" "$ENV_FILE" | cut -d= -f2)
    echo "   Old: ${OLD_TOKEN:0:30}..."

    if [[ "$OLD_TOKEN" == "$FRESH_TOKEN" ]]; then
        echo "✓ Token already up to date"
    else
        sed -i '' "s|CLAUDE_CODE_OAUTH_TOKEN=.*|CLAUDE_CODE_OAUTH_TOKEN=$FRESH_TOKEN|" "$ENV_FILE"
        echo "✓ Token updated in .env"
    fi
else
    # Add token to .env
    echo "" >> "$ENV_FILE"
    echo "# Claude Pro OAuth Token" >> "$ENV_FILE"
    echo "CLAUDE_CODE_OAUTH_TOKEN=$FRESH_TOKEN" >> "$ENV_FILE"
    echo "✓ Token added to .env"
fi

# Restart if requested
if [[ "$1" == "--restart" ]] || [[ "$1" == "-r" ]]; then
    echo ""
    echo "🔄 Restarting NanoClaw..."
    launchctl kickstart -k gui/$(id -u)/com.nanoclaw 2>/dev/null && echo "✓ Restarted" || echo "⚠️  Could not restart (may need manual restart)"
fi

echo ""
echo "Done. Run 'launchctl kickstart -k gui/\$(id -u)/com.nanoclaw' to restart if needed."
