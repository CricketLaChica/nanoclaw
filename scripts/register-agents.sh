#!/usr/bin/env bash

# Register all agent groups in NanoClaw database

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
DB_FILE="$PROJECT_ROOT/store/messages.db"

# Color output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Agent configuration: agent_id|trigger_pattern|requires_trigger
# JID format: {agent_id}@nanoclaw.local
AGENTS=(
    # Executive Level - Lucy receives web messages directly, no trigger needed
    "lucy|@Lucy|0"
    # C-level executives - can be mentioned with triggers
    "nalu|@Nalu|1"
    "maui|@Maui|1"
    "hoku|@Hoku|1"
    # Specialists - under C-level
    "reef|@Reef|1"
    "pali|@Pali|1"
    "mana|@Mana|1"
    "ahi|@Ahi|1"
    "liko|@Liko|1"
    "hali|@Hali|1"
    "moana|@Moana|1"
    "koa|@Koa|1"
    "leilani|@Leilani|1"
    "noelani|@Noelani|1"
    "ikaika|@Ikaika|1"
    "kai|@Kai|1"
    "wai|@Wai|1"
    "makani|@Makani|1"
    "lani|@Lani|1"
    "keoni|@Keoni|1"
    "pua|@Pua|1"
    "noe|@Noe|1"
)

log_info "Registering agent groups in NanoClaw database"
log_info "================================================"

# Check if database exists
if [ ! -f "$DB_FILE" ]; then
    log_error "Database not found: $DB_FILE"
    exit 1
fi

# Get current timestamp
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%S.%3NZ")

# Register each agent
for agent_config in "${AGENTS[@]}"; do
    IFS='|' read -r agent_id trigger requires_trigger <<< "$agent_config"
    jid="${agent_id}@nanoclaw.local"
    name="${agent_id}"
    folder="${agent_id}"

    log_info "Registering: $agent_id (JID: $jid)"

    # Check if agent already exists
    existing=$(sqlite3 "$DB_FILE" "SELECT jid FROM registered_groups WHERE jid='$jid';" 2>/dev/null || echo "")

    # Map requires_trigger to no_trigger_required (inverse logic)
    no_trigger_required=$((1 - requires_trigger))

    if [ -n "$existing" ]; then
        log_warn "  → Agent already registered, updating..."
        sqlite3 "$DB_FILE" "UPDATE registered_groups SET name='$name', folder='$folder', trigger='$trigger', no_trigger_required=$no_trigger_required WHERE jid='$jid';"
    else
        log_info "  → Inserting new agent..."
        sqlite3 "$DB_FILE" "INSERT INTO registered_groups (jid, name, folder, trigger, no_trigger_required, added_at) VALUES ('$jid', '$name', '$folder', '$trigger', $no_trigger_required, '$TIMESTAMP');"
    fi

    # Create IPC directory for the agent
    mkdir -p "$PROJECT_ROOT/data/ipc/$folder"/{messages,tasks,input}

    log_info "  ✓ Registered $agent_id"
done

log_info ""
log_info "================================================"
log_info "Agent registration complete!"
log_info "================================================"
log_info ""

# Display registered agents
log_info "Registered agents:"
sqlite3 "$DB_FILE" "SELECT folder, trigger, CASE WHEN no_trigger_required=1 THEN 'No' ELSE 'Yes' END as needs_trigger FROM registered_groups WHERE jid LIKE '%@nanoclaw.local' ORDER BY folder;" | while IFS='|' read -r folder trigger needs_trigger; do
    log_info "  - $folder (trigger: $trigger, needs trigger: $needs_trigger)"
done

log_info ""
log_info "Total agents: $(sqlite3 "$DB_FILE" "SELECT COUNT(*) FROM registered_groups WHERE jid LIKE '%@nanoclaw.local';")"
log_info ""
