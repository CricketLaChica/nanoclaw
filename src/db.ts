import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { ASSISTANT_NAME, DATA_DIR, STORE_DIR } from './config.js';
import { NewMessage, RegisteredGroup, ScheduledTask, TaskRunLog } from './types.js';
import { logger } from './logger.js';

export let db: Database.Database;

function createSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS chats (
      jid TEXT PRIMARY KEY,
      name TEXT,
      last_message_time TEXT
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT,
      chat_jid TEXT,
      sender TEXT,
      sender_name TEXT,
      content TEXT,
      timestamp TEXT,
      is_from_me INTEGER,
      is_bot_message INTEGER DEFAULT 0,
      PRIMARY KEY (id, chat_jid),
      FOREIGN KEY (chat_jid) REFERENCES chats(jid)
    );
    CREATE INDEX IF NOT EXISTS idx_timestamp ON messages(timestamp);

    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      prompt TEXT NOT NULL,
      schedule_type TEXT NOT NULL,
      schedule_value TEXT NOT NULL,
      next_run TEXT,
      last_run TEXT,
      last_result TEXT,
      status TEXT DEFAULT 'active',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_next_run ON scheduled_tasks(next_run);
    CREATE INDEX IF NOT EXISTS idx_status ON scheduled_tasks(status);

    CREATE TABLE IF NOT EXISTS task_run_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      run_at TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      status TEXT NOT NULL,
      result TEXT,
      error TEXT,
      FOREIGN KEY (task_id) REFERENCES scheduled_tasks(id)
    );
    CREATE INDEX IF NOT EXISTS idx_task_run_logs ON task_run_logs(task_id, run_at);

    CREATE TABLE IF NOT EXISTS router_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      group_folder TEXT PRIMARY KEY,
      session_id TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS registered_groups (
      jid TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      folder TEXT NOT NULL UNIQUE,
      trigger_pattern TEXT NOT NULL,
      added_at TEXT NOT NULL,
      container_config TEXT,
      requires_trigger INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      agent_folder TEXT NOT NULL,
      memory_type TEXT NOT NULL,
      content TEXT NOT NULL,
      importance INTEGER DEFAULT 1,
      created_at TEXT NOT NULL,
      last_accessed TEXT,
      FOREIGN KEY (agent_folder) REFERENCES registered_groups(folder)
    );

    CREATE TABLE IF NOT EXISTS daily_memories (
      date TEXT NOT NULL,
      agent_folder TEXT NOT NULL,
      summary TEXT NOT NULL,
      topics TEXT,
      message_count INTEGER,
      PRIMARY KEY (date, agent_folder)
    );

    CREATE TABLE IF NOT EXISTS memory_relationships (
      memory_id TEXT NOT NULL,
      related_memory_id TEXT NOT NULL,
      relationship_type TEXT NOT NULL,
      PRIMARY KEY (memory_id, related_memory_id),
      FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS tags (
      id TEXT PRIMARY KEY,
      agent_folder TEXT NOT NULL,
      name TEXT NOT NULL UNIQUE,
      color TEXT DEFAULT '#3B82F6',
      created_at TEXT NOT NULL,
      FOREIGN KEY (agent_folder) REFERENCES registered_groups(folder)
    );

    CREATE TABLE IF NOT EXISTS memory_tags (
      memory_id TEXT NOT NULL,
      tag_id TEXT NOT NULL,
      PRIMARY KEY (memory_id, tag_id),
      FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE CASCADE,
      FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_memories_agent_folder ON memories(agent_folder);
    CREATE INDEX IF NOT EXISTS idx_memories_created_at ON memories(created_at);
    CREATE INDEX IF NOT EXISTS idx_memories_importance ON memories(importance);

    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
      id UNINDEXED,
      content,
      agent_folder,
      memory_type,
      importance,
      tokenize='porter unicode61'
    );

    CREATE TABLE IF NOT EXISTS goals (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      progress INTEGER DEFAULT 0,
      target INTEGER DEFAULT 100,
      deadline TEXT,
      type TEXT DEFAULT 'short',
      status TEXT DEFAULT 'active',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_goals_status ON goals(status);
    CREATE INDEX IF NOT EXISTS idx_goals_type ON goals(type);
    CREATE INDEX IF NOT EXISTS idx_goals_deadline ON goals(deadline);
  `);

  // Add last_read_at column to web_sessions if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE web_sessions ADD COLUMN last_read_at TEXT`,
    );
  } catch {
    /* column already exists */
  }

  // Add context_mode column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE scheduled_tasks ADD COLUMN context_mode TEXT DEFAULT 'isolated'`,
    );
  } catch {
    /* column already exists */
  }

  // Add is_bot_message column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE messages ADD COLUMN is_bot_message INTEGER DEFAULT 0`,
    );
    // Backfill: mark existing bot messages that used the content prefix pattern
    database.prepare(
      `UPDATE messages SET is_bot_message = 1 WHERE content LIKE ?`,
    ).run(`${ASSISTANT_NAME}:%`);
  } catch {
    /* column already exists */
  }

  // Create FTS triggers for memories (idempotent)
  // Note: The UPDATE trigger only fires when FTS-relevant columns change
  // to avoid "unsafe use of virtual table" errors when updating last_accessed
  try {
    database.exec(`
      CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(id, content, agent_folder, memory_type, importance)
        VALUES (new.id, new.content, new.agent_folder, new.memory_type, new.importance);
      END;

      CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, id)
        VALUES ('delete', old.id);
      END;

      CREATE TRIGGER memories_au AFTER UPDATE OF content, agent_folder, memory_type, importance ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, id)
        VALUES ('delete', old.id);
        INSERT INTO memories_fts(id, content, agent_folder, memory_type, importance)
        VALUES (new.id, new.content, new.agent_folder, new.memory_type, new.importance);
      END;
    `);
  } catch {
    /* triggers already exist */
  }

  // Add custom metadata columns for registered_groups (agent customization)
  try {
    database.exec(
      `ALTER TABLE registered_groups ADD COLUMN display_name TEXT`,
    );
  } catch {
    /* column already exists */
  }

  try {
    database.exec(
      `ALTER TABLE registered_groups ADD COLUMN custom_description TEXT`,
    );
  } catch {
    /* column already exists */
  }

  try {
    database.exec(
      `ALTER TABLE registered_groups ADD COLUMN icon_type TEXT DEFAULT 'emoji'`,
    );
  } catch {
    /* column already exists */
  }

  try {
    database.exec(
      `ALTER TABLE registered_groups ADD COLUMN icon_value TEXT DEFAULT '🤖'`,
    );
  } catch {
    /* column already exists */
  }

  // --- Workflow tables ---

  database.exec(`
    CREATE TABLE IF NOT EXISTS workflow_runs (
      id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL,
      group_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending','running','paused','completed','failed','escalated')),
      input TEXT,
      context TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT,
      FOREIGN KEY (group_id) REFERENCES registered_groups(folder)
    );
    CREATE INDEX IF NOT EXISTS idx_workflow_runs_status ON workflow_runs(status);
    CREATE INDEX IF NOT EXISTS idx_workflow_runs_group ON workflow_runs(group_id);

    CREATE TABLE IF NOT EXISTS workflow_steps (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      step_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      status TEXT CHECK(status IN ('pending','running','completed','failed','skipped')),
      input TEXT,
      output TEXT,
      error TEXT,
      retries INTEGER DEFAULT 0,
      started_at TEXT,
      completed_at TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (run_id) REFERENCES workflow_runs(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_workflow_steps_run ON workflow_steps(run_id);
    CREATE INDEX IF NOT EXISTS idx_workflow_steps_status ON workflow_steps(status);

    CREATE TABLE IF NOT EXISTS workflow_artifacts (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      step_id TEXT,
      artifact_type TEXT,
      path TEXT,
      metadata TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (run_id) REFERENCES workflow_runs(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_workflow_artifacts_run ON workflow_artifacts(run_id);

    CREATE TABLE IF NOT EXISTS workflow_metrics (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      step_id TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      container_start_ms INTEGER NOT NULL,
      agent_execution_ms INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (run_id) REFERENCES workflow_runs(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_workflow_metrics_run ON workflow_metrics(run_id);
  `);

  // Add performance indexes for frequently queried columns
  database.exec(`
    -- Index for bot message filtering (used in getNewMessages, getMessagesSince)
    CREATE INDEX IF NOT EXISTS idx_messages_bot_message ON messages(is_bot_message);

    -- Index for memory access patterns
    CREATE INDEX IF NOT EXISTS idx_memories_last_accessed ON memories(last_accessed);

    -- Composite index for workflow step queries (status + run_id)
    CREATE INDEX IF NOT EXISTS idx_workflow_steps_run_status ON workflow_steps(run_id, status);

    -- Index for chat history queries
    CREATE INDEX IF NOT EXISTS idx_chat_history_session_timestamp ON chat_history(session_id, timestamp);
  `);
}

