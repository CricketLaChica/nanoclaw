import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  ASSISTANT_NAME,
  DATA_DIR,
  IDLE_TIMEOUT,
  MAIN_GROUP_FOLDER,
  POLL_INTERVAL,
} from './config.js';
import { WhatsAppChannel } from './channels/whatsapp.js';
import { startWebSocketServer, stopWebSocketServer } from './websocket.js';
import {
  ContainerOutput,
  runContainerAgent,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import { stopAllContainers, cleanupOrphanedContainers } from './container-pool.js';
import {
  getAllChats,
  getAllRegisteredGroups,
  getAllSessions,
  getAllTasks,
  getMessagesSince,
  getNewMessages,
  getRouterState,
  initDatabase,
  setRegisteredGroup,
  setRouterState,
  setSession,
  storeChatMetadata,
  storeMessage,
  storeMessageDirect,
  updateChatName,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { startIpcWatcher } from './ipc.js';
import { formatMessages, formatOutbound, routeOutbound } from './router.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { NewMessage, RegisteredGroup } from './types.js';
import { handleWorkflowMessage } from './workflow-router.js';
import { logger } from './logger.js';
import { getRelevantMemories, readPersonalityFile } from './memory.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

let lastTimestamp = '';
let sessions: Record<string, string> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};
let messageLoopRunning = false;

// Track active delegations to safely swap registrations
// Key: sourceJid, Value: { originalGroup, delegatedBy }
const activeDelegations: Record<string, { originalGroup: RegisteredGroup; delegatedBy: string }> = {};

let whatsapp: WhatsAppChannel;
const queue = new GroupQueue();

function loadState(): void {
  lastTimestamp = getRouterState('last_timestamp') || '';
  const agentTs = getRouterState('last_agent_timestamp');
  try {
    lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
  } catch {
    logger.warn('Corrupted last_agent_timestamp in DB, resetting');
    lastAgentTimestamp = {};
  }
  sessions = getAllSessions();
  registeredGroups = getAllRegisteredGroups();
  logger.info(
    { groupCount: Object.keys(registeredGroups).length },
    'State loaded',
  );
}

function saveState(): void {
  setRouterState('last_timestamp', lastTimestamp);
  setRouterState(
    'last_agent_timestamp',
    JSON.stringify(lastAgentTimestamp),
  );
}

function registerGroup(jid: string, group: RegisteredGroup): void {
  registeredGroups[jid] = group;
  setRegisteredGroup(jid, group);

  // Create group folder
  const groupDir = path.join(DATA_DIR, '..', 'groups', group.folder);
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  logger.info(
    { jid, name: group.name, folder: group.folder },
    'Group registered',
  );
}

/**
 * Get available groups list for the agent.
 * Returns groups ordered by most recent activity.
 */
export function getAvailableGroups(): import('./container-runner.js').AvailableGroup[] {
  const chats = getAllChats();
  const registeredJids = new Set(Object.keys(registeredGroups));

  return chats
    .filter((c) => c.jid !== '__group_sync__' && c.jid.endsWith('@g.us'))
    .map((c) => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid),
    }));
}

/** @internal - exported for testing */
export function _setRegisteredGroups(groups: Record<string, RegisteredGroup>): void {
  registeredGroups = groups;
}

/**
 * Process all pending messages for a group.
 * Called by the GroupQueue when it's this group's turn.
 */
