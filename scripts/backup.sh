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

ARCHIVE_NAME="nanoclaw-${DATE}.tar.gz"
ARCHIVE_PATH="/tmp/${ARCHIVE_NAME}"
DEST_PATH="${BACKUP_DIR}/${ARCHIVE_NAME}"

# Tar excludes
TAR_EXCLUDES=(
    --exclude='node_modules'
    --exclude='.git'
    --exclude='.gitignore'
    --exclude='dist'
    --exclude='build'
    --exclude='.DS_Store'
    --exclude='*.log'
)

echo "Starting backup for $DATE..."
echo "Creating archive at $ARCHIVE_PATH..."

# Build list of folders to include
FOLDERS=("store" "data" "groups")

# Compress to /tmp first (fast local disk)
tar -czf "$ARCHIVE_PATH" -C "$SOURCE_DIR" "${TAR_EXCLUDES[@]}" "${FOLDERS[@]}"
echo "✓ archive created"

# Move single file to external drive (one large sequential write = much faster)
echo "Copying to external drive..."
cp "$ARCHIVE_PATH" "$DEST_PATH"
rm "$ARCHIVE_PATH"
echo "✓ copied to $DEST_PATH"

# Calculate size
TOTAL_SIZE=$(du -sh "$DEST_PATH" | cut -f1)

echo "Backup complete: $DEST_PATH"
echo "Total size: $TOTAL_SIZE"

# Send Telegram notification
send_telegram_notification "✅ *NanoClaw Backup Complete*\n\n📅 Date: ${DATE}\n💾 Size: ${TOTAL_SIZE}\n📦 Archive: ${ARCHIVE_NAME}\n\nBacked up: store, data, groups\n_Excluded: node_modules, .git, dist, build_"
