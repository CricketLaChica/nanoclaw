#!/bin/bash
# NanoClaw Daily Backup Script
# Backs up store, data, logs, and groups to dated folder
# Excludes: node_modules, .git, and other large artifacts

set -e

SOURCE_DIR="/Users/lachicalife/lucy/nanoclaw"
BACKUP_DIR="/Volumes/drive/nanoclaw-backup"
DATE=$(date +%Y-%m-%d)
TODAY_DIR="$BACKUP_DIR/$DATE"

# Telegram config
TELEGRAM_TOKEN="8339828038:AAEgS88GvVbzuI0GBu7F6vP6KQ2BQUKAdp4"
TELEGRAM_CHAT_ID="8257522578"

# Send Telegram notification function
send_telegram_notification() {
    local message="$1"
    curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage" \
        -d "chat_id=${TELEGRAM_CHAT_ID}" \
        -d "text=${message}" \
        -d "parse_mode=Markdown" > /dev/null 2>&1 || true
}

# Ensure backup drive is mounted
if [ ! -d "$BACKUP_DIR" ]; then
    echo "Error: Backup drive not mounted at $BACKUP_DIR"
    send_telegram_notification "⚠️ *Backup Failed*\n\nBackup drive not mounted at $BACKUP_DIR"
    exit 1
fi

# Create today's backup directory
mkdir -p "$TODAY_DIR"

# Rsync options with exclusions
RSYNC_OPTS="-a --exclude='node_modules' --exclude='.git' --exclude='.gitignore' --exclude='dist' --exclude='build' --exclude='.DS_Store' --exclude='*.log'"

echo "Starting backup for $DATE..."
echo "Excluding: node_modules, .git, dist, build, .DS_Store"

# Backup store folder
eval "rsync $RSYNC_OPTS \"$SOURCE_DIR/store\" \"$TODAY_DIR/\""
echo "✓ store backed up"

# Backup data folder (but exclude node_modules in workspace)
eval "rsync $RSYNC_OPTS \"$SOURCE_DIR/data\" \"$TODAY_DIR/\""
echo "✓ data backed up"

# Backup logs folder (try data/logs first, fall back to logs)
if [ -d "$SOURCE_DIR/data/logs" ]; then
    eval "rsync $RSYNC_OPTS \"$SOURCE_DIR/data/logs\" \"$TODAY_DIR/\""
else
    eval "rsync $RSYNC_OPTS \"$SOURCE_DIR/logs\" \"$TODAY_DIR/\""
fi
echo "✓ logs backed up"

# Backup groups folder (excluding node_modules in any projects)
eval "rsync $RSYNC_OPTS \"$SOURCE_DIR/groups\" \"$TODAY_DIR/\""
echo "✓ groups backed up"

# Calculate total size
TOTAL_SIZE=$(du -sh "$TODAY_DIR" | cut -f1)

# Create a completion marker with stats
echo "Backup completed: $(date)" > "$TODAY_DIR/BACKUP_COMPLETE.txt"
echo "Size: $TOTAL_SIZE" >> "$TODAY_DIR/BACKUP_COMPLETE.txt"

echo "Backup complete: $TODAY_DIR"
echo "Total size: $TOTAL_SIZE"

# Send Telegram notification
send_telegram_notification "✅ *NanoClaw Backup Complete*\n\n📅 Date: ${DATE}\n💾 Size: ${TOTAL_SIZE}\n📂 Location: ${TODAY_DIR}\n\nBacked up folders:\n• store\n• data\n• logs\n• groups\n\n_Excluded: node_modules, .git, dist, build_"
