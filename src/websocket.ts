import { WebSocketServer, WebSocket } from 'ws';
import { randomUUID } from 'crypto';
import path from 'path';
import fs from 'fs';
import { logger } from './logger.js';
import {
  WEBSOCKET_PORT,
  WEBSOCKET_CORS_ORIGIN,
  WEBSOCKET_AUTH_TOKEN,
  ASSISTANT_NAME,
} from './config.js';
import { getAllGroups, getChatHistory, saveChatMessage } from './db.js';
import { runContainerAgent } from './container-runner.js';
import { getRegisteredGroup } from './db.js';
import { getOrCreateContainer, getContainerStats } from './container-pool.js';

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

// Track active runs for streaming
const activeRuns = new Map<string, { sessionId: string; agent: string }>();

export function startWebSocketServer(): void {
  if (wss) {
    logger.warn('WebSocket server already running');
    return;
  }

  wss = new WebSocketServer({
    port: WEBSOCKET_PORT,
  });

  wss.on('listening', () => {
    logger.info({ port: WEBSOCKET_PORT }, 'WebSocket server started');
  });

  wss.on('connection', (ws, req) => {
    const clientId = randomUUID();
    logger.info({ clientId, ip: req.socket.remoteAddress }, 'WebSocket client connected');

    // Check CORS origin
    const origin = req.headers.origin;
    if (WEBSOCKET_CORS_ORIGIN !== '*' && origin !== WEBSOCKET_CORS_ORIGIN) {
      logger.warn({ origin, allowedOrigin: WEBSOCKET_CORS_ORIGIN }, 'CORS rejection');
      ws.close(1008, 'CORS policy violation');
      return;
    }

    // Initialize client session
    const client: WebSocketClient = {
      ws,
      sessionId: clientId,
      authenticated: false,
      agent: 'lucy', // Default to lucy
    };
    clients.set(ws, client);

    // Send challenge
    const nonce = randomUUID();
    sendEvent(ws, 'connect.challenge', { nonce });

    ws.on('message', async (data: Buffer) => {
      try {
        const rawMessage = data.toString();
        logger.debug({ clientId: client.sessionId, rawMessage }, 'WebSocket message received');
        const message = JSON.parse(rawMessage);
        await handleMessage(ws, client, message);
      } catch (err) {
        logger.error({ err, clientId: client.sessionId, rawMessage: data.toString() }, 'Error handling WebSocket message');
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
    logger.debug({ method: req.method, clientId: client.sessionId }, 'WebSocket request');

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

      case 'system.health':
        await handleSystemHealth(ws, client, req);
        break;

      default:
        sendError(ws, req.id, -32601, `Unknown method: ${req.method}`);
    }
  } else {
    logger.warn({ type: message.type, clientId: client.sessionId }, 'Unknown message type');
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

  // Verify token
  if (token !== WEBSOCKET_AUTH_TOKEN) {
    logger.warn({ clientId: client.sessionId, receivedToken: token?.substring(0, 8) + '...' }, 'Authentication failed');
    sendResponse(ws, req.id, { ok: false }, { code: 401, message: 'Invalid token' });
    ws.close(1008, 'Authentication failed');
    return;
  }

  client.authenticated = true;
  logger.info({ clientId: client.sessionId, clientInfo }, 'Client authenticated');

  sendResponse(ws, req.id, { ok: true }, {
    type: 'hello-ok',
    protocol: 3,
  });
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
  const groups = await getAllGroups();

  // Filter to show agents (not WhatsApp groups)
  const sessions = Object.entries(groups)
    .filter(([jid, group]) => jid.endsWith('@nanoclaw.local'))
    .map(([jid, group]) => ({
      key: `agent:${group.folder}:main`,
      label: group.folder.charAt(0).toUpperCase() + group.folder.slice(1), // Capitalize
      displayName: group.folder.charAt(0).toUpperCase() + group.folder.slice(1),
      folder: group.folder,
    }));

  // Always prioritize lucy at the top
  sessions.sort((a, b) => {
    if (a.folder === 'lucy') return -1;
    if (b.folder === 'lucy') return 1;
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

  const { sessionKey, limit = 100 } = req.params;

  // Extract agent folder from sessionKey (format: agent:{folder}:main)
  const match = sessionKey?.match(/^agent:([^:]+):/);
  if (!match) {
    sendError(ws, req.id, 400, 'Invalid sessionKey format');
    return;
  }

  const agentFolder = match[1];

  // Get chat history from database
  const history = await getChatHistory(client.sessionId, agentFolder, limit);

  const messages = history.map((msg) => ({
    role: msg.role,
    content: [{ type: 'text', text: msg.content }],
    timestamp: msg.timestamp,
  }));

  sendResponse(ws, req.id, { ok: true }, { messages });
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

  const { sessionKey, message, idempotencyKey } = req.params;

  logger.info({ sessionKey, message: message?.substring(0, 50) }, 'chat.send received');

  // Extract agent folder from sessionKey
  const match = sessionKey?.match(/^agent:([^:]+):/);
  if (!match) {
    logger.warn({ sessionKey }, 'Invalid sessionKey format - does not match pattern agent:xxx:...');
    sendError(ws, req.id, 400, 'Invalid sessionKey format');
    return;
  }

  const agentFolder = match[1];
  const runId = `run-${Date.now()}-${randomUUID()}`;
  const chatJid = `${agentFolder}@nanoclaw.local`;

  // Get the agent group from database
  const group = await getRegisteredGroup(chatJid);
  if (!group) {
    sendError(ws, req.id, 404, `Agent ${agentFolder} not found`);
    return;
  }

  // Save user message to database
  await saveChatMessage(client.sessionId, agentFolder, 'user', message);

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

  // Run the agent container (using pool for persistent containers) with retry logic
  logger.info({ agentFolder, message, runId }, 'Running agent container');

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
        isMain: agentFolder === 'lucy', // Lucy is main
        isScheduledTask: false,
        singleMessage: true, // Exit after first response instead of entering query loop
      },
      (proc, containerName) => {
        logger.info({ containerName }, 'Agent container started');
      },
      async (result) => {
        // Stream result back to WebSocket client and accumulate for database save
        // This callback is invoked during streaming, before container completes
        try {
          if (result.status === 'success' && result.result) {
            const text = typeof result.result === 'string' ? result.result : JSON.stringify(result.result);

            // Strip internal reasoning blocks
            const visibleText = text.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();

            // Accumulate response for final database save (save once at the end, not on every delta)
            accumulatedResponse = visibleText;

            logger.debug({ runId, responseLength: visibleText.length }, 'Accumulated streaming response');

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
            logger.warn({ runId, error: streamingErrorMessage }, 'Streaming callback received error');

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
          logger.error({ runId, error: callbackError }, 'Error in streaming callback (container continuing)');
          hadStreamingError = true;
          streamingErrorMessage = callbackError instanceof Error ? callbackError.message : 'Callback error';
        }
      },
    );

    logger.info({ runId, agentFolder, wasNew, outputStatus: output.status, hadAccumulatedResponse: !!accumulatedResponse }, 'Container execution completed');

    // CRITICAL: In streaming mode, output.result is always null (see container-runner.ts:534)
    // The actual response was accumulated in the streaming callback
    // This is the ONE AND ONLY database save for the assistant's response
    if (accumulatedResponse && !hadStreamingError) {
      logger.info({ runId, agentFolder, responseLength: accumulatedResponse.length }, 'Saving assistant response to database');
      await saveChatMessage(client.sessionId, agentFolder, 'assistant', accumulatedResponse);

      // Send final event via WebSocket only if still connected
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
        logger.info({ runId, agentFolder }, 'WebSocket closed before final event (response saved to database)');
      }
    } else if (hadStreamingError) {
      // Had an error during streaming - still save what we accumulated
      if (accumulatedResponse) {
        logger.warn({ runId, agentFolder, responseLength: accumulatedResponse.length, error: streamingErrorMessage }, 'Saving partial response after streaming error');
        await saveChatMessage(client.sessionId, agentFolder, 'assistant', accumulatedResponse);
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
      logger.warn({ runId, agentFolder, outputStatus: output.status }, 'Container completed with no accumulated response');
    }

    // Success! Break out of retry loop
    break;

  } catch (error) {
    lastError = error instanceof Error ? error : new Error(String(error));
    logger.error({
      error: lastError.message,
      agentFolder,
      attempt,
      maxRetries: MAX_RETRIES,
      hadAccumulatedResponse: !!accumulatedResponse,
    }, 'Agent container execution failed');

    // Check if we should retry
    attempt++;
    if (attempt <= MAX_RETRIES) {
      // Calculate exponential backoff delay
      const delay = Math.min(RETRY_DELAY_MS * Math.pow(2, attempt - 1), MAX_RETRY_DELAY_MS);
      logger.info({ attempt, delay, agentFolder }, `Retrying after ${delay}ms...`);

      // Wait before retrying
      await new Promise(resolve => setTimeout(resolve, delay));

      // Clear accumulated state for retry
      accumulatedResponse = '';
      hadStreamingError = false;
      streamingErrorMessage = '';

      // Continue to next iteration (retry)
      continue;
    }

    // Max retries exceeded - give up and send error to client
    logger.error({ agentFolder, totalAttempts: attempt, lastError: lastError.message }, 'Max retries exceeded');

    // Try to save any accumulated response even if execution failed
    if (accumulatedResponse) {
      logger.info({ runId, agentFolder, responseLength: accumulatedResponse.length }, 'Saving partial response after retry failure');
      try {
        await saveChatMessage(client.sessionId, agentFolder, 'assistant', accumulatedResponse);
      } catch (saveError) {
        logger.error({ runId, error: saveError }, 'Failed to save response to database after retry failure');
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
  const closeSentinelPath = path.join(process.cwd(), 'data', 'ipc', agentFolder, 'input', '_close');
  try {
    fs.mkdirSync(path.dirname(closeSentinelPath), { recursive: true });
    fs.writeFileSync(closeSentinelPath, 'close');
    logger.debug({ agentFolder, closeSentinel: closeSentinelPath }, 'Sent _close sentinel to container');
  } catch (err) {
    logger.warn({ agentFolder, error: err }, 'Failed to send _close sentinel (non-critical, container will timeout)');
  }
}

// Helper functions

function sendResponse(ws: WebSocket, id: string, base: any, payload?: any): void {
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

function sendError(ws: WebSocket, id: string, code: number, message: string): void {
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

  const health = {
    uptime: Math.floor(uptime),
    uptimeHuman: formatUptime(uptime),
    memory: {
      rss: Math.round(memUsage.rss / 1024 / 1024), // MB
      heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024), // MB
      heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024), // MB
      external: Math.round(memUsage.external / 1024 / 1024), // MB
    },
    containers: {
      total: containerStats.totalContainers,
      details: containerStats.containers,
    },
    connectedClients: clients.size,
    timestamp: new Date().toISOString(),
  };

  sendResponse(ws, req.id, { ok: true }, { health });
}

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);

  const parts = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (secs > 0 || parts.length === 0) parts.push(`${secs}s`);

  return parts.join(' ');
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
  if (wss) {
    wss.close();
    wss = null;
    clients.clear();
    logger.info('WebSocket server stopped');
  }
}
