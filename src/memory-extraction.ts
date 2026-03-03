/**
 * Memory Extraction System
 * Analyzes conversations to extract structured memories using LLM
 */
import { runContainerAgent } from './container-runner.js';
import { getRegisteredGroupByFolder } from './db.js';
import { logger } from './logger.js';
import { Memory, MemoryType } from './types.js';

export interface ExtractedMemory {
  type: MemoryType;
  content: string;
  importance: number; // 1-10 scale
}

/**
 * Extract memories from a conversation using LLM analysis
 */
export async function extractMemoriesFromConversation(
  agentFolder: string,
  conversation: Array<{ role: 'user' | 'assistant'; content: string }>,
): Promise<ExtractedMemory[]> {
  if (conversation.length === 0) {
    return [];
  }

  // IMPORTANT: Use getRegisteredGroupByFolder, not getRegisteredGroup with constructed JID
  // because main agent uses Telegram JID (tg:...) not @nanoclaw.local
  const group = getRegisteredGroupByFolder(agentFolder);

  if (!group) {
    logger.error({ agentFolder }, 'Agent not found for memory extraction');
    return [];
  }

  const chatJid = group.jid;

  // Format conversation for the prompt
  const conversationText = conversation
    .map((msg) => `${msg.role.toUpperCase()}: ${msg.content}`)
    .join('\n\n');

  // Build the extraction prompt
  const extractionPrompt = `You are a memory extraction system. Analyze this conversation and extract important information that should be remembered long-term.

**Conversation to analyze:**
${conversationText}

**Instructions:**
Extract memories in these categories:
1. **FACT** - Specific information mentioned (dates, names, events, facts)
2. **PREFERENCE** - User likes/dislikes, communication preferences, habits
3. **DECISION** - Choices made or conclusions reached
4. **EVENT** - Important events or occurrences
5. **PATTERN** - Recurring themes, behaviors, or trends

For each memory, provide:
- type: One of: fact, preference, decision, event, pattern
- content: Brief description (1-2 sentences max)
- importance: Rating 1-10 based on significance (10 = critical, 1 = minor)

**Rating Guidelines:**
- 9-10: Critical user preferences, major decisions, important facts user expects to be remembered
- 7-8: Significant events, strong preferences, notable patterns
- 5-6: Moderate preferences, routine facts, useful information
- 3-4: Minor details, casual mentions
- 1-2: Trivial information, rarely relevant

**Output Format:**
Return ONLY a JSON array. No markdown, no code blocks, no additional text.

Example output format:
[
  {"type": "preference", "content": "User prefers brief, concise responses without unnecessary elaboration", "importance": 8},
  {"type": "fact", "content": "User is working on a TypeScript project called NanoClaw", "importance": 6},
  {"type": "decision", "content": "Decided to implement SQLite-based memory system instead of pure file-based", "importance": 7}
]

If no significant memories are found, return an empty array: []`;

  try {
    // Run the agent with the extraction prompt
    const result = await runContainerAgent(
      group,
      {
        prompt: extractionPrompt,
        groupFolder: agentFolder,
        chatJid,
        isMain: agentFolder === 'lucy',
        singleMessage: true,
      },
      () => {
        // No process tracking needed
      },
      undefined, // No streaming callback needed
    );

    if (result.status === 'error') {
      logger.error(
        { error: result.error, agentFolder },
        'Memory extraction failed',
      );
      return [];
    }

    if (!result.result) {
      logger.warn({ agentFolder }, 'Memory extraction returned no result');
      return [];
    }

    // Parse the JSON response
    const responseText =
      typeof result.result === 'string'
        ? result.result
        : JSON.stringify(result.result);

    // Try to extract JSON array from the response - find outermost brackets by counting
    let bracketCount = 0;
    let startIndex = -1;
    let endIndex = -1;

    for (let i = 0; i < responseText.length; i++) {
      if (responseText[i] === '[') {
        if (startIndex === -1) {
          startIndex = i;
        }
        bracketCount++;
      } else if (responseText[i] === ']') {
        bracketCount--;
        if (bracketCount === 0 && startIndex !== -1) {
          endIndex = i + 1;
          break;
        }
      }
    }

    if (startIndex === -1 || endIndex === -1) {
      logger.warn(
        { agentFolder, response: responseText.slice(0, 200) },
        'No JSON array found in extraction response',
      );
      return [];
    }

    const jsonString = responseText.slice(startIndex, endIndex);
    const memories = JSON.parse(jsonString) as ExtractedMemory[];

    // Validate and filter memories
    const validTypes: MemoryType[] = [
      'fact',
      'preference',
      'decision',
      'event',
      'pattern',
    ];
    const filteredMemories = memories.filter((m) => {
      if (!validTypes.includes(m.type)) {
        logger.warn(
          { invalidType: m.type, content: m.content },
          'Invalid memory type, skipping',
        );
        return false;
      }
      if (m.importance < 1 || m.importance > 10) {
        logger.warn(
          { invalidImportance: m.importance, content: m.content },
          'Invalid importance, defaulting to 5',
        );
        m.importance = 5;
      }
      if (!m.content || m.content.trim().length === 0) {
        logger.warn({ memory: m }, 'Empty memory content, skipping');
        return false;
      }
      return true;
    });

    logger.info(
      { agentFolder, extractedCount: filteredMemories.length },
      'Memories extracted successfully',
    );
    return filteredMemories;
  } catch (error) {
    logger.error({ error, agentFolder }, 'Exception during memory extraction');
    return [];
  }
}

