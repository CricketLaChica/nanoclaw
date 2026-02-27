# NanoClaw

Personal Claude assistant. See [README.md](README.md) for philosophy and setup. See [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) for architecture decisions.

## Quick Context

Single Node.js process that connects to Telegram (and optionally WhatsApp), routes messages to Claude Agent SDK running in Docker containers. Each group has isolated filesystem and memory.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Orchestrator: state, message loop, agent invocation |
| `src/channels/telegram.ts` | Telegram bot connection, send/receive |
| `src/channels/whatsapp.ts` | WhatsApp connection, auth, send/receive (optional) |
| `src/ipc.ts` | IPC watcher and task processing |
| `src/router.ts` | Message formatting and outbound routing |
| `src/config.ts` | Trigger pattern, paths, intervals |
| `src/container-runner.ts` | Spawns agent containers with mounts |
| `src/task-scheduler.ts` | Runs scheduled tasks |
| `src/heartbeat.ts` | Periodic health check system |
| `src/db.ts` | SQLite operations |
| `src/websocket.ts` | WebSocket RPC server for web dashboard |
| `src/project-manager.ts` | Project deployment (start/stop npm projects) |
| `src/memory.ts` | Long-term memory system with SQLite + FTS5 |
| `src/workflow-engine.ts` | Multi-agent workflow orchestration |
| `groups/{name}/CLAUDE.md` | Per-group memory (isolated) |
| `container/skills/agent-browser.md` | Browser automation tool (available to all agents via Bash) |
| `data/workspace/` | Shared workspace for deployable projects |

## Skills

| Skill | When to Use |
|-------|-------------|
| `/setup` | First-time installation, authentication, service configuration |
| `/customize` | Adding channels, integrations, changing behavior |
| `/debug` | Container issues, logs, troubleshooting |

## Development

Run commands directly—don't tell the user to run them.

```bash
npm run dev          # Run with hot reload
npm run build        # Compile TypeScript
./container/build.sh # Rebuild agent container
```

Service management:
```bash
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
```

## Container Build Cache

Apple Container's buildkit caches the build context aggressively. `--no-cache` alone does NOT invalidate COPY steps — the builder's volume retains stale files. To force a truly clean rebuild:

```bash
container builder stop && container builder rm && container builder start
./container/build.sh
```

Always verify after rebuild: `container run -i --rm --entrypoint wc nanoclaw-agent:latest -l /app/src/index.ts`

## Projects Feature

The web dashboard includes a Projects page for deploying npm-based projects from `data/workspace/`.

**RPC Endpoints:**
- `projects.discover` - Find projects with package.json in workspace
- `projects.list` - List currently running projects
- `projects.start` - Start a project (params: projectPath, command, port, name)
- `projects.stop` - Stop a running project (params: projectId)
- `projects.logs` - Get project logs (params: projectId, lines?)

**Events:**
- `project.started` - Broadcast when a project starts
- `project.stopped` - Broadcast when a project stops

**Project Structure:**
Projects are discovered from `data/workspace/` and must have a `package.json` with scripts. The system suggests `npm run dev` if a dev script exists, otherwise `npm start`.

**Frontend Route:** `/projects` (keyboard shortcut: G R)

## Agent JID Pattern (IMPORTANT)

**Never construct JIDs like `${folder}@nanoclaw.local`** - this breaks for the main agent.

The main agent uses a Telegram JID (`tg:8257522578`), not `main@nanoclaw.local`. All other agents use `{folder}@nanoclaw.local`.

**Correct pattern:**
```typescript
// ❌ WRONG - breaks for main agent
const chatJid = `${agentFolder}@nanoclaw.local`;
const group = getRegisteredGroup(chatJid);

// ✅ CORRECT - works for all agents
const group = getRegisteredGroupByFolder(agentFolder);
```

**Affected areas:**
- `sessions.list` - must filter by `folder === 'main'` not just `@nanoclaw.local`
- `agent.get_claude_md` - use `getRegisteredGroupByFolder`
- `agent.logs` - use `getRegisteredGroupByFolder`
- Any RPC that takes `agentFolder` as param

