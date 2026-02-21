#!/usr/bin/env node

/**
 * API Protocol Translator
 * Translates Anthropic API requests to OpenAI format for Z.AI compatibility
 *
 * Run: node dist/anthropic-to-openai-proxy.js
 * Listens on: http://localhost:8787
 *
 * Usage in .env:
 *   ANTHROPIC_BASE_URL=http://localhost:8787
 */

import http from 'http';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const PORT = 8787;
const ZAI_BASE_URL = 'https://api.z.ai/api/coding/paas/v4';

// Configuration
const REQUEST_TIMEOUT_MS = 120000; // 2 minutes - LLM responses can take a while
const MAX_REQUEST_SIZE = 10 * 1024 * 1024; // 10MB max request size

// Get the directory where this script is located
const __dirname = dirname(fileURLToPath(import.meta.url));
// Navigate to the project root (assuming this is in nanoclaw/dist/)
const projectRoot = join(__dirname, '..');

// Read API key from .env file
function getZaiApiKey(): string {
  const envPath = join(projectRoot, '.env');
  try {
    const envContent = readFileSync(envPath, 'utf-8');
    for (const line of envContent.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('ZAI_API_KEY=') || trimmed.startsWith('OPENAI_API_KEY=')) {
        const value = trimmed.split('=')[1].trim();
        if (value && !value.startsWith('#')) {
          return value.replace(/^["']|["']$/g, '');
        }
      }
    }
  } catch (error) {
    console.error('Error reading .env file:', error);
  }
  return '';
}

const ZAI_API_KEY = getZaiApiKey();

if (!ZAI_API_KEY) {
  console.error('ZAI_API_KEY not found in .env file');
  process.exit(1);
}

// Translate Anthropic tool definitions to OpenAI format
function translateTools(anthropicTools: any[]): any[] {
  return anthropicTools.map(tool => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description || '',
      parameters: tool.input_schema || {},
    },
  }));
}

// Anthropic to OpenAI message format translation
function translateRequest(anthropicReq: any): any {
  const { model, max_tokens, messages, system, tools, tool_choice } = anthropicReq;

  // Anthropic format -> OpenAI format
  const openaiMessages: any[] = [];

  // Add system message as first message
  if (system) {
    openaiMessages.push({
      role: 'system',
      content: typeof system === 'string' ? system : system.content || '',
    });
  }

  for (const msg of messages) {
    // Handle different message types
    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      // Assistant message with potential tool_use blocks
      let textContent = '';
      const toolCalls: any[] = [];

      for (const block of msg.content) {
        if (block.type === 'text') {
          textContent += block.text;
        } else if (block.type === 'tool_use') {
          toolCalls.push({
            id: block.id,
            type: 'function',
            function: {
              name: block.name,
              arguments: JSON.stringify(block.input || {}),
            },
          });
        }
      }

      const openaiMsg: any = {
        role: 'assistant',
        content: textContent || null,
      };
      if (toolCalls.length > 0) {
        openaiMsg.tool_calls = toolCalls;
      }
      openaiMessages.push(openaiMsg);
    } else if (msg.role === 'user' && Array.isArray(msg.content)) {
      // User message - could be text or tool_result
      const toolResults: any[] = [];
      let textContent = '';

      for (const block of msg.content) {
        if (block.type === 'tool_result') {
          // Convert Anthropic tool_result to OpenAI tool message
          toolResults.push({
            role: 'tool',
            tool_call_id: block.tool_use_id,
            content: typeof block.content === 'string'
              ? block.content
              : JSON.stringify(block.content),
          });
        } else if (block.type === 'text') {
          textContent += block.text;
        }
      }

      // Add tool result messages
      for (const toolResult of toolResults) {
        openaiMessages.push(toolResult);
      }

      // Add text content if present (and no tool results mixed with text)
      if (textContent && toolResults.length === 0) {
        openaiMessages.push({
          role: 'user',
          content: textContent,
        });
      } else if (textContent) {
        // If there's both text and tool results, add text as user message first
        openaiMessages.push({
          role: 'user',
          content: textContent,
        });
      }
    } else {
      // Simple string content
      openaiMessages.push({
        role: msg.role,
        content: typeof msg.content === 'string' ? msg.content : '',
      });
    }
  }

  // Build OpenAI request
  const openaiReq: any = {
    model: 'glm-5',
    messages: openaiMessages,
    max_tokens: max_tokens || 4096,
  };

  // Translate tools if present
  if (tools && tools.length > 0) {
    openaiReq.tools = translateTools(tools);
    // Handle tool_choice
    if (tool_choice) {
      if (tool_choice.type === 'auto') {
        openaiReq.tool_choice = 'auto';
      } else if (tool_choice.type === 'any') {
        openaiReq.tool_choice = 'required';
      } else if (tool_choice.type === 'tool') {
        openaiReq.tool_choice = { type: 'function', function: { name: tool_choice.name } };
      }
    }
  }

  return openaiReq;
}

