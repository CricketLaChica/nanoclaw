/**
 * NanoClaw Memory System
 * Provides persistent long-term memory for agents using SQLite + FTS5
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';

import { DATA_DIR, GROUPS_DIR } from './config.js';
import { db } from './db.js';
import { logger } from './logger.js';
import { DailyMemory, Memory, MemoryFilters, MemoryRelationship, MemoryType } from './types.js';

// === Memory CRUD Operations ===

/**
 * Check if a memory already exists (exact content match)
 * Returns the existing memory ID if found, null otherwise
 */
export function findDuplicateMemory(
  agentFolder: string,
  content: string,
  memoryType?: MemoryType
): string | null {
  try {
    const normalizedContent = content.trim().toLowerCase();

    let sql = `SELECT id FROM memories WHERE agent_folder = ? AND LOWER(content) = ?`;
    const params: unknown[] = [agentFolder, normalizedContent];

    if (memoryType) {
      sql += ` AND memory_type = ?`;
      params.push(memoryType);
    }

    const result = db.prepare(sql).get(...params) as { id: string } | undefined;
    return result?.id || null;
  } catch (error) {
    logger.error({ agentFolder, content, memoryType, error }, 'Failed to check for duplicate memory');
    return null;
  }
}

/**
 * Save a new memory to the database
 */
