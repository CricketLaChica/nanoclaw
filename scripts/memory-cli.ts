#!/usr/bin/env tsx
/**
 * Memory CLI - Command-line tool for managing agent memories
 *
 * Usage:
 *   npm run memory <command> [options]
 *
 * Commands:
 *   stats <agent>          Show memory statistics for an agent
 *   search <agent> <query>  Search memories by content
 *   list <agent>            List all memories for an agent
 *   daily <agent> [date]    Show daily memory summary
 *   report <agent>          Generate memory report
 *   extract <agent>         Manually extract memories from recent conversations
 *   cleanup <agent> [--delete]  Clean up low-importance memories (dry-run unless --delete)
 *   export <agent> [file]   Export memories to JSON
 *   import <agent> <file>   Import memories from JSON [--overwrite]
 */

import { initDatabase, db as dbImport } from '../src/db.js';
import {
  getMemoryStats,
  searchMemories,
  getMemoriesForAgent,
  getDailyMemory,
  getDailyMemoriesForAgent,
  saveMemory,
  deleteMemory,
  exportMemories,
  importMemories,
  applyImportanceDecay,
} from '../src/memory.js';
import { generateMemoryReport } from '../src/memory-scheduler.js';
import {
  extractMemoriesFromConversation,
  createDailySummary,
} from '../src/memory-extraction.js';
import { getChatHistory } from '../src/db.js';
import { logger } from '../src/logger.js';
import fs from 'fs';

// Initialize database
initDatabase();
const db = dbImport;

const args = process.argv.slice(2);
const command = args[0];

