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
Agent runs: start_task "nalu" "Build Blog" "Create NextJS project..."
     ↓
Container writes: /workspace/ipc/tasks/task-{timestamp}.json
     ↓
Host sees: data/ipc/{agent}/tasks/task-{timestamp}.json
     ↓
Background Task Watcher (websocket.ts) picks up file
     ↓
Creates task record, spawns container agent
     ↓
Task runs independently (singleMessage: true)
     ↓
Container completes, returns status + result
     ↓
Task marked completed/failed
     ↓
WhatsApp notification sent
```

## Using from Agents

### Method 1: start_task Binary (Recommended)

Agents can use the `start_task` bash command:

```bash
start_task "<agent>" "<task-name>" "<prompt>"
```

**Example:**
```bash
start_task "nalu" "Build Blog" "Create a new NextJS blog project with Tailwind CSS"
```

**For parallel tasks:**
```bash
start_task "hali" "Research Topics" "Research 5 blog topics about sustainable living"
start_task "nalu" "Build Blog Project" "Set up a NextJS blog project with Tailwind"
```

### Method 2: Direct IPC File

Alternatively, write a JSON file directly:

```bash
cat > /workspace/ipc/tasks/start-$(date +%s).json << 'EOF'
{
  "type": "background_task",
  "agentFolder": "nalu",
  "name": "Build Blog Project",
  "description": "Create NextJS blog with Tailwind CSS",
  "prompt": "Create a new NextJS blog project in /workspace/shared/blog"
}
EOF
```

## API

### RPC Methods

| Method | Description |
|--------|-------------|
| `task.start` | Start a new background task |
| `task.status` | Get status of a specific task |
| `task.list` | List all tasks (with optional filter) |
| `task.cancel` | Cancel a running task |
| `agent.logs` | Get container logs for an agent |

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

### agent.logs

```javascript
{
  method: 'agent.logs',
  params: {
    agentFolder: 'lucy',
    lines: 200,  // Optional, defaults to 200
    containerId: 'xxx'  // Optional, auto-detected if not provided
  }
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

The web OS includes:
- **Tasks page** (`/tasks`): Shows all running and completed tasks with real-time updates
- **Agent Logs** (Edit Agent → Logs tab): View container output for debugging

## Storage

Tasks are persisted to `data/tasks.json` and survive server restarts.

## Debugging

### Check if tasks are being processed

```bash
# Watch the task directory
ls -la data/ipc/lucy/tasks/

# Check task status
cat data/tasks.json | python3 -m json.tool

# Check container logs
docker logs nanoclaw-nalu-XXX
```

### Common Issues

1. **Task stuck in "running"**: Container may have hit API rate limit. Check container logs.
2. **Task failed with "Execution error"**: ZAI proxy may be down or rate limited.
3. **Task never started**: Check if task file was created in correct directory.

## Files

| File | Purpose |
|------|---------|
| `src/websocket.ts` | Task RPC handlers, background task watcher |
| `src/ipc.ts` | IPC handler for background_task type |
| `container/Dockerfile` | Contains start_task binary |
| `groups/lucy/CLAUDE.md` | Lucy's instructions for starting tasks |
| `we-hawaii-os/src/pages/Tasks.tsx` | Web UI for task monitoring |
| `we-hawaii-os/src/hooks/useTaskRpc.ts` | Frontend task RPC hook |