// OpenAI to Anthropic response format translation
function translateResponse(openaiRes: any): any {
  if (openaiRes.error) {
    return openaiRes; // Pass through errors
  }

  const choice = openaiRes.choices?.[0];
  if (!choice) {
    return {
      id: `msg_${Date.now()}`,
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: openaiRes?.error?.message || 'Empty response' }],
      model: openaiRes.model,
      stop_reason: 'end_turn',
    };
  }

  // Build content blocks
  const contentBlocks: any[] = [];

  // Add text content if present
  const textContent = choice.message?.content || choice.message?.reasoning_content || '';
  if (textContent) {
    contentBlocks.push({ type: 'text', text: textContent });
  }

  // Handle tool calls - convert OpenAI format to Anthropic format
  if (choice.message?.tool_calls && choice.message.tool_calls.length > 0) {
    for (const toolCall of choice.message.tool_calls) {
      if (toolCall.type === 'function') {
        // Safely parse tool arguments
        let toolInput = {};
        try {
          toolInput = JSON.parse(toolCall.function.arguments || '{}');
        } catch (parseError) {
          console.error(`[Proxy] Failed to parse tool arguments for ${toolCall.function.name}:`, toolCall.function.arguments);
          // Use empty object on parse failure
          toolInput = {};
        }
        contentBlocks.push({
          type: 'tool_use',
          id: toolCall.id,
          name: toolCall.function.name,
          input: toolInput,
        });
      }
    }
  }

  // Determine stop reason
  let stopReason = 'end_turn';
  if (choice.finish_reason === 'tool_calls' || choice.message?.tool_calls?.length > 0) {
    stopReason = 'tool_use';
  } else if (choice.finish_reason === 'length') {
    stopReason = 'max_tokens';
  }

  return {
    id: openaiRes.id || `msg_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    content: contentBlocks.length > 0 ? contentBlocks : [{ type: 'text', text: '' }],
    model: openaiRes.model || 'glm-5',
    stop_reason: stopReason,
    usage: {
      input_tokens: openaiRes.usage?.prompt_tokens || 0,
      output_tokens: openaiRes.usage?.completion_tokens || 0,
    },
  };
}

const server = http.createServer(async (req, res) => {
  console.log(`[Proxy] ${req.method} ${req.url} from ${req.socket.remoteAddress}`);

  if (req.method === 'OPTIONS') {
    res.writeHead(200, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, x-api-key, anthropic-version',
    });
    res.end();
    return;
  }

  // Accept /v1/messages, /v1/complete, and /v1/messages/count_tokens (for SDK compatibility)
  const urlPath = (req.url || '/').split('?')[0];
  const isMessagesEndpoint = urlPath === '/v1/messages';
  const isCompleteEndpoint = urlPath === '/v1/complete';
  const isCountTokensEndpoint = urlPath === '/v1/messages/count_tokens';

  // Handle count_tokens endpoint - return fake response
  if (isCountTokensEndpoint && req.method === 'POST') {
    console.log(`[Proxy] Handling count_tokens request`);
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      // Return a fake token count - the actual count doesn't matter for the proxy
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ input_tokens: 100 }));
    });
    return;
  }

  if (req.method !== 'POST' || (!isMessagesEndpoint && !isCompleteEndpoint)) {
    console.log(`[Proxy] 404 Rejecting: method=${req.method}, url=${req.url}, path=${urlPath}`);
    res.writeHead(404);
    res.end('Not Found');
    return;
  }

  console.log(`[Proxy] Accepting ${req.url} request`);

  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
  });

  req.on('end', async () => {
    try {
      // Validate request size
      if (body.length > MAX_REQUEST_SIZE) {
        console.error(`[Proxy] Request too large: ${body.length} bytes`);
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: {
            type: 'invalid_request_error',
            message: `Request body too large (max ${MAX_REQUEST_SIZE / 1024 / 1024}MB)`,
          },
        }));
        return;
      }

      // Parse JSON with error handling
      let anthropicReq;
      try {
        anthropicReq = JSON.parse(body);
      } catch (parseError: any) {
        console.error('[Proxy] JSON parse error:', parseError.message);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: {
            type: 'invalid_request_error',
            message: `Invalid JSON: ${parseError.message}`,
          },
        }));
        return;
      }

      // Translate Anthropic request to OpenAI format
      const openaiReq = translateRequest(anthropicReq);

      console.log(`[Proxy] ${anthropicReq.model} -> ${openaiReq.model}`);

      // Create abort controller for timeout
      const controller = new AbortController();
      const timeoutId = setTimeout(() => {
        controller.abort();
        console.error(`[Proxy] Request timed out after ${REQUEST_TIMEOUT_MS}ms`);
      }, REQUEST_TIMEOUT_MS);

      // Call Z.AI OpenAI-compatible endpoint with timeout
      let zaiRes;
      try {
        zaiRes = await fetch(`${ZAI_BASE_URL}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${ZAI_API_KEY}`,
          },
          body: JSON.stringify(openaiReq),
          signal: controller.signal,
        });
        clearTimeout(timeoutId);
      } catch (fetchError: any) {
        clearTimeout(timeoutId);
        if (fetchError.name === 'AbortError') {
          console.error('[Proxy] Request aborted due to timeout');
          res.writeHead(504, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            error: {
              type: 'timeout_error',
              message: `Request timed out after ${REQUEST_TIMEOUT_MS / 1000} seconds`,
            },
          }));
          return;
        }
        throw fetchError;
      }

      // Parse response with error handling
      let openaiRes;
      const responseText = await zaiRes.text();
      try {
        openaiRes = JSON.parse(responseText);
      } catch (parseError: any) {
        console.error('[Proxy] Response JSON parse error:', parseError.message);
        console.error('[Proxy] Response text:', responseText.slice(0, 500));
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: {
            type: 'api_error',
            message: `Invalid response from upstream: ${responseText.slice(0, 200)}`,
          },
        }));
        return;
      }

      console.log(`[Proxy] Z.AI status: ${zaiRes.status}`);
      console.log(`[Proxy] Z.AI response:`, JSON.stringify(openaiRes).slice(0, 500));

      // Check for API errors
      if (!zaiRes.ok || openaiRes.error) {
        const errorMessage = openaiRes.error?.message || `Upstream error: ${zaiRes.status}`;
        console.error('[Proxy] Upstream error:', errorMessage);
        res.writeHead(zaiRes.status || 502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: {
            type: 'api_error',
            message: errorMessage,
          },
        }));
        return;
      }

      // Translate OpenAI response back to Anthropic format
      const anthropicRes = translateResponse(openaiRes);

      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(JSON.stringify(anthropicRes));

      console.log(`[Proxy] Response: ${anthropicRes.stop_reason}`);
    } catch (error: any) {
      console.error('[Proxy] Error:', error.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: {
          type: 'internal_error',
          message: error.message,
        },
      }));
    }
  });
});

server.listen(PORT, () => {
  console.log(`\n🔄 API Protocol Translator running on http://localhost:${PORT}`);
  console.log(`📡 Forwarding to Z.AI: ${ZAI_BASE_URL}`);
  console.log(`\n✅ Set in .env:`);
  console.log(`   ANTHROPIC_BASE_URL=http://localhost:${PORT}\n`);
});
