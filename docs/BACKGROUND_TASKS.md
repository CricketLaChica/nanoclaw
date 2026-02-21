# Background Tasks System

NanoClaw supports parallel, long-running background tasks that can run for minutes or hours independently.

## Overview

The background task system enables:
- **Parallel execution** - Multiple agents working simultaneously
- **Long-running tasks** - Tasks that take minutes or hours
- **WhatsApp notifications** - Get notified when tasks complete
- **Progress tracking** - Monitor task status via web UI

## Architecture

```
User Request → Lucy (orchestrator) → IPC background_task request
                                           ↓
                              Background Task Watcher (websocket.ts)
                                           ↓
                              Spawns container agent
                                           ↓
                              Task runs independently
                                           ↓
                              WhatsApp notification on completion
```

## API

### RPC Methods

| Method | Description |
|--------|-------------|
| `task.start` | Start a new background task |
| `task.status` | Get status of a specific task |
| `task.list` | List all tasks (with optional filter) |
| `task.cancel` | Cancel a running task |

### task.start

```javascript
{
  method: 'task.start',
  params: {
    name: 'Build Blog Project',
    description: 'Create NextJS blog with Tailwind',
    agentFolder: 'nalu',  // Optional, defaults to 'lucy'
    prompt: 'Create a NextJS blog project...',
    notifyOnComplete: true,  // Optional, defaults to true
    notifyJid: '120363422227220717@g.us'  // Optional
  }
}
```

### task.status

```javascript
{
  method: 'task.status',
  params: { taskId: 'task-1234567890-abc123' }
}
```

### task.list

```javascript
{
  method: 'task.list',
  params: {
    status: 'running',  // Optional: 'pending', 'running', 'completed', 'failed', 'cancelled'
    limit: 50  // Optional
  }
}
```

### task.cancel

```javascript
{
  method: 'task.cancel',
  params: { taskId: 'task-1234567890-abc123' }
}
```

## Using from Lucy

Lucy can start background tasks via the IPC system:

```bash
# Write a background task request
cat > /workspace/ipc/tasks/start-$(date +%s).json << 'EOF'
{
  "type": "background_task",
  "agentFolder": "nalu",
  "name": "Build Blog Project",
  "description": "Create NextJS blog with Tailwind CSS",
  "prompt": "Create a new NextJS blog project in /workspace/shared/blog with Tailwind CSS and a clean layout"
}
EOF
```

## IPC Format

To start a background task via IPC, write a JSON file to `/workspace/ipc/tasks/`:

```json
{
  "type": "background_task",
  "agentFolder": "nalu",
  "name": "Task Name",
  "description": "Task description",
  "prompt": "Detailed instructions for the agent",
  "notifyOnComplete": true,
  "notifyJid": "120363422227220717@g.us"
}
```

## Task States

| State | Description |
|-------|-------------|
| `pending` | Task queued, waiting to start |
| `running` | Task is actively executing |
| `completed` | Task finished successfully |
| `failed` | Task encountered an error |
| `cancelled` | Task was cancelled by user |

## Frontend Integration

The web OS includes a Tasks page at `/tasks` that shows:
- All running and completed tasks
- Real-time progress updates (5 second refresh)
- Task duration and status
- Results and error messages

## Storage

Tasks are persisted to `data/tasks.json` and survive server restarts.

## Example: Parallel Tasks

```
User: "Start a blog project and research sustainable living topics in parallel"

Lucy executes:
1. start_task "nalu" "Build Blog" "Create NextJS blog project..."
2. start_task "hali" "Research Topics" "Research 5 blog topics..."

Both tasks run simultaneously. User receives WhatsApp notification for each completion.
```

## Files

| File | Purpose |
|------|---------|
| `src/websocket.ts` | Task RPC handlers, background task watcher |
| `src/ipc.ts` | IPC handler for background_task type |
| `groups/lucy/CLAUDE.md` | Lucy's instructions for starting tasks |
| `we-hawaii-os/src/pages/Tasks.tsx` | Web UI for task monitoring |
| `we-hawaii-os/src/hooks/useTaskRpc.ts` | Frontend task RPC hook |