export function saveMemory(memory: Omit<Memory, 'id' | 'created_at'>): string {
  try {
    // Validate agent_folder is not empty
    if (!memory.agent_folder || !memory.agent_folder.trim()) {
      throw new Error('Memory agent_folder cannot be empty');
    }

    // Validate content is not empty or whitespace-only
    if (!memory.content || !memory.content.trim()) {
      throw new Error('Memory content cannot be empty');
    }

    // Validate memory_type
    const validTypes: MemoryType[] = ['fact', 'preference', 'decision', 'event', 'pattern'];
    if (!validTypes.includes(memory.memory_type)) {
      throw new Error(`Invalid memory_type: ${memory.memory_type}`);
    }

    // Check for duplicate memory (exact content match)
    const existingId = findDuplicateMemory(memory.agent_folder.trim(), memory.content.trim(), memory.memory_type);
    if (existingId) {
      logger.debug({ existingId, content: memory.content.trim(), type: memory.memory_type }, 'Duplicate memory detected, skipping save');
      return existingId; // Return existing memory ID instead of creating duplicate
    }

    const id = randomUUID();
    const created_at = new Date().toISOString();

    // Validate and clamp importance to 1-10 range
    let importance = memory.importance || 1;
    if (importance < 1) importance = 1;
    if (importance > 10) importance = 10;

    const stmt = db.prepare(
      `INSERT INTO memories (id, agent_folder, memory_type, content, importance, created_at, last_accessed)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );

    stmt.run(
      id,
      memory.agent_folder.trim(),
      memory.memory_type,
      memory.content.trim(),
      importance,
      created_at,
      created_at, // last_accessed starts same as created_at
    );

    logger.debug({ memoryId: id, type: memory.memory_type, folder: memory.agent_folder }, 'Memory saved');
    return id;
  } catch (error) {
    logger.error({ memory, error }, 'Failed to save memory');
    throw error; // Re-throw because caller needs to know if save failed
  }
}

/**
 * Get a specific memory by ID
 */
export function getMemory(id: string): Memory | undefined {
  try {
    const row = db
      .prepare('SELECT * FROM memories WHERE id = ?')
      .get(id) as Memory | undefined;

    if (row) {
      // Update last_accessed timestamp (non-fatal if it fails)
      try {
        db.prepare('UPDATE memories SET last_accessed = ? WHERE id = ?').run(
          new Date().toISOString(),
          id
        );
      } catch (updateError) {
        logger.warn({ id, updateError }, 'Failed to update last_accessed timestamp');
      }
    }

    return row;
  } catch (error) {
    logger.error({ id, error }, 'Failed to get memory');
    return undefined;
  }
}

/**
 * Get all memories for a specific agent
 */
export function getMemoriesForAgent(agentFolder: string, limit?: number): Memory[] {
  try {
    const sql = limit
      ? `SELECT * FROM memories WHERE agent_folder = ? ORDER BY importance DESC, created_at DESC LIMIT ?`
      : `SELECT * FROM memories WHERE agent_folder = ? ORDER BY importance DESC, created_at DESC`;

    const stmt = db.prepare(sql);
    const params = limit ? [agentFolder, limit] : [agentFolder];

    return stmt.all(...params) as Memory[];
  } catch (error) {
    logger.error({ agentFolder, limit, error }, 'Failed to get memories for agent');
    return [];
  }
}

/**
 * Update an existing memory
 */
export function updateMemory(
  id: string,
  updates: Partial<Pick<Memory, 'content' | 'importance' | 'memory_type'>>
): boolean {
  try {
    const fields: string[] = [];
    const values: unknown[] = [];

    if (updates.content !== undefined) {
      // Validate content is not empty or whitespace-only
      if (!updates.content.trim()) {
        logger.warn({ id }, 'Cannot update memory with empty content, skipping');
        return false;
      }
      fields.push('content = ?');
      values.push(updates.content.trim());
    }
    if (updates.importance !== undefined) {
      // Validate and clamp importance to 1-10 range
      let importance = updates.importance;
      if (importance < 1) importance = 1;
      if (importance > 10) importance = 10;
      fields.push('importance = ?');
      values.push(importance);
    }
    if (updates.memory_type !== undefined) {
      fields.push('memory_type = ?');
      values.push(updates.memory_type);
    }

    if (fields.length === 0) return false;

    values.push(id);
    const result = db
      .prepare(`UPDATE memories SET ${fields.join(', ')} WHERE id = ?`)
      .run(...values);

    return result.changes > 0;
  } catch (error) {
    logger.error({ id, updates, error }, 'Failed to update memory');
    return false;
  }
}

/**
 * Delete a memory by ID
 */
export function deleteMemory(id: string): boolean {
  try {
    const result = db.prepare('DELETE FROM memories WHERE id = ?').run(id);
    return result.changes > 0;
  } catch (error) {
    logger.error({ id, error }, 'Failed to delete memory');
    return false;
  }
}

// === Semantic Search with FTS5 ===

/**
 * Search memories using full-text search with BM25 ranking
 * Returns memories ranked by relevance + importance + recency
 */
export function searchMemories(
  agentFolder: string,
  query: string,
  filters?: MemoryFilters
): Memory[] {
  // Build the FTS5 search query
  // Use simple matching (no special query syntax for security)
  let searchQuery = query.trim();

  if (!searchQuery) {
    return [];
  }

  // Remove newlines and other whitespace characters that break FTS5
  searchQuery = searchQuery.replace(/[\r\n\t]+/g, ' ');

  // Escape special FTS5 characters to prevent syntax errors
  // FTS5 special chars: - " " + * ( ) : [ ] ^ & ;
  const escapedQuery = searchQuery.replace(/([\-"\+\*\(\)\:\[\]\^&;])/g, '"$1"');

  // Start with base SQL - using subquery to avoid FTS5 JOIN issues
  let sql = `SELECT m.* FROM memories m WHERE id IN (SELECT id FROM memories_fts WHERE memories_fts MATCH ?) AND agent_folder = ?`;

  const params: unknown[] = [escapedQuery, agentFolder];

  // Apply optional filters
  if (filters?.type) {
    sql += ' AND memory_type = ?';
    params.push(filters.type);
  }

  if (filters?.minImportance) {
    sql += ' AND importance >= ?';
    params.push(filters.minImportance);
  }

  if (filters?.startDate) {
    sql += ' AND created_at >= ?';
    params.push(filters.startDate);
  }

  if (filters?.endDate) {
    sql += ' AND created_at <= ?';
    params.push(filters.endDate);
  }

  // Order by BM25 score (implicit in FTS5) + importance + recency
  // Recent memories get a boost, as do high-importance ones
  sql += ` ORDER BY importance DESC, created_at DESC`;

  if (filters?.limit) {
    sql += ` LIMIT ?`;
    params.push(filters.limit);
  } else {
    sql += ` LIMIT ?`;
    params.push(10);
  }

  try {
    const results = db.prepare(sql).all(...params) as Memory[];

    // Update last_accessed for all returned memories (don't fail if this fails)
    if (results.length > 0) {
      try {
        const updateStmt = db.prepare('UPDATE memories SET last_accessed = ? WHERE id = ?');
        const now = new Date().toISOString();
        for (const memory of results) {
          updateStmt.run(now, memory.id);
        }
      } catch (updateError) {
        // Non-fatal: log but still return results
        logger.warn({ updateError, count: results.length }, 'Failed to update last_accessed timestamps');
      }
    }

    return results;
  } catch (error) {
    const err = error as Error & { code?: string };
    logger.error({
      errorMessage: err.message,
      errorCode: err.code,
      query,
      agentFolder,
      sql,
      params
    }, 'FTS search failed');
    return [];
  }
}

/**
 * Get relevant memories for a specific context/message
 * Convenience wrapper around searchMemories
 */
export function getRelevantMemories(
  agentFolder: string,
  currentMessage: string,
  limit: number = 5
): Memory[] {
  try {
    // Extract key terms from the message (simple version)
    // For better results, you could use NLP or LLM-based extraction
    const terms = currentMessage
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 3)
      .slice(0, 5); // Use top 5 significant words

    const searchQuery = terms.join(' OR ');

    if (!searchQuery) {
      // If no good terms, fall back to recent high-importance memories
      return getMemoriesForAgent(agentFolder, limit);
    }

    return searchMemories(agentFolder, searchQuery, { limit });
  } catch (error) {
    logger.error({ agentFolder, currentMessage, error }, 'Failed to get relevant memories');
    return [];
  }
}

// === Daily Memory Summaries ===

/**
 * Create or update a daily memory summary
 */
export function saveDailyMemory(daily: Omit<DailyMemory, 'topics'> & { topics: string[] }): void {
  try {
    const stmt = db.prepare(
      `INSERT OR REPLACE INTO daily_memories (date, agent_folder, summary, topics, message_count)
       VALUES (?, ?, ?, ?, ?)`
    );

    stmt.run(
      daily.date,
      daily.agent_folder,
      daily.summary,
      JSON.stringify(daily.topics),
      daily.message_count
    );

    logger.debug({ date: daily.date, folder: daily.agent_folder }, 'Daily memory saved');
  } catch (error) {
    logger.error({ daily, error }, 'Failed to save daily memory');
  }
}

/**
 * Get a daily memory summary
 */
export function getDailyMemory(agentFolder: string, date: string): DailyMemory | undefined {
  try {
    const row = db
      .prepare('SELECT * FROM daily_memories WHERE agent_folder = ? AND date = ?')
      .get(agentFolder, date) as
      | { date: string; agent_folder: string; summary: string; topics: string; message_count: number }
      | undefined;

    if (!row) return undefined;

    let topics: string[];
    try {
      const parsed = JSON.parse(row.topics);
      // Handle both double-stringified old data and properly stringified new data
      if (typeof parsed === 'string') {
        topics = JSON.parse(parsed);
      } else if (Array.isArray(parsed)) {
        topics = parsed;
      } else {
        logger.warn({ agentFolder, date, topics: row.topics, parsedType: typeof parsed }, 'Unexpected topics format, using empty array');
        topics = [];
      }
    } catch {
      logger.warn({ agentFolder, date, topics: row.topics }, 'Failed to parse topics JSON, using empty array');
      topics = [];
    }

    return {
      ...row,
      topics,
    };
  } catch (error) {
    logger.error({ agentFolder, date, error }, 'Failed to get daily memory');
    return undefined;
  }
}

/**
 * Get all daily memories for an agent
 */
export function getDailyMemoriesForAgent(agentFolder: string, limit?: number): DailyMemory[] {
  try {
    const sql = limit
      ? `SELECT * FROM daily_memories WHERE agent_folder = ? ORDER BY date DESC LIMIT ?`
      : `SELECT * FROM daily_memories WHERE agent_folder = ? ORDER BY date DESC`;

    const stmt = db.prepare(sql);
    const params = limit ? [agentFolder, limit] : [agentFolder];
    const rows = stmt.all(...params) as Array<{
      date: string;
      agent_folder: string;
      summary: string;
      topics: string;
      message_count: number;
    }>;

    return rows.map(row => {
      let topics: string[];
      try {
        const parsed = JSON.parse(row.topics);
        // Handle both double-stringified old data and properly stringified new data
        if (typeof parsed === 'string') {
          topics = JSON.parse(parsed);
        } else if (Array.isArray(parsed)) {
          topics = parsed;
        } else {
          logger.warn({ agentFolder, date: row.date, topics: row.topics, parsedType: typeof parsed }, 'Unexpected topics format, using empty array');
          topics = [];
        }
      } catch {
        logger.warn({ agentFolder, date: row.date, topics: row.topics }, 'Failed to parse topics JSON, using empty array');
        topics = [];
      }
      return {
        ...row,
        topics,
      };
    });
  } catch (error) {
    logger.error({ agentFolder, limit, error }, 'Failed to get daily memories for agent');
    return [];
  }
}

// === Memory Relationships ===

/**
 * Create a relationship between two memories
 */
export function linkMemories(
  memoryId: string,
  relatedMemoryId: string,
  relationshipType: MemoryRelationship['relationship_type']
): void {
  try {
    const stmt = db.prepare(
      `INSERT OR IGNORE INTO memory_relationships (memory_id, related_memory_id, relationship_type)
       VALUES (?, ?, ?)`
    );

    stmt.run(memoryId, relatedMemoryId, relationshipType);
    logger.debug({ memoryId, relatedMemoryId, type: relationshipType }, 'Memories linked');
  } catch (error) {
    logger.error({ memoryId, relatedMemoryId, relationshipType, error }, 'Failed to link memories');
  }
}

/**
 * Get related memories for a given memory
 */
export function getRelatedMemories(
  memoryId: string,
  relationshipType?: MemoryRelationship['relationship_type']
): Memory[] {
  try {
    let sql = `
      SELECT m.* FROM memories m
      INNER JOIN memory_relationships mr ON m.id = mr.related_memory_id
      WHERE mr.memory_id = ?
    `;

    const params: unknown[] = [memoryId];

    if (relationshipType) {
      sql += ' AND mr.relationship_type = ?';
      params.push(relationshipType);
    }

    sql += ' ORDER BY m.importance DESC, m.created_at DESC';

    return db.prepare(sql).all(...params) as Memory[];
  } catch (error) {
    logger.error({ memoryId, relationshipType, error }, 'Failed to get related memories');
    return [];
  }
}

// === Memory File Operations ===

/**
 * Ensure memory directory structure exists for an agent
 */
export function ensureMemoryDirectory(agentFolder: string): void {
  try {
    const memoryDir = path.join(GROUPS_DIR, agentFolder, 'memory');
    fs.mkdirSync(memoryDir, { recursive: true });
  } catch (error) {
    // Ignore error if directory already exists
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      logger.error({ agentFolder, error }, 'Failed to ensure memory directory');
      throw error;
    }
  }
}

/**
 * Write a daily memory to markdown file
 */
export function writeDailyMemoryToFile(agentFolder: string, date: string, content: string): void {
  try {
    ensureMemoryDirectory(agentFolder);
    const memoryFile = path.join(GROUPS_DIR, agentFolder, 'memory', `${date}.md`);
    fs.writeFileSync(memoryFile, content, 'utf-8');
    logger.debug({ agentFolder, date, file: memoryFile }, 'Daily memory written to file');
  } catch (error) {
    logger.error({ agentFolder, date, error }, 'Failed to write daily memory to file');
  }
}

/**
 * Read a daily memory from markdown file
 */
export function readDailyMemoryFromFile(agentFolder: string, date: string): string | null {
  try {
    const memoryFile = path.join(GROUPS_DIR, agentFolder, 'memory', `${date}.md`);
    if (!fs.existsSync(memoryFile)) {
      return null;
    }
    return fs.readFileSync(memoryFile, 'utf-8');
  } catch (error) {
    logger.error({ agentFolder, date, error }, 'Failed to read daily memory from file');
    return null;
  }
}

/**
 * Get all daily memory file dates for an agent
 */
export function getDailyMemoryFiles(agentFolder: string): string[] {
  try {
    const memoryDir = path.join(GROUPS_DIR, agentFolder, 'memory');
    if (!fs.existsSync(memoryDir)) {
      return [];
    }

    const files = fs.readdirSync(memoryDir);
    return files
      .filter(f => f.endsWith('.md'))
      .map(f => f.replace('.md', ''))
      .sort()
      .reverse(); // Most recent first
  } catch (error) {
    logger.error({ agentFolder, error }, 'Failed to get daily memory files');
    return [];
  }
}

// === Personality File Operations ===

/**
 * Get the path to a personality file for an agent
 */
export function getPersonalityFilePath(agentFolder: string, filename: string): string {
  return path.join(GROUPS_DIR, agentFolder, filename);
}

/**
 * Check if a personality file exists
 */
export function personalityFileExists(agentFolder: string, filename: string): boolean {
  const filePath = getPersonalityFilePath(agentFolder, filename);
  return fs.existsSync(filePath);
}

/**
 * Read a personality file
 */
export function readPersonalityFile(agentFolder: string, filename: string): string | null {
  try {
    const filePath = getPersonalityFilePath(agentFolder, filename);
    if (!fs.existsSync(filePath)) {
      return null;
    }
    return fs.readFileSync(filePath, 'utf-8');
  } catch (error) {
    logger.error({ agentFolder, filename, error }, 'Failed to read personality file');
    return null;
  }
}

/**
 * Write a personality file
 */
export function writePersonalityFile(agentFolder: string, filename: string, content: string): void {
  try {
    const filePath = getPersonalityFilePath(agentFolder, filename);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf-8');
    logger.debug({ agentFolder, filename }, 'Personality file written');
  } catch (error) {
    logger.error({ agentFolder, filename, error }, 'Failed to write personality file');
    throw error;
  }
}

/**
 * Get all available personality files for an agent
 */
export function getPersonalityFiles(agentFolder: string): string[] {
  try {
    const agentDir = path.join(GROUPS_DIR, agentFolder);
    if (!fs.existsSync(agentDir)) {
      return [];
    }

    const personalityFiles = ['SOUL.md', 'PERSONALITY.md', 'MEMORY.md', 'USER.md', 'BOOTSTRAP.md', 'HEARTBEAT.md'];
    return personalityFiles.filter(f => fs.existsSync(path.join(agentDir, f)));
  } catch (error) {
    logger.error({ agentFolder, error }, 'Failed to get personality files');
    return [];
  }
}

// === Memory Export/Import ===

/**
 * Export all memories for an agent to JSON
 */
export function exportMemories(agentFolder: string): string {
  try {
    const memories = getMemoriesForAgent(agentFolder);

    const exportData = {
      agent_folder: agentFolder,
      export_date: new Date().toISOString(),
      total_memories: memories.length,
      memories: memories.map(m => ({
        id: m.id,
        memory_type: m.memory_type,
        content: m.content,
        importance: m.importance,
        created_at: m.created_at,
        last_accessed: m.last_accessed,
      })),
    };

    return JSON.stringify(exportData, null, 2);
  } catch (error) {
    logger.error({ agentFolder, error }, 'Failed to export memories');
    throw error;
  }
}

/**
 * Import memories from JSON
 * Returns the number of memories imported
 */
export function importMemories(
  agentFolder: string,
  jsonData: string,
  overwrite: boolean = false
): number {
  try {
    const data = JSON.parse(jsonData);

    if (!data.memories || !Array.isArray(data.memories)) {
      throw new Error('Invalid import data format');
    }

    let importedCount = 0;

    for (const mem of data.memories) {
      // Check if memory already exists
      const existing = db.prepare('SELECT id FROM memories WHERE id = ?').get(mem.id) as { id: string } | undefined;

      if (existing && !overwrite) {
        logger.debug({ memoryId: mem.id }, 'Memory already exists, skipping import');
        continue;
      }

      if (existing && overwrite) {
        // Delete existing memory
        db.prepare('DELETE FROM memories WHERE id = ?').run(mem.id);
      }

      // Insert memory
      db.prepare(
        `INSERT INTO memories (id, agent_folder, memory_type, content, importance, created_at, last_accessed)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(
        mem.id,
        agentFolder,
        mem.memory_type,
        mem.content,
        mem.importance,
        mem.created_at,
        mem.last_accessed || mem.created_at
      );

      importedCount++;
    }

    logger.info({ agentFolder, importedCount }, 'Memories imported');
    return importedCount;
  } catch (error) {
    logger.error({ agentFolder, error }, 'Failed to import memories');
    throw error;
  }
}

