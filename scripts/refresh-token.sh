#!/bin/bash
# Refresh CLAUDE_CODE_OAUTH_TOKEN via Anthropic OAuth refresh endpoint
# Reads refresh_token from Keychain, calls the OAuth token endpoint for a fresh
# access_token, updates Keychain and .env.  The refresh_token rotates on each
# call, so the Keychain is always kept up to date.
#
# Usage: ./scripts/refresh-token.sh [--restart]

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$PROJECT_DIR/.env"
CLAUDE_CLIENT_ID="9d1c250a-e61b-44d9-88ed-5944d1962f5e"
OAUTH_TOKEN_URL="https://platform.claude.com/v1/oauth/token"

cd "$PROJECT_DIR"

echo "🔐 Refreshing Claude OAuth token..."

# Read current credentials from Keychain
TOKEN_JSON=$(security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null)

if [[ -z "$TOKEN_JSON" ]]; then
    echo "❌ No credentials in Keychain. Run 'claude /login' first."
    exit 1
fi

REFRESH_TOKEN=$(echo "$TOKEN_JSON" | python3 -c \
    "import json,sys; print(json.load(sys.stdin)['claudeAiOauth']['refreshToken'])" 2>/dev/null)

if [[ -z "$REFRESH_TOKEN" ]]; then
    echo "❌ No refresh_token in Keychain. Re-login with 'claude /login'."
    exit 1
fi

echo "   Calling OAuth refresh endpoint..."

# Call OAuth token endpoint — refresh_token rotates on each successful call
OAUTH_RESPONSE=$(curl -s -X POST "$OAUTH_TOKEN_URL" \
    -H "Content-Type: application/json" \
    --data-binary @- <<EOF
{"grant_type":"refresh_token","refresh_token":"$REFRESH_TOKEN","client_id":"$CLAUDE_CLIENT_ID"}
EOF
)

FRESH_TOKEN=$(echo "$OAUTH_RESPONSE" | python3 -c \
    "import json,sys; d=json.load(sys.stdin); print(d.get('access_token',''))" 2>/dev/null)

if [[ -z "$FRESH_TOKEN" ]]; then
    ERR=$(echo "$OAUTH_RESPONSE" | python3 -c \
        "import json,sys; d=json.load(sys.stdin); print(d.get('error', d.get('message','unknown')))" 2>/dev/null)
    echo "❌ OAuth refresh failed: $ERR"
    echo "   Falling back to keychain access_token (may be stale)"
    FRESH_TOKEN=$(echo "$TOKEN_JSON" | python3 -c \
        "import json,sys; print(json.load(sys.stdin)['claudeAiOauth']['accessToken'])" 2>/dev/null)
    if [[ -z "$FRESH_TOKEN" ]]; then
        echo "❌ No access_token in Keychain either. Re-login with 'claude /login'."
        exit 1
    fi
else
    echo "✓ Got fresh access_token from Anthropic"

    # Update Keychain with new access_token, refresh_token, and expiresAt
    UPDATED_JSON=$(TOKEN_JSON="$TOKEN_JSON" OAUTH_RESPONSE="$OAUTH_RESPONSE" python3 -c '
import json, os, time
current = json.loads(os.environ["TOKEN_JSON"])
response = json.loads(os.environ["OAUTH_RESPONSE"])
oauth = current["claudeAiOauth"]
oauth["accessToken"] = response["access_token"]
expires_in = int(response.get("expires_in", 28800))
oauth["expiresAt"] = int((time.time() + expires_in) * 1000)
new_rt = response.get("refresh_token", "")
if new_rt:
    oauth["refreshToken"] = new_rt
print(json.dumps(current))
')

    if [[ -n "$UPDATED_JSON" ]]; then
        # security add-generic-password -U updates if already exists
        printf '%s' "$UPDATED_JSON" | security add-generic-password \
            -U -s "Claude Code-credentials" -a "$USER" -w "$(cat)" 2>/dev/null \
            && echo "✓ Keychain updated (rotated refresh_token)" \
            || echo "⚠️  Keychain update failed (tokens still valid in .env)"
    fi
fi

echo "   Token: ${FRESH_TOKEN:0:30}..."

# Update .env
if grep -q "CLAUDE_CODE_OAUTH_TOKEN=" "$ENV_FILE" 2>/dev/null; then
    OLD_TOKEN=$(grep "CLAUDE_CODE_OAUTH_TOKEN=" "$ENV_FILE" | cut -d= -f2)
    echo "   Old:   ${OLD_TOKEN:0:30}..."

    if [[ "$OLD_TOKEN" == "$FRESH_TOKEN" ]]; then
        echo "✓ Token already up to date"
    else
        sed -i '' "s|CLAUDE_CODE_OAUTH_TOKEN=.*|CLAUDE_CODE_OAUTH_TOKEN=$FRESH_TOKEN|" "$ENV_FILE"
        echo "✓ Token updated in .env"
    fi
else
    echo "" >> "$ENV_FILE"
    echo "# Claude Pro OAuth Token" >> "$ENV_FILE"
    echo "CLAUDE_CODE_OAUTH_TOKEN=$FRESH_TOKEN" >> "$ENV_FILE"
    echo "✓ Token added to .env"
fi

# Always re-lock permissions — macOS sed -i creates a new file (inherits umask 644)
chmod 600 "$ENV_FILE"
echo "✓ Locked .env permissions (600)"

# Restart if requested
if [[ "$1" == "--restart" ]] || [[ "$1" == "-r" ]]; then
    echo ""
    echo "🔄 Restarting NanoClaw..."
    if command -v pm2 &>/dev/null && pm2 list 2>/dev/null | grep -q "nanoclaw"; then
        pm2 restart nanoclaw \
            && echo "✓ Restarted via pm2" \
            || echo "⚠️  pm2 restart failed"
    else
        launchctl kickstart -k gui/$(id -u)/com.nanoclaw 2>/dev/null \
            && echo "✓ Restarted via launchctl" \
            || echo "⚠️  Could not restart"
    fi
fi

echo ""
echo "Done."