export function initDatabase(): void {
  const dbPath = path.join(STORE_DIR, 'messages.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  db = new Database(dbPath);
  db.pragma('foreign_keys = ON'); // Enable foreign key constraints
  createSchema(db);

  // Migrate from JSON files if they exist
  migrateJsonState();
}

/** @internal - for tests only. Creates a fresh in-memory database. */
export function _initTestDatabase(): void {
  db = new Database(':memory:');
  createSchema(db);
}

/**
 * Store chat metadata only (no message content).
 * Used for all chats to enable group discovery without storing sensitive content.
 */
export function storeChatMetadata(
  chatJid: string,
  timestamp: string,
  name?: string,
): void {
  if (name) {
    // Update with name, preserving existing timestamp if newer
    db.prepare(
      `
      INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET
        name = excluded.name,
        last_message_time = MAX(last_message_time, excluded.last_message_time)
    `,
    ).run(chatJid, name, timestamp);
  } else {
    // Update timestamp only, preserve existing name if any
    db.prepare(
      `
      INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET
        last_message_time = MAX(last_message_time, excluded.last_message_time)
    `,
    ).run(chatJid, chatJid, timestamp);
  }
}

/**
 * Update chat name without changing timestamp for existing chats.
 * New chats get the current time as their initial timestamp.
 * Used during group metadata sync.
 */
export function updateChatName(chatJid: string, name: string): void {
  db.prepare(
    `
    INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)
    ON CONFLICT(jid) DO UPDATE SET name = excluded.name
  `,
  ).run(chatJid, name, new Date().toISOString());
}

export interface ChatInfo {
  jid: string;
  name: string;
  last_message_time: string;
}

/**
 * Get all known chats, ordered by most recent activity.
 */
export function getAllChats(): ChatInfo[] {
  return db
    .prepare(
      `
    SELECT jid, name, last_message_time
    FROM chats
    ORDER BY last_message_time DESC
  `,
    )
    .all() as ChatInfo[];
}

/**
 * Get timestamp of last group metadata sync.
 */
export function getLastGroupSync(): string | null {
  // Store sync time in a special chat entry
  const row = db
    .prepare(`SELECT last_message_time FROM chats WHERE jid = '__group_sync__'`)
    .get() as { last_message_time: string } | undefined;
  return row?.last_message_time || null;
}

/**
 * Record that group metadata was synced.
 */
export function setLastGroupSync(): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT OR REPLACE INTO chats (jid, name, last_message_time) VALUES ('__group_sync__', '__group_sync__', ?)`,
  ).run(now);
}

/**
 * Store a message with full content.
 * Only call this for registered groups where message history is needed.
 */
export function storeMessage(msg: NewMessage): void {
  db.prepare(
    `INSERT OR REPLACE INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    msg.id,
    msg.chat_jid,
    msg.sender,
    msg.sender_name,
    msg.content,
    msg.timestamp,
    msg.is_from_me ? 1 : 0,
    msg.is_bot_message ? 1 : 0,
  );
}

