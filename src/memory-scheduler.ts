/**
 * Memory Scheduler
 * Handles periodic memory maintenance tasks (daily summaries, compression, etc.)
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR, GROUPS_DIR, TIMEZONE } from './config.js';
import { getAllRegisteredGroups, db } from './db.js';
import { logger } from './logger.js';
import { getChatHistory, ChatHistoryMessage } from './db.js';
import { Memory } from './types.js';
import {
  createDailySummary,
  extractMemoriesFromConversation,
  ExtractedMemory,
} from './memory-extraction.js';
import {
  saveMemory,
  saveDailyMemory,
  writeDailyMemoryToFile,
  getMemoriesForAgent,
  getMemoryStats,
  linkMemories,
  searchMemories,
  applyImportanceDecay,
} from './memory.js';

const MAIN_GROUP_JID = '120363422227220717@g.us';
const DAILY_TASK_NOTIFICATION_JID = '120363422227220717@g.us';

function getSharedWorkspaceDir(): string {
  return path.join(DATA_DIR, 'workspace');
}

function getDailyTaskDir(): string {
  return path.join(getSharedWorkspaceDir(), 'daily-2am');
}

/**
 * Get current date in configured timezone (YYYY-MM-DD format)
 */
function getLocalDateString(): string {
  return new Date().toLocaleDateString('en-CA', {
    timeZone: TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
}

export interface MemorySchedulerConfig {
  /** Hour of day to run (0-23). Default: 2 (2 AM) */
  hour?: number;
  /** Minute of hour to run. Default: 0 */
  minute?: number;
  /** Minimum messages before creating summary. Default: 5 */
  minMessageThreshold?: number;
  /** Age in days before archiving old conversations. Default: 30 */
  archiveAgeDays?: number;
}

/**
 * Run the daily memory compression and summary task
 */
export interface DailyMemoryTaskResult {
  date: string;
  agentsProcessed: string[];
  agentsWithMemories: number;
  totalMemoriesSaved: number;
  errors: string[];
  duration: number;
}

/**
 * Format daily task result for messaging
 */
export function formatDailyTaskSummary(result: DailyMemoryTaskResult): string {
  const lines = [
    `📋 **Daily Memory Task Summary - ${result.date}**`,
    '',
    `✅ Agents processed: ${result.agentsProcessed.length}`,
    `📝 Memories saved: ${result.totalMemoriesSaved}`,
    `⏱️ Duration: ${Math.round(result.duration / 1000)}s`,
  ];

  if (result.agentsWithMemories > 0) {
    lines.push('', '**Agents with new memories:**');
    result.agentsProcessed.forEach((agent) => {
      lines.push(`- ${agent}`);
    });
  }

  if (result.errors.length > 0) {
    lines.push('', '⚠️ **Errors:**');
    result.errors.forEach((err) => {
      lines.push(`- ${err}`);
    });
  }

  return lines.join('\n');
}

/**
 * Save daily task summary to workspace as markdown
 */
export function saveDailyTaskSummaryToWorkspace(
  result: DailyMemoryTaskResult,
): void {
  const dailyTaskDir = getDailyTaskDir();
  fs.mkdirSync(dailyTaskDir, { recursive: true });

  const filename = `daily-task-${result.date}.md`;
  const filePath = path.join(dailyTaskDir, filename);

  const lines = [
    `# Daily Task Summary - ${result.date}`,
    '',
    '## Statistics',
    '',
    `| Metric | Value |`,
    `|--------|-------|`,
    `| Agents Processed | ${result.agentsProcessed.length} |`,
    `| Agents with Memories | ${result.agentsWithMemories} |`,
    `| Total Memories Saved | ${result.totalMemoriesSaved} |`,
    `| Duration | ${Math.round(result.duration / 1000)}s |`,
    '',
    '## Agents',
    '',
    ...result.agentsProcessed.map((a) => `- ${a}`),
  ];

  if (result.errors.length > 0) {
    lines.push('', '## Errors', '', ...result.errors.map((e) => `- ${e}`));
  }

  fs.writeFileSync(filePath, lines.join('\n'));
  logger.info(
    { filePath, date: result.date },
    'Daily task summary saved to workspace',
  );
}

export async function runDailyMemoryTask(
  date?: string,
): Promise<DailyMemoryTaskResult> {
  // Use local date in configured timezone
  const localDate = getLocalDateString();
  const targetDate = date || localDate;
  const startTime = Date.now();

  const result: DailyMemoryTaskResult = {
    date: targetDate,
    agentsProcessed: [],
    agentsWithMemories: 0,
    totalMemoriesSaved: 0,
    errors: [],
    duration: 0,
  };

  logger.info(
    { date: targetDate, timezone: TIMEZONE },
    'Starting daily memory task',
  );

  try {
    const groups = getAllRegisteredGroups();

    for (const [jid, group] of Object.entries(groups)) {
      // Process agents (@nanoclaw.local) and the main orchestrator (Telegram or other channels)
      const isAgent = jid.endsWith('@nanoclaw.local');
      const isMainOrchestrator = group.folder === 'main';
      if (!isAgent && !isMainOrchestrator) {
        continue;
      }

      result.agentsProcessed.push(group.folder);
      logger.info(
        { agent: group.folder, date: targetDate },
        'Processing daily memory for agent',
      );

      try {
        const memoriesSaved = await processAgentDailyMemories(
          group.folder,
          targetDate,
        );
        if (memoriesSaved > 0) {
          result.agentsWithMemories++;
          result.totalMemoriesSaved += memoriesSaved;
        }
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        result.errors.push(`${group.folder}: ${errorMsg}`);
        logger.error(
          { agent: group.folder, date: targetDate, error },
          'Failed to process daily memories',
        );
      }
    }

    result.duration = Date.now() - startTime;
    logger.info(
      { date: targetDate, duration: result.duration },
      'Daily memory task completed',
    );
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    result.errors.push(errorMsg);
    result.duration = Date.now() - startTime;
    logger.error({ date: targetDate, error }, 'Daily memory task failed');
  }

  return result;
}

/**
 * Process daily memories for a specific agent
 */
async function processAgentDailyMemories(
  agentFolder: string,
  date: string,
): Promise<number> {
  // Get the most recent session for this agent
  const sessionResult = db
    .prepare(
      `SELECT session_id FROM web_sessions WHERE agent_folder = ? ORDER BY last_active DESC LIMIT 1`,
    )
    .get(agentFolder) as { session_id: string } | undefined;

  if (!sessionResult) {
    logger.debug({ agentFolder, date }, 'No sessions found for agent');
    return 0;
  }

  const sessionKey = sessionResult.session_id;

  // Get all conversation history for this agent from the database
  // We'll get the last 100 messages to avoid overwhelming the LLM
  const historyResult = getChatHistory(sessionKey, agentFolder, 100);

  if (historyResult.messages.length === 0) {
    logger.debug({ agentFolder, date }, 'No messages to process');
    return 0;
  }

  const history = historyResult.messages;
  logger.info(
    { agentFolder, date, messageCount: history.length },
    'Processing conversation history',
  );

  // Step 1: Extract memories from the conversation
  const extractedMemories = await extractMemoriesFromConversation(
    agentFolder,
    history,
  );

  // Save the extracted memories (filter out low-importance ones)
  const importantMemories = extractedMemories.filter((m) => m.importance >= 3); // Only save medium+ importance

  const savedMemoryIds: string[] = [];

  for (const memory of importantMemories) {
    const memoryId = saveMemory({
      agent_folder: agentFolder,
      memory_type: memory.type,
      content: memory.content,
      importance: memory.importance,
    });
    savedMemoryIds.push(memoryId);
  }

  logger.info(
    { agentFolder, date, savedCount: importantMemories.length },
    'Memories saved to database',
  );

  // Step 1.5: Link related memories
  // Find and link memories that are semantically related
  try {
    let linksCreated = 0;

    for (let i = 0; i < importantMemories.length; i++) {
      const newMemory = importantMemories[i];
      const newMemoryId = savedMemoryIds[i];

      // Extract key terms from the new memory
      const terms = newMemory.content
        .toLowerCase()
        .replace(/[^\w\s]/g, ' ')
        .split(/\s+/)
        .filter((w) => w.length > 4)
        .slice(0, 3);

      if (terms.length === 0) continue;

      // Search for related existing memories
      const searchQuery = terms.join(' OR ');
      const relatedMemories = searchMemories(agentFolder, searchQuery, {
        limit: 5,
      });

      for (const related of relatedMemories) {
        // Don't link to self
        if (related.id === newMemoryId) continue;

        // Check if content is similar enough (not exact match)
        const similarity = calculateSimilarity(
          newMemory.content,
          related.content,
        );
        if (similarity > 0.3 && similarity < 0.9) {
          // Link bidirectionally
          linkMemories(newMemoryId, related.id, 'relates_to');
          linkMemories(related.id, newMemoryId, 'relates_to');
          linksCreated++;
        }
      }
    }

    if (linksCreated > 0) {
      logger.info({ agentFolder, date, linksCreated }, 'Memory links created');
    }
  } catch (error) {
    logger.warn(
      { agentFolder, date, error },
      'Failed to link related memories',
    );
  }

  // Step 2: Create daily summary
  const summaryData = await createDailySummary(agentFolder, date, history);

  if (summaryData) {
    // Save to database
    saveDailyMemory({
      date,
      agent_folder: agentFolder,
      summary: summaryData.summary,
      topics: summaryData.topics,
      message_count: history.length,
    });

    // Write to markdown file
    const markdownContent = formatDailyMemoryMarkdown(
      date,
      summaryData,
      history.length,
      importantMemories,
    );
    writeDailyMemoryToFile(agentFolder, date, markdownContent);

    logger.info(
      { agentFolder, date, topicCount: summaryData.topics.length },
      'Daily summary saved',
    );

    // Step 3: Archive old conversations (older than 30 days)
    try {
      archiveOldConversations(agentFolder, 30);
    } catch (error) {
      logger.warn(
        { agentFolder, date, error },
        'Failed to archive old conversations',
      );
    }

    // Step 4: Apply importance decay to old memories
    try {
      const decayed = applyImportanceDecay(agentFolder, {
        decayStartDays: 30,
        decayRate: 0.1,
        minImportance: 1,
      });
      if (decayed > 0) {
        logger.info({ agentFolder, date, decayed }, 'Importance decay applied');
      }
    } catch (error) {
      logger.warn(
        { agentFolder, date, error },
        'Failed to apply importance decay',
      );
    }
  }

  return importantMemories.length;
}

/**
 * Format daily memory as markdown for file storage
 */
function formatDailyMemoryMarkdown(
  date: string,
  summaryData: { summary: string; topics: string[] },
  messageCount: number,
  memories: ExtractedMemory[],
): string {
  const lines: string[] = [];

  lines.push(`# Daily Memory - ${date}`);
  lines.push();
  lines.push(`**Messages:** ${messageCount}`);
  lines.push(`**Extracted Memories:** ${memories.length}`);
  lines.push();

  lines.push('## Summary');
  lines.push(summaryData.summary);
  lines.push();

  lines.push('## Topics');
  for (const topic of summaryData.topics) {
    lines.push(`- ${topic}`);
  }
  lines.push();

  if (memories.length > 0) {
    lines.push('## Key Memories');
    for (const memory of memories) {
      lines.push(
        `**[${memory.type.toUpperCase()}]** (importance: ${memory.importance}/10) ${memory.content}`,
      );
    }
    lines.push();
  }

  lines.push(`*Generated: ${new Date().toISOString()}*`);

  return lines.join('\n');
}

/**
 * Archive old conversations (compress old memory files)
 */
export function archiveOldConversations(
  agentFolder: string,
  ageDays: number = 30,
): void {
  const memoryDir = path.join(GROUPS_DIR, agentFolder, 'memory');
  if (!fs.existsSync(memoryDir)) {
    return;
  }

  const files = fs.readdirSync(memoryDir);
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - ageDays);

  let archivedCount = 0;

  for (const file of files) {
    if (!file.endsWith('.md')) continue;

    const match = file.match(/^(\d{4}-\d{2}-\d{2})\.md$/);
    if (!match) continue;

    const fileDate = new Date(match[1]);
    if (fileDate < cutoffDate) {
      // Archive by moving to archive/ subdirectory
      const archiveDir = path.join(memoryDir, 'archive');
      fs.mkdirSync(archiveDir, { recursive: true });

      const srcPath = path.join(memoryDir, file);
      const dstPath = path.join(archiveDir, file);

      fs.renameSync(srcPath, dstPath);
      archivedCount++;
    }
  }

  if (archivedCount > 0) {
    logger.info(
      { agentFolder, ageDays, archivedCount },
      'Old conversations archived',
    );
  }
}

/**
 * Clean up low-importance memories to maintain performance
 */
export function cleanupLowImportanceMemories(
  agentFolder: string,
  keepThreshold: number = 3,
): void {
  // Get all memories for the agent
  const memories = getMemoriesForAgent(agentFolder);

  // Filter out low-importance memories
  const lowImportanceMemories = memories.filter(
    (m) => m.importance < keepThreshold,
  );

  logger.info(
    { agentFolder, lowImportanceCount: lowImportanceMemories.length },
    'Low-importance memories found',
  );

  // In a real implementation, you might want to:
  // 1. Archive them to a file instead of deleting
  // 2. Keep them if they've been accessed recently
  // 3. Consolidate similar memories

  // For now, we'll just log them - deletion should be manual or more sophisticated
  if (lowImportanceMemories.length > 0) {
    logger.debug(
      {
        agentFolder,
        memories: lowImportanceMemories.map((m) => ({
          id: m.id,
          content: m.content,
        })),
      },
      'Low-importance memories (not deleted)',
    );
  }
}

/**
 * Generate a memory report for an agent
 */
export function generateMemoryReport(agentFolder: string): string {
  try {
    const memories = getMemoriesForAgent(agentFolder);

    const lines: string[] = [];
    lines.push(`# Memory Report - ${agentFolder}`);
    lines.push();
    lines.push(`**Total Memories:** ${memories.length}`);
    lines.push(`**Generated:** ${new Date().toISOString()}`);
    lines.push();

    // Group by type
    const byType: Record<string, Memory[]> = {};
    for (const memory of memories) {
      if (!byType[memory.memory_type]) {
        byType[memory.memory_type] = [];
      }
      byType[memory.memory_type].push(memory);
    }

    for (const [type, typeMemories] of Object.entries(byType)) {
      lines.push(`## ${type.toUpperCase()} (${typeMemories.length})`);
      // Sort by importance
      typeMemories.sort((a, b) => b.importance - a.importance);

      for (const memory of typeMemories.slice(0, 10)) {
        // Show top 10 per type
        lines.push(`- [${memory.importance}/10] ${memory.content}`);
      }

      if (typeMemories.length > 10) {
        lines.push(`- ... and ${typeMemories.length - 10} more`);
      }
      lines.push();
    }

    return lines.join('\n');
  } catch (error) {
    logger.error({ agentFolder, error }, 'Failed to generate memory report');
    return `# Memory Report - ${agentFolder}\n\nError generating report: ${error}`;
  }
}

/**
 * Calculate similarity between two strings using Jaccard similarity
 * Returns a value between 0 (no similarity) and 1 (identical)
 */
function calculateSimilarity(str1: string, str2: string): number {
  const normalize = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 0);

  const set1 = new Set(normalize(str1));
  const set2 = new Set(normalize(str2));

  if (set1.size === 0 || set2.size === 0) return 0;

  // Jaccard similarity: intersection / union
  const intersection = new Set([...set1].filter((x) => set2.has(x)));
  const union = new Set([...set1, ...set2]);

  return intersection.size / union.size;
}