// === Memory Importance Decay ===

/**
 * Apply importance decay to old memories that haven't been accessed recently
 * Memories lose importance over time unless accessed
 * Returns the number of memories updated
 */
export function applyImportanceDecay(
  agentFolder: string,
  options?: {
    /** Days before decay starts (default: 30) */
    decayStartDays?: number;
    /** Decay rate per day - amount to reduce importance (default: 0.1) */
    decayRate?: number;
    /** Minimum importance floor (default: 1) */
    minImportance?: number;
    /** Dry run - don't actually update (default: false) */
    dryRun?: boolean;
  }
): number {
  const {
    decayStartDays = 30,
    decayRate = 0.1,
    minImportance = 1,
    dryRun = false,
  } = options || {};

  try {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - decayStartDays);
    const cutoffDateStr = cutoffDate.toISOString();

    // Get old memories that haven't been accessed recently
    const memories = db.prepare(
      `SELECT * FROM memories
       WHERE agent_folder = ?
       AND last_accessed < ?
       AND importance > ?`
    ).all(agentFolder, cutoffDateStr, minImportance) as Memory[];

    if (dryRun) {
      logger.info({ agentFolder, count: memories.length }, 'Importance decay: dry run, no changes made');
      return memories.length;
    }

    let updatedCount = 0;

    for (const memory of memories) {
      // Calculate days since last access
      const lastAccessed = memory.last_accessed || memory.created_at;
      const daysSinceAccess = Math.floor(
        (Date.now() - new Date(lastAccessed).getTime()) / (1000 * 60 * 60 * 24)
      );

      // Calculate decay amount (capped to avoid negative importance)
      const daysToDecay = daysSinceAccess - decayStartDays;
      const decayAmount = Math.floor(daysToDecay * decayRate * 10) / 10;
      const newImportance = Math.max(minImportance, memory.importance - decayAmount);

      if (newImportance < memory.importance) {
        db.prepare('UPDATE memories SET importance = ? WHERE id = ?').run(newImportance, memory.id);
        updatedCount++;
      }
    }

    logger.info({ agentFolder, updatedCount }, 'Applied importance decay');
    return updatedCount;
  } catch (error) {
    logger.error({ agentFolder, error }, 'Failed to apply importance decay');
    return 0;
  }
}

