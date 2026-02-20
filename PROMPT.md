# Ralph Loop Prompt: Fix NanoClaw Memory System

You are working on implementing a long-term memory system for NanoClaw (a multi-agent AI assistant system).

## Current Situation

The memory system has been CODED but is NOT WORKING. There are critical bugs preventing it from functioning.

## Your Task

Fix the memory system so it actually works. Keep iterating until all tasks below are complete.

## Critical Bugs to Fix

### Bug #1: TypeScript Module Import Issue
**Symptom:** `searchMemories()` function throws empty error when imported via tsx/node, even though the same query works when executed directly in Node.js.

**Files:** `src/memory.ts`

**Test:**
```bash
node -e "
import('./dist/memory.js').then(m => {
  const memories = m.getRelevantMemories('lucy', 'Cricket', 5);
  console.log('Found:', memories.length);
});
"
```

**Expected:** Should find 1 memory
**Actual:** Returns 0 and logs error

**Investigation:**
- The SQL query works when tested directly with `better-sqlite3`
- The query is: `SELECT m.* FROM memories m INNER JOIN memories_fts ON m.id = memories_fts.id WHERE m.agent_folder = ? AND memories_fts MATCH ? ORDER BY m.importance DESC, m.created_at DESC LIMIT ?`
- Something in the TypeScript compilation or import chain is broken

**Fix this bug completely.** The `getRelevantMemories()` function MUST work.

### Bug #2: Wrong Session Key in Memory Scheduler
**File:** `src/memory-scheduler.ts` line ~71

**Problem:** Uses hardcoded session key `'agent:${agentFolder}:main'` but actual sessions have UUIDs

**Current code:**
```typescript
const sessionKey = `agent:${agentFolder}:main`;
const history = getChatHistory(sessionKey, agentFolder, 100);
```

**Should be:** Query actual session from database:
```typescript
const sessionResult = db.prepare(
  `SELECT session_id FROM web_sessions WHERE agent_folder = ? ORDER BY last_active DESC LIMIT 1`
).get(agentFolder) as { session_id: string } | undefined;

if (!sessionResult) {
  logger.debug({ agentFolder, date }, 'No sessions found for agent');
  return;
}

const sessionKey = sessionResult.session_id;
```

**Fix this bug.**

### Bug #3: Database Schema Not Reproducible
**Problem:** Manual fixes were applied to `store/messages.db` but these won't happen automatically for new installations.

**Fix:** Create a migration script or ensure `db.ts` properly creates/updates the schema.

**Required FTS5 schema:**
```sql
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  id UNINDEXED,
  content,
  agent_folder,
  memory_type,
  importance,
  tokenize='porter unicode61'
);
```

**Ensure triggers are:**
```sql
CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(id, content, agent_folder, memory_type, importance)
  VALUES (new.id, new.content, new.agent_folder, new.memory_type, new.importance);
END;
```

## Testing Requirements

After each fix, YOU MUST TEST:

1. **Test search works:**
```bash
npm run build
node -e "
import('./dist/memory.js').then(m => {
  const results = m.searchMemories('lucy', 'Cricket', {});
  console.log('Found:', results.length);
  if (results.length > 0) console.log('First:', results[0]);
});
"
```

2. **Test memory extraction:**
```bash
npm run memory extract lucy
# Should extract memories, not fail
```

3. **Test CLI commands:**
```bash
npm run memory search lucy "Cricket"  # Should return results
npm run memory stats lucy            # Should show statistics
```

## Definition of Done

You are DONE when ALL of these work:

### Database & Storage
- [ ] All memory tables exist in `store/messages.db`
- [ ] FTS5 search works: `npm run memory search lucy "Cricket"` returns results
- [ ] Can insert memories without errors
- [ ] Triggers automatically sync to FTS5

### Memory Injection
- [ ] WebSocket: SOUL.md loads when user sends message
- [ ] WebSocket: Memories inject into agent prompts
- [ ] WhatsApp: SOUL.md loads for messages
- [ ] WhatsApp: Memories inject into agent prompts
- [ ] Logs show "Personality & Core Values:" or "Relevant Memories:"

### Daily Maintenance
- [ ] Daily task runs at 2 AM (check logs for "Running daily memory maintenance task")
- [ ] Extraction works: `npm run memory extract lucy` completes successfully
- [ ] Creates daily markdown files: `ls -la groups/lucy/memory/`

### Integration
- [ ] No TypeScript errors: `npm run build` succeeds
- [ ] No database errors in logs
- [ ] System works with running NanoClaw

## How to Iterate

1. **Pick ONE bug** to fix
2. **Make the code changes**
3. **Rebuild:** `npm run build`
4. **Test:** Run the appropriate test command
5. **If test passes:** Mark task as done by updating [ ] to [x] in docs/MEMORY_TASKS.md
6. **If test fails:** Investigate, fix again, retest
7. **When ALL bugs fixed:** Test the full system end-to-end
8. **Loop will automatically exit** when all tasks are marked [x]

## Important Notes

- The database at `store/messages.db` already has test data (3 memories)
- The FTS5 table may need to be recreated with correct schema
- Use `sqlite3 store/messages.db` to test queries directly
- Check logs in `groups/lucy/logs/` for errors
- Be thorough - one fix may break another thing

## Start Here

1. First, verify what's broken by running the test commands above
2. Fix Bug #1 (TypeScript import issue) - this is blocking everything
3. Fix Bug #2 (session key in scheduler)
4. Fix Bug #3 (database schema)
5. Test everything end-to-end

Keep iterating until ALL tests pass. Be persistent like Ralph Wiggum - fail, try again, fail, try again, until it works.

---

** iteration notes:**
(Use this space to track what you've tried and what worked/didn't)
