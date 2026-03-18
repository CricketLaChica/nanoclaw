import { WebSocketServer, WebSocket } from 'ws';
import { randomUUID } from 'crypto';
import path from 'path';
import fs from 'fs';
import { logger } from './logger.js';
import {
  WEBSOCKET_PORT,
  WEBSOCKET_CORS_ORIGIN,
  WEBSOCKET_AUTH_TOKEN,
  WEBSOCKET_MAX_MESSAGE_SIZE,
  WEBSOCKET_AUTH_MAX_ATTEMPTS,
  WEBSOCKET_AUTH_WINDOW_MS,
  ASSISTANT_NAME,
  GROUPS_DIR,
  DATA_DIR,
  TIMEZONE,
  CONTAINER_TIMEOUT,
  IDLE_TIMEOUT,
  MAX_CONCURRENT_CONTAINERS,
  KNOWN_AGENTS,
  MAIN_GROUP_FOLDER,
  MAIN_GROUP_JID,
} from './config.js';
import {
  getChatHistory,
  saveChatMessage,
  setRegisteredGroup,
  getAllRegisteredGroups,
  markChatAsRead,
  hasUnreadMessages,
  getAllGoals,
  getGoalById,
  createGoal,
  updateGoal,
  deleteGoal,
  archiveGoal,
} from './db.js';
import { handleWorkflowMessage } from './workflow-router.js';
import {
  listWorkflowRuns,
  getWorkflowStatus,
  getWorkflowRun,
} from './workflow-db.js';
import { workflowEngine } from './workflow-engine.js';
import { runContainerAgent } from './container-runner.js';
import { getRegisteredGroup, getRegisteredGroupByFolder } from './db.js';
import { getOrCreateContainer, getContainerStats } from './container-pool.js';
import { RegisteredGroup } from './types.js';
import { getRelevantMemories, readPersonalityFile } from './memory.js';
import Database from 'better-sqlite3';

// Kanban database path (support both container and Mac host)
const KANBAN_DB_PATH =
  process.env.KANBAN_DB_PATH ||
  path.join(DATA_DIR, 'workspace', 'data', 'kanban.db');

interface WebSocketClient {
  ws: WebSocket;
  sessionId: string;
  authenticated: boolean;
  agent: string; // Current selected agent
}

interface OpenClawRequest {
  type: 'req';
  id: string;
  method: string;
  params: any;
}

interface OpenClawResponse {
  type: 'res';
  id: string;
  ok?: boolean;
  error?: { code: number; message: string };
  payload?: any;
}

interface OpenClawEvent {
  type: 'event';
  event: string;
  payload: any;
}

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
}

// Retry configuration for container execution
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000; // Start with 1 second
const MAX_RETRY_DELAY_MS = 10000; // Max 10 seconds

let wss: WebSocketServer | null = null;
const clients = new Map<WebSocket, WebSocketClient>();

// Auth rate limiting: track failed attempts by IP
const authAttempts = new Map<string, { count: number; firstAttempt: number }>();

function checkAuthRateLimit(ip: string): boolean {
  const now = Date.now();
  const attempts = authAttempts.get(ip);

  if (!attempts) {
    authAttempts.set(ip, { count: 1, firstAttempt: now });
    return true;
  }

  // Reset if outside the window
  if (now - attempts.firstAttempt > WEBSOCKET_AUTH_WINDOW_MS) {
    authAttempts.set(ip, { count: 1, firstAttempt: now });
    return true;
  }

  // Check if over limit
  if (attempts.count >= WEBSOCKET_AUTH_MAX_ATTEMPTS) {
    return false;
  }

  attempts.count++;
  return true;
}

// Cleanup old auth attempts every 5 minutes
const authCleanupInterval = setInterval(
  () => {
    const now = Date.now();
    for (const [ip, attempts] of authAttempts.entries()) {
      if (now - attempts.firstAttempt > WEBSOCKET_AUTH_WINDOW_MS * 2) {
        authAttempts.delete(ip);
      }
    }
  },
  5 * 60 * 1000,
);
// Allow the process to exit even if this interval is still scheduled
authCleanupInterval.unref();

// Callback for sending messages to external channels (e.g., WhatsApp)
let sendMessageToExternal:
  | ((jid: string, text: string) => Promise<void>)
  | null = null;

export function startWebSocketServer(
  sendMessageFn?: (jid: string, text: string) => Promise<void>,
): void {
  if (wss) {
    logger.warn('WebSocket server already running');
    return;
  }

  // Store the sendMessage callback for external channel routing
  sendMessageToExternal = sendMessageFn || null;

  // Load persisted tasks (deferred from module scope to avoid import-time side effects)
  loadTasks();

  wss = new WebSocketServer({
    port: WEBSOCKET_PORT,
  });

  wss.on('listening', () => {
    logger.info({ port: WEBSOCKET_PORT }, 'WebSocket server started');
    // Start background task watcher
    startBackgroundTaskWatcher();
  });

  wss.on('connection', (ws, req) => {
    const clientId = randomUUID();
    const clientIp = req.socket.remoteAddress || 'unknown';
    logger.info({ clientId, ip: clientIp }, 'WebSocket client connected');

    // Check CORS origin
    const origin = req.headers.origin;
    if (WEBSOCKET_CORS_ORIGIN !== '*' && origin !== WEBSOCKET_CORS_ORIGIN) {
      logger.warn(
        { origin, allowedOrigin: WEBSOCKET_CORS_ORIGIN },
        'CORS rejection',
      );
      ws.close(1008, 'CORS policy violation');
      return;
    }

    // Initialize client session
    const client: WebSocketClient = {
      ws,
      sessionId: clientId,
      authenticated: false,
      agent: MAIN_GROUP_FOLDER,
      ip: clientIp, // Store IP for rate limiting
    } as WebSocketClient & { ip: string };
    clients.set(ws, client);

    // Send challenge
    const nonce = randomUUID();
    sendEvent(ws, 'connect.challenge', { nonce });

    ws.on('message', async (data: Buffer) => {
      try {
        // Message size validation
        if (data.length > WEBSOCKET_MAX_MESSAGE_SIZE) {
          logger.warn(
            {
              clientId: client.sessionId,
              size: data.length,
              maxSize: WEBSOCKET_MAX_MESSAGE_SIZE,
            },
            'WebSocket message too large, closing connection',
          );
          sendError(
            ws,
            '-1',
            413,
            `Message too large (max ${WEBSOCKET_MAX_MESSAGE_SIZE / 1024 / 1024}MB)`,
          );
          ws.close(1009, 'Message too large');
          return;
        }

        const rawMessage = data.toString();
        logger.debug(
          { clientId: client.sessionId, rawMessage },
          'WebSocket message received',
        );
        const message = JSON.parse(rawMessage);
        await handleMessage(ws, client, message);
      } catch (err) {
        logger.error(
          { err, clientId: client.sessionId, rawMessage: data.toString() },
          'Error handling WebSocket message',
        );
        sendError(ws, '-1', -1, 'Invalid message format');
      }
    });

    ws.on('close', (code, reason) => {
      logger.info(
        { clientId: client.sessionId, code, reason: reason.toString() },
        'WebSocket client disconnected',
      );
      clients.delete(ws);
    });

    ws.on('error', (err) => {
      logger.error({ err, clientId: client.sessionId }, 'WebSocket error');
    });
  });

  wss.on('error', (err) => {
    logger.error({ err }, 'WebSocket server error');
  });
}

async function handleMessage(
  ws: WebSocket,
  client: WebSocketClient,
  message: any,
): Promise<void> {
  if (message.type === 'req') {
    const req = message as OpenClawRequest;
    logger.debug(
      { method: req.method, clientId: client.sessionId },
      'WebSocket request',
    );

    switch (req.method) {
      case 'connect':
        await handleConnect(ws, client, req);
        break;

      case 'sessions.list':
        await handleSessionsList(ws, client, req);
        break;

      case 'chat.history':
        await handleChatHistory(ws, client, req);
        break;

      case 'chat.send':
        await handleChatSend(ws, client, req);
        break;

      case 'chat.mark_read':
        await handleChatMarkRead(ws, client, req);
        break;

      case 'chat.search':
        await handleChatSearch(ws, client, req);
        break;

      case 'system.health':
        await handleSystemHealth(ws, client, req);
        break;

      case 'system.ping':
        await handleSystemPing(ws, client, req);
        break;

      case 'agent.update':
        await handleAgentUpdate(ws, client, req);
        break;

      case 'agents.metadata':
        await handleAgentsMetadata(ws, client, req);
        break;

      case 'agent.get_claude_md':
        await handleAgentGetClaudeMd(ws, client, req);
        break;

      case 'agent.set_claude_md':
        await handleAgentSetClaudeMd(ws, client, req);
        break;

      case 'agent.logs':
        await handleAgentLogs(ws, client, req);
        break;

      case 'agents.list':
        await handleAgentsList(ws, client, req);
        break;

      case 'files.list':
        await handleFilesList(ws, client, req);
        break;

      case 'files.roots':
        await handleFilesRoots(ws, client, req);
        break;

      case 'files.read':
        await handleFilesRead(ws, client, req);
        break;

      case 'files.write':
        await handleFilesWrite(ws, client, req);
        break;

      case 'files.delete':
        await handleFilesDelete(ws, client, req);
        break;

      case 'files.mkdir':
        await handleFilesMkdir(ws, client, req);
        break;

      case 'workflow.list':
        await handleWorkflowList(ws, client, req);
        break;

      case 'workflow.status':
        await handleWorkflowStatus(ws, client, req);
        break;

      case 'workflow.cancel':
        await handleWorkflowCancel(ws, client, req);
        break;

      case 'workflow.start':
        await handleWorkflowStart(ws, client, req);
        break;

      case 'channel.send':
      case 'whatsapp.send': // Legacy alias
        await handleChannelSend(ws, client, req);
        break;

      case 'task.start':
        await handleTaskStart(ws, client, req);
        break;

      case 'task.status':
        await handleTaskStatus(ws, client, req);
        break;

      case 'task.list':
        await handleTaskList(ws, client, req);
        break;

      case 'task.active':
        await handleTaskActive(ws, client, req);
        break;

      case 'task.cancel':
        await handleTaskCancel(ws, client, req);
        break;

      case 'schedule.list':
        await handleScheduleList(ws, client, req);
        break;

      // Goals
      case 'goals.list':
        await handleGoalsList(ws, client, req);
        break;
      case 'goals.get':
        await handleGoalsGet(ws, client, req);
        break;
      case 'goals.create':
        await handleGoalsCreate(ws, client, req);
        break;
      case 'goals.update':
        await handleGoalsUpdate(ws, client, req);
        break;
      case 'goals.delete':
        await handleGoalsDelete(ws, client, req);
        break;

      // Dashboard
      case 'dashboard.stats':
        await handleDashboardStats(ws, client, req);
        break;

      // Metrics
      case 'metrics.get':
        await handleMetricsGet(ws, client, req);
        break;

      // Config
      case 'config.get':
        await handleConfigGet(ws, client, req);
        break;

      // Memory
      case 'memory.list':
        await handleMemoryList(ws, client, req);
        break;
      case 'memory.search':
        await handleMemorySearch(ws, client, req);
        break;
      case 'memory.get':
        await handleMemoryGet(ws, client, req);
        break;
      case 'memory.stats':
        await handleMemoryStats(ws, client, req);
        break;

      // System
      case 'system.info':
        await handleSystemInfo(ws, client, req);
        break;
      case 'system.containers':
        await handleSystemContainers(ws, client, req);
        break;

      // Projects
      case 'projects.discover':
        await handleProjectsDiscover(ws, client, req);
        break;
      case 'projects.list':
        await handleProjectsList(ws, client, req);
        break;
      case 'projects.start':
        await handleProjectsStart(ws, client, req);
        break;
      case 'projects.stop':
        await handleProjectsStop(ws, client, req);
        break;
      case 'projects.logs':
        await handleProjectsLogs(ws, client, req);
        break;
      case 'projects.delete':
        await handleProjectsDelete(ws, client, req);
        break;

      // Kanban
      case 'kanban.workspace':
        await handleKanbanWorkspace(ws, client, req);
        break;
      case 'kanban.createBoard':
        await handleKanbanCreateBoard(ws, client, req);
        break;
      case 'kanban.updateBoard':
        await handleKanbanUpdateBoard(ws, client, req);
        break;
      case 'kanban.deleteBoard':
        await handleKanbanDeleteBoard(ws, client, req);
        break;
      case 'kanban.createColumn':
        await handleKanbanCreateColumn(ws, client, req);
        break;
      case 'kanban.updateColumn':
        await handleKanbanUpdateColumn(ws, client, req);
        break;
      case 'kanban.deleteColumn':
        await handleKanbanDeleteColumn(ws, client, req);
        break;
      case 'kanban.createCard':
        await handleKanbanCreateCard(ws, client, req);
        break;
      case 'kanban.updateCard':
        await handleKanbanUpdateCard(ws, client, req);
        break;
      case 'kanban.moveCard':
        await handleKanbanMoveCard(ws, client, req);
        break;
      case 'kanban.deleteCard':
        await handleKanbanDeleteCard(ws, client, req);
        break;
      case 'kanban.createLabel':
        await handleKanbanCreateLabel(ws, client, req);
        break;
      case 'kanban.deleteLabel':
        await handleKanbanDeleteLabel(ws, client, req);
        break;
      case 'kanban.createMember':
        await handleKanbanCreateMember(ws, client, req);
        break;
      case 'kanban.deleteMember':
        await handleKanbanDeleteMember(ws, client, req);
        break;

      default:
        sendError(ws, req.id, -32601, `Unknown method: ${req.method}`);
    }
  } else {
    logger.warn(
      { type: message.type, clientId: client.sessionId },
      'Unknown message type',
    );
  }
}

async function handleConnect(
  ws: WebSocket,
  client: WebSocketClient,
  req: OpenClawRequest,
): Promise<void> {
  const { client: clientInfo } = req.params;

  // Token may be at params.token (simple) or params.auth.token (OpenClaw format)
  const token = req.params.auth?.token || req.params.token;

  // Get IP for rate limiting
  const clientIp = (client as any).ip || 'unknown';

  // Verify token
  if (token !== WEBSOCKET_AUTH_TOKEN) {
    // Only count failed attempts toward rate limit
    if (!checkAuthRateLimit(clientIp)) {
      logger.warn(
        { clientId: client.sessionId, ip: clientIp },
        'Auth rate limit exceeded',
      );
      sendResponse(
        ws,
        req.id,
        { ok: false },
        { code: 429, message: 'Too many authentication attempts' },
      );
      ws.close(1008, 'Rate limit exceeded');
      return;
    }
    logger.warn(
      {
        clientId: client.sessionId,
        receivedToken: token?.substring(0, 8) + '...',
      },
      'Authentication failed',
    );
    sendResponse(
      ws,
      req.id,
      { ok: false },
      { code: 401, message: 'Invalid token' },
    );
    ws.close(1008, 'Authentication failed');
    return;
  }

  client.authenticated = true;
  logger.info(
    { clientId: client.sessionId, clientInfo },
    'Client authenticated',
  );

  sendResponse(
    ws,
    req.id,
    { ok: true },
    {
      type: 'hello-ok',
      protocol: 3,
    },
  );
}

async function handleSessionsList(
  ws: WebSocket,
  client: WebSocketClient,
  req: OpenClawRequest,
): Promise<void> {
  if (!client.authenticated) {
    sendError(ws, req.id, 401, 'Not authenticated');
    return;
  }

  // Get all registered groups as sessions
  const groups = getAllRegisteredGroups();

  // Filter to show agents (not WhatsApp groups)
  // Include: @nanoclaw.local JIDs OR the main agent (any JID with folder='main')
  const sessions = Object.entries(groups)
    .filter(
      ([jid, group]) =>
        jid.endsWith('@nanoclaw.local') || group.folder === 'main',
    )
    .map(([jid, group]) => ({
      key: `agent:${group.folder}:main`,
      label:
        group.displayName ||
        group.folder.charAt(0).toUpperCase() + group.folder.slice(1),
      displayName:
        group.displayName ||
        group.folder.charAt(0).toUpperCase() + group.folder.slice(1),
      folder: group.folder,
    }));

  // Always prioritize main at the top
  sessions.sort((a, b) => {
    if (a.folder === 'main') return -1;
    if (b.folder === 'main') return 1;
    return a.folder.localeCompare(b.folder);
  });

  sendResponse(ws, req.id, { ok: true }, { sessions });
}

async function handleChatHistory(
  ws: WebSocket,
  client: WebSocketClient,
  req: OpenClawRequest,
): Promise<void> {
  if (!client.authenticated) {
    sendError(ws, req.id, 401, 'Not authenticated');
    return;
  }

  const { sessionKey, limit = 20, before } = req.params;

  // Extract agent folder from sessionKey (format: agent:{folder}:main or agent:{folder}:web:{id})
  const match = sessionKey?.match(/^agent:([^:]+):/);
  if (!match) {
    sendError(ws, req.id, 400, 'Invalid sessionKey format');
    return;
  }

  const agentFolder = match[1];

  // Use sessionKey as the stable session identifier instead of client.sessionId
  // This ensures history persists across page refreshes and reconnections
  const result = getChatHistory(sessionKey, agentFolder, limit, before);

  const messages = result.messages.map((msg) => ({
    role: msg.role,
    content: [{ type: 'text', text: msg.content }],
    timestamp: msg.timestamp,
  }));

  sendResponse(
    ws,
    req.id,
    { ok: true },
    {
      messages,
      hasMore: result.hasMore,
      total: result.total,
    },
  );
}

/**
 * Handle chat.search RPC - search chat messages
 */
async function handleChatSearch(
  ws: WebSocket,
  client: WebSocketClient,
  req: OpenClawRequest,
): Promise<void> {
  if (!client.authenticated) {
    sendError(ws, req.id, 401, 'Not authenticated');
    return;
  }

  const { sessionKey, query, limit = 20 } = req.params;

  if (!sessionKey) {
    sendError(ws, req.id, 400, 'sessionKey is required');
    return;
  }

  if (!query || typeof query !== 'string') {
    sendError(ws, req.id, 400, 'query is required');
    return;
  }

  // Validate query length
  if (query.length > 200) {
    sendError(ws, req.id, 400, 'Query too long (max 200 characters)');
    return;
  }

  // Extract agent folder from sessionKey
  const match = sessionKey.match(/^agent:([^:]+):/);
  if (!match) {
    sendError(ws, req.id, 400, 'Invalid sessionKey format');
    return;
  }

  const agentFolder = match[1];

  try {
    // Get all messages and filter by query (simple implementation)
    const result = getChatHistory(sessionKey, agentFolder, 1000);
    const searchQuery = query.toLowerCase();

    const matchingMessages = result.messages
      .filter((msg) => msg.content.toLowerCase().includes(searchQuery))
      .slice(0, limit)
      .map((msg) => ({
        role: msg.role,
        content: [{ type: 'text', text: msg.content }],
        timestamp: msg.timestamp,
      }));

    sendResponse(
      ws,
      req.id,
      { ok: true },
      {
        messages: matchingMessages,
        query,
        total: matchingMessages.length,
      },
    );
  } catch (error) {
    logger.error(
      { error, sessionKey, query },
      'Failed to search chat messages',
    );
    sendError(ws, req.id, 500, 'Failed to search messages');
  }
}

async function handleChatMarkRead(
  ws: WebSocket,
  client: WebSocketClient,
  req: OpenClawRequest,
): Promise<void> {
  if (!client.authenticated) {
    sendError(ws, req.id, 401, 'Not authenticated');
    return;
  }

  const { sessionKey } = req.params;

  if (!sessionKey) {
    sendError(ws, req.id, 400, 'sessionKey is required');
    return;
  }

  // Mark the chat as read
  markChatAsRead(sessionKey);

  logger.info({ sessionKey }, 'Chat marked as read');

  sendResponse(ws, req.id, { ok: true }, { marked: true });
}