/**
 * Store a message directly (for non-WhatsApp channels that don't use Baileys proto).
 */
export function storeMessageDirect(msg: {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me: boolean;
  is_bot_message?: boolean;
}): void {
  db.prepare(
    `INSERT OR REPLACE INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    msg.id,
    msg.chat_jid,
    msg.sender,
    msg.sender_name,
    msg.content,
    msg.timestamp,
    msg.is_from_me ? 1 : 0,
    msg.is_bot_message ? 1 : 0,
  );
}

export function getNewMessages(
  jids: string[],
  lastTimestamp: string,
  botPrefix: string,
): { messages: NewMessage[]; newTimestamp: string } {
  if (jids.length === 0) return { messages: [], newTimestamp: lastTimestamp };

  const placeholders = jids.map(() => '?').join(',');
  // Filter bot messages using both the is_bot_message flag AND the content
  // prefix as a backstop for messages written before the migration ran.
  const sql = `
    SELECT id, chat_jid, sender, sender_name, content, timestamp
    FROM messages
    WHERE timestamp > ? AND chat_jid IN (${placeholders})
      AND is_bot_message = 0 AND content NOT LIKE ?
    ORDER BY timestamp
  `;

  const rows = db
    .prepare(sql)
    .all(lastTimestamp, ...jids, `${botPrefix}:%`) as NewMessage[];

  let newTimestamp = lastTimestamp;
  for (const row of rows) {
    if (row.timestamp > newTimestamp) newTimestamp = row.timestamp;
  }

  return { messages: rows, newTimestamp };
}

export function getMessagesSince(
  chatJid: string,
  sinceTimestamp: string,
  botPrefix: string,
): NewMessage[] {
  // Filter bot messages using both the is_bot_message flag AND the content
  // prefix as a backstop for messages written before the migration ran.
  const sql = `
    SELECT id, chat_jid, sender, sender_name, content, timestamp
    FROM messages
    WHERE chat_jid = ? AND timestamp > ?
      AND is_bot_message = 0 AND content NOT LIKE ?
    ORDER BY timestamp
  `;
  return db
    .prepare(sql)
    .all(chatJid, sinceTimestamp, `${botPrefix}:%`) as NewMessage[];
}

export function createTask(
  task: Omit<ScheduledTask, 'last_run' | 'last_result'> & Partial<Pick<ScheduledTask, 'task_type' | 'workflow_id'>>,
): void {
  db.prepare(
    `
    INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, context_mode, next_run, status, created_at, task_type, workflow_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    task.id,
    task.group_folder,
    task.chat_jid,
    task.prompt,
    task.schedule_type,
    task.schedule_value,
    task.context_mode || 'isolated',
    task.next_run,
    task.status,
    task.created_at,
    task.task_type || null,
    task.workflow_id || null,
  );
}

