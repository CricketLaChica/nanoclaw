# Heartbeat System

NanoClaw includes a heartbeat system inspired by OpenClaw that periodically runs health checks and notifies you of anything needing attention.

## How It Works

- Runs every 30 minutes (configurable) during active hours
- Lucy reads `HEARTBEAT.md` and executes the checks
- If nothing needs attention → responds `HEARTBEAT_OK` (silent)
- If something needs attention → sends alert to your main channel (Telegram/WhatsApp)

## Configuration

Environment variables (in `src/config.ts`):

| Variable                       | Default                    | Description                |
| ------------------------------ | -------------------------- | -------------------------- |
| `HEARTBEAT_ENABLED`            | `true`                     | Enable/disable heartbeat   |
| `HEARTBEAT_INTERVAL_MS`        | `1800000`                  | Interval in ms (30 min)    |
| `HEARTBEAT_ACTIVE_HOURS_START` | `08:00`                    | Start of active hours      |
| `HEARTBEAT_ACTIVE_HOURS_END`   | `22:00`                    | End of active hours        |
| `HEARTBEAT_MODEL`              | `claude-sonnet-4-20250514` | Model for heartbeat checks |

## HEARTBEAT.md

Located at `data/workspace/HEARTBEAT.md` - editable from webOS.

The file contains check instructions. Example format:

```markdown
# Heartbeat Checks

Run these checks on every heartbeat. If anything needs attention, respond with what needs to be done. If nothing needs attention, respond with just `HEARTBEAT_OK`.

## System Checks

- Check if there are any failed background tasks
- Check if scheduled tasks are overdue
- Check system health status

## Project Checks

- Check if kanban-planner is running (port 3000)
- Check for errors in recent logs
```

## Active Hours

Heartbeat only runs between 8am-10pm local time (based on `TIMEZONE` config). Outside these hours, it's skipped.

## Alert Behavior

When Lucy finds something needing attention during heartbeat:

1. She responds with details about the issue
2. The system sends a message to your main group (Telegram or WhatsApp) with `💓 Heartbeat Alert` prefix