async function main() {
  try {
    switch (command) {
      case 'stats': {
        const agentFolder = args[1];
        if (!agentFolder) {
          console.error('Usage: npm run memory stats <agent>');
          process.exit(1);
        }

        const stats = getMemoryStats(agentFolder);
        console.log(`\n📊 Memory Statistics for ${agentFolder}\n`);
        console.log(`Total Memories: ${stats.totalMemories}`);
        console.log(`Daily Summaries: ${stats.dailySummaries}`);
        console.log(`Average Importance: ${stats.averageImportance.toFixed(2)}/10`);
        console.log(`Oldest Memory: ${stats.oldestMemory || 'None'}`);
        console.log(`Newest Memory: ${stats.newestMemory || 'None'}`);
        console.log('\nMemories by Type:');
        for (const [type, count] of Object.entries(stats.memoriesByType)) {
          console.log(`  ${type}: ${count}`);
        }
        break;
      }

      case 'search': {
        const agentFolder = args[1];
        const query = args.slice(2).join(' ');

        if (!agentFolder || !query) {
          console.error('Usage: npm run memory search <agent> <query>');
          process.exit(1);
        }

        const results = searchMemories(agentFolder, query, { limit: 10 });
        console.log(`\n🔍 Search Results for "${query}" in ${agentFolder}\n`);
        console.log(`Found ${results.length} memories:\n`);

        for (const memory of results) {
          console.log(`[${memory.importance}/10] ${memory.memory_type}: ${memory.content}`);
          console.log(`  Created: ${memory.created_at}\n`);
        }
        break;
      }

      case 'list': {
        const agentFolder = args[1];
        const limit = args[2] ? parseInt(args[2], 10) : 20;

        if (!agentFolder) {
          console.error('Usage: npm run memory list <agent> [limit]');
          process.exit(1);
        }

        const memories = getMemoriesForAgent(agentFolder, limit);
        console.log(`\n📝 Recent Memories for ${agentFolder} (showing ${memories.length})\n`);

        for (const memory of memories) {
          console.log(`[${memory.importance}/10] ${memory.memory_type}: ${memory.content}`);
          console.log(`  ID: ${memory.id}`);
          console.log(`  Created: ${memory.created_at}\n`);
        }
        break;
      }

      case 'daily': {
        const agentFolder = args[1];
        const now = new Date();
        const date = args[2] || `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

        if (!agentFolder) {
          console.error('Usage: npm run memory daily <agent> [date]');
          process.exit(1);
        }

        const daily = getDailyMemory(agentFolder, date);
        if (!daily) {
          console.log(`\nNo daily summary found for ${agentFolder} on ${date}\n`);
          break;
        }

        console.log(`\n📅 Daily Summary for ${agentFolder} - ${date}\n`);
        console.log(`Messages: ${daily.message_count}`);
        console.log(`\nSummary:\n${daily.summary}`);
        console.log(`\nTopics:\n${daily.topics.map(t => `- ${t}`).join('\n')}\n`);
        break;
      }

      case 'report': {
        const agentFolder = args[1];

        if (!agentFolder) {
          console.error('Usage: npm run memory report <agent>');
          process.exit(1);
        }

        const report = generateMemoryReport(agentFolder);
        console.log(`\n${report}\n`);
        break;
      }

      case 'extract': {
        const agentFolder = args[1];

        if (!agentFolder) {
          console.error('Usage: npm run memory extract <agent>');
          process.exit(1);
        }

        console.log(`\n🧠 Extracting memories from recent conversations for ${agentFolder}...\n`);

        // Get the most recent session for this agent
        const sessionResult = db.prepare(
          `SELECT session_id FROM web_sessions WHERE agent_folder = ? ORDER BY last_active DESC LIMIT 1`
        ).get(agentFolder) as { session_id: string } | undefined;

        if (!sessionResult) {
          console.log('No conversation history found.\n');
          break;
        }

        const sessionKey = sessionResult.session_id;
        const history = getChatHistory(sessionKey, agentFolder, 100);

        if (history.length === 0) {
          console.log('No conversation history found.\n');
          break;
        }

        const memories = await extractMemoriesFromConversation(agentFolder, history);

        console.log(`Extracted ${memories.length} memories:\n`);

        for (const memory of memories) {
          console.log(`[${memory.importance}/10] ${memory.type}: ${memory.content}`);
          // Save to database
          if (memory.importance >= 3) {
            saveMemory({
              agent_folder: agentFolder,
              memory_type: memory.type,
              content: memory.content,
              importance: memory.importance,
            });
          }
        }
        console.log('\n✅ Memories saved to database.\n');
        break;
      }

      case 'cleanup': {
        const agentFolder = args[1];
        const deleteFlag = args.includes('--delete') || args.includes('-d');

        if (!agentFolder) {
          console.error('Usage: npm run memory cleanup <agent> [--delete]');
          process.exit(1);
        }

        console.log(`\n🧹 Cleaning up low-importance memories for ${agentFolder}...\n`);

        const memories = getMemoriesForAgent(agentFolder);
        const lowImportance = memories.filter(m => m.importance < 3);

        if (!deleteFlag) {
          console.log('Note: This is a dry-run. No memories were deleted.');
          console.log('Use --delete flag to actually delete memories.\n');
        }

        console.log(`Found ${lowImportance.length} low-importance memories (importance < 3):\n`);

        for (const memory of lowImportance) {
          console.log(`[${memory.importance}/10] ${memory.memory_type}: ${memory.content}`);
          console.log(`  ID: ${memory.id}\n`);
        }

        if (deleteFlag && lowImportance.length > 0) {
          console.log(`Deleting ${lowImportance.length} memories...`);
          let deletedCount = 0;
          for (const memory of lowImportance) {
            if (deleteMemory(memory.id)) {
              deletedCount++;
            }
          }
          console.log(`✅ Deleted ${deletedCount} memories.\n`);
        } else if (deleteFlag) {
          console.log('No memories to delete.\n');
        }
        break;
      }

      case 'export': {
        const agentFolder = args[1];
        const outputFile = args[2];

        if (!agentFolder) {
          console.error('Usage: npm run memory export <agent> [output-file]');
          process.exit(1);
        }

        console.log(`\n📤 Exporting memories for ${agentFolder}...\n`);

        const jsonData = exportMemories(agentFolder);

        if (outputFile) {
          fs.writeFileSync(outputFile, jsonData, 'utf-8');
          console.log(`✅ Exported to ${outputFile}\n`);
        } else {
          console.log(jsonData);
        }
        break;
      }

      case 'import': {
        const agentFolder = args[1];
        const inputFile = args[2];
        const overwriteFlag = args.includes('--overwrite') || args.includes('-o');

        if (!agentFolder || !inputFile) {
          console.error('Usage: npm run memory import <agent> <input-file> [--overwrite]');
          process.exit(1);
        }

        if (!fs.existsSync(inputFile)) {
          console.error(`File not found: ${inputFile}`);
          process.exit(1);
        }

        console.log(`\n📥 Importing memories for ${agentFolder} from ${inputFile}...\n`);

        const jsonData = fs.readFileSync(inputFile, 'utf-8');
        const imported = importMemories(agentFolder, jsonData, overwriteFlag);

        console.log(`✅ Imported ${imported} memories.\n`);
        break;
      }

      case 'decay': {
        const agentFolder = args[1];
        const dryRun = args.includes('--dry-run') || args.includes('-n');
        const days = args.indexOf('--days') >= 0 ? parseInt(args[args.indexOf('--days') + 1], 10) : undefined;
        const rate = args.indexOf('--rate') >= 0 ? parseFloat(args[args.indexOf('--rate') + 1]) : undefined;

        if (!agentFolder) {
          console.error('Usage: npm run memory decay <agent> [--dry-run] [--days N] [--rate N]');
          process.exit(1);
        }

        console.log(`\n📉 Applying importance decay to ${agentFolder} memories...\n`);

        const updated = applyImportanceDecay(agentFolder, {
          decayStartDays: days,
          decayRate: rate,
          dryRun,
        });

        if (dryRun) {
          console.log(`Would update ${updated} memories.\n`);
        } else {
          console.log(`✅ Updated ${updated} memories.\n`);
        }
        break;
      }

      default:
        console.error(`
Unknown command: ${command}

Available commands:
  stats <agent>          Show memory statistics for an agent
  search <agent> <query>  Search memories by content
  list <agent> [limit]    List all memories for an agent
  daily <agent> [date]    Show daily memory summary
  report <agent>          Generate memory report
  extract <agent>         Manually extract memories from recent conversations
  cleanup <agent>         List low-importance memories (dry-run)
  export <agent> [file]   Export memories to JSON
  import <agent> <file>   Import memories from JSON

Examples:
  npm run memory stats lucy
  npm run memory search lucy "TypeScript"
  npm run memory list lucy 50
  npm run memory daily lucy 2026-02-19
  npm run memory report lucy
  npm run memory extract lucy
  npm run memory cleanup lucy
  npm run memory export lucy backup.json
  npm run memory import lucy backup.json --overwrite
  npm run memory cleanup lucy --delete
        `);
        process.exit(1);
    }
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

main();
