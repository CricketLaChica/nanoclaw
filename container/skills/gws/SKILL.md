# Google Workspace (gws) Skill

Use the `gws` CLI to interact with Google Workspace services: Gmail, Calendar, Drive, Docs, Sheets, Chat, Tasks, and more.

## Usage

Run `gws` commands via Bash. The CLI is pre-installed and credentials are already configured.

```bash
# List available commands
gws --help

# Gmail
gws gmail list-messages --query "is:unread" --max-results 10
gws gmail send --to "user@example.com" --subject "Subject" --body "Body"
gws gmail get-message --id <message-id>

# Calendar
gws calendar list-events --calendar-id primary --max-results 10
gws calendar create-event --summary "Meeting" --start "2026-03-12T10:00:00" --end "2026-03-12T11:00:00"

# Drive
gws drive list-files --query "name contains 'report'"
gws drive upload --file /path/to/file --name "filename"
gws drive download --file-id <id> --output /workspace/group/file.txt

# Docs
gws docs get --document-id <id>
gws docs append --document-id <id> --text "New content"

# Sheets
gws sheets read --spreadsheet-id <id> --range "Sheet1!A1:Z100"
gws sheets append --spreadsheet-id <id> --range "Sheet1" --values '[["col1","col2"]]'

# Tasks
gws tasks list --tasklist "@default"
gws tasks create --tasklist "@default" --title "New task"

# Chat
gws chat list-spaces
gws chat send-message --space <space-name> --text "Hello"
```

## Tips

- IDs for Drive files, Sheets, Docs, etc. can be found in the URL of the item
- For Calendar, `primary` refers to the user's main calendar
- Use `gws <service> --help` to see all options for a service
- Output is JSON by default — pipe through `python3 -c "import json,sys; ..."` or use `--format table` for readable output