// === Memory Statistics ===

/**
 * Get memory statistics for an agent
 */
export function getMemoryStats(agentFolder: string): {
  totalMemories: number;
  memoriesByType: Record<MemoryType, number>;
  averageImportance: number;
  oldestMemory?: string;
  newestMemory?: string;
  dailySummaries: number;
} {
  try {
    const typeStats = db.prepare(
      `SELECT memory_type, COUNT(*) as count FROM memories WHERE agent_folder = ? GROUP BY memory_type`
    ).all(agentFolder) as Array<{ memory_type: string; count: number }>;

    const memoriesByType: Record<MemoryType, number> = {
      fact: 0,
      preference: 0,
      decision: 0,
      event: 0,
      pattern: 0,
    };

    let totalMemories = 0;
    for (const row of typeStats) {
      // Validate memory_type before using it
      if (['fact', 'preference', 'decision', 'event', 'pattern'].includes(row.memory_type)) {
        memoriesByType[row.memory_type as MemoryType] = row.count;
        totalMemories += row.count;
      } else {
        logger.warn({ agentFolder, invalidType: row.memory_type, count: row.count }, 'Skipping invalid memory type in stats');
      }
    }

    const avgImportance = db.prepare(
      `SELECT AVG(importance) as avg FROM memories WHERE agent_folder = ?`
    ).get(agentFolder) as { avg: number | null };

    const oldest = db
      .prepare(`SELECT MIN(created_at) as min FROM memories WHERE agent_folder = ?`)
      .get(agentFolder) as { min: string | null };

    const newest = db
      .prepare(`SELECT MAX(created_at) as max FROM memories WHERE agent_folder = ?`)
      .get(agentFolder) as { max: string | null };

    const dailyCount = db
      .prepare(`SELECT COUNT(*) as count FROM daily_memories WHERE agent_folder = ?`)
      .get(agentFolder) as { count: number };

    return {
      totalMemories,
      memoriesByType,
      averageImportance: avgImportance.avg || 0,
      oldestMemory: oldest.min || undefined,
      newestMemory: newest.max || undefined,
      dailySummaries: dailyCount.count,
    };
  } catch (error) {
    logger.error({ agentFolder, error }, 'Failed to get memory stats');
    return {
      totalMemories: 0,
      memoriesByType: { fact: 0, preference: 0, decision: 0, event: 0, pattern: 0 },
      averageImportance: 0,
      oldestMemory: undefined,
      newestMemory: undefined,
      dailySummaries: 0,
    };
  }
}
