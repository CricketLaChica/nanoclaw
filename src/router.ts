import { Channel, NewMessage } from './types.js';

// WhatsApp message limits
const MAX_MESSAGE_LENGTH = 4096;
const MAX_TOTAL_MESSAGE_LENGTH = 100000; // ~100KB limit for safety

export function escapeXml(s: string): string {
  if (!s) return '';
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;'); // Add single quote escaping
}

export function formatMessages(messages: NewMessage[]): string {
  // Limit total messages to prevent excessive payloads
  const limitedMessages = messages.slice(-100); // Last 100 messages max

  const lines = limitedMessages.map((m) =>
    `<message sender="${escapeXml(m.sender_name)}" time="${escapeXml(m.timestamp)}">${escapeXml(m.content)}</message>`,
  );
  return `<messages>\n${lines.join('\n')}\n</messages>`;
}

export function stripInternalTags(text: string): string {
  return text.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
}

export function formatOutbound(rawText: string): string {
  const text = stripInternalTags(rawText);
  if (!text) return '';

  // Truncate if too long for WhatsApp
  if (text.length > MAX_MESSAGE_LENGTH) {
    return text.slice(0, MAX_MESSAGE_LENGTH - 3) + '...';
  }

  return text;
}

// Validate JID format to prevent injection
export function isValidJid(jid: string): boolean {
  // Telegram JID format: tg:numeric_id (e.g., tg:123456789 or tg:-1001234567890)
  if (jid.startsWith('tg:')) {
    const telegramPattern = /^tg:-?\d+$/;
    return telegramPattern.test(jid) && jid.length < 50;
  }

  // WhatsApp JID format: local@domain or local@domain/resource
  const jidPattern = /^[a-zA-Z0-9._%-]+@[a-zA-Z0-9.-]+(\/[a-zA-Z0-9._%-]+)?$/;
  return jidPattern.test(jid) && jid.length < 256;
}

export async function routeOutbound(
  channels: Channel[],
  jid: string,
  text: string,
): Promise<void> {
  // Validate JID
  if (!isValidJid(jid)) {
    throw new Error(`Invalid JID format: ${jid.slice(0, 50)}...`);
  }

  // Validate message length
  if (text.length > MAX_TOTAL_MESSAGE_LENGTH) {
    throw new Error(`Message too long: ${text.length} bytes (max ${MAX_TOTAL_MESSAGE_LENGTH})`);
  }

  const channel = channels.find((c) => c.ownsJid(jid) && c.isConnected());
  if (!channel) throw new Error(`No channel for JID: ${jid}`);
  return channel.sendMessage(jid, text);
}

export function findChannel(
  channels: Channel[],
  jid: string,
): Channel | undefined {
  return channels.find((c) => c.ownsJid(jid));
}