async function handleChatSend(
  ws: WebSocket,
  client: WebSocketClient,
  req: OpenClawRequest,
): Promise<void> {
  if (!client.authenticated) {
    sendError(ws, req.id, 401, 'Not authenticated');
    return;
  }

  const { sessionKey, message, idempotencyKey, targetJid } = req.params;

  logger.info(
    { sessionKey, message: message?.substring(0, 50) },
    'chat.send received',
  );

  // Extract agent folder from sessionKey
  const match = sessionKey?.match(/^agent:([^:]+):/);
  if (!match) {
    logger.warn(
      { sessionKey },
      'Invalid sessionKey format - does not match pattern agent:xxx:...',
    );
    sendError(ws, req.id, 400, 'Invalid sessionKey format');
    return;
  }

  const agentFolder = match[1];
  const runId = `run-${Date.now()}-${randomUUID()}`;

  // IMPORTANT: Use getRegisteredGroupByFolder, not getRegisteredGroup with constructed JID
  // because main agent uses Telegram JID (tg:...) not @nanoclaw.local
  const group = await getRegisteredGroupByFolder(agentFolder);
  if (!group) {
    sendError(ws, req.id, 404, `Agent ${agentFolder} not found`);
    return;
  }

  const chatJid = group.jid;

  // Fetch chat history BEFORE saving the current message so the current
  // message doesn't appear in both history context AND "Current Message".
  const historyResult = getChatHistory(sessionKey, agentFolder, 20); // Get last 20 messages for context

  // Save user message to database (before workflow check)
  saveChatMessage(sessionKey, agentFolder, 'user', message);

  // Send user message event to client
  sendEvent(ws, 'chat', {
    runId,
    sessionKey,
    state: 'final',
    message: {
      role: 'user',
      content: [{ type: 'text', text: message }],
    },
  });

  // Send acknowledgment
  sendResponse(ws, req.id, { ok: true }, { taskId: runId });

  // Check for workflow commands
  const workflowResult = await handleWorkflowMessage(message, agentFolder);
  if (workflowResult.shouldSend) {
    // Workflow command detected - send response and skip normal agent processing
    sendEvent(ws, 'chat', {
      runId,
      sessionKey,
      state: 'final',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: workflowResult.response }],
      },
    });
    return;
  }

  // Send thinking event to show indicator immediately
  sendEvent(ws, 'chat', {
    runId,
    sessionKey,
    state: 'thinking',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: '' }],
    },
  });

  // Fetch relevant long-term memories
  // This provides persistent context across sessions
  const relevantMemories = getRelevantMemories(agentFolder, message, 5);

  logger.debug(
    { agentFolder, memoryCount: relevantMemories.length },
    'WebSocket: Memory injection fetched relevant memories',
  );

  // Build prompt with conversation history, memory context, and current message
  let promptWithContext = message;
  let contextParts: string[] = [];

  // Add personality context if SOUL.md exists
  const soulContent = readPersonalityFile(agentFolder, 'SOUL.md');
  if (soulContent) {
    contextParts.push(
      `**Personality & Core Values:**\n${soulContent.trim()}\n`,
    );
  }

  // Add long-term memory context
  if (relevantMemories.length > 0) {
    const memoryText = relevantMemories
      .map((m) => `- [${m.memory_type}] ${m.content}`)
      .join('\n');
    contextParts.push(`**Relevant Memories:**\n${memoryText}\n`);
  }

  // Add conversation history
  if (historyResult.messages.length > 0) {
    const historyText = historyResult.messages
      .map((msg) => {
        const role = msg.role === 'user' ? 'User' : 'Assistant';
        return `${role}: ${msg.content}`;
      })
      .join('\n\n');
    contextParts.push(`**Previous Conversation:**\n${historyText}`);
  }

  // Combine all context with the current message
  if (contextParts.length > 0) {
    promptWithContext = `${contextParts.join('\n\n')}\n\n**Current Message:** ${message}`;

    logger.debug(
      { agentFolder, contextSize: contextParts.length },
      'WebSocket: Memory injection added context to prompt',
    );
  }

  // Run the agent container asynchronously (non-blocking)
  // This allows multiple agents to respond in parallel
  runAgentContainerAsync(
    ws,
    client,
    sessionKey,
    agentFolder,
    chatJid,
    promptWithContext,
    runId,
    group,
    targetJid,
  ).catch((error) => {
    logger.error(
      { runId, agentFolder, error },
      'Unhandled error in async container execution',
    );
  });
}

/**
 * Run an agent container with automatic delegation following
 * Recursively handles delegation chains (e.g., Lucy -> Maui -> Hali)
 * Returns the final accumulated response
 */
async function runAgentWithDelegation(
  ws: WebSocket,
  client: WebSocketClient,
  sessionKey: string,
  agentFolder: string,
  chatJid: string,
  message: string,
  runId: string,
  group: RegisteredGroup & { jid: string },
  depth: number,
  originalAgent: string,
  targetJid?: string, // Optional: Send response to this WhatsApp JID
): Promise<string | null> {
  // Prevent infinite delegation loops
  const MAX_DELEGATION_DEPTH = 5;
  if (depth >= MAX_DELEGATION_DEPTH) {
    logger.error(
      { runId, depth, agentFolder },
      'Max delegation depth reached, stopping',
    );
    return null;
  }

  logger.info(
    { runId, agentFolder, depth },
    `Running agent container (delegation level ${depth})`,
  );

  // Send thinking event for delegated agents to show their status
  // For delegated agents (depth > 0), generate their session key
  let delegatedSessionKey = sessionKey;
  if (depth > 0) {
    // Extract the base session key pattern and replace agent folder
    const baseMatch = sessionKey.match(/^agent:([^:]+):(.*)$/);
    if (baseMatch) {
      delegatedSessionKey = `agent:${agentFolder}:${baseMatch[2]}`;
    }

    // Send thinking event to UI for delegated agent
    if (client.ws.readyState === WebSocket.OPEN) {
      sendEvent(ws, 'chat', {
        runId: `${runId}-delegated-${agentFolder}`,
        sessionKey: delegatedSessionKey,
        state: 'thinking',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: '' }],
        },
      });
      logger.info(
        { runId, delegatedAgent: agentFolder, delegatedSessionKey },
        'Sent thinking event for delegated agent',
      );
    }
  }

  let accumulatedResponse = '';
  let hadStreamingError = false;
  let streamingErrorMessage = '';

  try {
    const { containerOutput: output } = await getOrCreateContainer(
      group,
      {
        prompt: message,
        groupFolder: agentFolder,
        chatJid,
        isMain: agentFolder === MAIN_GROUP_FOLDER,
        isScheduledTask: false,
        singleMessage: false, // Allow follow-up messages for delegated agents too
      },
      (proc, containerName) => {
        logger.info({ containerName, depth }, 'Agent container started');
      },
      async (result) => {
        // Stream result back to WebSocket and accumulate for final save
        try {
          if (result.status === 'success' && result.result) {
            const text =
              typeof result.result === 'string'
                ? result.result
                : JSON.stringify(result.result);
            const visibleText = text
              .replace(/<internal>[\s\S]*?<\/internal>/g, '')
              .trim();
            accumulatedResponse = visibleText;

            // Send delta event via WebSocket
            if (client.ws.readyState === WebSocket.OPEN) {
              sendEvent(ws, 'chat', {
                runId,
                sessionKey,
                state: 'delta',
                message: {
                  role: 'assistant',
                  content: [{ type: 'text', text: visibleText }],
                },
              });
            }
          }
        } catch (callbackError) {
          logger.error(
            { runId, error: callbackError },
            'Error in streaming callback',
          );
        }
      },
    );

    if (accumulatedResponse && !hadStreamingError) {
      logger.info(
        { runId, agentFolder, responseLength: accumulatedResponse.length },
        'Saving delegated agent response to database',
      );

      // Add agent name prefix for delegated agents (not the original agent)
      const agentPrefix =
        agentFolder === originalAgent
          ? ''
          : `**${agentFolder.charAt(0).toUpperCase() + agentFolder.slice(1)}**: `;
      const prefixedResponse = agentPrefix + accumulatedResponse;

      saveChatMessage(sessionKey, agentFolder, 'assistant', prefixedResponse);

      // Check for further delegation
      const delegatedAgent = detectDelegation(
        accumulatedResponse,
        message,
        agentFolder,
        agentFolder,
      );

      if (delegatedAgent) {
        logger.info(
          {
            runId,
            delegatedAgent,
            currentAgent: agentFolder,
            depth: depth + 1,
          },
          'Further delegation detected, recursing',
        );

        // IMPORTANT: Use getRegisteredGroupByFolder, not getRegisteredGroup with constructed JID
        // because main agent uses Telegram JID (tg:...) not @nanoclaw.local
        const delegatedGroup = await getRegisteredGroupByFolder(delegatedAgent);

        if (!delegatedGroup) {
          logger.error({ runId, delegatedAgent }, 'Delegated agent not found');
          return accumulatedResponse; // Return what we have so far
        }

        const delegatedJid = delegatedGroup.jid;

        // Recurse to the next agent
        return await runAgentWithDelegation(
          ws,
          client,
          sessionKey,
          delegatedAgent,
          delegatedJid,
          message,
          runId,
          delegatedGroup,
          depth + 1,
          originalAgent,
          targetJid, // Pass through targetJid for delegated agents
        );
      }

      // No further delegation - send final event and return
      // For delegated agents (depth > 0), send final event to UI
      if (depth > 0 && client.ws.readyState === WebSocket.OPEN) {
        sendEvent(ws, 'chat', {
          runId: `${runId}-delegated-${agentFolder}`,
          sessionKey: delegatedSessionKey,
          state: 'final',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: accumulatedResponse }],
          },
        });
        logger.info(
          { runId, delegatedAgent: agentFolder, delegatedSessionKey },
          'Sent final event for delegated agent',
        );
      }

      // Also send to external channel (e.g., WhatsApp) if targetJid is specified
      // This applies to both delegated and non-delegated agents
      if (targetJid && sendMessageToExternal) {
        try {
          await sendMessageToExternal(targetJid, accumulatedResponse);
          logger.info(
            {
              targetJid,
              delegatedAgent: agentFolder,
              responseLength: accumulatedResponse.length,
            },
            'Delegated agent response sent to external channel',
          );
        } catch (error) {
          logger.error(
            { targetJid, delegatedAgent: agentFolder, error },
            'Failed to send delegated agent response to external channel',
          );
        }
      }

      return accumulatedResponse;
    }

    // Had an error or no response
    if (hadStreamingError) {
      logger.error(
        { runId, agentFolder, error: streamingErrorMessage },
        'Delegated agent had error',
      );
    }
    return accumulatedResponse || null;
  } catch (error) {
    logger.error(
      { runId, agentFolder, depth, error },
      'Error in delegated agent execution',
    );
    return accumulatedResponse || null;
  }
}

/**
 * Run agent container asynchronously without blocking the WebSocket handler
 * This enables parallel execution of multiple agents
 */
async function runAgentContainerAsync(
  ws: WebSocket,
  client: WebSocketClient,
  sessionKey: string,
  agentFolder: string,
  chatJid: string,
  message: string,
  runId: string,
  group: RegisteredGroup & { jid: string },
  targetJid?: string, // Optional: Send response to this WhatsApp JID
): Promise<void> {
  // Run the agent container (using pool for persistent containers) with retry logic
  logger.info(
    { agentFolder, message, runId },
    'Running agent container (async)',
  );

  // Track accumulated response and error state for database save
  let accumulatedResponse = '';
  let hadStreamingError = false;
  let streamingErrorMessage = '';

  // Retry loop for transient failures
  let lastError: Error | null = null;
  let attempt = 0;

  while (attempt <= MAX_RETRIES) {
    try {
      const { containerOutput: output, wasNew } = await getOrCreateContainer(
        group,
        {
          prompt: message,
          groupFolder: agentFolder,
          chatJid,
          isMain: agentFolder === MAIN_GROUP_FOLDER,
          isScheduledTask: false,
          singleMessage: false, // Allow follow-up messages
        },
        (proc, containerName) => {
          logger.info({ containerName }, 'Agent container started');
        },
        async (result) => {
          // Stream result back to WebSocket client and accumulate for database save
          // This callback is invoked during streaming, before container completes
          try {
            if (result.status === 'success' && result.result) {
              const text =
                typeof result.result === 'string'
                  ? result.result
                  : JSON.stringify(result.result);

              // Strip internal reasoning blocks
              const visibleText = text
                .replace(/<internal>[\s\S]*?<\/internal>/g, '')
                .trim();

              // Accumulate response for final database save (save once at the end, not on every delta)
              accumulatedResponse = visibleText;

              logger.debug(
                { runId, responseLength: visibleText.length },
                'Accumulated streaming response',
              );

              // Send delta event via WebSocket only if still connected
              if (client.ws.readyState === WebSocket.OPEN) {
                sendEvent(ws, 'chat', {
                  runId,
                  sessionKey,
                  state: 'delta',
                  message: {
                    role: 'assistant',
                    content: [{ type: 'text', text: visibleText }],
                  },
                });
              }
            } else if (result.status === 'error') {
              hadStreamingError = true;
              streamingErrorMessage = result.error || 'Unknown error';
              logger.warn(
                { runId, error: streamingErrorMessage },
                'Streaming callback received error',
              );

              // Send error event only if WebSocket still connected
              if (client.ws.readyState === WebSocket.OPEN) {
                sendEvent(ws, 'chat', {
                  runId,
                  sessionKey,
                  state: 'error',
                  errorMessage: streamingErrorMessage,
                });
              }
            }
          } catch (callbackError) {
            // Log callback errors but don't throw - container should continue
            logger.error(
              { runId, error: callbackError },
              'Error in streaming callback (container continuing)',
            );
            hadStreamingError = true;
            streamingErrorMessage =
              callbackError instanceof Error
                ? callbackError.message
                : 'Callback error';
          }
        },
      );

      logger.info(
        {
          runId,
          agentFolder,
          wasNew,
          outputStatus: output.status,
          hadAccumulatedResponse: !!accumulatedResponse,
        },
        'Container execution completed',
      );

      // CRITICAL: In streaming mode, output.result is always null (see container-runner.ts:534)
      // The actual response was accumulated in the streaming callback
      // This is the ONE AND ONLY database save for the assistant's response
      if (accumulatedResponse && !hadStreamingError) {
        logger.info(
          { runId, agentFolder, responseLength: accumulatedResponse.length },
          'Saving assistant response to database',
        );

        // Detect delegation: check if agent mentioned another agent to hand off to
        // Use group.folder (actual responding agent) not agentFolder (session agent)
        const delegatedAgent = detectDelegation(
          accumulatedResponse,
          message,
          agentFolder,
          group.folder,
        );

        if (delegatedAgent) {
          // Delegation detected! Execute via IPC for WhatsApp, then spawn delegated agent for WebSocket (non-blocking)
          logger.info(
            { runId, delegatedAgent, originalAgent: agentFolder },
            'Delegation detected, spawning delegated agent (non-blocking)',
          );

          // Get the delegated agent's group info
          // IMPORTANT: Use getRegisteredGroupByFolder, not getRegisteredGroup with constructed JID
          // because main agent uses Telegram JID (tg:...) not @nanoclaw.local
          const delegatedGroup =
            await getRegisteredGroupByFolder(delegatedAgent);

          if (!delegatedGroup) {
            logger.error(
              { runId, delegatedAgent },
              'Delegated agent not found',
            );
            sendEvent(ws, 'chat', {
              runId,
              sessionKey,
              state: 'error',
              errorMessage: `Delegated agent ${delegatedAgent} not found`,
            });
            break;
          }

          const delegatedJid = delegatedGroup.jid;

          // Save the delegating agent's response with agent prefix
          const agentPrefix =
            agentFolder === MAIN_GROUP_FOLDER
              ? ''
              : `**${agentFolder.charAt(0).toUpperCase() + agentFolder.slice(1)}**: `;
          saveChatMessage(
            sessionKey,
            agentFolder,
            'assistant',
            accumulatedResponse,
          );

          // Spawn delegated agent asynchronously (non-blocking)
          // This allows Lucy (or other agents) to immediately handle new messages
          runAgentWithDelegation(
            ws,
            client,
            sessionKey,
            delegatedAgent,
            delegatedJid,
            message,
            runId,
            delegatedGroup,
            0, // depth counter to prevent infinite loops
            agentFolder, // original agent
            targetJid, // Pass through targetJid for delegated agents
          ).catch((error) => {
            logger.error(
              { runId, delegatedAgent, error },
              'Delegated agent execution failed',
            );
          });

          // Don't wait for delegated agent - complete immediately
          // The delegated agent will stream its response independently
          break;
        }

        // No delegation - save and send final response
        saveChatMessage(
          sessionKey,
          agentFolder,
          'assistant',
          accumulatedResponse,
        );

        // Also send to external channel (e.g., WhatsApp) if targetJid is specified
        if (targetJid && sendMessageToExternal) {
          try {
            await sendMessageToExternal(targetJid, accumulatedResponse);
            logger.info(
              { targetJid, responseLength: accumulatedResponse.length },
              'Response sent to external channel',
            );
          } catch (error) {
            logger.error(
              { targetJid, error },
              'Failed to send response to external channel',
            );
          }
        }

        // Send final event via WebSocket
        if (client.ws.readyState === WebSocket.OPEN) {
          sendEvent(ws, 'chat', {
            runId,
            sessionKey,
            state: 'final',
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: accumulatedResponse }],
            },
          });
        } else {
          logger.info(
            { runId, agentFolder },
            'WebSocket closed before final event (response saved to database)',
          );
        }
      } else if (hadStreamingError) {
        // Had an error during streaming - still save what we accumulated
        if (accumulatedResponse) {
          logger.warn(
            {
              runId,
              agentFolder,
              responseLength: accumulatedResponse.length,
              error: streamingErrorMessage,
            },
            'Saving partial response after streaming error',
          );
          saveChatMessage(
            sessionKey,
            agentFolder,
            'assistant',
            accumulatedResponse,
          );
        }

        // Send final error event only if WebSocket still connected
        if (client.ws.readyState === WebSocket.OPEN) {
          sendEvent(ws, 'chat', {
            runId,
            sessionKey,
            state: 'error',
            errorMessage: streamingErrorMessage,
          });
        }
      } else {
        // No response accumulated - this might be a silent completion
        logger.warn(
          { runId, agentFolder, outputStatus: output.status },
          'Container completed with no accumulated response',
        );
      }

      // Success! Break out of retry loop
      break;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      logger.error(
        {
          error: lastError.message,
          agentFolder,
          attempt,
          maxRetries: MAX_RETRIES,
          hadAccumulatedResponse: !!accumulatedResponse,
        },
        'Agent container execution failed',
      );

      // Check if we should retry
      attempt++;
      if (attempt <= MAX_RETRIES) {
        // Calculate exponential backoff delay
        const delay = Math.min(
          RETRY_DELAY_MS * Math.pow(2, attempt - 1),
          MAX_RETRY_DELAY_MS,
        );
        logger.info(
          { attempt, delay, agentFolder },
          `Retrying after ${delay}ms...`,
        );

        // Wait before retrying
        await new Promise((resolve) => setTimeout(resolve, delay));

        // Clear accumulated state for retry
        accumulatedResponse = '';
        hadStreamingError = false;
        streamingErrorMessage = '';

        // Continue to next iteration (retry)
        continue;
      }

      // Max retries exceeded - give up and send error to client
      logger.error(
        { agentFolder, totalAttempts: attempt, lastError: lastError.message },
        'Max retries exceeded',
      );

      // Try to save any accumulated response even if execution failed
      if (accumulatedResponse) {
        logger.info(
          { runId, agentFolder, responseLength: accumulatedResponse.length },
          'Saving partial response after retry failure',
        );
        try {
          saveChatMessage(
            sessionKey,
            agentFolder,
            'assistant',
            accumulatedResponse,
          );
        } catch (saveError) {
          logger.error(
            { runId, error: saveError },
            'Failed to save response to database after retry failure',
          );
        }
      }

      // Send error event only if WebSocket still connected
      if (client.ws.readyState === WebSocket.OPEN) {
        sendEvent(ws, 'chat', {
          runId,
          sessionKey,
          state: 'error',
          errorMessage: `Failed after ${attempt} attempts: ${lastError.message}`,
        });
      }

      // Don't send _close sentinel since we already failed
      return;
    }
  } // End of while loop

  // Send _close sentinel to tell container to exit gracefully
  // Container stays alive due to -i flag, but exits when it receives this
  const closeSentinelPath = path.join(
    DATA_DIR,
    'ipc',
    agentFolder,
    'input',
    '_close',
  );
  try {
    fs.mkdirSync(path.dirname(closeSentinelPath), { recursive: true });
    fs.writeFileSync(closeSentinelPath, 'close');
    logger.debug(
      { agentFolder, closeSentinel: closeSentinelPath },
      'Sent _close sentinel to container',
    );
  } catch (err) {
    logger.warn(
      { agentFolder, error: err },
      'Failed to send _close sentinel (non-critical, container will timeout)',
    );
  }
} // End of runAgentContainerAsync

/**
 * Detect if agent response mentions another agent for handoff.
 * Returns the agent name if found, null otherwise.
 */
