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

## Key Invariants and Gotchas

- `container-pool.ts` uses `DATA_DIR` from `src/config.ts` — do NOT use `process.env.DATA_DIR || process.cwd(), 'data'`
- `src/utils/validation.ts` uses static ES module imports — no `require()` calls
- `memory-scheduler.ts` uses `MAIN_GROUP_JID` from config, not a hardcoded JID
- Auth rate limiting in `websocket.ts` only counts **failed** auth attempts (successful logins do not consume rate limit budget)
- WebSocket `bgTaskWatcherInterval` is cleared in `stopWebSocketServer()` to prevent resource leaks on shutdown
- Container names are `nanoclaw-{folder}-{8char-uuid}` — use regex `^nanoclaw-(.+)-[a-f0-9]{8}$` to extract folder

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
- `workflow-engine.ts` `executeSteps` - use `getRegisteredGroupByFolder(run.group_id)`
- `workflow-router.ts` all `case` blocks - use `getRegisteredGroupByFolder(groupFolder)`
- `workflow-router.ts` schedule case `chat_jid` - look up real JID via `getRegisteredGroupByFolder`
- Any RPC or engine function that takes `agentFolder`/`groupFolder` as param

## Additional Invariants (discovered in bug hunt)

- **Switch case lexical declarations**: Always wrap `case` blocks that use `const`/`let` in `{}` braces to avoid TDZ errors in strict mode. (`ipc.ts` `background_task` case)
- **Telegram thread JIDs**: Format is `tg:chatId:threadId` — `isValidJid()` regex must allow the optional `:threadId` suffix: `/^tg:-?\d+(:\d+)?$/`
- **Heartbeat JID stability**: Use stable strings for `chatJid` and `onProcess` JID arg — never two separate `Date.now()` calls that evaluate at different times (heartbeat.ts).
- **IPC sentinel path**: `_close` sentinel must use `DATA_DIR` from config, not `process.cwd()/data/ipc`. (`websocket.ts` `runAgentContainerAsync`)
- **Cleanup timers**: Call `.unref()` on cleanup `setTimeout` calls that only remove Map entries — prevents process hang. (`websocket.ts` `completeTelegramTask`)
- **Chat history ordering**: Fetch `getChatHistory` BEFORE calling `saveChatMessage` — otherwise the just-saved message appears twice in the agent prompt (in history + as "Current Message"). (`websocket.ts` `handleChatSend`)
- **Agent metadata filter**: Include `|| group.folder === 'main'` alongside `jid.endsWith('@nanoclaw.local')` when iterating registered groups. (`websocket.ts` `handleAgentsMetadata`)
- **`Array.push()` with no args**: `lines.push()` is a no-op that does NOT add a blank line — use `lines.push('')`. (`memory-scheduler.ts`)
- **`Array.filter()` result**: `.filter()` is non-mutating — must assign the result: `arr = arr.filter(...)`. (`workflow-router.ts` artifacts case)

