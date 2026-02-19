import { WebSocketServer, WebSocket } from 'ws';
import { randomUUID } from 'crypto';
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

  // Run the agent container
  logger.info({ agentFolder, message, runId }, 'Running agent container');

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt: message,
        groupFolder: agentFolder,
        chatJid,
        isMain: agentFolder === 'lucy', // Lucy is main
        isScheduledTask: false,
      },
      (proc, containerName) => {
        logger.info({ containerName }, 'Agent container started');
      },
      async (result) => {
        // Stream result back to WebSocket client
        if (result.status === 'success' && result.result) {
          const text = typeof result.result === 'string' ? result.result : JSON.stringify(result.result);

          // Strip internal reasoning blocks
          const visibleText = text.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();

          // Send delta event
          sendEvent(ws, 'chat', {
            runId,
            sessionKey,
            state: 'delta',
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: visibleText }],
            },
          });

          // Save to database
          await saveChatMessage(client.sessionId, agentFolder, 'assistant', visibleText);
        } else if (result.status === 'error') {
          sendEvent(ws, 'chat', {
            runId,
            sessionKey,
            state: 'error',
            errorMessage: result.error || 'Unknown error',
          });
        }
      },
    );

    // Send final event when complete
    if (output.status === 'success' && output.result) {
      const finalText = typeof output.result === 'string' ? output.result : JSON.stringify(output.result);
      const visibleFinalText = finalText.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();

      sendEvent(ws, 'chat', {
        runId,
        sessionKey,
        state: 'final',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: visibleFinalText }],
        },
      });
    }
  } catch (error) {
    logger.error({ error, agentFolder }, 'Agent container failed');
    sendEvent(ws, 'chat', {
      runId,
      sessionKey,
      state: 'error',
      errorMessage: error instanceof Error ? error.message : 'Container execution failed',
    });
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
  ws.send(JSON.stringify(res));
}

function sendError(ws: WebSocket, id: string, code: number, message: string): void {
  const res: OpenClawResponse = {
    type: 'res',
    id,
    ok: false,
    error: { code, message },
  };
  ws.send(JSON.stringify(res));
}

function sendEvent(ws: WebSocket, event: string, payload: any): void {
  const evt: OpenClawEvent = {
    type: 'event',
    event,
    payload,
  };
  ws.send(JSON.stringify(evt));
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