function detectDelegation(
  response: string,
  originalMessage: string,
  fromAgentFolder: string,
  delegatedAgent?: string,
): string | null {
  const lowerResponse = response.toLowerCase();

  // Find if agent is mentioned (word boundary check to avoid false positives
  // with short names like "kai", "koa", "ahi" matching inside other words)
  const mentionedAgent = KNOWN_AGENTS.find((agent) => {
    const re = new RegExp(`\\b${agent}\\b`);
    return re.test(lowerResponse);
  });

  if (!mentionedAgent) {
    return null; // No delegation detected
  }

  // Determine the actual source agent:
  // - If delegatedAgent is set (e.g., "maui"), use that as the source
  // - Otherwise use fromAgentFolder
  const actualSourceAgent = delegatedAgent || fromAgentFolder;

  logger.info(
    {
      fromAgent: actualSourceAgent,
      toAgent: mentionedAgent,
      originalMessage,
      delegatedAgent,
    },
    'Delegation detected in response',
  );

  // Return the delegated agent for the caller to handle
  return mentionedAgent;
}


// Helper functions

function sendResponse(
  ws: WebSocket,
  id: string,
  base: any,
  payload?: any,
): void {
  const res: OpenClawResponse = {
    type: 'res',
    id,
    ...base,
  };
  if (payload !== undefined) {
    res.payload = payload;
  }
  // Only send if WebSocket is still open
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(res));
  }
}

function sendError(
  ws: WebSocket,
  id: string,
  code: number,
  message: string,
): void {
  const res: OpenClawResponse = {
    type: 'res',
    id,
    ok: false,
    error: { code, message },
  };
  // Only send if WebSocket is still open
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(res));
  }
}

function sendEvent(ws: WebSocket, event: string, payload: any): void {
  const evt: OpenClawEvent = {
    type: 'event',
    event,
    payload,
  };
  // Only send if WebSocket is still open
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(evt));
  }
}

async function handleSystemHealth(
  ws: WebSocket,
  client: WebSocketClient,
  req: OpenClawRequest,
): Promise<void> {
  if (!client.authenticated) {
    sendError(ws, req.id, 401, 'Not authenticated');
    return;
  }

  // Get container pool statistics
  const containerStats = getContainerStats();

  // Get system uptime
  const uptime = process.uptime();

  // Get memory usage
  const memUsage = process.memoryUsage();

  // Get database health (import dynamically to avoid circular deps)
  const { checkDatabaseHealth, getDatabaseStats } = await import('./db.js');
  const dbHealth = checkDatabaseHealth();
  const dbStats = getDatabaseStats();

  // Get memory system health
  const { getMemorySystemHealth } = await import('./memory.js');
  const memorySystemHealth = getMemorySystemHealth();

  // Get resource metrics
  const { resourceManager, getDiskSpaceUsage, getMemoryDetails } =
    await import('./utils/resource-manager.js');
  const resourceMetrics = await resourceManager.getMetrics();
  const diskSpace = await getDiskSpaceUsage('.');
  const memoryDetails = await getMemoryDetails();

  const health = {
    uptime: Math.floor(uptime),
    uptimeHuman: formatUptime(uptime),
    memory: {
      rss: Math.round(memUsage.rss / 1024 / 1024), // MB
      heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024), // MB
      heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024), // MB
      external: Math.round(memUsage.external / 1024 / 1024), // MB
      systemPercent: memoryDetails.systemMemoryPercent,
    },
    containers: {
      total: containerStats.totalContainers,
      details: containerStats.containers,
    },
    database: {
      healthy: dbHealth.healthy,
      integrity: dbHealth.integrity,
      sizeMb: dbHealth.sizeMb,
      walMode: dbHealth.walMode,
      issues: dbHealth.issues,
      tables: dbHealth.tables,
      stats: dbStats,
    },
    memorySystem: {
      cacheStats: memorySystemHealth.cacheStats,
      totalAgents: memorySystemHealth.totalAgents,
      totalMemories: memorySystemHealth.totalMemories,
    },
    resources: {
      cpuPercent: resourceMetrics.cpuPercent,
      disk: diskSpace,
    },
    connectedClients: clients.size,
    timestamp: new Date().toISOString(),
  };

  sendResponse(ws, req.id, { ok: true }, { health });
}

async function handleSystemPing(
  ws: WebSocket,
  client: WebSocketClient,
  req: OpenClawRequest,
): Promise<void> {
  // Ping doesn't require authentication - used for connectivity checks
  const startTime = Date.now();

  // Quick health indicators
  const mem = process.memoryUsage();
  const healthy = mem.heapUsed < mem.heapTotal * 0.9; // Less than 90% heap used

  sendResponse(
    ws,
    req.id,
    { ok: true },
    {
      pong: true,
      timestamp: new Date().toISOString(),
      uptime: Math.floor(process.uptime()),
      latency: Date.now() - startTime,
      healthy,
      version: process.env.npm_package_version || '1.0.0',
    },
  );
}

/**
 * Handle system.info RPC - get comprehensive system information
 */
async function handleSystemInfo(
  ws: WebSocket,
  client: WebSocketClient,
  req: OpenClawRequest,
): Promise<void> {
  if (!client.authenticated) {
    sendError(ws, req.id, 401, 'Not authenticated');
    return;
  }

  try {
    const mem = process.memoryUsage();
    const { getContainerStats } = await import('./container-pool.js');
    const containerStats = getContainerStats();

    // Get database stats
    const { getAllGoals, getAllTasks, getAllRegisteredGroups } =
      await import('./db.js');
    const goals = getAllGoals();
    const tasks = getAllTasks();
    const groups = getAllRegisteredGroups();

    // Calculate uptime
    const uptimeSeconds = Math.floor(process.uptime());
    const days = Math.floor(uptimeSeconds / 86400);
    const hours = Math.floor((uptimeSeconds % 86400) / 3600);
    const mins = Math.floor((uptimeSeconds % 3600) / 60);

    sendResponse(
      ws,
      req.id,
      { ok: true },
      {
        version: process.env.npm_package_version || '1.0.0',
        nodeVersion: process.version,
        platform: process.platform,
        arch: process.arch,
        uptime: {
          seconds: uptimeSeconds,
          formatted: `${days}d ${hours}h ${mins}m`,
        },
        memory: {
          heapUsed: Math.round(mem.heapUsed / 1024 / 1024),
          heapTotal: Math.round(mem.heapTotal / 1024 / 1024),
          rss: Math.round(mem.rss / 1024 / 1024),
          external: Math.round(mem.external / 1024 / 1024),
        },
        containers: {
          total: containerStats.totalContainers,
          max: MAX_CONCURRENT_CONTAINERS,
        },
        database: {
          goals: goals.length,
          tasks: tasks.length,
          groups: Object.keys(groups).length,
        },
        clients: {
          connected: clients.size,
          authenticated: Array.from(clients.values()).filter(
            (c: WebSocketClient) => c.authenticated,
          ).length,
        },
        timezone: TIMEZONE,
        timestamp: new Date().toISOString(),
      },
    );
  } catch (error) {
    logger.error({ error }, 'Failed to get system info');
    sendError(ws, req.id, 500, 'Failed to get system info');
  }
}

/**
 * Handle config.get RPC - get public configuration
 */
async function handleConfigGet(
  ws: WebSocket,
  client: WebSocketClient,
  req: OpenClawRequest,
): Promise<void> {
  if (!client.authenticated) {
    sendError(ws, req.id, 401, 'Not authenticated');
    return;
  }

  // Return only non-sensitive configuration values
  const publicConfig = {
    assistantName: ASSISTANT_NAME,
    timezone: TIMEZONE,
    containerTimeout: CONTAINER_TIMEOUT,
    idleTimeout: IDLE_TIMEOUT,
    maxConcurrentContainers: MAX_CONCURRENT_CONTAINERS,
    websocketPort: WEBSOCKET_PORT,
    version: process.env.npm_package_version || '1.0.0',
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
  };

  sendResponse(ws, req.id, { ok: true }, publicConfig);
}

/**
 * Handle system.containers RPC - get container status
 */
async function handleSystemContainers(
  ws: WebSocket,
  client: WebSocketClient,
  req: OpenClawRequest,
): Promise<void> {
  if (!client.authenticated) {
    sendError(ws, req.id, 401, 'Not authenticated');
    return;
  }

  try {
    const { getContainerStats } = await import('./container-pool.js');
    const stats = getContainerStats();

    sendResponse(
      ws,
      req.id,
      { ok: true },
      {
        totalContainers: stats.totalContainers,
        maxContainers: MAX_CONCURRENT_CONTAINERS,
        containers: stats.containers.map((c) => ({
          groupFolder: c.groupFolder,
          containerName: c.containerName,
          messageCount: c.messageCount,
          uptime: Math.floor(c.uptime / 1000), // Convert to seconds
          idleTime: Math.floor(c.idleTime / 1000), // Convert to seconds
        })),
      },
    );
  } catch (error) {
    logger.error({ error }, 'Failed to get container stats');
    sendError(ws, req.id, 500, 'Failed to get container stats');
  }
}

/**
 * Handle memory.list RPC - list memories for an agent
 */
async function handleMemoryList(
  ws: WebSocket,
  client: WebSocketClient,
  req: OpenClawRequest,
): Promise<void> {
  if (!client.authenticated) {
    sendError(ws, req.id, 401, 'Not authenticated');
    return;
  }

  const { agentFolder, limit = 50 } = req.params;

  if (!agentFolder) {
    sendError(ws, req.id, 400, 'agentFolder is required');
    return;
  }

  try {
    const { getMemoriesForAgent } = await import('./memory.js');
    const memories = getMemoriesForAgent(agentFolder, limit);

    sendResponse(
      ws,
      req.id,
      { ok: true },
      {
        memories: memories.map((m) => ({
          id: m.id,
          content: m.content.slice(0, 500), // Truncate for display
          type: m.memory_type,
          importance: m.importance,
          agentFolder: m.agent_folder,
          created_at: m.created_at,
        })),
        total: memories.length,
      },
    );
  } catch (error) {
    logger.error({ error, agentFolder }, 'Failed to list memories');
    sendError(ws, req.id, 500, 'Failed to list memories');
  }
}

/**
 * Handle memory.search RPC - search memories
 */
async function handleMemorySearch(
  ws: WebSocket,
  client: WebSocketClient,
  req: OpenClawRequest,
): Promise<void> {
  if (!client.authenticated) {
    sendError(ws, req.id, 401, 'Not authenticated');
    return;
  }

  const { agentFolder, query, limit = 20 } = req.params;

  if (!agentFolder || !query) {
    sendError(ws, req.id, 400, 'agentFolder and query are required');
    return;
  }

  try {
    const { searchMemories } = await import('./memory.js');
    const memories = searchMemories(agentFolder, query, limit);

    sendResponse(
      ws,
      req.id,
      { ok: true },
      {
        memories: memories.map((m) => ({
          id: m.id,
          content: m.content.slice(0, 500),
          type: m.memory_type,
          importance: m.importance,
          agentFolder: m.agent_folder,
          created_at: m.created_at,
        })),
        query,
        total: memories.length,
      },
    );
  } catch (error) {
    logger.error({ error, agentFolder, query }, 'Failed to search memories');
    sendError(ws, req.id, 500, 'Failed to search memories');
  }
}

/**
 * Handle memory.get RPC - get a single memory
 */
async function handleMemoryGet(
  ws: WebSocket,
  client: WebSocketClient,
  req: OpenClawRequest,
): Promise<void> {
  if (!client.authenticated) {
    sendError(ws, req.id, 401, 'Not authenticated');
    return;
  }

  const { memoryId } = req.params;

  if (!memoryId) {
    sendError(ws, req.id, 400, 'memoryId is required');
    return;
  }

  try {
    const { getMemory } = await import('./memory.js');
    const memory = getMemory(memoryId);

    if (!memory) {
      sendError(ws, req.id, 404, 'Memory not found');
      return;
    }

    sendResponse(
      ws,
      req.id,
      { ok: true },
      {
        memory: {
          id: memory.id,
          content: memory.content,
          type: memory.memory_type,
          importance: memory.importance,
          agentFolder: memory.agent_folder,
          created_at: memory.created_at,
          last_accessed: memory.last_accessed,
        },
      },
    );
  } catch (error) {
    logger.error({ error, memoryId }, 'Failed to get memory');
    sendError(ws, req.id, 500, 'Failed to get memory');
  }
}

/**
 * Handle memory.stats RPC - get memory statistics for an agent
 */
async function handleMemoryStats(
  ws: WebSocket,
  client: WebSocketClient,
  req: OpenClawRequest,
): Promise<void> {
  if (!client.authenticated) {
    sendError(ws, req.id, 401, 'Not authenticated');
    return;
  }

  const { agentFolder } = req.params;

  if (!agentFolder) {
    sendError(ws, req.id, 400, 'agentFolder is required');
    return;
  }

  try {
    const { getMemoryStats } = await import('./memory.js');
    const stats = getMemoryStats(agentFolder);

    sendResponse(ws, req.id, { ok: true }, stats);
  } catch (error) {
    logger.error({ error, agentFolder }, 'Failed to get memory stats');
    sendError(ws, req.id, 500, 'Failed to get memory stats');
  }
}

async function handleAgentUpdate(
  ws: WebSocket,
  client: WebSocketClient,
  req: OpenClawRequest,
): Promise<void> {
  if (!client.authenticated) {
    sendError(ws, req.id, 401, 'Not authenticated');
    return;
  }

  const { agentFolder, displayName, customDescription, iconType, iconValue } =
    req.params;

  logger.info(
    { agentFolder, displayName, customDescription, iconType, iconValue },
    'Agent metadata update requested',
  );

  // Validate parameters
  if (!agentFolder) {
    sendError(ws, req.id, 400, 'agentFolder is required');
    return;
  }

  // Get the agent group from database
  // IMPORTANT: Use getRegisteredGroupByFolder, not getRegisteredGroup with constructed JID
  // because main agent uses Telegram JID (tg:...) not @nanoclaw.local
  const group = await getRegisteredGroupByFolder(agentFolder);

  if (!group) {
    sendError(ws, req.id, 404, `Agent ${agentFolder} not found`);
    return;
  }

  const chatJid = group.jid;

  // Update only provided fields
  const updatedGroup: RegisteredGroup & { jid: string } = {
    ...group,
    jid: chatJid,
  };

  if (displayName !== undefined) {
    updatedGroup.displayName = displayName;
  }
  if (customDescription !== undefined) {
    updatedGroup.customDescription = customDescription;
  }
  if (iconType !== undefined) {
    updatedGroup.iconType = iconType;
  }
  if (iconValue !== undefined) {
    updatedGroup.iconValue = iconValue;
  }

  // Save to database
  setRegisteredGroup(chatJid, updatedGroup);

  logger.info(
    {
      agentFolder,
      updates: { displayName, customDescription, iconType, iconValue },
    },
    'Agent metadata updated successfully',
  );

  // Broadcast update to all connected clients
  broadcastEvent('agent.updated', {
    agentFolder,
    displayName: updatedGroup.displayName,
    customDescription: updatedGroup.customDescription,
    iconType: updatedGroup.iconType,
    iconValue: updatedGroup.iconValue,
  });

  sendResponse(
    ws,
    req.id,
    { ok: true },
    {
      agent: {
        folder: agentFolder,
        displayName: updatedGroup.displayName,
        customDescription: updatedGroup.customDescription,
        iconType: updatedGroup.iconType,
        iconValue: updatedGroup.iconValue,
      },
    },
  );
}

async function handleAgentsMetadata(
  ws: WebSocket,
  client: WebSocketClient,
  req: OpenClawRequest,
): Promise<void> {
  if (!client.authenticated) {
    sendError(ws, req.id, 401, 'Not authenticated');
    return;
  }

  // Get all registered groups with their custom metadata
  const allGroups = getAllRegisteredGroups();

  // Transform into a simpler format for the frontend
  const agentsMetadata: Record<
    string,
    {
      folder: string;
      displayName?: string;
      customDescription?: string;
      iconType: 'emoji' | 'image';
      iconValue: string;
      hasUnread: boolean;
    }
  > = {};

  for (const [jid, group] of Object.entries(allGroups) as [
    string,
    RegisteredGroup,
  ][]) {
    // Only include agents (not WhatsApp groups)
    // Include @nanoclaw.local JIDs AND the main agent (which uses a Telegram JID)
    if (jid.endsWith('@nanoclaw.local') || group.folder === 'main') {
      // Check for unread messages using the main session key format
      const sessionKey = `agent:${group.folder}:main`;
      const hasUnread = hasUnreadMessages(sessionKey);

      agentsMetadata[group.folder] = {
        folder: group.folder,
        displayName: group.displayName,
        customDescription: group.customDescription,
        iconType: group.iconType || 'emoji',
        iconValue: group.iconValue || '🤖',
        hasUnread,
      };
    }
  }

  logger.info(
    { count: Object.keys(agentsMetadata).length },
    'Agent metadata retrieved',
  );

  sendResponse(ws, req.id, { ok: true }, { agents: agentsMetadata });
}

