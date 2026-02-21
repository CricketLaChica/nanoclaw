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
  GROUPS_DIR,
  DATA_DIR,
} from './config.js';
import { getAllGroups, getChatHistory, saveChatMessage, setRegisteredGroup, getAllRegisteredGroups } from './db.js';
import { handleWorkflowMessage } from './workflow-router.js';
import { runContainerAgent } from './container-runner.js';
import { getRegisteredGroup } from './db.js';
import { getOrCreateContainer, getContainerStats } from './container-pool.js';
import { RegisteredGroup } from './types.js';
import { getRelevantMemories, readPersonalityFile } from './memory.js';

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

// Callback for sending messages to external channels (e.g., WhatsApp)
let sendMessageToExternal: ((jid: string, text: string) => Promise<void>) | null = null;

export function startWebSocketServer(sendMessageFn?: (jid: string, text: string) => Promise<void>): void {
  if (wss) {
    logger.warn('WebSocket server already running');
    return;
  }

  // Store the sendMessage callback for external channel routing
  sendMessageToExternal = sendMessageFn || null;

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

      case 'files.list':
        await handleFilesList(ws, client, req);
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

  // Extract agent folder from sessionKey (format: agent:{folder}:main or agent:{folder}:web:{id})
  const match = sessionKey?.match(/^agent:([^:]+):/);
  if (!match) {
    sendError(ws, req.id, 400, 'Invalid sessionKey format');
    return;
  }

  const agentFolder = match[1];

  // Use sessionKey as the stable session identifier instead of client.sessionId
  // This ensures history persists across page refreshes and reconnections
  const history = await getChatHistory(sessionKey, agentFolder, limit);

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

  const { sessionKey, message, idempotencyKey, targetJid } = req.params;

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

  // Save user message to database FIRST (before workflow check)
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

  // Fetch chat history to provide context to the agent
  // This ensures the agent remembers previous messages
  const history = await getChatHistory(sessionKey, agentFolder, 20); // Get last 20 messages for context

  // Fetch relevant long-term memories
  // This provides persistent context across sessions
  const relevantMemories = getRelevantMemories(agentFolder, message, 5);

  logger.debug(
    { agentFolder, memoryCount: relevantMemories.length },
    'WebSocket: Memory injection fetched relevant memories'
  );

  // Build prompt with conversation history, memory context, and current message
  let promptWithContext = message;
  let contextParts: string[] = [];

  // Add personality context if SOUL.md exists
  const soulContent = readPersonalityFile(agentFolder, 'SOUL.md');
  if (soulContent) {
    contextParts.push(`**Personality & Core Values:**\n${soulContent.trim()}\n`);
  }

  // Add long-term memory context
  if (relevantMemories.length > 0) {
    const memoryText = relevantMemories
      .map(m => `- [${m.memory_type}] ${m.content}`)
      .join('\n');
    contextParts.push(`**Relevant Memories:**\n${memoryText}\n`);
  }

  // Add conversation history
  if (history && history.length > 0) {
    const historyText = history
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
      'WebSocket: Memory injection added context to prompt'
    );
  }

  // Run the agent container asynchronously (non-blocking)
  // This allows multiple agents to respond in parallel
  runAgentContainerAsync(ws, client, sessionKey, agentFolder, chatJid, promptWithContext, runId, group, targetJid).catch(error => {
    logger.error({ runId, agentFolder, error }, 'Unhandled error in async container execution');
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
    logger.error({ runId, depth, agentFolder }, 'Max delegation depth reached, stopping');
    return null;
  }

  logger.info({ runId, agentFolder, depth }, `Running agent container (delegation level ${depth})`);

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
      logger.info({ runId, delegatedAgent: agentFolder, delegatedSessionKey }, 'Sent thinking event for delegated agent');
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
        isMain: agentFolder === 'lucy',
        isScheduledTask: false,
        singleMessage: true,
      },
      (proc, containerName) => {
        logger.info({ containerName, depth }, 'Agent container started');
      },
      async (result) => {
        // Stream result back to WebSocket and accumulate for final save
        try {
          if (result.status === 'success' && result.result) {
            const text = typeof result.result === 'string' ? result.result : JSON.stringify(result.result);
            const visibleText = text.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
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
          logger.error({ runId, error: callbackError }, 'Error in streaming callback');
        }
      },
    );

    if (accumulatedResponse && !hadStreamingError) {
      logger.info({ runId, agentFolder, responseLength: accumulatedResponse.length }, 'Saving delegated agent response to database');

      // Add agent name prefix for delegated agents (not the original agent)
      const agentPrefix = agentFolder === originalAgent ? '' : `**${agentFolder.charAt(0).toUpperCase() + agentFolder.slice(1)}**: `;
      const prefixedResponse = agentPrefix + accumulatedResponse;

      saveChatMessage(sessionKey, agentFolder, 'assistant', prefixedResponse);

      // Check for further delegation
      const delegatedAgent = detectDelegation(accumulatedResponse, message, agentFolder, agentFolder);

      if (delegatedAgent) {
        // Execute delegation for WhatsApp flow
        executeDelegation(accumulatedResponse, message, agentFolder, agentFolder);

        logger.info({ runId, delegatedAgent, currentAgent: agentFolder, depth: depth + 1 }, 'Further delegation detected, recursing');

        const delegatedJid = `${delegatedAgent}@nanoclaw.local`;
        const delegatedGroup = await getRegisteredGroup(delegatedJid);

        if (!delegatedGroup) {
          logger.error({ runId, delegatedAgent }, 'Delegated agent not found');
          return accumulatedResponse; // Return what we have so far
        }

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
        logger.info({ runId, delegatedAgent: agentFolder, delegatedSessionKey }, 'Sent final event for delegated agent');
      }

      // Also send to external channel (e.g., WhatsApp) if targetJid is specified
      // This applies to both delegated and non-delegated agents
      if (targetJid && sendMessageToExternal) {
        try {
          await sendMessageToExternal(targetJid, accumulatedResponse);
          logger.info({ targetJid, delegatedAgent: agentFolder, responseLength: accumulatedResponse.length }, 'Delegated agent response sent to external channel');
        } catch (error) {
          logger.error({ targetJid, delegatedAgent: agentFolder, error }, 'Failed to send delegated agent response to external channel');
        }
      }

      return accumulatedResponse;
    }

    // Had an error or no response
    if (hadStreamingError) {
      logger.error({ runId, agentFolder, error: streamingErrorMessage }, 'Delegated agent had error');
    }
    return accumulatedResponse || null;
  } catch (error) {
    logger.error({ runId, agentFolder, depth, error }, 'Error in delegated agent execution');
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
  logger.info({ agentFolder, message, runId }, 'Running agent container (async)');

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
        singleMessage: true, // Exit after first response
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

      // Detect delegation (GLM5 workaround for tool calling)
      // Use group.folder (actual responding agent) not agentFolder (session agent)
      const delegatedAgent = detectDelegation(accumulatedResponse, message, agentFolder, group.folder);

      if (delegatedAgent) {
        // Delegation detected! Execute via IPC for WhatsApp, then spawn delegated agent for WebSocket (non-blocking)
        executeDelegation(accumulatedResponse, message, agentFolder, group.folder);

        logger.info({ runId, delegatedAgent, originalAgent: agentFolder }, 'Delegation detected, spawning delegated agent (non-blocking)');

        // Get the delegated agent's group info
        const delegatedJid = `${delegatedAgent}@nanoclaw.local`;
        const delegatedGroup = await getRegisteredGroup(delegatedJid);

        if (!delegatedGroup) {
          logger.error({ runId, delegatedAgent }, 'Delegated agent not found');
          sendEvent(ws, 'chat', {
            runId,
            sessionKey,
            state: 'error',
            errorMessage: `Delegated agent ${delegatedAgent} not found`,
          });
          break;
        }

        // Save the delegating agent's response with agent prefix
        const agentPrefix = agentFolder === 'lucy' ? '' : `**${agentFolder.charAt(0).toUpperCase() + agentFolder.slice(1)}**: `;
        saveChatMessage(sessionKey, agentFolder, 'assistant', accumulatedResponse);

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
        ).catch(error => {
          logger.error({ runId, delegatedAgent, error }, 'Delegated agent execution failed');
        });

        // Don't wait for delegated agent - complete immediately
        // The delegated agent will stream its response independently
        break;
      }

      // No delegation - save and send final response
      saveChatMessage(sessionKey, agentFolder, 'assistant', accumulatedResponse);

      // Also send to external channel (e.g., WhatsApp) if targetJid is specified
      if (targetJid && sendMessageToExternal) {
        try {
          await sendMessageToExternal(targetJid, accumulatedResponse);
          logger.info({ targetJid, responseLength: accumulatedResponse.length }, 'Response sent to external channel');
        } catch (error) {
          logger.error({ targetJid, error }, 'Failed to send response to external channel');
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
          logger.info({ runId, agentFolder }, 'WebSocket closed before final event (response saved to database)');
        }
    } else if (hadStreamingError) {
      // Had an error during streaming - still save what we accumulated
      if (accumulatedResponse) {
        logger.warn({ runId, agentFolder, responseLength: accumulatedResponse.length, error: streamingErrorMessage }, 'Saving partial response after streaming error');
        saveChatMessage(sessionKey, agentFolder, 'assistant', accumulatedResponse);
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
        saveChatMessage(sessionKey, agentFolder, 'assistant', accumulatedResponse);
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
} // End of runAgentContainerAsync

/**
 * Detect delegation in agent response and execute it automatically.
 * This is a workaround for GLM5 not calling tools reliably.
 * Patterns: "delegate to {agent}", "passing to {agent}", etc.
 */
function detectDelegation(
  response: string,
  originalMessage: string,
  fromAgentFolder: string,
  delegatedAgent?: string,
): string | null {
  // Known agents that can be delegated to
  const knownAgents = ['maui', 'nalu', 'hoku', 'hali', 'moana', 'koa', 'leilani', 'noelani', 'ikaika',
                       'reef', 'pali', 'mana', 'ahi', 'liko', 'kai', 'wai', 'makani', 'lani', 'keoni', 'pua', 'noe'];

  const lowerResponse = response.toLowerCase();

  // Find if agent is mentioned
  const mentionedAgent = knownAgents.find(agent => lowerResponse.includes(agent));

  if (!mentionedAgent) {
    return null; // No delegation detected
  }

  // Determine the actual source agent:
  // - If delegatedAgent is set (e.g., "maui"), use that as the source
  // - Otherwise use fromAgentFolder
  const actualSourceAgent = delegatedAgent || fromAgentFolder;

  logger.info(
    { fromAgent: actualSourceAgent, toAgent: mentionedAgent, originalMessage, delegatedAgent },
    'Delegation detected in response'
  );

  // Return the delegated agent for the caller to handle
  return mentionedAgent;
}

function executeDelegation(
  response: string,
  originalMessage: string,
  fromAgentFolder: string,
  delegatedAgent?: string,
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

  // Determine the actual source agent:
  // - If delegatedAgent is set (e.g., "maui"), use that as the source
  // - Otherwise use fromAgentFolder
  const actualSourceAgent = delegatedAgent || fromAgentFolder;

  logger.info(
    { fromAgent: actualSourceAgent, toAgent: mentionedAgent, originalMessage, delegatedAgent },
    'Delegation detected in response, executing automatically'
  );

  // Write delegation IPC file to the SOURCE agent's tasks directory
  // The IPC handler will route it to the target agent
  const tasksDir = path.join(DATA_DIR, 'ipc', actualSourceAgent, 'tasks');
  fs.mkdirSync(tasksDir, { recursive: true });

  const timestamp = new Date().toISOString();
  const delegationFile = path.join(tasksDir, `delegation-${Date.now()}.json`);

  const delegationContent = {
    type: 'agent_message',
    from: actualSourceAgent,
    to: mentionedAgent,
    message: originalMessage,
    context: {
      originalRequest: originalMessage,
      delegatedBy: actualSourceAgent,
      timestamp,
    },
  };

  try {
    fs.writeFileSync(delegationFile, JSON.stringify(delegationContent));
    logger.info(
      { from: actualSourceAgent, to: mentionedAgent, file: delegationFile },
      'Delegation IPC file written successfully'
    );
  } catch (err) {
    logger.error({ error: err }, 'Failed to write delegation IPC file');
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

async function handleAgentUpdate(
  ws: WebSocket,
  client: WebSocketClient,
  req: OpenClawRequest,
): Promise<void> {
  if (!client.authenticated) {
    sendError(ws, req.id, 401, 'Not authenticated');
    return;
  }

  const { agentFolder, displayName, customDescription, iconType, iconValue } = req.params;

  logger.info({ agentFolder, displayName, customDescription, iconType, iconValue }, 'Agent metadata update requested');

  // Validate parameters
  if (!agentFolder) {
    sendError(ws, req.id, 400, 'agentFolder is required');
    return;
  }

  // Get the agent group from database
  const chatJid = `${agentFolder}@nanoclaw.local`;
  const group = await getRegisteredGroup(chatJid);

  if (!group) {
    sendError(ws, req.id, 404, `Agent ${agentFolder} not found`);
    return;
  }

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

  logger.info({ agentFolder, updates: { displayName, customDescription, iconType, iconValue } }, 'Agent metadata updated successfully');

  // Broadcast update to all connected clients
  broadcastEvent('agent.updated', {
    agentFolder,
    displayName: updatedGroup.displayName,
    customDescription: updatedGroup.customDescription,
    iconType: updatedGroup.iconType,
    iconValue: updatedGroup.iconValue,
  });

  sendResponse(ws, req.id, { ok: true }, {
    agent: {
      folder: agentFolder,
      displayName: updatedGroup.displayName,
      customDescription: updatedGroup.customDescription,
      iconType: updatedGroup.iconType,
      iconValue: updatedGroup.iconValue,
    },
  });
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
  const agentsMetadata: Record<string, {
    folder: string;
    displayName?: string;
    customDescription?: string;
    iconType: 'emoji' | 'image';
    iconValue: string;
  }> = {};

  for (const [jid, group] of Object.entries(allGroups) as [string, RegisteredGroup][]) {
    // Only include agents (not WhatsApp groups)
    if (jid.endsWith('@nanoclaw.local')) {
      agentsMetadata[group.folder] = {
        folder: group.folder,
        displayName: group.displayName,
        customDescription: group.customDescription,
        iconType: group.iconType || 'emoji',
        iconValue: group.iconValue || '🤖',
      };
    }
  }

  logger.info({ count: Object.keys(agentsMetadata).length }, 'Agent metadata retrieved');

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
  const chatJid = `${agentFolder}@nanoclaw.local`;
  const group = await getRegisteredGroup(chatJid);
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

    logger.info({ agentFolder, contentLength: content.length }, 'CLAUDE.md retrieved');

    sendResponse(ws, req.id, { ok: true }, {
      agentFolder,
      content,
    });
  } catch (error) {
    logger.error({ agentFolder, error }, 'Failed to read CLAUDE.md');
    sendError(ws, req.id, 500, `Failed to read CLAUDE.md: ${error instanceof Error ? error.message : String(error)}`);
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

  // Security check: verify this is a valid agent folder
  const chatJid = `${agentFolder}@nanoclaw.local`;
  const group = await getRegisteredGroup(chatJid);
  if (!group) {
    sendError(ws, req.id, 404, `Agent ${agentFolder} not found`);
    return;
  }

  // Write CLAUDE.md file
  const claudeMdPath = path.join(GROUPS_DIR, agentFolder, 'CLAUDE.md');

  try {
    // Ensure directory exists
    fs.mkdirSync(path.dirname(claudeMdPath), { recursive: true });

    // Write content
    fs.writeFileSync(claudeMdPath, content, 'utf-8');

    logger.info({ agentFolder, contentLength: content.length }, 'CLAUDE.md updated');

    // Broadcast update to all connected clients
    broadcastEvent('agent.claude_md_updated', {
      agentFolder,
      timestamp: new Date().toISOString(),
    });

    sendResponse(ws, req.id, { ok: true }, {
      agentFolder,
      saved: true,
    });
  } catch (error) {
    logger.error({ agentFolder, error }, 'Failed to write CLAUDE.md');
    sendError(ws, req.id, 500, `Failed to write CLAUDE.md: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// Shared workspace directory for file browser operations
const SHARED_WORKSPACE_DIR = path.join(DATA_DIR, 'workspace');

// File size limits
const MAX_FILE_READ_SIZE = 5 * 1024 * 1024; // 5MB
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

  // Resolve the path and ensure it's within the workspace
  const resolvedPath = path.resolve(SHARED_WORKSPACE_DIR, relativePath);

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
    '.txt': 'text/plain',
    '.md': 'text/markdown',
    '.json': 'application/json',
    '.js': 'application/javascript',
    '.ts': 'application/typescript',
    '.html': 'text/html',
    '.css': 'text/css',
    '.xml': 'application/xml',
    '.csv': 'text/csv',
    '.pdf': 'application/pdf',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.zip': 'application/zip',
  };
  return mimeTypes[ext] || 'application/octet-stream';
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
    const targetPath = validateWorkspacePath(relativePath);

    if (!fs.existsSync(targetPath)) {
      sendResponse(ws, req.id, { ok: true }, {
        path: relativePath,
        files: [],
        directories: [],
      });
      return;
    }

    if (!fs.statSync(targetPath).isDirectory()) {
      sendError(ws, req.id, 400, 'Path is not a directory');
      return;
    }

    const entries = fs.readdirSync(targetPath, { withFileTypes: true });
    const files: Array<{ name: string; size: number; modified: string; isHidden: boolean }> = [];
    const directories: Array<{ name: string; modified: string; isHidden: boolean }> = [];

    for (const entry of entries) {
      const entryPath = path.join(targetPath, entry.name);
      const stats = fs.statSync(entryPath);
      const isHidden = entry.name.startsWith('.');

      if (entry.isDirectory()) {
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

    logger.info({ path: relativePath, fileCount: files.length, dirCount: directories.length }, 'Files listed');

    sendResponse(ws, req.id, { ok: true }, {
      path: relativePath,
      files,
      directories,
    });
  } catch (error) {
    if (error instanceof Error && error.message === 'Path traversal not allowed') {
      sendError(ws, req.id, 403, 'Path traversal not allowed');
      return;
    }
    logger.error({ path: relativePath, error }, 'Failed to list files');
    sendError(ws, req.id, 500, `Failed to list files: ${error instanceof Error ? error.message : String(error)}`);
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
    const targetPath = validateWorkspacePath(relativePath);

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
      sendError(ws, req.id, 413, `File too large (max ${MAX_FILE_READ_SIZE / 1024 / 1024}MB)`);
      return;
    }

    const content = fs.readFileSync(targetPath, 'utf-8');
    const mimeType = getMimeType(targetPath);

    logger.info({ path: relativePath, size: stats.size }, 'File read');

    sendResponse(ws, req.id, { ok: true }, {
      path: relativePath,
      content,
      mimeType,
      size: stats.size,
      modified: stats.mtime.toISOString(),
    });
  } catch (error) {
    if (error instanceof Error && error.message === 'Path traversal not allowed') {
      sendError(ws, req.id, 403, 'Path traversal not allowed');
      return;
    }
    logger.error({ path: relativePath, error }, 'Failed to read file');
    sendError(ws, req.id, 500, `Failed to read file: ${error instanceof Error ? error.message : String(error)}`);
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
    sendError(ws, req.id, 413, `Content too large (max ${MAX_FILE_WRITE_SIZE / 1024 / 1024}MB)`);
    return;
  }

  try {
    const targetPath = validateWorkspacePath(relativePath);

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

    sendResponse(ws, req.id, { ok: true }, {
      path: relativePath,
      size: contentSize,
      saved: true,
    });
  } catch (error) {
    if (error instanceof Error && error.message === 'Path traversal not allowed') {
      sendError(ws, req.id, 403, 'Path traversal not allowed');
      return;
    }
    logger.error({ path: relativePath, error }, 'Failed to write file');
    sendError(ws, req.id, 500, `Failed to write file: ${error instanceof Error ? error.message : String(error)}`);
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
    const targetPath = validateWorkspacePath(relativePath);

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

    logger.info({ path: relativePath, wasDirectory: stats.isDirectory() }, 'Path deleted');

    // Broadcast file change event
    broadcastEvent('file.changed', {
      path: relativePath,
      action: 'delete',
      timestamp: new Date().toISOString(),
    });

    sendResponse(ws, req.id, { ok: true }, {
      path: relativePath,
      deleted: true,
    });
  } catch (error) {
    if (error instanceof Error && error.message === 'Path traversal not allowed') {
      sendError(ws, req.id, 403, 'Path traversal not allowed');
      return;
    }
    logger.error({ path: relativePath, error }, 'Failed to delete');
    sendError(ws, req.id, 500, `Failed to delete: ${error instanceof Error ? error.message : String(error)}`);
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
    const targetPath = validateWorkspacePath(relativePath);

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

    sendResponse(ws, req.id, { ok: true }, {
      path: relativePath,
      created: true,
    });
  } catch (error) {
    if (error instanceof Error && error.message === 'Path traversal not allowed') {
      sendError(ws, req.id, 403, 'Path traversal not allowed');
      return;
    }
    logger.error({ path: relativePath, error }, 'Failed to create directory');
    sendError(ws, req.id, 500, `Failed to create directory: ${error instanceof Error ? error.message : String(error)}`);
  }
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
    sendMessageToExternal = null;
    logger.info('WebSocket server stopped');
  }
}