async function processGroupMessages(chatJid: string): Promise<boolean> {
  let group = registeredGroups[chatJid];
  if (!group) return true;

  // Check if this is a delegated request (source agent passing to target agent)
  const delegation = activeDelegations[chatJid];
  let isDelegated = false;
  if (delegation) {
    // Get the target agent's registration
    const targetJid = `${delegation.delegatedBy}@nanoclaw.local`;
    const targetGroup = registeredGroups[targetJid];
    if (targetGroup) {
      logger.info({ chatJid, delegatedTo: delegation.delegatedBy }, 'Processing delegated request');
      group = targetGroup;
      isDelegated = true;
      // Temporarily swap for this processing
      registeredGroups[chatJid] = targetGroup;
    }
  }

  const isMainGroup = group.folder === MAIN_GROUP_FOLDER;

  const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
  const missedMessages = getMessagesSince(chatJid, sinceTimestamp, ASSISTANT_NAME);

  if (missedMessages.length === 0) {
    // Restore original registration after delegation
    if (isDelegated && delegation) {
      registeredGroups[chatJid] = delegation.originalGroup;
      delete activeDelegations[chatJid];
    }
    return true;
  }

  // Build prompt with memory context
  let prompt = formatMessages(missedMessages);

  // Add relevant long-term memories for context
  // Get the last message as a query for memory retrieval
  const lastMessage = missedMessages.length > 0
    ? missedMessages[missedMessages.length - 1].content
    : '';

  // Check for workflow commands BEFORE processing
  if (lastMessage) {
    const workflowResult = await handleWorkflowMessage(lastMessage, group.folder);
    if (workflowResult.shouldSend) {
      // Workflow command detected and handled
      if (whatsapp && whatsapp.isConnected()) {
        await whatsapp.sendMessage(chatJid, workflowResult.response);
      }

      // Update timestamp so we don't reprocess this message
      lastAgentTimestamp[chatJid] = missedMessages[missedMessages.length - 1].timestamp;
      saveState();

      // Restore original registration after delegation
      if (isDelegated && delegation) {
        registeredGroups[chatJid] = delegation.originalGroup;
        delete activeDelegations[chatJid];
      }
      return true;
    }
  }

  if (lastMessage) {
    const relevantMemories = getRelevantMemories(group.folder, lastMessage, 5);

    logger.debug(
      { group: group.name, memoryCount: relevantMemories.length },
      'Memory injection: fetched relevant memories'
    );

    // Add personality context if SOUL.md exists
    const soulContent = readPersonalityFile(group.folder, 'SOUL.md');
    const memoryContextParts: string[] = [];

    if (soulContent) {
      memoryContextParts.push(`**Personality & Core Values:**\n${soulContent.trim()}`);
    }

    if (relevantMemories.length > 0) {
      const memoryText = relevantMemories
        .map(m => `- [${m.memory_type}] ${m.content}`)
        .join('\n');
      memoryContextParts.push(`**Relevant Memories:**\n${memoryText}`);
    }

    if (memoryContextParts.length > 0) {
      prompt = `${memoryContextParts.join('\n\n')}\n\n**Conversation:**\n${prompt}`;

      logger.debug(
        { group: group.name, contextSize: memoryContextParts.length },
        'Memory injection: added memories to prompt'
      );
    }
  }

  // Advance cursor so the piping path in startMessageLoop won't re-fetch
  // these messages. Save the old cursor so we can roll back on error.
  const previousCursor = lastAgentTimestamp[chatJid] || '';
  lastAgentTimestamp[chatJid] =
    missedMessages[missedMessages.length - 1].timestamp;
  saveState();

  logger.info(
    { group: group.name, delegated: isDelegated, messageCount: missedMessages.length },
    'Processing messages',
  );

  // Track idle timer for closing stdin when agent is idle
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug({ group: group.name }, 'Idle timeout, closing container stdin');
      queue.closeStdin(chatJid);
    }, IDLE_TIMEOUT);
  };

  await whatsapp.setTyping(chatJid, true);
  let hadError = false;
  let outputSentToUser = false;
  let accumulatedResponse = '';
  let delegationChecked = false;

  const output = await runAgent(group, prompt, chatJid, async (result) => {
    // Streaming output callback — called for each agent result
    if (result.result) {
      const raw = typeof result.result === 'string' ? result.result : JSON.stringify(result.result);
      // Strip <internal>...</internal> blocks — agent uses these for internal reasoning
      const text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
      accumulatedResponse += text;
      logger.info({ group: group.name, delegated: isDelegated }, `Agent output: ${raw.slice(0, 200)}`);
      if (text) {
        await whatsapp.sendMessage(chatJid, text);
        outputSentToUser = true;
      }
      // Only reset idle timer on actual results, not session-update markers (result: null)
      resetIdleTimer();
    }

    // Check for delegation after receiving output (handles timeouts better)
    if (accumulatedResponse && !delegationChecked && isDelegated) {
      delegationChecked = true;
      logger.info({ agentFolder: group.folder, chatJid, responseLength: accumulatedResponse.length }, 'Checking for delegation in streaming response');
      detectAndExecuteDelegationForIndex(accumulatedResponse, missedMessages[missedMessages.length - 1].content, group.folder);
    }

    if (result.status === 'error') {
      hadError = true;
    }
  });

  await whatsapp.setTyping(chatJid, false);
  if (idleTimer) clearTimeout(idleTimer);

  // Save the accumulated response to database for delegated requests
  // This ensures responses like Hali's blog post are persisted
  if (accumulatedResponse && isDelegated) {
    logger.info({ agentFolder: group.folder, chatJid, responseLength: accumulatedResponse.length }, 'Saving delegated agent response to database');
    storeMessageDirect({
      id: `delegated-response-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      chat_jid: chatJid,
      sender: chatJid,
      sender_name: group.folder,
      content: accumulatedResponse,
      timestamp: new Date().toISOString(),
      is_from_me: false,
      is_bot_message: false,
    });
  }

  // Detect and execute delegation (for delegated requests that don't go through WebSocket)
  if (accumulatedResponse && isDelegated) {
    // Use the actual agent that responded (group.folder), not the original chat JID
    logger.info({ agentFolder: group.folder, chatJid, responseLength: accumulatedResponse.length }, 'Checking for delegation in agent response');
    detectAndExecuteDelegationForIndex(accumulatedResponse, missedMessages[missedMessages.length - 1].content, group.folder);
  } else if (accumulatedResponse) {
    // Also check for delegation in non-delegated requests
    logger.info({ agentFolder: group.folder, chatJid, responseLength: accumulatedResponse.length }, 'Checking for delegation in agent response (non-delegated)');
    detectAndExecuteDelegationForIndex(accumulatedResponse, missedMessages[missedMessages.length - 1].content, group.folder);
  }

  // Restore original registration after delegation
  if (isDelegated && delegation) {
    registeredGroups[chatJid] = delegation.originalGroup;
    delete activeDelegations[chatJid];
    logger.info({ chatJid }, 'Delegation complete, restored original agent');
  }

  if (output === 'error' || hadError) {
    // If we already sent output to the user, don't roll back the cursor —
    // the user got their response and re-processing would send duplicates.
    if (outputSentToUser) {
      logger.warn({ group: group.name }, 'Agent error after output was sent, skipping cursor rollback to prevent duplicates');
      return true;
    }
    // Roll back cursor so retries can re-process these messages
    lastAgentTimestamp[chatJid] = previousCursor;
    saveState();
    logger.warn({ group: group.name }, 'Agent error, rolled back message cursor for retry');
    return false;
  }

  return true;
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<'success' | 'error'> {
  const isMain = group.folder === MAIN_GROUP_FOLDER;
  const sessionId = sessions[group.folder];

  // Update tasks snapshot for container to read (filtered by group)
  const tasks = getAllTasks();
  writeTasksSnapshot(
    group.folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  // Update available groups snapshot (main group only can see all groups)
  const availableGroups = getAvailableGroups();
  writeGroupsSnapshot(
    group.folder,
    isMain,
    availableGroups,
    new Set(Object.keys(registeredGroups)),
  );

  // Wrap onOutput to track session ID from streamed results
  const wrappedOnOutput = onOutput
    ? async (output: ContainerOutput) => {
        if (output.newSessionId) {
          sessions[group.folder] = output.newSessionId;
          setSession(group.folder, output.newSessionId);
        }
        await onOutput(output);
      }
    : undefined;

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt,
        sessionId,
        groupFolder: group.folder,
        chatJid,
        isMain,
      },
      (proc, containerName) => queue.registerProcess(chatJid, proc, containerName, group.folder),
      wrappedOnOutput,
    );

    if (output.newSessionId) {
      sessions[group.folder] = output.newSessionId;
      setSession(group.folder, output.newSessionId);
    }

    if (output.status === 'error') {
      logger.error(
        { group: group.name, error: output.error },
        'Container agent error',
      );
      return 'error';
    }

    return 'success';
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
    return 'error';
  }
}

async function startMessageLoop(): Promise<void> {
  if (messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  messageLoopRunning = true;

  logger.info(`NanoClaw running (trigger: @${ASSISTANT_NAME})`);

  while (true) {
    try {
      const jids = Object.keys(registeredGroups);
      const { messages, newTimestamp } = getNewMessages(jids, lastTimestamp, ASSISTANT_NAME);

      if (messages.length > 0) {
        logger.info({ count: messages.length }, 'New messages');

        // Advance the "seen" cursor for all messages immediately
        lastTimestamp = newTimestamp;
        saveState();

        // Deduplicate by group
        const messagesByGroup = new Map<string, NewMessage[]>();
        for (const msg of messages) {
          const existing = messagesByGroup.get(msg.chat_jid);
          if (existing) {
            existing.push(msg);
          } else {
            messagesByGroup.set(msg.chat_jid, [msg]);
          }
        }

        for (const [chatJid, groupMessages] of messagesByGroup) {
          const group = registeredGroups[chatJid];
          if (!group) continue;

          // Pull all messages since lastAgentTimestamp
          const allPending = getMessagesSince(
            chatJid,
            lastAgentTimestamp[chatJid] || '',
            ASSISTANT_NAME,
          );
          const messagesToSend =
            allPending.length > 0 ? allPending : groupMessages;
          const formatted = formatMessages(messagesToSend);

          if (queue.sendMessage(chatJid, formatted)) {
            logger.debug(
              { chatJid, count: messagesToSend.length },
              'Piped messages to active container',
            );
            lastAgentTimestamp[chatJid] =
              messagesToSend[messagesToSend.length - 1].timestamp;
            saveState();
            // Show typing indicator while the container processes the piped message
            whatsapp.setTyping(chatJid, true);
          } else {
            // No active container — enqueue for a new one
            queue.enqueueMessageCheck(chatJid);
          }
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

/**
 * Startup recovery: check for unprocessed messages in registered groups.
 * Handles crash between advancing lastTimestamp and processing messages.
 */
function recoverPendingMessages(): void {
  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
    const pending = getMessagesSince(chatJid, sinceTimestamp, ASSISTANT_NAME);
    if (pending.length > 0) {
      logger.info(
        { group: group.name, pendingCount: pending.length },
        'Recovery: found unprocessed messages',
      );
      queue.enqueueMessageCheck(chatJid);
    }
  }
}

function ensureDockerRunning(): void {
  try {
    execSync('docker info', { stdio: 'pipe', timeout: 10000 });
    logger.debug('Docker daemon is running');
  } catch {
    logger.error('Docker daemon is not running');
    console.error(
      '\n╔════════════════════════════════════════════════════════════════╗',
    );
    console.error(
      '║  FATAL: Docker is not running                                  ║',
    );
    console.error(
      '║                                                                ║',
    );
    console.error(
      '║  Agents cannot run without Docker. To fix:                     ║',
    );
    console.error(
      '║  macOS: Start Docker Desktop                                   ║',
    );
    console.error(
      '║  Linux: sudo systemctl start docker                            ║',
    );
    console.error(
      '║                                                                ║',
    );
    console.error(
      '║  Install from: https://docker.com/products/docker-desktop      ║',
    );
    console.error(
      '╚════════════════════════════════════════════════════════════════╝\n',
    );
    throw new Error('Docker is required but not running');
  }
}

async function main(): Promise<void> {
  ensureDockerRunning();
  initDatabase();
  logger.info('Database initialized');

  // Clean up orphaned containers from previous runs
  logger.info('Checking for orphaned containers...');
  await cleanupOrphanedContainers();

  loadState();

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');

    // Stop all pooled containers first
    try {
      await stopAllContainers();
      logger.info('All containers stopped');
    } catch (err) {
      logger.error({ err }, 'Error stopping containers during shutdown');
    }

    stopWebSocketServer();
    await queue.shutdown(10000);
    await whatsapp.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Create WhatsApp channel
  whatsapp = new WhatsAppChannel({
    onMessage: (chatJid, msg) => storeMessage(msg),
    onChatMetadata: (chatJid, timestamp) => storeChatMetadata(chatJid, timestamp),
    registeredGroups: () => registeredGroups,
  });

  // Connect — resolves when first connected
  await whatsapp.connect();

  // Start WebSocket server for web app integration
  // Pass sendMessage function so agents can send to WhatsApp groups
  startWebSocketServer((jid, text) => whatsapp.sendMessage(jid, text));
  logger.info('WebSocket server started');

  // Implement sendAgentMessage for agent-to-agent delegation
  const sendAgentMessage = async (fromAgent: string, toAgent: string, message: string, context?: any): Promise<void> => {
    logger.info({ fromAgent, toAgent, messageLength: message.length, context }, 'Agent delegation requested');

    // Get both agents' registrations
    const sourceJid = `${fromAgent}@nanoclaw.local`;
    const targetJid = `${toAgent}@nanoclaw.local`;
    const sourceGroup = registeredGroups[sourceJid];
    const targetGroup = registeredGroups[targetJid];

    if (!targetGroup) {
      logger.error({ toAgent, targetJid }, 'Target agent not found for delegation');
      throw new Error(`Agent ${toAgent} not found`);
    }

    // Track this delegation so processGroupMessages knows to use the target agent
    activeDelegations[sourceJid] = {
      originalGroup: sourceGroup,
      delegatedBy: toAgent,
    };

    // Ensure the source chat exists in the database (required for FOREIGN KEY constraint)
    updateChatName(sourceJid, fromAgent);

    // Store the delegated message for the SOURCE chat Jid (preserves WebSocket session)
    // Note: is_bot_message must be false so getMessagesSince will pick it up for processing
    await storeMessageDirect({
      id: `delegated-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      chat_jid: sourceJid,
      sender: sourceJid,
      sender_name: fromAgent,
      content: `[Delegating to ${toAgent}]: ${message}`,
      timestamp: new Date().toISOString(),
      is_from_me: false,
      is_bot_message: false,
    });

    // Notify queue to process this message
    queue.enqueueMessageCheck(sourceJid);

    logger.info({ fromAgent, toAgent, sourceJid }, 'Delegation queued');
  };

  // Start subsystems (independently of connection handler)
  startSchedulerLoop({
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    queue,
    onProcess: (groupJid, proc, containerName, groupFolder) => queue.registerProcess(groupJid, proc, containerName, groupFolder),
    sendMessage: async (jid, rawText) => {
      const text = formatOutbound(rawText);
      if (text) await whatsapp.sendMessage(jid, text);
    },
  });
  startIpcWatcher({
    sendMessage: (jid, text) => whatsapp.sendMessage(jid, text),
    registeredGroups: () => registeredGroups,
    registerGroup,
    syncGroupMetadata: (force) => whatsapp.syncGroupMetadata(force),
    getAvailableGroups,
    writeGroupsSnapshot: (gf, im, ag, rj) => writeGroupsSnapshot(gf, im, ag, rj),
    sendAgentMessage,
  });
  queue.setProcessMessagesFn(processGroupMessages);
  recoverPendingMessages();
  startMessageLoop();
}