async function handleAgentGetClaudeMd(
  ws: WebSocket,
  client: WebSocketClient,
  req: OpenClawRequest,
): Promise<void> {
  if (!client.authenticated) {
    sendError(ws, req.id, 401, 'Not authenticated');
    return;
  }

  const { agentFolder } = req.params;

  // Validate parameter
  if (!agentFolder) {
    sendError(ws, req.id, 400, 'agentFolder is required');
    return;
  }

  // Security check: verify this is a valid agent folder
  // IMPORTANT: Use getRegisteredGroupByFolder, not getRegisteredGroup with constructed JID
  // because main agent uses Telegram JID (tg:...) not @nanoclaw.local
  const group = getRegisteredGroupByFolder(agentFolder);
  if (!group) {
    sendError(ws, req.id, 404, `Agent ${agentFolder} not found`);
    return;
  }

  // Read CLAUDE.md file
  const claudeMdPath = path.join(GROUPS_DIR, agentFolder, 'CLAUDE.md');

  try {
    let content = '';
    if (fs.existsSync(claudeMdPath)) {
      content = fs.readFileSync(claudeMdPath, 'utf-8');
    } else {
      // File doesn't exist, return empty content
      content = '';
    }

    logger.info(
      { agentFolder, contentLength: content.length },
      'CLAUDE.md retrieved',
    );

    sendResponse(
      ws,
      req.id,
      { ok: true },
      {
        agentFolder,
        content,
      },
    );
  } catch (error) {
    logger.error({ agentFolder, error }, 'Failed to read CLAUDE.md');
    sendError(
      ws,
      req.id,
      500,
      `Failed to read CLAUDE.md: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function handleAgentSetClaudeMd(
  ws: WebSocket,
  client: WebSocketClient,
  req: OpenClawRequest,
): Promise<void> {
  if (!client.authenticated) {
    sendError(ws, req.id, 401, 'Not authenticated');
    return;
  }

  const { agentFolder, content } = req.params;

  // Validate parameters
  if (!agentFolder) {
    sendError(ws, req.id, 400, 'agentFolder is required');
    return;
  }

  if (content === undefined) {
    sendError(ws, req.id, 400, 'content is required');
    return;
  }

  // Prevent accidental overwrite with empty content
  if (typeof content === 'string' && content.trim() === '') {
    sendError(
      ws,
      req.id,
      400,
      'Cannot save empty CLAUDE.md - this would delete all agent instructions',
    );
    return;
  }

  // Security check: verify this is a valid agent folder
  // IMPORTANT: Use getRegisteredGroupByFolder, not getRegisteredGroup with constructed JID
  // because main agent uses Telegram JID (tg:...) not @nanoclaw.local
  const group = await getRegisteredGroupByFolder(agentFolder);
  if (!group) {
    sendError(ws, req.id, 404, `Agent ${agentFolder} not found`);
    return;
  }

  const chatJid = group.jid;

  // Write CLAUDE.md file
  const claudeMdPath = path.join(GROUPS_DIR, agentFolder, 'CLAUDE.md');

  try {
    // Ensure directory exists
    fs.mkdirSync(path.dirname(claudeMdPath), { recursive: true });

    // Write content
    fs.writeFileSync(claudeMdPath, content, 'utf-8');

    logger.info(
      { agentFolder, contentLength: content.length },
      'CLAUDE.md updated',
    );

    // Broadcast update to all connected clients
    broadcastEvent('agent.claude_md_updated', {
      agentFolder,
      timestamp: new Date().toISOString(),
    });

    sendResponse(
      ws,
      req.id,
      { ok: true },
      {
        agentFolder,
        saved: true,
      },
    );
  } catch (error) {
    logger.error({ agentFolder, error }, 'Failed to write CLAUDE.md');
    sendError(
      ws,
      req.id,
      500,
      `Failed to write CLAUDE.md: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

// Shared workspace directory for file browser operations
const SHARED_WORKSPACE_DIR = path.join(DATA_DIR, 'workspace');

// File size limits
const MAX_FILE_READ_SIZE = 20 * 1024 * 1024; // 20MB
const MAX_FILE_WRITE_SIZE = 1 * 1024 * 1024; // 1MB

/**
 * Validate and resolve a path within the shared workspace.
 * Returns the resolved absolute path or throws if path traversal is detected.
 */
function validateWorkspacePath(relativePath: string): string {
  // Ensure workspace directory exists
  if (!fs.existsSync(SHARED_WORKSPACE_DIR)) {
    fs.mkdirSync(SHARED_WORKSPACE_DIR, { recursive: true });
  }

  // Normalize the path - remove leading slash to make it relative
  let normalizedPath = relativePath;
  if (normalizedPath === '/' || normalizedPath === '') {
    normalizedPath = '';
  } else if (normalizedPath.startsWith('/')) {
    normalizedPath = normalizedPath.slice(1);
  }

  // Resolve the path and ensure it's within the workspace
  const resolvedPath = path.resolve(SHARED_WORKSPACE_DIR, normalizedPath);

  if (!resolvedPath.startsWith(SHARED_WORKSPACE_DIR)) {
    throw new Error('Path traversal not allowed');
  }

  return resolvedPath;
}

/**
 * Get MIME type based on file extension
 */
function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const mimeTypes: Record<string, string> = {
    // Text files
    '.txt': 'text/plain',
    '.md': 'text/markdown',
    '.markdown': 'text/markdown',
    '.rst': 'text/x-rst',
    '.log': 'text/plain',
    // Code files
    '.json': 'application/json',
    '.js': 'application/javascript',
    '.mjs': 'application/javascript',
    '.cjs': 'application/javascript',
    '.jsx': 'application/javascript',
    '.ts': 'application/typescript',
    '.tsx': 'application/typescript',
    '.py': 'text/x-python',
    '.go': 'text/x-go',
    '.rs': 'text/x-rust',
    '.java': 'text/x-java',
    '.c': 'text/x-c',
    '.cpp': 'text/x-c++',
    '.h': 'text/x-c',
    '.hpp': 'text/x-c++',
    '.cs': 'text/x-csharp',
    '.rb': 'text/x-ruby',
    '.php': 'text/x-php',
    '.swift': 'text/x-swift',
    '.kt': 'text/x-kotlin',
    '.scala': 'text/x-scala',
    '.sh': 'text/x-shellscript',
    '.bash': 'text/x-shellscript',
    '.zsh': 'text/x-shellscript',
    '.ps1': 'text/x-powershell',
    // Web files
    '.html': 'text/html',
    '.htm': 'text/html',
    '.css': 'text/css',
    '.scss': 'text/x-scss',
    '.sass': 'text/x-sass',
    '.less': 'text/x-less',
    '.vue': 'text/x-vue',
    '.svelte': 'text/x-svelte',
    // Config files
    '.xml': 'application/xml',
    '.yaml': 'text/x-yaml',
    '.yml': 'text/x-yaml',
    '.toml': 'text/x-toml',
    '.ini': 'text/x-ini',
    '.env': 'text/plain',
    '.gitignore': 'text/plain',
    '.dockerignore': 'text/plain',
    '.eslintrc': 'application/json',
    '.prettierrc': 'application/json',
    // Data files
    '.csv': 'text/csv',
    '.sql': 'application/sql',
    // Binary files
    '.pdf': 'application/pdf',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.ico': 'image/x-icon',
    '.svg': 'image/svg+xml',
    '.zip': 'application/zip',
    '.tar': 'application/x-tar',
    '.gz': 'application/gzip',
  };
  return mimeTypes[ext] || 'application/octet-stream';
}

async function handleFilesRoots(
  ws: WebSocket,
  client: WebSocketClient,
  req: OpenClawRequest,
): Promise<void> {
  if (!client.authenticated) {
    sendError(ws, req.id, 401, 'Not authenticated');
    return;
  }

  try {
    const roots: Array<{ name: string; path: string }> = [];

    // Shared workspace
    roots.push({ name: 'Workspace', path: '/workspace' });

    // Groups directory
    if (fs.existsSync(GROUPS_DIR)) {
      const groupFolders = fs.readdirSync(GROUPS_DIR);
      for (const folder of groupFolders) {
        const groupPath = path.join(GROUPS_DIR, folder);
        if (fs.statSync(groupPath).isDirectory()) {
          roots.push({ name: folder, path: `/groups/${folder}` });
        }
      }
    }

    sendResponse(ws, req.id, { ok: true }, { roots });
  } catch (error) {
    logger.error({ error }, 'Failed to list file roots');
    sendError(ws, req.id, 500, 'Failed to list roots');
  }
}

async function handleFilesList(
  ws: WebSocket,
  client: WebSocketClient,
  req: OpenClawRequest,
): Promise<void> {
  if (!client.authenticated) {
    sendError(ws, req.id, 401, 'Not authenticated');
    return;
  }

  const { path: relativePath = '' } = req.params;

  try {
    // Support both /workspace/ and /groups/ paths
    let targetPath: string;
    let normalizedPath = relativePath;

    if (normalizedPath.startsWith('/groups/')) {
      // Handle groups paths
      const groupSubpath = normalizedPath.slice(8); // Remove '/groups/'
      targetPath = path.join(GROUPS_DIR, groupSubpath);
    } else if (
      normalizedPath.startsWith('/workspace/') ||
      normalizedPath === '/workspace' ||
      normalizedPath === '' ||
      normalizedPath === '/'
    ) {
      // Handle workspace paths
      const workspaceSubpath = normalizedPath.startsWith('/workspace/')
        ? normalizedPath.slice(11) // Remove '/workspace/'
        : '';
      targetPath = path.join(SHARED_WORKSPACE_DIR, workspaceSubpath);
    } else {
      // Default to workspace for backwards compatibility
      targetPath = path.join(
        SHARED_WORKSPACE_DIR,
        normalizedPath.replace(/^\//, ''),
      );
    }

    // Security check: ensure path is within allowed directories
    if (
      !targetPath.startsWith(SHARED_WORKSPACE_DIR) &&
      !targetPath.startsWith(GROUPS_DIR)
    ) {
      sendError(ws, req.id, 403, 'Path not allowed');
      return;
    }

    if (!fs.existsSync(targetPath)) {
      sendResponse(
        ws,
        req.id,
        { ok: true },
        {
          path: relativePath,
          files: [],
          directories: [],
        },
      );
      return;
    }

    if (!fs.statSync(targetPath).isDirectory()) {
      sendError(ws, req.id, 400, 'Path is not a directory');
      return;
    }

    const entries = fs.readdirSync(targetPath, { withFileTypes: true });
    const files: Array<{
      name: string;
      size: number;
      modified: string;
      isHidden: boolean;
    }> = [];
    const directories: Array<{
      name: string;
      modified: string;
      isHidden: boolean;
    }> = [];

    for (const entry of entries) {
      const entryPath = path.join(targetPath, entry.name);
      const stats = fs.statSync(entryPath);
      const isHidden = entry.name.startsWith('.');

      // Use stats.isDirectory() instead of entry.isDirectory() to follow symlinks
      if (stats.isDirectory()) {
        directories.push({
          name: entry.name,
          modified: stats.mtime.toISOString(),
          isHidden,
        });
      } else {
        files.push({
          name: entry.name,
          size: stats.size,
          modified: stats.mtime.toISOString(),
          isHidden,
        });
      }
    }

    logger.info(
      {
        path: relativePath,
        fileCount: files.length,
        dirCount: directories.length,
      },
      'Files listed',
    );

    sendResponse(
      ws,
      req.id,
      { ok: true },
      {
        path: relativePath,
        files,
        directories,
      },
    );
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === 'Path traversal not allowed'
    ) {
      sendError(ws, req.id, 403, 'Path traversal not allowed');
      return;
    }
    logger.error({ path: relativePath, error }, 'Failed to list files');
    sendError(
      ws,
      req.id,
      500,
      `Failed to list files: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function handleFilesRead(
  ws: WebSocket,
  client: WebSocketClient,
  req: OpenClawRequest,
): Promise<void> {
  if (!client.authenticated) {
    sendError(ws, req.id, 401, 'Not authenticated');
    return;
  }

  const { path: relativePath } = req.params;

  if (!relativePath) {
    sendError(ws, req.id, 400, 'path is required');
    return;
  }

  try {
    // Support both /workspace/ and /groups/ paths
    let targetPath: string;

    if (relativePath.startsWith('/groups/')) {
      const groupSubpath = relativePath.slice(8);
      targetPath = path.join(GROUPS_DIR, groupSubpath);
    } else if (
      relativePath.startsWith('/workspace/') ||
      relativePath.startsWith('/workspace')
    ) {
      const workspaceSubpath = relativePath.startsWith('/workspace/')
        ? relativePath.slice(11)
        : '';
      targetPath = path.join(SHARED_WORKSPACE_DIR, workspaceSubpath);
    } else {
      targetPath = path.join(
        SHARED_WORKSPACE_DIR,
        relativePath.replace(/^\//, ''),
      );
    }

    // Security check
    if (
      !targetPath.startsWith(SHARED_WORKSPACE_DIR) &&
      !targetPath.startsWith(GROUPS_DIR)
    ) {
      sendError(ws, req.id, 403, 'Path not allowed');
      return;
    }

    if (!fs.existsSync(targetPath)) {
      sendError(ws, req.id, 404, 'File not found');
      return;
    }

    const stats = fs.statSync(targetPath);
    if (!stats.isFile()) {
      sendError(ws, req.id, 400, 'Path is not a file');
      return;
    }

    if (stats.size > MAX_FILE_READ_SIZE) {
      sendError(
        ws,
        req.id,
        413,
        `File too large (max ${MAX_FILE_READ_SIZE / 1024 / 1024}MB)`,
      );
      return;
    }

    const mimeType = getMimeType(targetPath);
    const isBinary =
      mimeType.startsWith('image/') ||
      mimeType === 'application/pdf' ||
      mimeType === 'application/zip' ||
      mimeType === 'application/octet-stream';

    // Read as base64 for binary files, utf-8 for text
    const content = isBinary
      ? fs.readFileSync(targetPath, 'base64')
      : fs.readFileSync(targetPath, 'utf-8');

    logger.info(
      { path: relativePath, size: stats.size, mimeType, isBinary },
      'File read',
    );

    sendResponse(
      ws,
      req.id,
      { ok: true },
      {
        path: relativePath,
        content,
        mimeType,
        size: stats.size,
        modified: stats.mtime.toISOString(),
        isBinary,
      },
    );
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === 'Path traversal not allowed'
    ) {
      sendError(ws, req.id, 403, 'Path traversal not allowed');
      return;
    }
    logger.error({ path: relativePath, error }, 'Failed to read file');
    sendError(
      ws,
      req.id,
      500,
      `Failed to read file: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function handleFilesWrite(
  ws: WebSocket,
  client: WebSocketClient,
  req: OpenClawRequest,
): Promise<void> {
  if (!client.authenticated) {
    sendError(ws, req.id, 401, 'Not authenticated');
    return;
  }

  const { path: relativePath, content } = req.params;

  if (!relativePath) {
    sendError(ws, req.id, 400, 'path is required');
    return;
  }

  if (content === undefined) {
    sendError(ws, req.id, 400, 'content is required');
    return;
  }

  // Check content size
  const contentSize = Buffer.byteLength(content, 'utf-8');
  if (contentSize > MAX_FILE_WRITE_SIZE) {
    sendError(
      ws,
      req.id,
      413,
      `Content too large (max ${MAX_FILE_WRITE_SIZE / 1024 / 1024}MB)`,
    );
    return;
  }

  try {
    // Support both /workspace/ and /groups/ paths
    let targetPath: string;

    if (relativePath.startsWith('/groups/')) {
      const groupSubpath = relativePath.slice(8);
      targetPath = path.join(GROUPS_DIR, groupSubpath);
    } else if (
      relativePath.startsWith('/workspace/') ||
      relativePath.startsWith('/workspace')
    ) {
      const workspaceSubpath = relativePath.startsWith('/workspace/')
        ? relativePath.slice(11)
        : '';
      targetPath = path.join(SHARED_WORKSPACE_DIR, workspaceSubpath);
    } else {
      targetPath = path.join(
        SHARED_WORKSPACE_DIR,
        relativePath.replace(/^\//, ''),
      );
    }

    // Security check
    if (
      !targetPath.startsWith(SHARED_WORKSPACE_DIR) &&
      !targetPath.startsWith(GROUPS_DIR)
    ) {
      sendError(ws, req.id, 403, 'Path not allowed');
      return;
    }

    // Ensure parent directory exists
    const parentDir = path.dirname(targetPath);
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    }

    fs.writeFileSync(targetPath, content, 'utf-8');

    logger.info({ path: relativePath, size: contentSize }, 'File written');

    // Broadcast file change event
    broadcastEvent('file.changed', {
      path: relativePath,
      action: 'write',
      timestamp: new Date().toISOString(),
    });

    sendResponse(
      ws,
      req.id,
      { ok: true },
      {
        path: relativePath,
        size: contentSize,
        saved: true,
      },
    );
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === 'Path traversal not allowed'
    ) {
      sendError(ws, req.id, 403, 'Path traversal not allowed');
      return;
    }
    logger.error({ path: relativePath, error }, 'Failed to write file');
    sendError(
      ws,
      req.id,
      500,
      `Failed to write file: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function handleFilesDelete(
  ws: WebSocket,
  client: WebSocketClient,
  req: OpenClawRequest,
): Promise<void> {
  if (!client.authenticated) {
    sendError(ws, req.id, 401, 'Not authenticated');
    return;
  }

  const { path: relativePath } = req.params;

  if (!relativePath) {
    sendError(ws, req.id, 400, 'path is required');
    return;
  }

  // Prevent deleting the root workspace directory
  if (relativePath === '' || relativePath === '/' || relativePath === '.') {
    sendError(ws, req.id, 403, 'Cannot delete workspace root');
    return;
  }

  try {
    // Support both /workspace/ and /groups/ paths
    let targetPath: string;

    if (relativePath.startsWith('/groups/')) {
      const groupSubpath = relativePath.slice(8);
      targetPath = path.join(GROUPS_DIR, groupSubpath);
    } else if (
      relativePath.startsWith('/workspace/') ||
      relativePath.startsWith('/workspace')
    ) {
      const workspaceSubpath = relativePath.startsWith('/workspace/')
        ? relativePath.slice(11)
        : '';
      targetPath = path.join(SHARED_WORKSPACE_DIR, workspaceSubpath);
    } else {
      targetPath = path.join(
        SHARED_WORKSPACE_DIR,
        relativePath.replace(/^\//, ''),
      );
    }

    // Security check
    if (
      !targetPath.startsWith(SHARED_WORKSPACE_DIR) &&
      !targetPath.startsWith(GROUPS_DIR)
    ) {
      sendError(ws, req.id, 403, 'Path not allowed');
      return;
    }

    if (!fs.existsSync(targetPath)) {
      sendError(ws, req.id, 404, 'Path not found');
      return;
    }

    const stats = fs.statSync(targetPath);

    if (stats.isDirectory()) {
      // Check if directory is empty
      const entries = fs.readdirSync(targetPath);
      if (entries.length > 0) {
        sendError(ws, req.id, 400, 'Directory is not empty');
        return;
      }
      fs.rmdirSync(targetPath);
    } else {
      fs.unlinkSync(targetPath);
    }

    logger.info(
      { path: relativePath, wasDirectory: stats.isDirectory() },
      'Path deleted',
    );

    // Broadcast file change event
    broadcastEvent('file.changed', {
      path: relativePath,
      action: 'delete',
      timestamp: new Date().toISOString(),
    });

    sendResponse(
      ws,
      req.id,
      { ok: true },
      {
        path: relativePath,
        deleted: true,
      },
    );
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === 'Path traversal not allowed'
    ) {
      sendError(ws, req.id, 403, 'Path traversal not allowed');
      return;
    }
    logger.error({ path: relativePath, error }, 'Failed to delete');
    sendError(
      ws,
      req.id,
      500,
      `Failed to delete: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function handleFilesMkdir(
  ws: WebSocket,
  client: WebSocketClient,
  req: OpenClawRequest,
): Promise<void> {
  if (!client.authenticated) {
    sendError(ws, req.id, 401, 'Not authenticated');
    return;
  }

  const { path: relativePath } = req.params;

  if (!relativePath) {
    sendError(ws, req.id, 400, 'path is required');
    return;
  }

  try {
    // Support both /workspace/ and /groups/ paths
    let targetPath: string;

    if (relativePath.startsWith('/groups/')) {
      const groupSubpath = relativePath.slice(8);
      targetPath = path.join(GROUPS_DIR, groupSubpath);
    } else if (
      relativePath.startsWith('/workspace/') ||
      relativePath.startsWith('/workspace')
    ) {
      const workspaceSubpath = relativePath.startsWith('/workspace/')
        ? relativePath.slice(11)
        : '';
      targetPath = path.join(SHARED_WORKSPACE_DIR, workspaceSubpath);
    } else {
      targetPath = path.join(
        SHARED_WORKSPACE_DIR,
        relativePath.replace(/^\//, ''),
      );
    }

    // Security check
    if (
      !targetPath.startsWith(SHARED_WORKSPACE_DIR) &&
      !targetPath.startsWith(GROUPS_DIR)
    ) {
      sendError(ws, req.id, 403, 'Path not allowed');
      return;
    }

    if (fs.existsSync(targetPath)) {
      sendError(ws, req.id, 409, 'Path already exists');
      return;
    }

    fs.mkdirSync(targetPath, { recursive: true });

    logger.info({ path: relativePath }, 'Directory created');

    // Broadcast file change event
    broadcastEvent('file.changed', {
      path: relativePath,
      action: 'mkdir',
      timestamp: new Date().toISOString(),
    });

    sendResponse(
      ws,
      req.id,
      { ok: true },
      {
        path: relativePath,
        created: true,
      },
    );
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === 'Path traversal not allowed'
    ) {
      sendError(ws, req.id, 403, 'Path traversal not allowed');
      return;
    }
    logger.error({ path: relativePath, error }, 'Failed to create directory');
    sendError(
      ws,
      req.id,
      500,
      `Failed to create directory: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Handle workflow.list RPC - list all workflow runs
 */
async function handleWorkflowList(
  ws: WebSocket,
  client: WebSocketClient,
  req: OpenClawRequest,
): Promise<void> {
  if (!client.authenticated) {
    sendError(ws, req.id, 401, 'Not authenticated');
    return;
  }

  const { status, limit = 50 } = req.params;

  try {
    const allRuns = listWorkflowRuns();

    // Filter by status if provided
    let filteredRuns = allRuns;
    if (status && typeof status === 'string') {
      const validStatuses = [
        'pending',
        'running',
        'completed',
        'failed',
        'paused',
        'escalated',
        'cancelled',
      ];
      if (!validStatuses.includes(status)) {
        sendError(
          ws,
          req.id,
          400,
          `Invalid status filter. Valid values: ${validStatuses.join(', ')}`,
        );
        return;
      }
      filteredRuns = allRuns.filter((r: any) => r.status === status);
    }

    // Apply limit
    const limitedRuns = filteredRuns.slice(0, Math.min(limit, 100));

    // Transform to frontend-friendly format
    const runs = limitedRuns.map((run: any) => ({
      id: run.id,
      workflow_id: run.workflow_id,
      group_id: run.group_id,
      input: run.input,
      status: run.status,
      created_at: run.created_at,
      updated_at: run.updated_at,
      progress: run.progress ? parseProgress(run.progress) : undefined,
    }));

    sendResponse(
      ws,
      req.id,
      { ok: true },
      {
        runs,
        total: filteredRuns.length,
      },
    );
  } catch (error) {
    logger.error({ error }, 'Failed to list workflows');
    sendError(
      ws,
      req.id,
      500,
      `Failed to list workflows: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Handle workflow.status RPC - get detailed status of a workflow run
 */
async function handleWorkflowStatus(
  ws: WebSocket,
  client: WebSocketClient,
  req: OpenClawRequest,
): Promise<void> {
  if (!client.authenticated) {
    sendError(ws, req.id, 401, 'Not authenticated');
    return;
  }

  const { runId } = req.params;

  if (!runId || typeof runId !== 'string') {
    sendError(ws, req.id, 400, 'runId is required');
    return;
  }

  try {
    const status = getWorkflowStatus(runId);

    if (!status) {
      sendError(ws, req.id, 404, 'Workflow run not found');
      return;
    }

    // Transform to frontend-friendly format
    const response = {
      run: {
        id: status.run.id,
        workflow_id: status.run.workflow_id,
        group_id: status.run.group_id,
        input: status.run.input,
        status: status.run.status,
        created_at: status.run.created_at,
        updated_at: status.run.updated_at,
        completed_at: status.run.completed_at,
      },
      steps: status.steps.map((step: any) => ({
        id: step.id,
        run_id: step.run_id,
        step_id: step.step_id,
        agent_id: step.agent_id,
        status: step.status,
        started_at: step.started_at,
        completed_at: step.completed_at,
        error: step.error,
        retries: step.retries,
      })),
      progress: status.progress,
      currentStep: status.currentStep
        ? {
            id: status.currentStep.id,
            step_id: status.currentStep.step_id,
            agent_id: status.currentStep.agent_id,
            status: status.currentStep.status,
          }
        : undefined,
    };

    sendResponse(ws, req.id, { ok: true }, response);
  } catch (error) {
    logger.error({ runId, error }, 'Failed to get workflow status');
    sendError(
      ws,
      req.id,
      500,
      `Failed to get workflow status: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Handle workflow.cancel RPC - cancel a running workflow
 */
async function handleWorkflowCancel(
  ws: WebSocket,
  client: WebSocketClient,
  req: OpenClawRequest,
): Promise<void> {
  if (!client.authenticated) {
    sendError(ws, req.id, 401, 'Not authenticated');
    return;
  }

  const { runId } = req.params;

  if (!runId || typeof runId !== 'string') {
    sendError(ws, req.id, 400, 'runId is required');
    return;
  }

  try {
    const run = getWorkflowRun(runId);

    if (!run) {
      sendError(ws, req.id, 404, 'Workflow run not found');
      return;
    }

    // Check if workflow can be cancelled
    if (
      run.status !== 'running' &&
      run.status !== 'pending' &&
      run.status !== 'paused'
    ) {
      sendError(
        ws,
        req.id,
        400,
        `Cannot cancel workflow in ${run.status} state`,
      );
      return;
    }

    // Cancel the workflow
    workflowEngine.cancelRun(runId);

    logger.info(
      { runId, workflowId: run.workflow_id },
      'Workflow cancelled via RPC',
    );

    sendResponse(
      ws,
      req.id,
      { ok: true },
      {
        runId,
        status: 'cancelled',
      },
    );
  } catch (error) {
    logger.error({ runId, error }, 'Failed to cancel workflow');
    sendError(
      ws,
      req.id,
      500,
      `Failed to cancel workflow: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Handle workflow.start RPC - start a new workflow run
 */
async function handleWorkflowStart(
  ws: WebSocket,
  client: WebSocketClient,
  req: OpenClawRequest,
): Promise<void> {
  if (!client.authenticated) {
    sendError(ws, req.id, 401, 'Not authenticated');
    return;
  }

  const { workflowId, input, groupId } = req.params;

  if (!workflowId || typeof workflowId !== 'string') {
    sendError(ws, req.id, 400, 'workflowId is required');
    return;
  }

  if (!input || typeof input !== 'string') {
    sendError(ws, req.id, 400, 'input is required');
    return;
  }

  // Validate input length
  if (input.length > 100000) {
    sendError(ws, req.id, 400, 'Input too long (max 100,000 characters)');
    return;
  }

  try {
    // Use provided groupId or default to 'main'
    const targetGroupId =
      groupId && typeof groupId === 'string' ? groupId : 'main';

    // Start the workflow
    const runId = await workflowEngine.startRun(
      workflowId,
      targetGroupId,
      input,
    );

    if (!runId) {
      sendError(
        ws,
        req.id,
        500,
        'Failed to start workflow - workflow not found or invalid',
      );
      return;
    }

    logger.info(
      { runId, workflowId, groupId: targetGroupId },
      'Workflow started via RPC',
    );

    sendResponse(
      ws,
      req.id,
      { ok: true },
      {
        runId,
        status: 'started',
      },
    );
  } catch (error) {
    logger.error({ workflowId, error }, 'Failed to start workflow');
    sendError(
      ws,
      req.id,
      500,
      `Failed to start workflow: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Parse progress string like "2/5 steps completed" into structured object
 */
function parseProgress(
  progressStr: string,
):
  | { completed: number; total: number; failed: number; running: number }
  | undefined {
  const match = progressStr.match(/(\d+)\/(\d+)/);
  if (match) {
    return {
      completed: parseInt(match[1], 10),
      total: parseInt(match[2], 10),
      failed: 0,
      running: 0,
    };
  }
  return undefined;
}

async function handleChannelSend(
  ws: WebSocket,
  client: WebSocketClient,
  req: OpenClawRequest,
): Promise<void> {
  if (!client.authenticated) {
    sendError(ws, req.id, 401, 'Not authenticated');
    return;
  }

  const { jid, message } = req.params;

  if (!jid) {
    sendError(ws, req.id, 400, 'jid is required');
    return;
  }

  if (!message) {
    sendError(ws, req.id, 400, 'message is required');
    return;
  }

  if (!sendMessageToExternal) {
    sendError(ws, req.id, 503, 'No channel connected');
    return;
  }

  try {
    await sendMessageToExternal(jid, message);
    logger.info(
      { jid, messageLength: message.length },
      'Message sent via channel RPC',
    );

    sendResponse(
      ws,
      req.id,
      { ok: true },
      {
        jid,
        sent: true,
        timestamp: new Date().toISOString(),
      },
    );
  } catch (error) {
    logger.error({ jid, error }, 'Failed to send channel message');
    sendError(
      ws,
      req.id,
      500,
      `Failed to send message: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

// ============================================================================
// Background Task System
// ============================================================================

interface BackgroundTask {
  id: string;
  name: string;
  description: string;
  agentFolder: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  createdAt: Date;
  startedAt?: Date;
  completedAt?: Date;
  progress?: number;
  progressMessage?: string;
  result?: string;
  error?: string;
  notifyOnComplete: boolean;
  notifyJid?: string;
}

// In-memory task store (persisted to data/tasks.json)
const TASKS_FILE = path.join(DATA_DIR, 'tasks.json');
const backgroundTasks = new Map<string, BackgroundTask>();

// ============================================================================
// Agent Hierarchy for Smart Task Routing
// ============================================================================

// Agent hierarchy: chief -> list of agents they can delegate to
const AGENT_TEAMS: Record<string, string[]> = {
  // Lucy (COO) delegates to chiefs
  lucy: ['nalu', 'maui', 'hoku'],
  // Nalu (CTO) - Tech team
  nalu: ['reef', 'pali', 'mana', 'ahi', 'liko'],
  // Maui (CMO) - Marketing team
  maui: ['hali', 'moana', 'koa', 'leilani', 'noelani', 'ikaika'],
  // Hoku (CRO) - Revenue team
  hoku: ['kai', 'wai', 'makani', 'lani', 'keoni', 'pua', 'noe'],
};

// Division groupings (agents with similar skills)
const AGENT_DIVISIONS: Record<string, string[]> = {
  // Nalu's divisions
  'backend-security': ['reef', 'pali'],
  'frontend-devops': ['mana', 'ahi'],
  qa: ['liko'],
  // Maui's divisions
  content: ['hali', 'moana', 'koa', 'leilani'],
  creative: ['noelani', 'ikaika'],
  // Hoku's divisions
  products: ['kai', 'wai'],
  growth: ['makani', 'lani'],
  community: ['keoni', 'pua', 'noe'],
};

// Reverse mapping: agent -> their chief
const AGENT_CHIEF: Record<string, string> = {};
for (const [chief, agents] of Object.entries(AGENT_TEAMS)) {
  for (const agent of agents) {
    AGENT_CHIEF[agent] = chief;
  }
}

/**
 * Check if an agent has any running tasks
 */
function isAgentBusy(agentFolder: string): boolean {
  for (const task of backgroundTasks.values()) {
    if (task.agentFolder === agentFolder && task.status === 'running') {
      return true;
    }
  }
  return false;
}

/**
 * Find an available agent from the same team as the requested agent.
 * Returns the requested agent if not busy, or an alternative if available.
 */
function findAvailableAgent(requestedAgent: string): string {
  // If requested agent is not busy, use them
  if (!isAgentBusy(requestedAgent)) {
    return requestedAgent;
  }

  logger.info(
    { requestedAgent },
    'Requested agent is busy, looking for alternative',
  );

  // Find the chief/team for this agent
  const chief = AGENT_CHIEF[requestedAgent] || requestedAgent;

  // If this is a chief, check their team members
  const team = AGENT_TEAMS[chief] || [];

  // Find available team member (prefer agents with similar role)
  // First, try to find someone in the same division
  for (const [divisionName, agents] of Object.entries(AGENT_DIVISIONS)) {
    if (agents.includes(requestedAgent)) {
      for (const agent of agents) {
        if (!isAgentBusy(agent)) {
          logger.info(
            { requestedAgent, alternativeAgent: agent, division: divisionName },
            'Found alternative agent in same division',
          );
          return agent;
        }
      }
    }
  }

  // If no one in same division, try any team member
  for (const agent of team) {
    if (!isAgentBusy(agent)) {
      logger.info(
        { requestedAgent, alternativeAgent: agent },
        'Found alternative agent in same team',
      );
      return agent;
    }
  }

  // If chief is requested and busy, try the chiefs that lucy delegates to
  if (
    requestedAgent === 'nalu' ||
    requestedAgent === 'maui' ||
    requestedAgent === 'hoku'
  ) {
    const chiefs = ['nalu', 'maui', 'hoku'];
    for (const altChief of chiefs) {
      if (altChief !== requestedAgent && !isAgentBusy(altChief)) {
        // Check if this chief has team members that could handle the task type
        logger.info(
          { requestedAgent, alternativeAgent: altChief },
          'Redirecting task to another available chief',
        );
        return altChief;
      }
    }
  }

  // If all else fails, return the requested agent (they'll be queued)
  logger.warn(
    { requestedAgent },
    'No alternative agents available, task will queue',
  );
  return requestedAgent;
}

// Load existing tasks from file
function loadTasks(): void {
  try {
    if (fs.existsSync(TASKS_FILE)) {
      const data = JSON.parse(fs.readFileSync(TASKS_FILE, 'utf-8'));
      for (const task of data.tasks || []) {
        // Convert date strings back to Date objects
        task.createdAt = new Date(task.createdAt);
        if (task.startedAt) task.startedAt = new Date(task.startedAt);
        if (task.completedAt) task.completedAt = new Date(task.completedAt);
        // Reset any tasks stuck in running state from a previous process
        if (task.status === 'running') {
          task.status = 'failed';
          task.completedAt = new Date();
          task.error = 'Process restarted while task was running';
          task.progressMessage = 'Task failed (process restart)';
        }
        backgroundTasks.set(task.id, task);
      }
      logger.info({ count: backgroundTasks.size }, 'Loaded background tasks');
    }
  } catch (error) {
    logger.error({ error }, 'Failed to load tasks');
  }
}

// Save tasks to file
function saveTasks(): void {
  try {
    const data = {
      tasks: Array.from(backgroundTasks.values()),
      savedAt: new Date().toISOString(),
    };
    fs.writeFileSync(TASKS_FILE, JSON.stringify(data, null, 2));
  } catch (error) {
    logger.error({ error }, 'Failed to save tasks');
  }
}

// loadTasks() is called from startWebSocketServer() to avoid side effects at import time

// Background task request watcher
let bgTaskWatcherInterval: ReturnType<typeof setInterval> | null = null;

function startBackgroundTaskWatcher(): void {
  if (bgTaskWatcherInterval) return;

  const processRequests = () => {
    try {
      const ipcBaseDir = path.join(DATA_DIR, 'ipc');

      if (!fs.existsSync(ipcBaseDir)) {
        fs.mkdirSync(ipcBaseDir, { recursive: true });
        return;
      }

      // Location 1: Legacy shared directory (from IPC handler)
      const sharedBgTaskDir = path.join(ipcBaseDir, 'background-tasks');
      if (fs.existsSync(sharedBgTaskDir)) {
        const files = fs
          .readdirSync(sharedBgTaskDir)
          .filter((f) => f.endsWith('.json'));
        for (const file of files) {
          const filePath = path.join(sharedBgTaskDir, file);
          processTaskFile(filePath, file, 'shared');
        }
      }

      // Location 2: Per-agent task directories (from start_task binary)
      const agentDirs = fs
        .readdirSync(ipcBaseDir, { withFileTypes: true })
        .filter(
          (dirent) =>
            dirent.isDirectory() &&
            dirent.name !== 'background-tasks' &&
            dirent.name !== 'errors',
        )
        .map((dirent) => dirent.name);

      for (const agentDir of agentDirs) {
        const tasksDir = path.join(ipcBaseDir, agentDir, 'tasks');

        if (!fs.existsSync(tasksDir)) {
          continue;
        }

        const files = fs
          .readdirSync(tasksDir)
          .filter((f) => f.endsWith('.json'));
        for (const file of files) {
          const filePath = path.join(tasksDir, file);
          processTaskFile(filePath, file, agentDir);
        }
      }
    } catch (error) {
      logger.error({ error }, 'Error in background task watcher');
    }
  };

  function processTaskFile(
    filePath: string,
    file: string,
    sourceAgent: string,
  ) {
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));

      // Only process background_task type (or files without type for backwards compatibility)
      if (data.type && data.type !== 'background_task') {
        return;
      }

      // Create task
      const taskId = generateTaskId();
      const requestedAgent =
        data.agentFolder || (sourceAgent === 'shared' ? MAIN_GROUP_FOLDER : sourceAgent);
      // Smart routing: find available agent if requested one is busy
      const agentFolder = findAvailableAgent(requestedAgent);
      const wasRedirected = agentFolder !== requestedAgent;

      // Resolve notifyJid: use source agent's registered chat JID so responses
      // reach the user on whichever channel they're using (Telegram or WhatsApp).
      // Falls back to the value in the IPC file, or the legacy WhatsApp JID.
      let resolvedNotifyJid = data.notifyJid || MAIN_GROUP_JID;
      if (!data.notifyJid || data.notifyJid === MAIN_GROUP_JID) {
        const allGroups = getAllRegisteredGroups();
        const sourceJidEntry = Object.entries(allGroups).find(
          ([, g]) => g.folder === sourceAgent,
        );
        if (sourceJidEntry) {
          resolvedNotifyJid = sourceJidEntry[0];
          logger.debug(
            { sourceAgent, resolvedNotifyJid },
            'Resolved notifyJid from source agent registration',
          );
        }
      }

      const task: BackgroundTask = {
        id: taskId,
        name: data.name || `Task ${taskId.slice(-6)}`,
        description: data.description || data.prompt?.slice(0, 100) || '',
        agentFolder,
        status: 'pending',
        createdAt: new Date(),
        notifyOnComplete: data.notifyOnComplete !== false,
        notifyJid: resolvedNotifyJid,
      };

      if (wasRedirected) {
        logger.info(
          { taskId, requestedAgent, assignedAgent: agentFolder },
          'Task redirected to available agent',
        );
      }

      backgroundTasks.set(taskId, task);
      saveTasks();

      // Start task in background
      const isMain = task.agentFolder === MAIN_GROUP_FOLDER;
      runBackgroundTask(task, data.prompt, isMain).catch((error) => {
        logger.error(
          { taskId, error },
          'Background task error from IPC request',
        );
      });

      logger.info(
        { taskId, name: task.name, agentFolder: task.agentFolder, sourceAgent },
        'Background task started from IPC request',
      );

      // Remove the request file
      fs.unlinkSync(filePath);
    } catch (error) {
      logger.error(
        { file, sourceAgent, error },
        'Error processing background task request',
      );
      // Move to errors
      const errorDir = path.join(DATA_DIR, 'ipc', 'errors');
      fs.mkdirSync(errorDir, { recursive: true });
      try {
        fs.renameSync(filePath, path.join(errorDir, `${sourceAgent}-${file}`));
      } catch (e) {
        // Ignore if file already moved
      }
    }
  }

  // Poll every 2 seconds
  bgTaskWatcherInterval = setInterval(processRequests, 2000);
  processRequests(); // Process immediately on start

  logger.info(
    'Background task watcher started (watching background-tasks/ and agent/*/tasks/)',
  );
}

// Generate unique task ID
function generateTaskId(): string {
  return `task-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

// Update task and broadcast to clients
function updateTask(task: BackgroundTask): void {
  backgroundTasks.set(task.id, task);
  saveTasks();
  broadcastEvent('task.updated', task);
}

// Run a task in the background
async function runBackgroundTask(
  task: BackgroundTask,
  prompt: string,
  isMain: boolean,
): Promise<void> {
  // Track execution state from streaming callbacks
  let executionError: string | null = null;
  let executionResult: string | null = null;
  let hadError = false;

  try {
    // Update status to running
    task.status = 'running';
    task.startedAt = new Date();
    task.progressMessage = 'Starting container...';
    updateTask(task);

    // Create workspace directory for this task
    const taskWorkspace = path.join(DATA_DIR, 'workspace', 'tasks', task.id);
    fs.mkdirSync(taskWorkspace, { recursive: true });

    // Get the registered group for this agent
    // IMPORTANT: Use getRegisteredGroupByFolder, not getRegisteredGroup with constructed JID
    // because main agent uses Telegram JID (tg:...) not @nanoclaw.local
    const group = await getRegisteredGroupByFolder(task.agentFolder);
    if (!group) {
      throw new Error(`Agent ${task.agentFolder} not found`);
    }

    const chatJid = group.jid;

    // Run the container
    const output = await runContainerAgent(
      group,
      {
        prompt,
        groupFolder: group.folder,
        chatJid: `task://${task.id}`,
        isMain,
        isScheduledTask: false,
        singleMessage: true, // Exit after first response - background tasks should complete
      },
      (proc, containerName) => {
        logger.info(
          { taskId: task.id, containerName },
          'Task container started',
        );
      },
      async (streamOutput) => {
        // Track the actual execution result from streaming
        logger.info(
          {
            taskId: task.id,
            status: streamOutput.status,
            error: streamOutput.error,
            hasResult: !!streamOutput.result,
            resultPreview:
              typeof streamOutput.result === 'string'
                ? streamOutput.result.slice(0, 50)
                : null,
            currentState: { hadError, hasResult: !!executionResult },
          },
          'Background task streaming output',
        );

        // If we get a result, always save it
        if (streamOutput.result) {
          executionResult =
            typeof streamOutput.result === 'string'
              ? streamOutput.result
              : JSON.stringify(streamOutput.result);
          task.progressMessage = 'Processing...';
          updateTask(task);
        }

        // Track errors, but clear them if we have a result
        if (streamOutput.status === 'error') {
          if (!executionResult) {
            // No result yet, so this error matters
            hadError = true;
            executionError = streamOutput.error || 'Execution error';
            logger.warn(
              { taskId: task.id, error: executionError },
              'Background task streaming error (no result yet)',
            );
          } else {
            // We have a result, so ignore this error
            logger.info(
              { taskId: task.id, error: streamOutput.error },
              'Background task streaming error ignored (already have result)',
            );
          }
        } else if (streamOutput.status === 'success' && executionResult) {
          // Success with result clears any previous error
          hadError = false;
          executionError = null;
        }
      },
    );

    // Determine final status - prefer streaming state over container exit status
    // because in streaming mode, output.status is always 'success'
    const resultPreview = executionResult
      ? String(executionResult).slice(0, 100)
      : null;
    logger.info(
      {
        taskId: task.id,
        hadError,
        executionError,
        resultPreview,
        outputStatus: output.status,
        outputError: output.error,
        hasOutputResult: !!output.result,
      },
      'Background task finalizing',
    );

    const finalStatus = hadError
      ? 'failed'
      : output.status === 'success'
        ? 'completed'
        : 'failed';
    const finalResult = executionResult || output.result || 'Task completed';
    const finalError = executionError || output.error;

    // Update task with result
    task.status = finalStatus;
    task.completedAt = new Date();
    task.progress = 100;
    task.progressMessage =
      finalStatus === 'completed' ? 'Task completed' : 'Task failed';
    task.result = finalResult;
    if (finalError) {
      task.error = finalError;
    }
    updateTask(task);

    logger.info(
      { taskId: task.id, status: output.status },
      'Background task completed',
    );

    // Prepare notification message
    const notification =
      task.status === 'completed'
        ? `✅ Task Complete: ${task.name}\n\n${task.result?.substring(0, 500) || 'Completed successfully'}`
        : `❌ Task Failed: ${task.name}\n\nError: ${task.error || 'Unknown error'}`;

    // Save notification to agent's chat history for web OS
    // Use agent:xxx:main format to match frontend sessionKey
    const agentSessionKey = `agent:${task.agentFolder}:main`;
    saveChatMessage(
      agentSessionKey,
      task.agentFolder,
      'assistant',
      notification,
    );

    // Broadcast to connected web OS clients (matching handleChatSend format)
    broadcastEvent('chat', {
      runId: task.id,
      sessionKey: agentSessionKey,
      state: 'final',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: notification }],
      },
    });

    // Send WhatsApp notification if requested
    if (task.notifyOnComplete && task.notifyJid && sendMessageToExternal) {
      try {
        await sendMessageToExternal(task.notifyJid, notification);
        logger.info(
          { taskId: task.id, jid: task.notifyJid },
          'Task completion notification sent',
        );
      } catch (error) {
        logger.error(
          { taskId: task.id, error },
          'Failed to send task notification',
        );
      }
    }
  } catch (error) {
    task.status = 'failed';
    task.completedAt = new Date();
    task.error = error instanceof Error ? error.message : String(error);
    task.progressMessage = `Failed: ${task.error}`;
    updateTask(task);

    logger.error({ taskId: task.id, error }, 'Background task failed');

    // Prepare failure notification
    const failureNotification = `❌ Task Failed: ${task.name}\n\nError: ${task.error}`;

    // Save to agent's chat history for web OS
    // Use agent:xxx:main format to match frontend sessionKey
    const agentSessionKey = `agent:${task.agentFolder}:main`;
    saveChatMessage(
      agentSessionKey,
      task.agentFolder,
      'assistant',
      failureNotification,
    );

    // Broadcast to connected web OS clients (matching handleChatSend format)
    broadcastEvent('chat', {
      runId: task.id,
      sessionKey: agentSessionKey,
      state: 'final',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: failureNotification }],
      },
    });

    // Send failure notification to WhatsApp
    if (task.notifyOnComplete && task.notifyJid && sendMessageToExternal) {
      try {
        await sendMessageToExternal(task.notifyJid, failureNotification);
      } catch (e) {
        logger.error(
          { taskId: task.id, error: e },
          'Failed to send failure notification',
        );
      }
    }
  }
}

async function handleTaskStart(
  ws: WebSocket,
  client: WebSocketClient,
  req: OpenClawRequest,
): Promise<void> {
  if (!client.authenticated) {
    sendError(ws, req.id, 401, 'Not authenticated');
    return;
  }

  const {
    name,
    description,
    agentFolder = MAIN_GROUP_FOLDER,
    prompt,
    notifyOnComplete = true,
    notifyJid = MAIN_GROUP_JID,
  } = req.params;

  if (!prompt) {
    sendError(ws, req.id, 400, 'prompt is required');
    return;
  }

  const taskId = generateTaskId();
  const task: BackgroundTask = {
    id: taskId,
    name: name || `Task ${taskId.slice(-6)}`,
    description: description || prompt.slice(0, 100),
    agentFolder,
    status: 'pending',
    createdAt: new Date(),
    notifyOnComplete,
    notifyJid,
  };

  backgroundTasks.set(taskId, task);
  saveTasks();

  // Start task in background (don't await)
  const isMain = agentFolder === MAIN_GROUP_FOLDER;
  runBackgroundTask(task, prompt, isMain).catch((error) => {
    logger.error({ taskId, error }, 'Background task error');
  });

  logger.info(
    { taskId, agentFolder, name: task.name },
    'Background task started',
  );

  sendResponse(
    ws,
    req.id,
    { ok: true },
    {
      taskId,
      name: task.name,
      status: task.status,
      createdAt: task.createdAt.toISOString(),
      message: 'Task started in background',
    },
  );
}

async function handleTaskStatus(
  ws: WebSocket,
  client: WebSocketClient,
  req: OpenClawRequest,
): Promise<void> {
  if (!client.authenticated) {
    sendError(ws, req.id, 401, 'Not authenticated');
    return;
  }

  const { taskId } = req.params;

  if (!taskId) {
    sendError(ws, req.id, 400, 'taskId is required');
    return;
  }

  const task = backgroundTasks.get(taskId);
  if (!task) {
    sendError(ws, req.id, 404, 'Task not found');
    return;
  }

  sendResponse(
    ws,
    req.id,
    { ok: true },
    {
      ...task,
      createdAt: task.createdAt.toISOString(),
      startedAt: task.startedAt?.toISOString(),
      completedAt: task.completedAt?.toISOString(),
    },
  );
}

async function handleTaskList(
  ws: WebSocket,
  client: WebSocketClient,
  req: OpenClawRequest,
): Promise<void> {
  if (!client.authenticated) {
    sendError(ws, req.id, 401, 'Not authenticated');
    return;
  }

  const { status, limit = 50 } = req.params;

  let tasks = Array.from(backgroundTasks.values());

  // Filter by status if provided
  if (status) {
    tasks = tasks.filter((t) => t.status === status);
  }

  // Sort by createdAt descending
  tasks.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

  // Limit results
  tasks = tasks.slice(0, limit);

  sendResponse(
    ws,
    req.id,
    { ok: true },
    {
      tasks: tasks.map((t) => ({
        ...t,
        createdAt: t.createdAt.toISOString(),
        startedAt: t.startedAt?.toISOString(),
        completedAt: t.completedAt?.toISOString(),
      })),
      total: backgroundTasks.size,
    },
  );
}

/**
 * Handle schedule.list RPC - list all scheduled tasks
 */
async function handleScheduleList(
  ws: WebSocket,
  client: WebSocketClient,
  req: OpenClawRequest,
): Promise<void> {
  if (!client.authenticated) {
    sendError(ws, req.id, 401, 'Not authenticated');
    return;
  }

  const { status, limit = 50 } = req.params;

  try {
    const { getAllTasks } = await import('./db.js');
    const allTasks = getAllTasks();

    // Calculate status counts from full list before filtering
    const statusCounts = {
      active: allTasks.filter((t: any) => t.status === 'active').length,
      paused: allTasks.filter((t: any) => t.status === 'paused').length,
      completed: allTasks.filter((t: any) => t.status === 'completed').length,
      error: allTasks.filter((t: any) => t.status === 'error').length,
    };

    // Filter by status if provided
    let tasks = allTasks;
    if (status && typeof status === 'string') {
      tasks = tasks.filter((t: any) => t.status === status);
    }

    // Limit results
    const limitedTasks = tasks.slice(0, limit);

    sendResponse(
      ws,
      req.id,
      { ok: true },
      {
        tasks: limitedTasks.map((t: any) => ({
          id: t.id,
          name: t.prompt?.slice(0, 50) || 'Scheduled Task',
          prompt: t.prompt,
          group_folder: t.group_folder,
          schedule_type: t.schedule_type,
          schedule_value: t.schedule_value,
          next_run: t.next_run,
          last_run: t.last_run,
          status: t.status,
          task_type: t.task_type,
          workflow_id: t.workflow_id,
          created_at: t.created_at,
        })),
        total: allTasks.length,
        statusCounts,
      },
    );
  } catch (error) {
    logger.error({ error }, 'Failed to list scheduled tasks');
    sendError(
      ws,
      req.id,
      500,
      `Failed to list scheduled tasks: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

// ============ Goals Handlers ============

async function handleGoalsList(
  ws: WebSocket,
  client: WebSocketClient,
  req: OpenClawRequest,
): Promise<void> {
  if (!client.authenticated) {
    sendError(ws, req.id, 401, 'Not authenticated');
    return;
  }

  try {
    const goals = getAllGoals();
    sendResponse(ws, req.id, { ok: true }, { goals });
  } catch (error) {
    logger.error({ error }, 'Failed to list goals');
    sendError(
      ws,
      req.id,
      500,
      `Failed to list goals: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function handleGoalsGet(
  ws: WebSocket,
  client: WebSocketClient,
  req: OpenClawRequest,
): Promise<void> {
  if (!client.authenticated) {
    sendError(ws, req.id, 401, 'Not authenticated');
    return;
  }

  const { id } = req.params;
  if (!id) {
    sendError(ws, req.id, 400, 'Goal ID is required');
    return;
  }

  try {
    const goal = getGoalById(id);
    if (!goal) {
      sendError(ws, req.id, 404, 'Goal not found');
      return;
    }
    sendResponse(ws, req.id, { ok: true }, { goal });
  } catch (error) {
    logger.error({ error }, 'Failed to get goal');
    sendError(
      ws,
      req.id,
      500,
      `Failed to get goal: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function handleGoalsCreate(
  ws: WebSocket,
  client: WebSocketClient,
  req: OpenClawRequest,
): Promise<void> {
  if (!client.authenticated) {
    sendError(ws, req.id, 401, 'Not authenticated');
    return;
  }

  const { title, description, progress, target, deadline, type, status } =
    req.params;

  // Validate title
  if (!title || typeof title !== 'string' || title.trim().length === 0) {
    sendError(ws, req.id, 400, 'Goal title is required');
    return;
  }
  if (title.length > 200) {
    sendError(ws, req.id, 400, 'Goal title must be 200 characters or less');
    return;
  }

  // Validate progress
  const progressNum = Number(progress);
  if (
    progress !== undefined &&
    (isNaN(progressNum) || progressNum < 0 || progressNum > 10000)
  ) {
    sendError(ws, req.id, 400, 'Progress must be a number between 0 and 10000');
    return;
  }

  // Validate target
  const targetNum = Number(target);
  if (
    target !== undefined &&
    (isNaN(targetNum) || targetNum < 1 || targetNum > 10000)
  ) {
    sendError(ws, req.id, 400, 'Target must be a number between 1 and 10000');
    return;
  }

  // Validate type
  const validTypes = ['short', 'long'];
  if (type && !validTypes.includes(type)) {
    sendError(ws, req.id, 400, `Type must be one of: ${validTypes.join(', ')}`);
    return;
  }

  // Validate status
  const validStatuses = ['active', 'completed', 'archived'];
  if (status && !validStatuses.includes(status)) {
    sendError(
      ws,
      req.id,
      400,
      `Status must be one of: ${validStatuses.join(', ')}`,
    );
    return;
  }

  // Validate deadline format if provided
  if (deadline && isNaN(Date.parse(deadline))) {
    sendError(ws, req.id, 400, 'Deadline must be a valid date');
    return;
  }

  try {
    const goal = createGoal({
      title: title.trim(),
      description: description || null,
      progress: progressNum || 0,
      target: targetNum || 100,
      deadline: deadline || null,
      type: type || 'short',
      status: status || 'active',
    });
    broadcastEvent('goal.created', goal);
    sendResponse(ws, req.id, { ok: true }, { goal });
  } catch (error) {
    logger.error({ error }, 'Failed to create goal');
    sendError(
      ws,
      req.id,
      500,
      `Failed to create goal: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function handleGoalsUpdate(
  ws: WebSocket,
  client: WebSocketClient,
  req: OpenClawRequest,
): Promise<void> {
  if (!client.authenticated) {
    sendError(ws, req.id, 401, 'Not authenticated');
    return;
  }

  const { id, ...updates } = req.params;
  if (!id || typeof id !== 'string') {
    sendError(ws, req.id, 400, 'Goal ID is required');
    return;
  }

  // Validate progress if provided
  if (updates.progress !== undefined) {
    const progressNum = Number(updates.progress);
    if (isNaN(progressNum) || progressNum < 0 || progressNum > 10000) {
      sendError(
        ws,
        req.id,
        400,
        'Progress must be a number between 0 and 10000',
      );
      return;
    }
    updates.progress = progressNum;
  }

  // Validate target if provided
  if (updates.target !== undefined) {
    const targetNum = Number(updates.target);
    if (isNaN(targetNum) || targetNum < 1 || targetNum > 10000) {
      sendError(ws, req.id, 400, 'Target must be a number between 1 and 10000');
      return;
    }
    updates.target = targetNum;
  }

  // Validate type if provided
  const validTypes = ['short', 'long'];
  if (updates.type && !validTypes.includes(updates.type)) {
    sendError(ws, req.id, 400, `Type must be one of: ${validTypes.join(', ')}`);
    return;
  }

  // Validate status if provided
  const validStatuses = ['active', 'completed', 'archived'];
  if (updates.status && !validStatuses.includes(updates.status)) {
    sendError(
      ws,
      req.id,
      400,
      `Status must be one of: ${validStatuses.join(', ')}`,
    );
    return;
  }

  // Validate deadline if provided
  if (updates.deadline !== undefined && updates.deadline !== null) {
    if (isNaN(Date.parse(updates.deadline))) {
      sendError(ws, req.id, 400, 'Deadline must be a valid date');
      return;
    }
  }

  try {
    const goal = updateGoal(id, updates);
    if (!goal) {
      sendError(ws, req.id, 404, 'Goal not found');
      return;
    }
    broadcastEvent('goal.updated', goal);
    sendResponse(ws, req.id, { ok: true }, { goal });
  } catch (error) {
    logger.error({ error }, 'Failed to update goal');
    sendError(
      ws,
      req.id,
      500,
      `Failed to update goal: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function handleGoalsDelete(
  ws: WebSocket,
  client: WebSocketClient,
  req: OpenClawRequest,
): Promise<void> {
  if (!client.authenticated) {
    sendError(ws, req.id, 401, 'Not authenticated');
    return;
  }

  const { id } = req.params;
  if (!id) {
    sendError(ws, req.id, 400, 'Goal ID is required');
    return;
  }

  try {
    const deleted = deleteGoal(id);
    if (!deleted) {
      sendError(ws, req.id, 404, 'Goal not found');
      return;
    }
    broadcastEvent('goal.deleted', { id });
    sendResponse(ws, req.id, { ok: true }, { deleted: true });
  } catch (error) {
    logger.error({ error }, 'Failed to delete goal');
    sendError(
      ws,
      req.id,
      500,
      `Failed to delete goal: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

// ============ Dashboard Handlers ============

async function handleDashboardStats(
  ws: WebSocket,
  client: WebSocketClient,
  req: OpenClawRequest,
): Promise<void> {
  if (!client.authenticated) {
    sendError(ws, req.id, 401, 'Not authenticated');
    return;
  }

  try {
    const { getAllTasks, getDatabaseStats: getDbStats } =
      await import('./db.js');
    const { getContainerStats } = await import('./container-pool.js');

    // Get agent stats
    const agentsMap = getAllRegisteredGroups();
    const agents = Object.values(agentsMap);
    const activeAgents = agents.filter(
      (a: any) => a.status === 'active',
    ).length;

    // Get scheduled task stats
    const tasks = getAllTasks();
    const activeTasks = tasks.filter((t: any) => t.status === 'active').length;

    // Get session stats (unique groups with activity today)
    const today = new Date().toISOString().split('T')[0];
    const dbStats = getDbStats();

    // Get container pool stats
    let containerStats = { active: 0, total: 0 };
    try {
      const poolStats = getContainerStats();
      containerStats = {
        active: poolStats.totalContainers,
        total: poolStats.totalContainers,
      };
    } catch {
      // Container pool may not be initialized
    }

    // Calculate uptime
    const uptimeSeconds = Math.floor(process.uptime());
    const uptimeFormatted = formatUptime(uptimeSeconds);

    sendResponse(
      ws,
      req.id,
      { ok: true },
      {
        agents: {
          total: agents.length,
          active: activeAgents,
        },
        tasks: {
          total: tasks.length,
          active: activeTasks,
        },
        containers: containerStats,
        database: {
          sizeBytes: dbStats.pageSize * dbStats.pageCount,
          readCount: dbStats.readCount,
          writeCount: dbStats.writeCount,
        },
        system: {
          uptime: uptimeFormatted,
          uptimeSeconds,
          nodeVersion: process.version,
          platform: process.platform,
          memoryUsage: {
            heapUsed: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
            heapTotal: Math.round(
              process.memoryUsage().heapTotal / 1024 / 1024,
            ),
            rss: Math.round(process.memoryUsage().rss / 1024 / 1024),
          },
        },
        timestamp: new Date().toISOString(),
      },
    );
  } catch (error) {
    logger.error({ error }, 'Failed to get dashboard stats');
    sendError(
      ws,
      req.id,
      500,
      `Failed to get dashboard stats: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const mins = Math.floor((seconds % 3600) / 60);

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (mins > 0 || parts.length === 0) parts.push(`${mins}m`);

  return parts.join(' ');
}

async function handleTaskActive(
  ws: WebSocket,
  client: WebSocketClient,
  req: OpenClawRequest,
): Promise<void> {
  if (!client.authenticated) {
    sendError(ws, req.id, 401, 'Not authenticated');
    return;
  }

  // Get only running and pending tasks
  const activeTasks = Array.from(backgroundTasks.values()).filter(
    (t) => t.status === 'running' || t.status === 'pending',
  );

  // Sort by createdAt descending
  activeTasks.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

  sendResponse(
    ws,
    req.id,
    { ok: true },
    {
      tasks: activeTasks.map((t) => ({
        ...t,
        createdAt: t.createdAt.toISOString(),
        startedAt: t.startedAt?.toISOString(),
        completedAt: t.completedAt?.toISOString(),
      })),
      total: activeTasks.length,
    },
  );
}

async function handleTaskCancel(
  ws: WebSocket,
  client: WebSocketClient,
  req: OpenClawRequest,
): Promise<void> {
  if (!client.authenticated) {
    sendError(ws, req.id, 401, 'Not authenticated');
    return;
  }

  const { taskId } = req.params;

  if (!taskId) {
    sendError(ws, req.id, 400, 'taskId is required');
    return;
  }

  const task = backgroundTasks.get(taskId);
  if (!task) {
    sendError(ws, req.id, 404, 'Task not found');
    return;
  }

  if (task.status !== 'pending' && task.status !== 'running') {
    sendError(
      ws,
      req.id,
      400,
      `Cannot cancel task with status: ${task.status}`,
    );
    return;
  }

  task.status = 'cancelled';
  task.completedAt = new Date();
  task.progressMessage = 'Cancelled by user';
  updateTask(task);

  logger.info({ taskId }, 'Task cancelled');

  sendResponse(
    ws,
    req.id,
    { ok: true },
    {
      taskId,
      status: task.status,
      message: 'Task cancelled',
    },
  );
}

async function handleAgentLogs(
  ws: WebSocket,
  client: WebSocketClient,
  req: OpenClawRequest,
): Promise<void> {
  if (!client.authenticated) {
    sendError(ws, req.id, 401, 'Not authenticated');
    return;
  }

  const { agentFolder, lines = 200, containerId } = req.params;

  if (!agentFolder) {
    sendError(ws, req.id, 400, 'agentFolder is required');
    return;
  }

  // Security check: verify this is a valid agent folder
  // IMPORTANT: Use getRegisteredGroupByFolder, not getRegisteredGroup with constructed JID
  // because main agent uses Telegram JID (tg:...) not @nanoclaw.local
  const group = getRegisteredGroupByFolder(agentFolder);
  if (!group) {
    sendError(ws, req.id, 404, `Agent ${agentFolder} not found`);
    return;
  }

  try {
    const { exec } = await import('child_process');

    // If a specific container ID is provided, use it; otherwise find by name pattern
    let targetContainer = containerId;

    if (!targetContainer) {
      // Find container by name pattern
      const containerName = await new Promise<string | null>((resolve) => {
        exec(
          `docker ps -a --format "{{.Names}}" --filter "name=nanoclaw-${agentFolder}-"`,
          (err, stdout) => {
            if (err || !stdout.trim()) {
              resolve(null);
              return;
            }
            const names = stdout
              .trim()
              .split('\n')
              .filter((n) => n);
            // Return the most recent (last) container
            resolve(names.length > 0 ? names[names.length - 1] : null);
          },
        );
      });

      if (!containerName) {
        sendResponse(
          ws,
          req.id,
          { ok: true },
          {
            agentFolder,
            logs: [],
            message: 'No container found for this agent',
            hasContainer: false,
          },
        );
        return;
      }
      targetContainer = containerName;
    }

    // Get container status
    const containerStatus = await new Promise<string>((resolve) => {
      exec(
        `docker inspect -f '{{.State.Status}}' ${targetContainer}`,
        (err, stdout) => {
          if (err) {
            resolve('unknown');
          } else {
            resolve(stdout.trim() || 'unknown');
          }
        },
      );
    });

    // Get logs from Docker
    const logs = await new Promise<string>((resolve, reject) => {
      exec(
        `docker logs --tail ${lines} ${targetContainer} 2>&1`,
        (err, stdout, stderr) => {
          if (err && !stdout) {
            reject(new Error(`Failed to get logs: ${err.message}`));
            return;
          }
          resolve(stdout || stderr || '');
        },
      );
    });

    // Parse logs into structured format
    const logLines = logs
      .split('\n')
      .filter((line) => line.trim())
      .map((line, index) => {
        // Try to parse timestamp from common log formats
        let timestamp: string | null = null;
        let level = 'info';
        let message = line;

        // Check for ISO timestamp at start
        const isoMatch = line.match(
          /^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)\s*(.*)/,
        );
        if (isoMatch) {
          timestamp = isoMatch[1];
          message = isoMatch[2];
        }

        // Detect log level from content
        const lowerLine = line.toLowerCase();
        if (
          lowerLine.includes('error') ||
          lowerLine.includes('err') ||
          lowerLine.includes('fail')
        ) {
          level = 'error';
        } else if (
          lowerLine.includes('warn') ||
          lowerLine.includes('warning')
        ) {
          level = 'warn';
        } else if (lowerLine.includes('debug')) {
          level = 'debug';
        }

        return {
          index,
          timestamp,
          level,
          message: message.slice(0, 5000), // Limit message length
          raw: line.slice(0, 5000),
        };
      });

    logger.info(
      {
        agentFolder,
        containerName: targetContainer,
        linesReturned: logLines.length,
      },
      'Agent logs retrieved',
    );

    sendResponse(
      ws,
      req.id,
      { ok: true },
      {
        agentFolder,
        containerName: targetContainer,
        containerStatus,
        logs: logLines,
        totalLines: logLines.length,
        hasContainer: true,
      },
    );
  } catch (error) {
    logger.error({ agentFolder, error }, 'Failed to get agent logs');
    sendError(
      ws,
      req.id,
      500,
      `Failed to get logs: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Handle agents.list RPC - list all registered agents with status
 */
async function handleAgentsList(
  ws: WebSocket,
  client: WebSocketClient,
  req: OpenClawRequest,
): Promise<void> {
  if (!client.authenticated) {
    sendError(ws, req.id, 401, 'Not authenticated');
    return;
  }

  try {
    const groups = getAllRegisteredGroups();
    const agents: Array<{
      id: string;
      name: string;
      role: string;
      status: 'active' | 'idle' | 'offline';
      model?: string;
      runningTask?: string;
    }> = [];

    for (const [jid, group] of Object.entries(groups)) {
      // Extract folder name from JID
      const folder = group.folder;
      const isMain = folder === MAIN_GROUP_FOLDER;

      // Determine status based on recent activity
      // Check if there's a running container for this agent
      let status: 'active' | 'idle' | 'offline' = 'offline';
      let runningTask: string | undefined;

      try {
        const { exec } = await import('child_process');
        const containerInfo = await new Promise<{
          running: boolean;
          name?: string;
        }>((resolve) => {
          exec(
            `docker ps --format "{{.Names}}" --filter "name=nanoclaw-${folder}-"`,
            (err, stdout) => {
              if (err || !stdout.trim()) {
                resolve({ running: false });
                return;
              }
              const names = stdout
                .trim()
                .split('\n')
                .filter((n) => n);
              resolve({ running: names.length > 0, name: names[0] });
            },
          );
        });

        if (containerInfo.running) {
          status = 'active';
          runningTask = 'Running task';
        } else {
          // Check for recent activity in chat history
          const recentActivity = await new Promise<boolean>((resolve) => {
            exec(
              `docker ps -a --format "{{.Names}}" --filter "name=nanoclaw-${folder}-" | head -1`,
              (err, stdout) => {
                resolve(!err && stdout.trim().length > 0);
              },
            );
          });

          status = recentActivity ? 'idle' : 'offline';
        }
      } catch {
        status = 'idle';
      }

      // Get agent name from display_name (if set) or folder (capitalize first letter)
      const name =
        group.displayName || folder.charAt(0).toUpperCase() + folder.slice(1);

      // Determine role based on folder name
      let role = 'Agent';
      if (isMain) {
        role = 'Primary Orchestrator';
      } else if (folder.includes('dev') || folder.includes('nalu')) {
        role = 'Dev & Infrastructure';
      } else if (folder.includes('content') || folder.includes('maui')) {
        role = 'Content & Social';
      } else if (folder.includes('research') || folder.includes('kai')) {
        role = 'Research & Analysis';
      } else if (folder.includes('support') || folder.includes('lani')) {
        role = 'Customer Support';
      } else if (folder.includes('data') || folder.includes('hoku')) {
        role = 'Data & Analytics';
      }

      agents.push({
        id: folder,
        name,
        role,
        status,
        model: 'Claude',
        runningTask,
      });
    }

    // Sort: active first, then idle, then offline; main always first
    agents.sort((a, b) => {
      if (a.id === 'main') return -1;
      if (b.id === 'main') return 1;

      const statusOrder = { active: 0, idle: 1, offline: 2 };
      const statusDiff = statusOrder[a.status] - statusOrder[b.status];
      if (statusDiff !== 0) return statusDiff;

      return a.name.localeCompare(b.name);
    });

    sendResponse(ws, req.id, { ok: true }, { agents, total: agents.length });
  } catch (error) {
    logger.error({ error }, 'Failed to list agents');
    sendError(
      ws,
      req.id,
      500,
      `Failed to list agents: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

// ============ Metrics Handler ============

// Simple in-memory metrics store
const metricsHistory: Array<{
  timestamp: string;
  memoryUsage: { heapUsed: number; heapTotal: number; rss: number };
  uptime: number;
  containerCount: number;
  clientCount: number;
  taskCount: number;
}> = [];

const MAX_METRICS_HISTORY = 100; // Keep last 100 data points

async function handleMetricsGet(
  ws: WebSocket,
  client: WebSocketClient,
  req: OpenClawRequest,
): Promise<void> {
  if (!client.authenticated) {
    sendError(ws, req.id, 401, 'Not authenticated');
    return;
  }

  try {
    const { getAllTasks } = await import('./db.js');
    const { getContainerStats } = await import('./container-pool.js');

    // Current metrics
    const mem = process.memoryUsage();
    const currentMetrics = {
      timestamp: new Date().toISOString(),
      memoryUsage: {
        heapUsed: Math.round(mem.heapUsed / 1024 / 1024),
        heapTotal: Math.round(mem.heapTotal / 1024 / 1024),
        rss: Math.round(mem.rss / 1024 / 1024),
      },
      uptime: Math.floor(process.uptime()),
      containerCount: getContainerStats().totalContainers,
      clientCount: clients.size,
      taskCount: getAllTasks().filter((t: any) => t.status === 'active').length,
    };

    // Add to history
    metricsHistory.push(currentMetrics);
    if (metricsHistory.length > MAX_METRICS_HISTORY) {
      metricsHistory.shift();
    }

    // Calculate trends
    const recentHistory = metricsHistory.slice(-10);
    const avgMemory =
      recentHistory.length > 0
        ? Math.round(
            recentHistory.reduce((sum, m) => sum + m.memoryUsage.heapUsed, 0) /
              recentHistory.length,
          )
        : currentMetrics.memoryUsage.heapUsed;

    const memoryTrend =
      recentHistory.length >= 2
        ? recentHistory[recentHistory.length - 1].memoryUsage.heapUsed -
          recentHistory[0].memoryUsage.heapUsed
        : 0;

    sendResponse(
      ws,
      req.id,
      { ok: true },
      {
        current: currentMetrics,
        history: metricsHistory.slice(-20), // Return last 20 data points
        trends: {
          avgMemoryMB: avgMemory,
          memoryTrendMB: memoryTrend,
          memoryTrendDirection:
            memoryTrend > 10 ? 'up' : memoryTrend < -10 ? 'down' : 'stable',
        },
        summary: {
          totalDataPoints: metricsHistory.length,
          maxMemoryMB: Math.max(
            ...metricsHistory.map((m) => m.memoryUsage.heapUsed),
          ),
          minMemoryMB: Math.min(
            ...metricsHistory.map((m) => m.memoryUsage.heapUsed),
          ),
        },
      },
    );
  } catch (error) {
    logger.error({ error }, 'Failed to get metrics');
    sendError(
      ws,
      req.id,
      500,
      `Failed to get metrics: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Handle projects.discover RPC - discover deployable projects
 */
async function handleProjectsDiscover(
  ws: WebSocket,
  client: WebSocketClient,
  req: OpenClawRequest,
): Promise<void> {
  if (!client.authenticated) {
    sendError(ws, req.id, 401, 'Not authenticated');
    return;
  }

  try {
    const { discoverProjects } = await import('./project-manager.js');
    const projects = discoverProjects();

    sendResponse(
      ws,
      req.id,
      { ok: true },
      {
        projects: projects.map((p) => ({
          name: p.name,
          path: p.path,
          hasPackageJson: p.hasPackageJson,
          suggestedCommand: p.suggestedCommand,
          suggestedPort: p.suggestedPort,
        })),
      },
    );
  } catch (error) {
    logger.error({ error }, 'Failed to discover projects');
    sendError(ws, req.id, 500, 'Failed to discover projects');
  }
}

/**
 * Handle projects.list RPC - list running projects
 */
async function handleProjectsList(
  ws: WebSocket,
  client: WebSocketClient,
  req: OpenClawRequest,
): Promise<void> {
  if (!client.authenticated) {
    sendError(ws, req.id, 401, 'Not authenticated');
    return;
  }

  try {
    const { getRunningProjects } = await import('./project-manager.js');
    const projects = getRunningProjects();

    sendResponse(
      ws,
      req.id,
      { ok: true },
      {
        projects: projects.map((p) => ({
          id: p.id,
          name: p.name,
          path: p.path,
          port: p.port,
          pid: p.pid,
          status: p.status,
          startedAt: p.startedAt,
          command: p.command,
          error: p.error,
        })),
      },
    );
  } catch (error) {
    logger.error({ error }, 'Failed to list projects');
    sendError(ws, req.id, 500, 'Failed to list projects');
  }
}

/**
 * Handle projects.start RPC - start a project
 */
async function handleProjectsStart(
  ws: WebSocket,
  client: WebSocketClient,
  req: OpenClawRequest,
): Promise<void> {
  if (!client.authenticated) {
    sendError(ws, req.id, 401, 'Not authenticated');
    return;
  }

  const { projectPath, command, port, name } = req.params;

  if (!projectPath || !command || !port) {
    sendError(ws, req.id, 400, 'projectPath, command, and port are required');
    return;
  }

  // Validate port
  const portNum = parseInt(port, 10);
  if (isNaN(portNum) || portNum < 1024 || portNum > 65535) {
    sendError(ws, req.id, 400, 'Invalid port (must be 1024-65535)');
    return;
  }

  try {
    const { startProject, isProjectStartError } =
      await import('./project-manager.js');
    const result = startProject(projectPath, command, portNum, name);

    // Check if it's an error response
    if (isProjectStartError(result)) {
      sendError(ws, req.id, 400, result.error);
      return;
    }

    const project = result;

    sendResponse(
      ws,
      req.id,
      { ok: true },
      {
        project: {
          id: project.id,
          name: project.name,
          path: project.path,
          port: project.port,
          status: project.status,
          startedAt: project.startedAt,
          command: project.command,
        },
      },
    );

    // Broadcast event
    broadcastEvent('project.started', {
      id: project.id,
      name: project.name,
      port: project.port,
    });
  } catch (error) {
    logger.error(
      { error, projectPath, command, port },
      'Failed to start project',
    );
    sendError(ws, req.id, 500, 'Failed to start project');
  }
}

/**
 * Handle projects.stop RPC - stop a project
 */
async function handleProjectsStop(
  ws: WebSocket,
  client: WebSocketClient,
  req: OpenClawRequest,
): Promise<void> {
  if (!client.authenticated) {
    sendError(ws, req.id, 401, 'Not authenticated');
    return;
  }

  const { projectId } = req.params;

  if (!projectId) {
    sendError(ws, req.id, 400, 'projectId is required');
    return;
  }

  try {
    const { stopProject, getProject } = await import('./project-manager.js');
    const project = getProject(projectId);

    if (!project) {
      sendError(ws, req.id, 404, 'Project not found');
      return;
    }

    const result = stopProject(projectId);

    if (!result.success) {
      sendError(ws, req.id, 400, result.error || 'Failed to stop project');
      return;
    }

    sendResponse(
      ws,
      req.id,
      { ok: true },
      {
        success: true,
        projectId,
      },
    );

    // Broadcast event
    broadcastEvent('project.stopped', { id: projectId, name: project.name });
  } catch (error) {
    logger.error({ error, projectId }, 'Failed to stop project');
    sendError(ws, req.id, 500, 'Failed to stop project');
  }
}

/**
 * Handle projects.logs RPC - get project logs
 */
async function handleProjectsLogs(
  ws: WebSocket,
  client: WebSocketClient,
  req: OpenClawRequest,
): Promise<void> {
  if (!client.authenticated) {
    sendError(ws, req.id, 401, 'Not authenticated');
    return;
  }

  const { projectId, lines = 50 } = req.params;

  if (!projectId) {
    sendError(ws, req.id, 400, 'projectId is required');
    return;
  }

  try {
    const { getProjectLogs, getProject } = await import('./project-manager.js');
    const project = getProject(projectId);

    if (!project) {
      sendError(ws, req.id, 404, 'Project not found');
      return;
    }

    const logs = getProjectLogs(projectId, lines);

    sendResponse(
      ws,
      req.id,
      { ok: true },
      {
        projectId,
        logs,
        total: logs.length,
      },
    );
  } catch (error) {
    logger.error({ error, projectId }, 'Failed to get project logs');
    sendError(ws, req.id, 500, 'Failed to get project logs');
  }
}

/**
 * Handle projects.delete RPC - delete a stopped project from memory
 */
async function handleProjectsDelete(
  ws: WebSocket,
  client: WebSocketClient,
  req: OpenClawRequest,
): Promise<void> {
  if (!client.authenticated) {
    sendError(ws, req.id, 401, 'Not authenticated');
    return;
  }

  const { projectId } = req.params;

  if (!projectId) {
    sendError(ws, req.id, 400, 'projectId is required');
    return;
  }

  try {
    const { deleteProject } = await import('./project-manager.js');
    const result = deleteProject(projectId);

    if (!result.success) {
      sendError(ws, req.id, 400, result.error || 'Failed to delete project');
      return;
    }

    sendResponse(
      ws,
      req.id,
      { ok: true },
      {
        success: true,
        projectId,
      },
    );
  } catch (error) {
    logger.error({ error, projectId }, 'Failed to delete project');
    sendError(ws, req.id, 500, 'Failed to delete project');
  }
}

/**
 * Register a Telegram-triggered processing task in backgroundTasks so the
 * webOS task.list shows the agent as active while it processes a Telegram message.
 * Returns the taskId for cleanup via completeTelegramTask.
 */
export function registerTelegramTask(
  agentFolder: string,
  taskName: string,
): string {
  const taskId = `tg-${agentFolder}-${Date.now()}`;
  const task: BackgroundTask = {
    id: taskId,
    name: taskName,
    description: 'Processing Telegram message',
    agentFolder,
    status: 'running',
    createdAt: new Date(),
    startedAt: new Date(),
    notifyOnComplete: false,
  };
  backgroundTasks.set(taskId, task);
  broadcastEvent('task.updated', task);
  return taskId;
}

/**
 * Mark a Telegram processing task as completed and clean it up.
 */
export function completeTelegramTask(taskId: string): void {
  const task = backgroundTasks.get(taskId);
  if (!task) return;
  task.status = 'completed';
  task.completedAt = new Date();
  backgroundTasks.set(taskId, task);
  broadcastEvent('task.updated', task);
  // Auto-cleanup after 30s so old entries don't accumulate
  // unref() so this timer doesn't prevent graceful process shutdown
  const cleanupTimer = setTimeout(() => backgroundTasks.delete(taskId), 30000);
  cleanupTimer.unref();
}

// Export function to broadcast events to all clients
export function broadcastEvent(event: string, payload: any): void {
  const evt: OpenClawEvent = {
    type: 'event',
    event,
    payload,
  };

  clients.forEach((client) => {
    if (client.authenticated && client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(JSON.stringify(evt));
    }
  });
}

export function stopWebSocketServer(): void {
  if (bgTaskWatcherInterval) {
    clearInterval(bgTaskWatcherInterval);
    bgTaskWatcherInterval = null;
  }
  if (wss) {
    wss.close();
    wss = null;
    clients.clear();
    sendMessageToExternal = null;
    logger.info('WebSocket server stopped');
  }
  if (kanbanDb) {
    kanbanDb.close();
    kanbanDb = null;
  }
}

// ============ Kanban Integration ============

let kanbanDb: Database.Database | null = null;

function getKanbanDb(): Database.Database | null {
  if (kanbanDb) return kanbanDb;
  try {
    if (!fs.existsSync(KANBAN_DB_PATH)) {
      logger.debug({ path: KANBAN_DB_PATH }, 'Kanban database not found');
      return null;
    }
    kanbanDb = new Database(KANBAN_DB_PATH);
    kanbanDb.pragma('journal_mode = WAL');
    kanbanDb.pragma('foreign_keys = ON');
    return kanbanDb;
  } catch (error) {
    logger.error(
      { error, path: KANBAN_DB_PATH },
      'Failed to open kanban database',
    );
    return null;
  }
}

interface KanbanWorkspace {
  boards: KanbanBoard[];
  currentBoardId: string | null;
}

interface KanbanBoard {
  id: string;
  title: string;
  description: string;
  isStarred: boolean;
  createdAt: number;
  columns: KanbanColumn[];
  labels: KanbanLabel[];
  members: KanbanMember[];
  archivedCards: KanbanCard[];
}

interface KanbanColumn {
  id: string;
  title: string;
  position: number;
  createdAt: number;
  cards: KanbanCard[];
  limit?: number;
}

interface KanbanCard {
  id: string;
  title: string;
  description: string;
  priority: 'low' | 'medium' | 'high';
  tags: string[];
  dueDate: string | null;
  labels: string[];
  members: string[];
  position: number;
  isArchived: boolean;
  createdAt: number;
  updatedAt?: number;
  activities?: KanbanActivity[];
  checklists?: KanbanChecklist[];
  comments?: KanbanComment[];
  cover?: string;
}

interface KanbanActivity {
  id: string;
  type: 'create' | 'update' | 'move' | 'comment';
  description: string;
  createdAt: number;
}

interface KanbanChecklist {
  id: string;
  title: string;
  items: KanbanChecklistItem[];
}

interface KanbanChecklistItem {
  id: string;
  text: string;
  checked: boolean;
}

interface KanbanComment {
  id: string;
  text: string;
  author: string;
  createdAt: number;
}

interface KanbanLabel {
  id: string;
  name: string;
  color: string;
}

interface KanbanMember {
  id: string;
  name: string;
  initials: string;
  color: string;
}

function parseJSON(val: string | null): any[] {
  if (!val) return [];
  try {
    return JSON.parse(val);
  } catch {
    return [];
  }
}

function buildKanbanWorkspace(db: Database.Database): KanbanWorkspace {
  const boards = db
    .prepare('SELECT * FROM boards ORDER BY created_at ASC')
    .all() as any[];
  const columns = db
    .prepare('SELECT * FROM columns ORDER BY position ASC')
    .all() as any[];
  const cards = db
    .prepare('SELECT * FROM cards ORDER BY position ASC')
    .all() as any[];
  const labels = db.prepare('SELECT * FROM labels').all() as any[];
  const members = db.prepare('SELECT * FROM members').all() as any[];

  const boardMap: Record<string, KanbanBoard> = {};
  for (const b of boards) {
    boardMap[b.id] = {
      id: b.id,
      title: b.title,
      description: b.description || '',
      isStarred: b.is_starred === 1,
      createdAt: b.created_at,
      columns: [],
      labels: [],
      members: [],
      archivedCards: [],
    };
  }

  // Attach labels and members
  for (const l of labels) {
    if (boardMap[l.board_id]) {
      boardMap[l.board_id].labels.push({
        id: l.id,
        name: l.name,
        color: l.color,
      });
    }
  }
  for (const m of members) {
    if (boardMap[m.board_id]) {
      boardMap[m.board_id].members.push({
        id: m.id,
        name: m.name,
        initials: m.initials,
        color: m.color,
      });
    }
  }

  // Attach columns
  const colMap: Record<string, { obj: KanbanColumn; boardId: string }> = {};
  for (const col of columns) {
    const colObj: KanbanColumn = {
      id: col.id,
      title: col.title,
      position: col.position,
      createdAt: col.created_at,
      cards: [],
      limit: col.limit,
    };
    colMap[col.id] = { obj: colObj, boardId: col.board_id };
    if (boardMap[col.board_id]) {
      boardMap[col.board_id].columns.push(colObj);
    }
  }

  // Attach cards
  for (const card of cards) {
    const cardObj: KanbanCard = {
      id: card.id,
      title: card.title,
      description: card.description || '',
      priority: card.priority || 'medium',
      tags: parseJSON(card.tags),
      dueDate: card.due_date || null,
      labels: parseJSON(card.labels),
      members: parseJSON(card.members),
      position: card.position,
      isArchived: card.archived === 1,
      createdAt: card.created_at,
      updatedAt: card.updated_at,
      activities: parseJSON(card.activities),
      checklists: parseJSON(card.checklists),
      comments: parseJSON(card.comments),
      cover: card.cover,
    };
    if (card.archived === 1) {
      const col = colMap[card.column_id];
      if (col && boardMap[col.boardId]) {
        boardMap[col.boardId].archivedCards.push(cardObj);
      }
    } else {
      if (colMap[card.column_id]) {
        colMap[card.column_id].obj.cards.push(cardObj);
      }
    }
  }

  const boardList = Object.values(boardMap);
  return {
    boards: boardList,
    currentBoardId: boardList[0]?.id || null,
  };
}

async function handleKanbanWorkspace(
  ws: WebSocket,
  client: WebSocketClient,
  req: OpenClawRequest,
): Promise<void> {
  if (!client.authenticated) {
    sendError(ws, req.id, 401, 'Not authenticated');
    return;
  }

  const db = getKanbanDb();
  if (!db) {
    sendError(ws, req.id, 503, 'Kanban database not available');
    return;
  }

  try {
    const workspace = buildKanbanWorkspace(db);
    sendResponse(ws, req.id, { ok: true }, workspace);
  } catch (error) {
    logger.error({ error }, 'Failed to get kanban workspace');
    sendError(ws, req.id, 500, 'Failed to get kanban workspace');
  }
}

async function handleKanbanCreateBoard(
  ws: WebSocket,
  client: WebSocketClient,
  req: OpenClawRequest,
): Promise<void> {
  if (!client.authenticated) {
    sendError(ws, req.id, 401, 'Not authenticated');
    return;
  }

  const db = getKanbanDb();
  if (!db) {
    sendError(ws, req.id, 503, 'Kanban database not available');
    return;
  }

  const { title, description } = req.params;
  if (!title) {
    sendError(ws, req.id, 400, 'title is required');
    return;
  }

  try {
    const id = `board-${randomUUID().slice(0, 8)}`;
    const now = Date.now();

    db.prepare(
      `
      INSERT INTO boards (id, title, description, is_starred, created_at)
      VALUES (?, ?, ?, 0, ?)
    `,
    ).run(id, title, description || null, now);

    const workspace = buildKanbanWorkspace(db);
    broadcastEvent('kanban.updated', workspace);
    sendResponse(
      ws,
      req.id,
      { ok: true },
      { board: workspace.boards.find((b) => b.id === id), workspace },
    );
  } catch (error) {
    logger.error({ error }, 'Failed to create kanban board');
    sendError(ws, req.id, 500, 'Failed to create board');
  }
}

async function handleKanbanUpdateBoard(
  ws: WebSocket,
  client: WebSocketClient,
  req: OpenClawRequest,
): Promise<void> {
  if (!client.authenticated) {
    sendError(ws, req.id, 401, 'Not authenticated');
    return;
  }

  const db = getKanbanDb();
  if (!db) {
    sendError(ws, req.id, 503, 'Kanban database not available');
    return;
  }

  const { id, title, description, isStarred } = req.params;
  if (!id) {
    sendError(ws, req.id, 400, 'id is required');
    return;
  }

  try {
    const board = db
      .prepare('SELECT * FROM boards WHERE id = ?')
      .get(id) as any;
    if (!board) {
      sendError(ws, req.id, 404, 'Board not found');
      return;
    }

    const newTitle = title ?? board.title;
    const newDesc = description ?? board.description;
    const newStarred =
      isStarred !== undefined ? (isStarred ? 1 : 0) : board.is_starred;

    db.prepare(
      'UPDATE boards SET title = ?, description = ?, is_starred = ? WHERE id = ?',
    ).run(newTitle, newDesc, newStarred, id);

    const workspace = buildKanbanWorkspace(db);
    broadcastEvent('kanban.updated', workspace);
    sendResponse(ws, req.id, { ok: true }, { workspace });
  } catch (error) {
    logger.error({ error }, 'Failed to update kanban board');
    sendError(ws, req.id, 500, 'Failed to update board');
  }
}

async function handleKanbanDeleteBoard(
  ws: WebSocket,
  client: WebSocketClient,
  req: OpenClawRequest,
): Promise<void> {
  if (!client.authenticated) {
    sendError(ws, req.id, 401, 'Not authenticated');
    return;
  }

  const db = getKanbanDb();
  if (!db) {
    sendError(ws, req.id, 503, 'Kanban database not available');
    return;
  }

  const { id } = req.params;
  if (!id) {
    sendError(ws, req.id, 400, 'id is required');
    return;
  }

  try {
    // Delete board cascades to columns, cards, labels, members
    db.prepare('DELETE FROM boards WHERE id = ?').run(id);

    const workspace = buildKanbanWorkspace(db);
    broadcastEvent('kanban.updated', workspace);
    sendResponse(ws, req.id, { ok: true }, { deleted: true, workspace });
  } catch (error) {
    logger.error({ error }, 'Failed to delete kanban board');
    sendError(ws, req.id, 500, 'Failed to delete board');
  }
}

async function handleKanbanCreateColumn(
  ws: WebSocket,
  client: WebSocketClient,
  req: OpenClawRequest,
): Promise<void> {
  if (!client.authenticated) {
    sendError(ws, req.id, 401, 'Not authenticated');
    return;
  }

  const db = getKanbanDb();
  if (!db) {
    sendError(ws, req.id, 503, 'Kanban database not available');
    return;
  }

  const { boardId, title, limit } = req.params;
  if (!boardId || !title) {
    sendError(ws, req.id, 400, 'boardId and title are required');
    return;
  }

  try {
    const maxPos = db
      .prepare('SELECT MAX(position) as m FROM columns WHERE board_id = ?')
      .get(boardId) as any;
    const position = (maxPos?.m ?? -1) + 1;

    const id = `col-${randomUUID().slice(0, 8)}`;
    const now = Date.now();

    db.prepare(
      `
      INSERT INTO columns (id, board_id, title, position, limit, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `,
    ).run(id, boardId, title, position, limit ?? null, now);

    const workspace = buildKanbanWorkspace(db);
    broadcastEvent('kanban.updated', workspace);
    sendResponse(ws, req.id, { ok: true }, { columnId: id, workspace });
  } catch (error) {
    logger.error({ error }, 'Failed to create kanban column');
    sendError(ws, req.id, 500, 'Failed to create column');
  }
}

async function handleKanbanUpdateColumn(
  ws: WebSocket,
  client: WebSocketClient,
  req: OpenClawRequest,
): Promise<void> {
  if (!client.authenticated) {
    sendError(ws, req.id, 401, 'Not authenticated');
    return;
  }

  const db = getKanbanDb();
  if (!db) {
    sendError(ws, req.id, 503, 'Kanban database not available');
    return;
  }

  const { id, title, position, limit } = req.params;
  if (!id) {
    sendError(ws, req.id, 400, 'id is required');
    return;
  }

  try {
    const fields: string[] = [];
    const values: any[] = [];

    if (title !== undefined) {
      fields.push('title = ?');
      values.push(title);
    }
    if (position !== undefined) {
      fields.push('position = ?');
      values.push(position);
    }
    if (limit !== undefined) {
      fields.push('limit = ?');
      values.push(limit);
    }

    if (fields.length === 0) {
      sendError(ws, req.id, 400, 'No fields to update');
      return;
    }

    values.push(id);
    db.prepare(`UPDATE columns SET ${fields.join(', ')} WHERE id = ?`).run(
      ...values,
    );

    const workspace = buildKanbanWorkspace(db);
    broadcastEvent('kanban.updated', workspace);
    sendResponse(ws, req.id, { ok: true }, { workspace });
  } catch (error) {
    logger.error({ error }, 'Failed to update kanban column');
    sendError(ws, req.id, 500, 'Failed to update column');
  }
}

async function handleKanbanDeleteColumn(
  ws: WebSocket,
  client: WebSocketClient,
  req: OpenClawRequest,
): Promise<void> {
  if (!client.authenticated) {
    sendError(ws, req.id, 401, 'Not authenticated');
    return;
  }

  const db = getKanbanDb();
  if (!db) {
    sendError(ws, req.id, 503, 'Kanban database not available');
    return;
  }

  const { id } = req.params;
  if (!id) {
    sendError(ws, req.id, 400, 'id is required');
    return;
  }

  try {
    db.prepare('DELETE FROM columns WHERE id = ?').run(id);

    const workspace = buildKanbanWorkspace(db);
    broadcastEvent('kanban.updated', workspace);
    sendResponse(ws, req.id, { ok: true }, { deleted: true, workspace });
  } catch (error) {
    logger.error({ error }, 'Failed to delete kanban column');
    sendError(ws, req.id, 500, 'Failed to delete column');
  }
}

async function handleKanbanCreateCard(
  ws: WebSocket,
  client: WebSocketClient,
  req: OpenClawRequest,
): Promise<void> {
  if (!client.authenticated) {
    sendError(ws, req.id, 401, 'Not authenticated');
    return;
  }

  const db = getKanbanDb();
  if (!db) {
    sendError(ws, req.id, 503, 'Kanban database not available');
    return;
  }

  const {
    columnId,
    title,
    description,
    priority,
    tags,
    dueDate,
    labels,
    members,
  } = req.params;
  if (!columnId || !title) {
    sendError(ws, req.id, 400, 'columnId and title are required');
    return;
  }

  try {
    const maxPos = db
      .prepare('SELECT MAX(position) as m FROM cards WHERE column_id = ?')
      .get(columnId) as any;
    const position = (maxPos?.m ?? -1) + 1;

    const id = `card-${randomUUID().slice(0, 8)}`;
    const now = Date.now();

    db.prepare(
      `
      INSERT INTO cards (id, column_id, title, description, priority, tags, due_date, labels, members, position, archived, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
    `,
    ).run(
      id,
      columnId,
      title,
      description || null,
      priority || 'medium',
      tags ? JSON.stringify(tags) : null,
      dueDate || null,
      labels ? JSON.stringify(labels) : null,
      members ? JSON.stringify(members) : null,
      position,
      now,
    );

    const workspace = buildKanbanWorkspace(db);
    broadcastEvent('kanban.updated', workspace);
    sendResponse(ws, req.id, { ok: true }, { cardId: id, workspace });
  } catch (error) {
    logger.error({ error }, 'Failed to create kanban card');
    sendError(ws, req.id, 500, 'Failed to create card');
  }
}

async function handleKanbanUpdateCard(
  ws: WebSocket,
  client: WebSocketClient,
  req: OpenClawRequest,
): Promise<void> {
  if (!client.authenticated) {
    sendError(ws, req.id, 401, 'Not authenticated');
    return;
  }

  const db = getKanbanDb();
  if (!db) {
    sendError(ws, req.id, 503, 'Kanban database not available');
    return;
  }

  const {
    id,
    title,
    description,
    priority,
    tags,
    columnId,
    archived,
    dueDate,
    labels,
    members,
    activities,
    checklists,
    comments,
    cover,
  } = req.params;
  if (!id) {
    sendError(ws, req.id, 400, 'id is required');
    return;
  }

  try {
    const card = db.prepare('SELECT * FROM cards WHERE id = ?').get(id) as any;
    if (!card) {
      sendError(ws, req.id, 404, 'Card not found');
      return;
    }

    const fields: string[] = [];
    const values: any[] = [];

    if (title !== undefined) {
      fields.push('title = ?');
      values.push(title);
    }
    if (description !== undefined) {
      fields.push('description = ?');
      values.push(description);
    }
    if (priority !== undefined) {
      fields.push('priority = ?');
      values.push(priority);
    }
    if (tags !== undefined) {
      fields.push('tags = ?');
      values.push(JSON.stringify(tags));
    }
    if (columnId !== undefined) {
      fields.push('column_id = ?');
      values.push(columnId);
    }
    if (archived !== undefined) {
      fields.push('archived = ?');
      values.push(archived ? 1 : 0);
    }
    if (dueDate !== undefined) {
      fields.push('due_date = ?');
      values.push(dueDate);
    }
    if (labels !== undefined) {
      fields.push('labels = ?');
      values.push(JSON.stringify(labels));
    }
    if (members !== undefined) {
      fields.push('members = ?');
      values.push(JSON.stringify(members));
    }
    if (activities !== undefined) {
      fields.push('activities = ?');
      values.push(JSON.stringify(activities));
    }
    if (checklists !== undefined) {
      fields.push('checklists = ?');
      values.push(JSON.stringify(checklists));
    }
    if (comments !== undefined) {
      fields.push('comments = ?');
      values.push(JSON.stringify(comments));
    }
    if (cover !== undefined) {
      fields.push('cover = ?');
      values.push(cover);
    }

    if (fields.length === 0) {
      sendError(ws, req.id, 400, 'No fields to update');
      return;
    }

    // Append updated_at value, then id for WHERE clause
    values.push(Date.now());
    values.push(id);
    db.prepare(
      `UPDATE cards SET ${fields.join(', ')}, updated_at = ? WHERE id = ?`,
    ).run(...values);

    const workspace = buildKanbanWorkspace(db);
    broadcastEvent('kanban.updated', workspace);
    sendResponse(ws, req.id, { ok: true }, { workspace });
  } catch (error) {
    logger.error({ error }, 'Failed to update kanban card');
    sendError(ws, req.id, 500, 'Failed to update card');
  }
}

async function handleKanbanMoveCard(
  ws: WebSocket,
  client: WebSocketClient,
  req: OpenClawRequest,
): Promise<void> {
  if (!client.authenticated) {
    sendError(ws, req.id, 401, 'Not authenticated');
    return;
  }

  const db = getKanbanDb();
  if (!db) {
    sendError(ws, req.id, 503, 'Kanban database not available');
    return;
  }

  const { id, columnId, position } = req.params;
  if (!id || !columnId) {
    sendError(ws, req.id, 400, 'id and columnId are required');
    return;
  }

  try {
    const card = db.prepare('SELECT * FROM cards WHERE id = ?').get(id) as any;
    if (!card) {
      sendError(ws, req.id, 404, 'Card not found');
      return;
    }

    const targetPosition = position ?? 0;

    // Shift other cards in target column to make room
    db.prepare(
      `
      UPDATE cards SET position = position + 1
      WHERE column_id = ? AND position >= ? AND id != ?
    `,
    ).run(columnId, targetPosition, id);

    db.prepare('UPDATE cards SET column_id = ?, position = ? WHERE id = ?').run(
      columnId,
      targetPosition,
      id,
    );

    const workspace = buildKanbanWorkspace(db);
    broadcastEvent('kanban.updated', workspace);
    sendResponse(ws, req.id, { ok: true }, { workspace });
  } catch (error) {
    logger.error({ error }, 'Failed to move kanban card');
    sendError(ws, req.id, 500, 'Failed to move card');
  }
}

async function handleKanbanDeleteCard(
  ws: WebSocket,
  client: WebSocketClient,
  req: OpenClawRequest,
): Promise<void> {
  if (!client.authenticated) {
    sendError(ws, req.id, 401, 'Not authenticated');
    return;
  }

  const db = getKanbanDb();
  if (!db) {
    sendError(ws, req.id, 503, 'Kanban database not available');
    return;
  }

  const { id } = req.params;
  if (!id) {
    sendError(ws, req.id, 400, 'id is required');
    return;
  }

  try {
    db.prepare('DELETE FROM cards WHERE id = ?').run(id);

    const workspace = buildKanbanWorkspace(db);
    broadcastEvent('kanban.updated', workspace);
    sendResponse(ws, req.id, { ok: true }, { deleted: true, workspace });
  } catch (error) {
    logger.error({ error }, 'Failed to delete kanban card');
    sendError(ws, req.id, 500, 'Failed to delete card');
  }
}

async function handleKanbanCreateLabel(
  ws: WebSocket,
  client: WebSocketClient,
  req: OpenClawRequest,
): Promise<void> {
  if (!client.authenticated) {
    sendError(ws, req.id, 401, 'Not authenticated');
    return;
  }

  const db = getKanbanDb();
  if (!db) {
    sendError(ws, req.id, 503, 'Kanban database not available');
    return;
  }

  const { boardId, name, color } = req.params;
  if (!boardId || !name || !color) {
    sendError(ws, req.id, 400, 'boardId, name, and color are required');
    return;
  }

  try {
    const id = `label-${randomUUID().slice(0, 8)}`;
    db.prepare(
      'INSERT INTO labels (id, board_id, name, color) VALUES (?, ?, ?, ?)',
    ).run(id, boardId, name, color);

    const workspace = buildKanbanWorkspace(db);
    broadcastEvent('kanban.updated', workspace);
    sendResponse(ws, req.id, { ok: true }, { labelId: id, workspace });
  } catch (error) {
    logger.error({ error }, 'Failed to create kanban label');
    sendError(ws, req.id, 500, 'Failed to create label');
  }
}

async function handleKanbanDeleteLabel(
  ws: WebSocket,
  client: WebSocketClient,
  req: OpenClawRequest,
): Promise<void> {
  if (!client.authenticated) {
    sendError(ws, req.id, 401, 'Not authenticated');
    return;
  }

  const db = getKanbanDb();
  if (!db) {
    sendError(ws, req.id, 503, 'Kanban database not available');
    return;
  }

  const { id } = req.params;
  if (!id) {
    sendError(ws, req.id, 400, 'id is required');
    return;
  }

  try {
    db.prepare('DELETE FROM labels WHERE id = ?').run(id);

    const workspace = buildKanbanWorkspace(db);
    broadcastEvent('kanban.updated', workspace);
    sendResponse(ws, req.id, { ok: true }, { deleted: true, workspace });
  } catch (error) {
    logger.error({ error }, 'Failed to delete kanban label');
    sendError(ws, req.id, 500, 'Failed to delete label');
  }
}

async function handleKanbanCreateMember(
  ws: WebSocket,
  client: WebSocketClient,
  req: OpenClawRequest,
): Promise<void> {
  if (!client.authenticated) {
    sendError(ws, req.id, 401, 'Not authenticated');
    return;
  }

  const db = getKanbanDb();
  if (!db) {
    sendError(ws, req.id, 503, 'Kanban database not available');
    return;
  }

  const { boardId, name, initials, color } = req.params;
  if (!boardId || !name) {
    sendError(ws, req.id, 400, 'boardId and name are required');
    return;
  }

  try {
    const id = `member-${randomUUID().slice(0, 8)}`;
    db.prepare(
      'INSERT INTO members (id, board_id, name, initials, color) VALUES (?, ?, ?, ?, ?)',
    ).run(
      id,
      boardId,
      name,
      initials || name.slice(0, 2).toUpperCase(),
      color || '#f59e0b',
    );

    const workspace = buildKanbanWorkspace(db);
    broadcastEvent('kanban.updated', workspace);
    sendResponse(ws, req.id, { ok: true }, { memberId: id, workspace });
  } catch (error) {
    logger.error({ error }, 'Failed to create kanban member');
    sendError(ws, req.id, 500, 'Failed to create member');
  }
}

async function handleKanbanDeleteMember(
  ws: WebSocket,
  client: WebSocketClient,
  req: OpenClawRequest,
): Promise<void> {
  if (!client.authenticated) {
    sendError(ws, req.id, 401, 'Not authenticated');
    return;
  }

  const db = getKanbanDb();
  if (!db) {
    sendError(ws, req.id, 503, 'Kanban database not available');
    return;
  }

  const { id } = req.params;
  if (!id) {
    sendError(ws, req.id, 400, 'id is required');
    return;
  }

  try {
    db.prepare('DELETE FROM members WHERE id = ?').run(id);

    const workspace = buildKanbanWorkspace(db);
    broadcastEvent('kanban.updated', workspace);
    sendResponse(ws, req.id, { ok: true }, { deleted: true, workspace });
  } catch (error) {
    logger.error({ error }, 'Failed to delete kanban member');
    sendError(ws, req.id, 500, 'Failed to delete member');
  }
}
