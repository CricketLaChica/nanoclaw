# NanoClaw Memory System

Complete documentation for the long-term memory implementation.

## Overview

The memory system gives NanoClaw agents persistent long-term memory capabilities, allowing them to:

1. **Learn over time** - Remember facts, preferences, and patterns from conversations
2. **Maintain personality** - Have consistent personality traits across sessions
3. **Archive efficiently** - Compress and store old conversations without bloat
4. **Retrieve intelligently** - Find relevant memories based on current context

## Architecture

### Storage: Hybrid Approach

- **SQLite + FTS5** - Fast semantic search with BM25 ranking
- **Markdown files** - Human-readable daily logs for transparency
- **Personality files** - Editable configuration for each agent

```
groups/lucy/
├── memory/
│   ├── 2026-02-19.md          # Daily conversation summary
│   ├── 2026-02-18.md
│   └── archive/               # Old compressed logs
├── SOUL.md                     # Core personality
├── PERSONALITY.md              # Behavioral patterns
├── MEMORY.md                   # Curated long-term memory
├── USER.md                     # User profile
├── BOOTSTRAP.md                # First-run config
├── HEARTBEAT.md                # Checklists
└── CLAUDE.md                   # Current role definition
```

### Database Schema

```sql
-- Long-term memories
CREATE TABLE memories (
  id TEXT PRIMARY KEY,
  agent_folder TEXT NOT NULL,
  memory_type TEXT NOT NULL,  -- 'fact', 'preference', 'decision', 'event', 'pattern'
  content TEXT NOT NULL,
  importance INTEGER DEFAULT 1,  -- 1-10 scale
  created_at TEXT NOT NULL,
  last_accessed TEXT
);

-- Daily conversation summaries
CREATE TABLE daily_memories (
  date TEXT NOT NULL,
  agent_folder TEXT NOT NULL,
  summary TEXT NOT NULL,
  topics TEXT,  -- JSON array
  message_count INTEGER,
  PRIMARY KEY (date, agent_folder)
);

-- Memory relationships
CREATE TABLE memory_relationships (
  memory_id TEXT NOT NULL,
  related_memory_id TEXT NOT NULL,
  relationship_type TEXT NOT NULL,  -- 'follows', 'contradicts', 'relates_to'
  PRIMARY KEY (memory_id, related_memory_id)
);

-- Full-text search index
CREATE VIRTUAL TABLE memories_fts USING fts5(
  content,
  agent_folder,
  memory_type,
  importance,
  tokenize='porter unicode61'
);
```

## Usage

### Automatic Memory Injection

Memories are **automatically injected** into agent prompts during conversations:

1. **User sends a message** via WebSocket or WhatsApp
2. **System extracts keywords** from the message
3. **FTS5 search** finds relevant memories from the database
4. **Top 5 memories** are added to the prompt context
5. **Personality files** (SOUL.md) are also loaded
6. **Agent responds** with full context

### Memory Types

| Type | Description | Example |
|------|-------------|---------|
| `fact` | Specific information | "User is working on NanoClaw project" |
| `preference` | User likes/dislikes | "User prefers brief responses" |
| `decision` | Choices made | "Chose SQLite over PostgreSQL" |
| `event` | Important occurrences | "Deployed version 2.0 to production" |
| `pattern` | Recurring themes | "User often asks about Docker issues" |

### Importance Scale (1-10)

- **9-10**: Critical - user preferences, major decisions, must remember
- **7-8**: Significant - events, strong preferences, notable patterns
- **5-6**: Moderate - routine facts, useful information
- **3-4**: Minor - casual mentions
- **1-2**: Trivial - rarely relevant

Only memories with importance ≥3 are automatically saved.

## CLI Tool

Manage memories via command line:

```bash
# Show memory statistics
npm run memory stats lucy

# Search memories by content
npm run memory search lucy "TypeScript"

# List recent memories
npm run memory list lucy 50

# Show daily summary
npm run memory daily lucy 2026-02-19

# Generate full report
npm run memory report lucy

# Manually extract memories
npm run memory extract lucy

# List low-importance memories (dry-run cleanup)
npm run memory cleanup lucy
```