export function getTaskById(id: string): ScheduledTask | undefined {
  return db.prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get(id) as
    | ScheduledTask
    | undefined;
}

export function getTasksForGroup(groupFolder: string): ScheduledTask[] {
  return db
    .prepare(
      'SELECT * FROM scheduled_tasks WHERE group_folder = ? ORDER BY created_at DESC',
    )
    .all(groupFolder) as ScheduledTask[];
}

export function getAllTasks(): ScheduledTask[] {
  return db
    .prepare('SELECT * FROM scheduled_tasks ORDER BY created_at DESC')
    .all() as ScheduledTask[];
}

export function updateTask(
  id: string,
  updates: Partial<
    Pick<
      ScheduledTask,
      'prompt' | 'schedule_type' | 'schedule_value' | 'next_run' | 'status'
    >
  >,
): void {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.prompt !== undefined) {
    fields.push('prompt = ?');
    values.push(updates.prompt);
  }
  if (updates.schedule_type !== undefined) {
    fields.push('schedule_type = ?');
    values.push(updates.schedule_type);
  }
  if (updates.schedule_value !== undefined) {
    fields.push('schedule_value = ?');
    values.push(updates.schedule_value);
  }
  if (updates.next_run !== undefined) {
    fields.push('next_run = ?');
    values.push(updates.next_run);
  }
  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
  }

  if (fields.length === 0) return;

  values.push(id);
  db.prepare(
    `UPDATE scheduled_tasks SET ${fields.join(', ')} WHERE id = ?`,
  ).run(...values);
}

export function deleteTask(id: string): void {
  // Use transaction to ensure atomic deletion
  const deleteTaskTransaction = db.transaction((taskId: string) => {
    // Delete child records first (FK constraint)
    db.prepare('DELETE FROM task_run_logs WHERE task_id = ?').run(taskId);
    db.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(taskId);
  });
  deleteTaskTransaction(id);
}

export function getDueTasks(): ScheduledTask[] {
  const now = new Date().toISOString();
  return db
    .prepare(
      `
    SELECT * FROM scheduled_tasks
    WHERE status = 'active' AND next_run IS NOT NULL AND next_run <= ?
    ORDER BY next_run
  `,
    )
    .all(now) as ScheduledTask[];
}

export function updateTaskAfterRun(
  id: string,
  nextRun: string | null,
  lastResult: string,
): void {
  const now = new Date().toISOString();
  db.prepare(
    `
    UPDATE scheduled_tasks
    SET next_run = ?, last_run = ?, last_result = ?, status = CASE WHEN ? IS NULL THEN 'completed' ELSE status END
    WHERE id = ?
  `,
  ).run(nextRun, now, lastResult, nextRun, id);
}

export function logTaskRun(log: TaskRunLog): void {
  db.prepare(
    `
    INSERT INTO task_run_logs (task_id, run_at, duration_ms, status, result, error)
    VALUES (?, ?, ?, ?, ?, ?)
  `,
  ).run(
    log.task_id,
    log.run_at,
    log.duration_ms,
    log.status,
    log.result,
    log.error,
  );
}

// --- Router state accessors ---

export function getRouterState(key: string): string | undefined {
  const row = db
    .prepare('SELECT value FROM router_state WHERE key = ?')
    .get(key) as { value: string } | undefined;
  return row?.value;
}

export function setRouterState(key: string, value: string): void {
  db.prepare(
    'INSERT OR REPLACE INTO router_state (key, value) VALUES (?, ?)',
  ).run(key, value);
}

// --- Session accessors ---

export function getSession(groupFolder: string): string | undefined {
  const row = db
    .prepare('SELECT session_id FROM sessions WHERE group_folder = ?')
    .get(groupFolder) as { session_id: string } | undefined;
  return row?.session_id;
}

export function setSession(groupFolder: string, sessionId: string): void {
  db.prepare(
    'INSERT OR REPLACE INTO sessions (group_folder, session_id) VALUES (?, ?)',
  ).run(groupFolder, sessionId);
}

export function getAllSessions(): Record<string, string> {
  const rows = db
    .prepare('SELECT group_folder, session_id FROM sessions')
    .all() as Array<{ group_folder: string; session_id: string }>;
  const result: Record<string, string> = {};
  for (const row of rows) {
    result[row.group_folder] = row.session_id;
  }
  return result;
}

// --- Registered group accessors ---

