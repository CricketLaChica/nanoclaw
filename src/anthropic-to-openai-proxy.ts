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

// Anthropic to OpenAI message format translation
function translateRequest(anthropicReq: any): any {
  const { model, max_tokens, messages, system } = anthropicReq;

  // Anthropic format -> OpenAI format
  const openaiMessages = messages.map((msg: any) => ({
    role: msg.role,
    content: msg.content,
  }));

  // Add system message as first user message (OpenAI doesn't have system role)
  if (system) {
    openaiMessages.unshift({
      role: 'system',
      content: system,
    });
  }

  // Always use glm-5 for Z.AI (ignore Anthropic model names)
  return {
    model: 'glm-5',
    messages: openaiMessages,
    max_tokens: max_tokens || 4096,
  };
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

  // GLM models can put content in either field
  // Prefer 'content' (actual response) over 'reasoning_content' (thinking)
  const messageContent = choice.message?.content || choice.message?.reasoning_content || '';

  return {
    id: openaiRes.id,
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text: messageContent }],
    model: openaiRes.model,
    stop_reason: choice.finish_reason === 'length' ? 'max_tokens' : 'end_turn',
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

  // Accept /v1/messages with or without query parameters
  const urlPath = (req.url || '/').split('?')[0];
  if (req.method !== 'POST' || urlPath !== '/v1/messages') {
    console.log(`[Proxy] Rejecting: method=${req.method}, url=${req.url}`);
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
      const anthropicReq = JSON.parse(body);

      // Translate Anthropic request to OpenAI format
      const openaiReq = translateRequest(anthropicReq);

      console.log(`[Proxy] ${anthropicReq.model} -> ${openaiReq.model}`);

      // Call Z.AI OpenAI-compatible endpoint
      const zaiRes = await fetch(`${ZAI_BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${ZAI_API_KEY}`,
        },
        body: JSON.stringify(openaiReq),
      });

      const openaiRes = await zaiRes.json();

      console.log(`[Proxy] Z.AI status: ${zaiRes.status}`);
      console.log(`[Proxy] Z.AI response:`, JSON.stringify(openaiRes).slice(0, 500));

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
      res.writeHead(500);
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
