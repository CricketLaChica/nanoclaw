#!/usr/bin/env bash

# Create WebSocket and delegation database tables

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

log_info "Creating WebSocket and delegation database tables"
log_info "================================================"

# Check if database exists
if [ ! -f "$DB_FILE" ]; then
    log_error "Database not found: $DB_FILE"
    exit 1
fi

# Create web_sessions table
log_info "Creating web_sessions table..."
sqlite3 "$DB_FILE" <<EOF
CREATE TABLE IF NOT EXISTS web_sessions (
  session_id TEXT PRIMARY KEY,
  agent_folder TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_active TEXT NOT NULL,
  FOREIGN KEY (agent_folder) REFERENCES registered_groups(folder)
);
CREATE INDEX IF NOT EXISTS idx_web_sessions_agent ON web_sessions(agent_folder);
CREATE INDEX IF NOT EXISTS idx_web_sessions_last_active ON web_sessions(last_active);
EOF
log_info "  ✓ web_sessions table created"

# Create chat_history table
log_info "Creating chat_history table..."
sqlite3 "$DB_FILE" <<EOF
CREATE TABLE IF NOT EXISTS chat_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  run_id TEXT,
  FOREIGN KEY (session_id) REFERENCES web_sessions(session_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_chat_history_session ON chat_history(session_id);
CREATE INDEX IF NOT EXISTS idx_chat_history_timestamp ON chat_history(timestamp);
CREATE INDEX IF NOT EXISTS idx_chat_history_run_id ON chat_history(run_id);
EOF
log_info "  ✓ chat_history table created"

# Create agent_messages table for delegation tracking
log_info "Creating agent_messages table for delegation..."
sqlite3 "$DB_FILE" <<EOF
CREATE TABLE IF NOT EXISTS agent_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_agent TEXT NOT NULL,
  to_agent TEXT NOT NULL,
  message TEXT NOT NULL,
  context TEXT,
  created_at TEXT NOT NULL,
  session_id TEXT,
  status TEXT DEFAULT 'pending'
);
CREATE INDEX IF NOT EXISTS idx_agent_messages_from ON agent_messages(from_agent);
CREATE INDEX IF NOT EXISTS idx_agent_messages_to ON agent_messages(to_agent);
CREATE INDEX IF NOT EXISTS idx_agent_messages_session ON agent_messages(session_id);
EOF
log_info "  ✓ agent_messages table created"

log_info ""
log_info "================================================"
log_info "Database tables created successfully!"
log_info "================================================"
log_info ""
log_info "New tables:"
log_info "  - web_sessions: WebSocket session tracking"
log_info "  - chat_history: Chat message history"
log_info "  - agent_messages: Agent-to-agent delegation messages"
log_info ""