export function getRegisteredGroup(
  jid: string,
): (RegisteredGroup & { jid: string }) | undefined {
  const row = db
    .prepare('SELECT * FROM registered_groups WHERE jid = ?')
    .get(jid) as
    | {
        jid: string;
        name: string;
        folder: string;
        trigger_pattern: string;
        added_at: string;
        container_config: string | null;
        requires_trigger: number | null;
        display_name: string | null;
        custom_description: string | null;
        icon_type: string | null;
        icon_value: string | null;
      }
    | undefined;
  if (!row) return undefined;
  return {
    jid: row.jid,
    name: row.name,
    folder: row.folder,
    trigger: row.trigger_pattern,
    added_at: row.added_at,
    containerConfig: row.container_config
      ? JSON.parse(row.container_config)
      : undefined,
    displayName: row.display_name || undefined,
    customDescription: row.custom_description || undefined,
    iconType: (row.icon_type as 'emoji' | 'image') || 'emoji',
    iconValue: row.icon_value || '🤖',
  };
}

export function setRegisteredGroup(
  jid: string,
  group: RegisteredGroup,
): void {
  db.prepare(
    `INSERT OR REPLACE INTO registered_groups (jid, name, folder, trigger_pattern, added_at, container_config, display_name, custom_description, icon_type, icon_value)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    jid,
    group.name,
    group.folder,
    group.trigger,
    group.added_at,
    group.containerConfig ? JSON.stringify(group.containerConfig) : null,
    group.displayName || null,
    group.customDescription || null,
    group.iconType || 'emoji',
    group.iconValue || '🤖',
  );
}

export function getAllRegisteredGroups(): Record<string, RegisteredGroup> {
  const rows = db
    .prepare('SELECT * FROM registered_groups')
    .all() as Array<{
    jid: string;
    name: string;
    folder: string;
    trigger_pattern: string;
    added_at: string;
    container_config: string | null;
    display_name: string | null;
    custom_description: string | null;
    icon_type: string | null;
    icon_value: string | null;
  }>;
  const result: Record<string, RegisteredGroup> = {};
  for (const row of rows) {
    result[row.jid] = {
      name: row.name,
      folder: row.folder,
      trigger: row.trigger_pattern,
      added_at: row.added_at,
      containerConfig: row.container_config
        ? JSON.parse(row.container_config)
        : undefined,
      displayName: row.display_name || undefined,
      customDescription: row.custom_description || undefined,
      iconType: (row.icon_type as 'emoji' | 'image') || 'emoji',
      iconValue: row.icon_value || '🤖',
    };
  }
  return result;
}

// --- WebSocket and chat history ---

export interface ChatHistoryMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
}

export function getAllGroups(): Record<string, RegisteredGroup> {
  return getAllRegisteredGroups();
}

export interface ChatHistoryResult {
  messages: ChatHistoryMessage[];
  hasMore: boolean;
  total: number;
}

export function getChatHistory(
  sessionId: string,
  agentFolder: string,
  limit: number = 20,
  before?: string, // ISO timestamp for pagination - get messages older than this
): ChatHistoryResult {
  try {
    // Get total count for this session
    const countRow = db
      .prepare('SELECT COUNT(*) as count FROM chat_history WHERE session_id = ?')
      .get(sessionId) as { count: number };
    const total = countRow.count;

    // Build query with optional before filter
    let query: string;
    let params: (string | number)[];

    if (before) {
      // Get messages older than 'before' timestamp
      query = `SELECT role, content, timestamp
               FROM chat_history
               WHERE session_id = ? AND timestamp < ?
               ORDER BY timestamp DESC
               LIMIT ?`;
      params = [sessionId, before, limit];
    } else {
      // Get most recent messages
      query = `SELECT role, content, timestamp
               FROM chat_history
               WHERE session_id = ?
               ORDER BY timestamp DESC
               LIMIT ?`;
      params = [sessionId, limit];
    }

    const rows = db
      .prepare(query)
      .all(...params) as Array<{
      role: string;
      content: string;
      timestamp: string;
    }>;

    const messages = rows
      .filter((row) => row.role === 'user' || row.role === 'assistant')
      .map((row) => ({
        role: row.role as 'user' | 'assistant',
        content: row.content,
        timestamp: row.timestamp,
      }))
      .reverse(); // Reverse to get oldest-first order for display

    // Check if there are more messages
    const hasMore = before
      ? rows.length === limit
      : total > limit;

    return { messages, hasMore, total };
  } catch (error) {
    logger.error({ sessionId, agentFolder, limit, before, error }, 'Failed to get chat history');
    return { messages: [], hasMore: false, total: 0 };
  }
}

export function saveChatMessage(
  sessionId: string,
  agentFolder: string,
  role: 'user' | 'assistant',
  content: string,
): void {
  const timestamp = new Date().toISOString();

  // Use transaction to ensure atomic session + message creation
  const saveMessageTransaction = db.transaction(() => {
    // Create session if it doesn't exist
    const sessionExists = db
      .prepare('SELECT session_id FROM web_sessions WHERE session_id = ?')
      .get(sessionId);
    if (!sessionExists) {
      db.prepare(
        'INSERT INTO web_sessions (session_id, agent_folder, created_at, last_active) VALUES (?, ?, ?, ?)',
      ).run(sessionId, agentFolder, timestamp, timestamp);
    } else {
      // Update last_active
      db.prepare('UPDATE web_sessions SET last_active = ? WHERE session_id = ?').run(
        timestamp,
        sessionId,
      );
    }

    // Save message
    db.prepare(
      'INSERT INTO chat_history (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)',
    ).run(sessionId, role, content, timestamp);
  });

  saveMessageTransaction();
}

// Mark a chat session as read (update last_read_at timestamp)
export function markChatAsRead(sessionId: string): void {
  const timestamp = new Date().toISOString();

  // Update or create session with last_read_at
  const sessionExists = db
    .prepare('SELECT session_id FROM web_sessions WHERE session_id = ?')
    .get(sessionId);

  if (sessionExists) {
    db.prepare('UPDATE web_sessions SET last_read_at = ? WHERE session_id = ?').run(
      timestamp,
      sessionId,
    );
  } else {
    // Extract agent_folder from sessionId (format: agent:{folder}:main)
    const match = sessionId.match(/^agent:([^:]+):/);
    const agentFolder = match ? match[1] : 'unknown';
    db.prepare(
      'INSERT INTO web_sessions (session_id, agent_folder, created_at, last_active, last_read_at) VALUES (?, ?, ?, ?, ?)',
    ).run(sessionId, agentFolder, timestamp, timestamp, timestamp);
  }
}

// Check if an agent has unread messages (messages newer than last_read_at)
export function hasUnreadMessages(sessionId: string): boolean {
  const session = db
    .prepare('SELECT last_read_at FROM web_sessions WHERE session_id = ?')
    .get(sessionId) as { last_read_at: string | null } | undefined;

  if (!session || !session.last_read_at) {
    // Never read - check if there are any messages
    const messageCount = db
      .prepare('SELECT COUNT(*) as count FROM chat_history WHERE session_id = ?')
      .get(sessionId) as { count: number };
    return messageCount.count > 0;
  }

  // Check for messages newer than last_read_at
  const unreadCount = db
    .prepare(
      'SELECT COUNT(*) as count FROM chat_history WHERE session_id = ? AND timestamp > ?',
    )
    .get(sessionId, session.last_read_at) as { count: number };

  return unreadCount.count > 0;
}

// --- JSON migration ---

function migrateJsonState(): void {
  const migrateFile = (filename: string) => {
    const filePath = path.join(DATA_DIR, filename);
    if (!fs.existsSync(filePath)) return null;
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      fs.renameSync(filePath, `${filePath}.migrated`);
      return data;
    } catch {
      return null;
    }
  };

  // Migrate router_state.json
  const routerState = migrateFile('router_state.json') as {
    last_timestamp?: string;
    last_agent_timestamp?: Record<string, string>;
  } | null;
  if (routerState) {
    if (routerState.last_timestamp) {
      setRouterState('last_timestamp', routerState.last_timestamp);
    }
    if (routerState.last_agent_timestamp) {
      setRouterState(
        'last_agent_timestamp',
        JSON.stringify(routerState.last_agent_timestamp),
      );
    }
  }

  // Migrate sessions.json
  const sessions = migrateFile('sessions.json') as Record<
    string,
    string
  > | null;
  if (sessions) {
    for (const [folder, sessionId] of Object.entries(sessions)) {
      setSession(folder, sessionId);
    }
  }

  // Migrate registered_groups.json
  const groups = migrateFile('registered_groups.json') as Record<
    string,
    RegisteredGroup
  > | null;
  if (groups) {
    for (const [jid, group] of Object.entries(groups)) {
      setRegisteredGroup(jid, group);
    }
  }
}

// --- Database health and maintenance ---

export interface DatabaseHealth {
  healthy: boolean;
  integrity: 'ok' | 'warning' | 'error';
  sizeBytes: number;
  sizeMb: number;
  tables: Record<string, number>;
  issues: string[];
  lastVacuum?: string;
  walMode: boolean;
}

/**
 * Check database health and integrity
 */
export function checkDatabaseHealth(): DatabaseHealth {
  const issues: string[] = [];
  let integrity: 'ok' | 'warning' | 'error' = 'ok';

  try {
    // Check integrity
    const integrityResult = db.pragma('integrity_check') as Array<{ integrity_check: string }>;
    if (integrityResult[0]?.integrity_check !== 'ok') {
      integrity = 'error';
      issues.push(`Integrity check failed: ${integrityResult[0]?.integrity_check}`);
    }

    // Check foreign key violations
    const fkResult = db.pragma('foreign_key_check') as Array<{ table: string; rowid: number; parent: string; fkid: number }>;
    if (fkResult.length > 0) {
      integrity = 'warning';
      issues.push(`Foreign key violations: ${fkResult.length} rows`);
    }

    // Get database file size
    const dbPath = path.join(STORE_DIR, 'messages.db');
    let sizeBytes = 0;
    try {
      const stat = fs.statSync(dbPath);
      sizeBytes = stat.size;
    } catch {
      issues.push('Could not determine database file size');
    }

    // Check WAL mode
    const journalMode = db.pragma('journal_mode') as Array<{ journal_mode: string }>;
    const walMode = journalMode[0]?.journal_mode?.toLowerCase() === 'wal';

    // Get table row counts
    const tables: Record<string, number> = {};
    const tableNames = ['messages', 'chats', 'scheduled_tasks', 'task_run_logs', 'registered_groups', 'sessions', 'memories', 'daily_memories', 'tags', 'workflow_runs', 'workflow_steps'];
    for (const table of tableNames) {
      try {
        const count = db.prepare(`SELECT COUNT(*) as count FROM ${table}`).get() as { count: number };
        tables[table] = count.count;
      } catch {
        // Table might not exist
      }
    }

    // Check for common issues
    if (tables['messages'] > 100000) {
      issues.push('Message count exceeds 100,000 - consider cleanup');
      integrity = 'warning';
    }

    if (tables['task_run_logs'] > 10000) {
      issues.push('Task run logs exceed 10,000 - consider cleanup');
      integrity = 'warning';
    }

    return {
      healthy: issues.length === 0 && integrity === 'ok',
      integrity,
      sizeBytes,
      sizeMb: Math.round(sizeBytes / 1024 / 1024 * 10) / 10,
      tables,
      issues,
      walMode,
    };
  } catch (error) {
    return {
      healthy: false,
      integrity: 'error',
      sizeBytes: 0,
      sizeMb: 0,
      tables: {},
      issues: [`Health check failed: ${error instanceof Error ? error.message : String(error)}`],
      walMode: false,
    };
  }
}

/**
 * Run database maintenance (VACUUM, ANALYZE)
 */
export function runDatabaseMaintenance(): {
  vacuum: boolean;
  analyze: boolean;
  errors: string[];
} {
  const errors: string[] = [];
  let vacuum = false;
  let analyze = false;

  try {
    db.exec('VACUUM');
    vacuum = true;
    logger.info('Database VACUUM completed');
  } catch (error) {
    errors.push(`VACUUM failed: ${error instanceof Error ? error.message : String(error)}`);
    logger.error({ error }, 'Database VACUUM failed');
  }

  try {
    db.exec('ANALYZE');
    analyze = true;
    logger.info('Database ANALYZE completed');
  } catch (error) {
    errors.push(`ANALYZE failed: ${error instanceof Error ? error.message : String(error)}`);
    logger.error({ error }, 'Database ANALYZE failed');
  }

  return { vacuum, analyze, errors };
}

/**
 * Clean up old records based on retention policies
 */
export function cleanupOldRecords(options: {
  messageRetentionDays?: number;
  taskLogRetentionDays?: number;
  chatHistoryRetentionDays?: number;
} = {}): {
  messagesDeleted: number;
  taskLogsDeleted: number;
  chatHistoryDeleted: number;
} {
  const result = {
    messagesDeleted: 0,
    taskLogsDeleted: 0,
    chatHistoryDeleted: 0,
  };

  const now = new Date();

  // Clean up old messages
  if (options.messageRetentionDays) {
    const cutoff = new Date(now.getTime() - options.messageRetentionDays * 24 * 60 * 60 * 1000);
    try {
      const deleteResult = db.prepare(
        'DELETE FROM messages WHERE timestamp < ?'
      ).run(cutoff.toISOString());
      result.messagesDeleted = deleteResult.changes;
      logger.info({ deleted: result.messagesDeleted, cutoff }, 'Old messages cleaned up');
    } catch (error) {
      logger.error({ error }, 'Failed to clean up old messages');
    }
  }

  // Clean up old task run logs
  if (options.taskLogRetentionDays) {
    const cutoff = new Date(now.getTime() - options.taskLogRetentionDays * 24 * 60 * 60 * 1000);
    try {
      const deleteResult = db.prepare(
        'DELETE FROM task_run_logs WHERE run_at < ?'
      ).run(cutoff.toISOString());
      result.taskLogsDeleted = deleteResult.changes;
      logger.info({ deleted: result.taskLogsDeleted, cutoff }, 'Old task logs cleaned up');
    } catch (error) {
      logger.error({ error }, 'Failed to clean up old task logs');
    }
  }

  // Clean up old chat history
  if (options.chatHistoryRetentionDays) {
    const cutoff = new Date(now.getTime() - options.chatHistoryRetentionDays * 24 * 60 * 60 * 1000);
    try {
      const deleteResult = db.prepare(
        'DELETE FROM chat_history WHERE timestamp < ?'
      ).run(cutoff.toISOString());
      result.chatHistoryDeleted = deleteResult.changes;
      logger.info({ deleted: result.chatHistoryDeleted, cutoff }, 'Old chat history cleaned up');
    } catch (error) {
      logger.error({ error }, 'Failed to clean up old chat history');
    }
  }

  return result;
}

/**
 * Get database statistics for monitoring
 */
export function getDatabaseStats(): {
  connectionPool: { used: number; max: number };
  pageSize: number;
  pageCount: number;
  cacheSize: number;
  readCount: number;
  writeCount: number;
} {
  try {
    const cacheSize = db.pragma('cache_size') as Array<{ cache_size: number }>;
    const pageSize = db.pragma('page_size') as Array<{ page_size: number }>;
    const pageCount = db.pragma('page_count') as Array<{ page_count: number }>;
    const stats = db.pragma('stats') as Array<{ read: number; write: number }>;

    return {
      connectionPool: { used: 1, max: 1 }, // better-sqlite3 uses single connection
      pageSize: pageSize[0]?.page_size || 0,
      pageCount: pageCount[0]?.page_count || 0,
      cacheSize: Math.abs(cacheSize[0]?.cache_size || 0),
      readCount: stats[0]?.read || 0,
      writeCount: stats[0]?.write || 0,
    };
  } catch {
    return {
      connectionPool: { used: 0, max: 0 },
      pageSize: 0,
      pageCount: 0,
      cacheSize: 0,
      readCount: 0,
      writeCount: 0,
    };
  }
}

// ============ Goals CRUD ============

export interface Goal {
  id: string;
  title: string;
  description: string | null;
  progress: number;
  target: number;
  deadline: string | null;
  type: 'long' | 'short';
  status: 'active' | 'completed' | 'archived';
  created_at: string;
  updated_at: string;
}

export function getAllGoals(): Goal[] {
  const stmt = db.prepare<[], Goal>(`
    SELECT * FROM goals
    WHERE status != 'archived'
    ORDER BY
      CASE WHEN deadline IS NULL THEN 1 ELSE 0 END,
      deadline ASC,
      created_at DESC
  `);
  return stmt.all();
}

export function getGoalById(id: string): Goal | null {
  const stmt = db.prepare<[string], Goal>('SELECT * FROM goals WHERE id = ?');
  return stmt.get(id) || null;
}

export function createGoal(goal: Omit<Goal, 'id' | 'created_at' | 'updated_at'>): Goal {
  const id = `goal_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  const now = new Date().toISOString();

  const stmt = db.prepare(`
    INSERT INTO goals (id, title, description, progress, target, deadline, type, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    id,
    goal.title,
    goal.description || null,
    goal.progress || 0,
    goal.target || 100,
    goal.deadline || null,
    goal.type || 'short',
    goal.status || 'active',
    now,
    now
  );

  return getGoalById(id)!;
}

export function updateGoal(id: string, updates: Partial<Omit<Goal, 'id' | 'created_at' | 'updated_at'>>): Goal | null {
  const goal = getGoalById(id);
  if (!goal) return null;

  const now = new Date().toISOString();
  const fields: string[] = [];
  const values: any[] = [];

  if (updates.title !== undefined) {
    fields.push('title = ?');
    values.push(updates.title);
  }
  if (updates.description !== undefined) {
    fields.push('description = ?');
    values.push(updates.description);
  }
  if (updates.progress !== undefined) {
    fields.push('progress = ?');
    values.push(updates.progress);
    // Auto-complete if progress reaches target
    if (updates.progress >= goal.target) {
      fields.push('status = ?');
      values.push('completed');
    }
  }
  if (updates.target !== undefined) {
    fields.push('target = ?');
    values.push(updates.target);
  }
  if (updates.deadline !== undefined) {
    fields.push('deadline = ?');
    values.push(updates.deadline);
  }
  if (updates.type !== undefined) {
    fields.push('type = ?');
    values.push(updates.type);
  }
  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
  }

  if (fields.length === 0) return goal;

  fields.push('updated_at = ?');
  values.push(now);
  values.push(id);

  const stmt = db.prepare(`UPDATE goals SET ${fields.join(', ')} WHERE id = ?`);
  stmt.run(...values);

  return getGoalById(id);
}

export function deleteGoal(id: string): boolean {
  const stmt = db.prepare('DELETE FROM goals WHERE id = ?');
  const result = stmt.run(id);
  return result.changes > 0;
}

export function archiveGoal(id: string): boolean {
  const now = new Date().toISOString();
  const stmt = db.prepare('UPDATE goals SET status = ?, updated_at = ? WHERE id = ?');
  const result = stmt.run('archived', now, id);
  return result.changes > 0;
}

/**
 * Backup database to a file
 */
export function backupDatabase(backupPath: string): { success: boolean; sizeBytes: number; error?: string } {
  try {
    const backup = db.backup(backupPath);
    const stat = fs.statSync(backupPath);
    logger.info({ backupPath, sizeBytes: stat.size }, 'Database backup completed');
    return { success: true, sizeBytes: stat.size };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error({ error, backupPath }, 'Database backup failed');
    return { success: false, sizeBytes: 0, error: errorMessage };
  }
}