// Process WebSocket message from web app
export async function processWebSocketMessage(
  sessionId: string,
  agentFolder: string,
  message: string,
  onStream: (content: string, isFinal: boolean) => void,
): Promise<void> {
  const chatJid = `${agentFolder}@nanoclaw.local`;
  const group = registeredGroups[chatJid];

  if (!group) {
    throw new Error(`Agent ${agentFolder} not registered`);
  }

  logger.info({ sessionId, agentFolder, message: message.substring(0, 50) }, 'WebSocket message received');

  // Store the message in database
  storeMessageDirect({
    id: `web-${sessionId}-${Date.now()}`,
    chat_jid: chatJid,
    sender: sessionId,
    sender_name: 'Web User',
    content: message,
    timestamp: new Date().toISOString(),
    is_from_me: false,
  });

  // Process the message through the agent
  await processGroupMessages(chatJid);
}

/**
 * Detect delegation in agent response and execute it automatically.
 * This is a workaround for GLM5 not calling tools reliably.
 * Used by the index.ts message processing path (delegated requests).
 */
function detectAndExecuteDelegationForIndex(
  response: string,
  originalMessage: string,
  fromAgentFolder: string,
): void {
  // Known agents that can be delegated to
  const knownAgents = ['maui', 'nalu', 'hoku', 'hali', 'moana', 'koa', 'leilani', 'noelani', 'ikaika',
                       'reef', 'pali', 'mana', 'ahi', 'liko', 'kai', 'wai', 'makani', 'lani', 'keoni', 'pua', 'noe'];

  const lowerResponse = response.toLowerCase();

  // Find if agent is mentioned
  const mentionedAgent = knownAgents.find(agent => lowerResponse.includes(agent));

  if (!mentionedAgent) {
    return; // No delegation detected
  }

  logger.info(
    { fromAgent: fromAgentFolder, toAgent: mentionedAgent, originalMessage },
    'Delegation detected in agent response, executing automatically'
  );

  // Write delegation IPC file to the SOURCE agent's tasks directory
  const tasksDir = path.join(DATA_DIR, 'ipc', fromAgentFolder, 'tasks');
  fs.mkdirSync(tasksDir, { recursive: true });

  const timestamp = new Date().toISOString();
  const delegationFile = path.join(tasksDir, `delegation-${Date.now()}.json`);

  const delegationContent = {
    type: 'agent_message',
    from: fromAgentFolder,
    to: mentionedAgent,
    message: originalMessage,
    context: {
      originalRequest: originalMessage,
      delegatedBy: fromAgentFolder,
      timestamp,
    },
  };

  try {
    fs.writeFileSync(delegationFile, JSON.stringify(delegationContent));
    logger.info(
      { from: fromAgentFolder, to: mentionedAgent, file: delegationFile },
      'Delegation IPC file written successfully'
    );
  } catch (err) {
    logger.error({ error: err }, 'Failed to write delegation IPC file');
  }
}

// Guard: only run when executed directly, not when imported by tests
const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname === new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start NanoClaw');
    process.exit(1);
  });
}