/**
 * Create a daily summary of conversations
 */
export async function createDailySummary(
  agentFolder: string,
  date: string,
  messages: Array<{
    role: 'user' | 'assistant';
    content: string;
    timestamp: string;
  }>,
): Promise<{ summary: string; topics: string[] } | null> {
  if (messages.length === 0) {
    return null;
  }

  // IMPORTANT: Use getRegisteredGroupByFolder, not getRegisteredGroup with constructed JID
  // because main agent uses Telegram JID (tg:...) not @nanoclaw.local
  const group = getRegisteredGroupByFolder(agentFolder);

  if (!group) {
    logger.error({ agentFolder }, 'Agent not found for daily summary');
    return null;
  }

  const chatJid = group.jid;

  // Format conversation for the prompt
  const conversationText = messages
    .map(
      (msg) => `[${msg.timestamp}] ${msg.role.toUpperCase()}: ${msg.content}`,
    )
    .join('\n\n');

  const summaryPrompt = `You are a conversation summarization system. Create a daily summary of this conversation.

**Date:** ${date}
**Message count:** ${messages.length}

**Conversation:**
${conversationText}

**Instructions:**
Create a concise daily summary that includes:
1. **Overview** - 2-3 sentences about the main topics discussed
2. **Key Topics** - List 5-10 main topics/themes (as a JSON array)
3. **Important Outcomes** - Any decisions made, tasks completed, or significant achievements

**Output Format:**
Return ONLY valid JSON in this exact format (no markdown, no code blocks):
{
  "summary": "Brief 2-3 sentence overview of the day's conversations...",
  "topics": ["topic1", "topic2", "topic3", ...]
}

Keep the summary under 200 words.`;

  try {
    const result = await runContainerAgent(
      group,
      {
        prompt: summaryPrompt,
        groupFolder: agentFolder,
        chatJid,
        isMain: agentFolder === 'lucy',
        singleMessage: true,
      },
      () => {},
      undefined,
    );

    if (result.status === 'error' || !result.result) {
      logger.error(
        { error: result.error, agentFolder },
        'Daily summary failed',
      );
      return null;
    }

    const responseText =
      typeof result.result === 'string'
        ? result.result
        : JSON.stringify(result.result);

    // Extract JSON - find the outermost object by counting braces
    let braceCount = 0;
    let startIndex = -1;
    let endIndex = -1;

    for (let i = 0; i < responseText.length; i++) {
      if (responseText[i] === '{') {
        if (startIndex === -1) {
          startIndex = i;
        }
        braceCount++;
      } else if (responseText[i] === '}') {
        braceCount--;
        if (braceCount === 0 && startIndex !== -1) {
          endIndex = i + 1;
          break;
        }
      }
    }

    if (startIndex === -1 || endIndex === -1) {
      logger.warn(
        { agentFolder, response: responseText.slice(0, 200) },
        'No JSON found in summary response',
      );
      return null;
    }

    const jsonString = responseText.slice(startIndex, endIndex);
    const summaryData = JSON.parse(jsonString) as {
      summary: string;
      topics: string[];
    };

    if (!summaryData.summary || !Array.isArray(summaryData.topics)) {
      logger.warn({ summaryData }, 'Invalid summary format');
      return null;
    }

    logger.info(
      { agentFolder, date, topicCount: summaryData.topics.length },
      'Daily summary created',
    );
    return summaryData;
  } catch (error) {
    logger.error(
      { error, agentFolder },
      'Exception during daily summary creation',
    );
    return null;
  }
}