## Daily Maintenance

At **2 AM daily**, the system automatically:

1. **Extracts memories** from the past 24 hours of conversations
2. **Creates daily summary** with key topics
3. **Saves to database** and markdown file
4. **Archives old logs** (older than 30 days)

### Manual Daily Extraction

```bash
# Force memory extraction for an agent
npm run memory extract lucy
```

## Personality Files

### SOUL.md

Core identity and values. Edit to define agent's purpose:

```markdown
# Soul - Lucy's Core Identity

**You are Lucy**, the primary AI agent...

## Core Values
1. Clarity Over Complexity
2. Pragmatism
...
```

### PERSONALITY.md

Behavioral patterns and communication style.

### MEMORY.md

Manually curated long-term memory. Important facts that should always be remembered.

### USER.md

User profile and preferences learned over time.

### BOOTSTRAP.md

First-run configuration and welcome message.

### HEARTBEAT.md

Periodic health checks and maintenance tasks.

## Programmatic API

### Saving Memories

```typescript
import { saveMemory } from './memory.js';

saveMemory({
  agent_folder: 'lucy',
  memory_type: 'preference',
  content: 'User prefers TypeScript over JavaScript',
  importance: 7,
});
```

### Searching Memories

```typescript
import { searchMemories } from './memory.js';

const results = searchMemories('lucy', 'TypeScript', {
  type: 'preference',
  minImportance: 5,
  limit: 10,
});
```

### Getting Relevant Context

```typescript
import { getRelevantMemories } from './memory.js';

const memories = getRelevantMemories('lucy', currentMessage, 5);
```

### Daily Summaries

```typescript
import { createDailySummary } from './memory-extraction.js';

const summary = await createDailySummary('lucy', date, messages);
```

## Performance

- **FTS5 search**: <100ms for 1000+ memories
- **Memory injection**: Adds ~500 tokens per retrieval
- **Daily compression**: ~30 seconds for 100 messages
- **Storage**: ~1KB per memory, ~5KB per daily summary

## Troubleshooting

### Memories Not Being Retrieved

1. Check database exists: `ls data/messages.db`
2. Verify memories exist: `npm run memory list lucy`
3. Check search terms match content
4. Confirm importance threshold (≥3)

### Daily Task Not Running

1. Check scheduler is started: See logs for "Scheduler loop started"
2. Verify time zone: Default is system timezone
3. Run manually: `npm run memory extract lucy`

### Personality Files Not Loading

1. Check file exists: `ls groups/lucy/SOUL.md`
2. Verify permissions: Agent can read files
3. Check path is correct

## Future Enhancements

Potential improvements:

1. **Automatic memory consolidation** - Merge similar memories
2. **Decay function** - Reduce importance over time
3. **User feedback** - Allow users to rate memory relevance
4. **Cross-agent memory** - Share memories between related agents
5. **Embedding-based search** - Use vector embeddings for semantic search
6. **Memory editing UI** - Web interface for memory management

## Design Decisions

### Why SQLite + FTS5?

- ✅ Fast full-text search with BM25 ranking
- ✅ Zero dependencies (built into better-sqlite3)
- ✅ ACID compliance for reliability
- ✅ Easy to backup and migrate
- ✅ Human-readable with SQLite tools

### Why Hybrid Storage?

- ✅ Fast database search (SQLite)
- ✅ Human-readable logs (markdown)
- ✅ Easy manual editing (personality files)
- ✅ Best of both worlds

### Why Importances?

- ✅ Prevents memory bloat
- ✅ Prioritizes what matters
- ✅ Enables cleanup strategies
- ✅ Matches human memory (forgetting curve)

## Security & Privacy

- Memories stored locally in `data/messages.db`
- No external API calls for memory
- User controls all stored information
- Personality files are plain text (editable)
- Daily logs in markdown (transparent)

---

**Last Updated:** 2026-02-19
**Version:** 1.0.0
