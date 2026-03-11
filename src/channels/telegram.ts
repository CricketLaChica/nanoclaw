import { Bot } from 'grammy';
import fs from 'fs';
import path from 'path';

import { ASSISTANT_NAME, DATA_DIR, TRIGGER_PATTERN } from '../config.js';
import { getRouterState, setRouterState } from '../db.js';
import { logger } from '../logger.js';
import {
  Channel,
  OnInboundMessage,
  OnChatMetadata,
  RegisteredGroup,
} from '../types.js';

export interface TelegramChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class TelegramChannel implements Channel {
  name = 'telegram';

  private bot: Bot | null = null;
  private opts: TelegramChannelOpts;
  private botToken: string;

  constructor(botToken: string, opts: TelegramChannelOpts) {
    this.botToken = botToken;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    this.bot = new Bot(this.botToken);

    // Command to get chat ID (useful for registration)
    this.bot.command('chatid', (ctx) => {
      const chatId = ctx.chat.id;
      const chatType = ctx.chat.type;
      const chatName =
        chatType === 'private'
          ? ctx.from?.first_name || 'Private'
          : (ctx.chat as any).title || 'Unknown';

      const threadId = ctx.message?.message_thread_id;
      const jid = threadId ? `tg:${chatId}:${threadId}` : `tg:${chatId}`;
      const topicNote = threadId ? `\nTopic thread ID: \`${threadId}\`` : '';

      ctx.reply(
        `Chat ID: \`${jid}\`\nName: ${chatName}\nType: ${chatType}${topicNote}`,
        { parse_mode: 'Markdown' },
      );
    });

    // Command to check bot status
    this.bot.command('ping', (ctx) => {
      ctx.reply(`${ASSISTANT_NAME} is online.`);
    });

    this.bot.on('message:text', async (ctx) => {
      // Skip commands
      if (ctx.message.text.startsWith('/')) return;

      const threadId = (ctx.message as any).message_thread_id;
      const chatJid = threadId
        ? `tg:${ctx.chat.id}:${threadId}`
        : `tg:${ctx.chat.id}`;
      let content = ctx.message.text;
      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id.toString() ||
        'Unknown';
      const sender = ctx.from?.id.toString() || '';
      const msgId = ctx.message.message_id.toString();

      // Determine chat name
      const chatName =
        ctx.chat.type === 'private'
          ? senderName
          : (ctx.chat as any).title || chatJid;

      // Translate Telegram @bot_username mentions into TRIGGER_PATTERN format.
      // Telegram @mentions (e.g., @andy_ai_bot) won't match TRIGGER_PATTERN
      // (e.g., ^@Andy\b), so we prepend the trigger when the bot is @mentioned.
      const botUsername = ctx.me?.username?.toLowerCase();
      if (botUsername) {
        const entities = ctx.message.entities || [];
        const isBotMentioned = entities.some((entity) => {
          if (entity.type === 'mention') {
            const mentionText = content
              .substring(entity.offset, entity.offset + entity.length)
              .toLowerCase();
            return mentionText === `@${botUsername}`;
          }
          return false;
        });
        if (isBotMentioned && !TRIGGER_PATTERN.test(content)) {
          content = `@${ASSISTANT_NAME} ${content}`;
        }
      }

      // Store chat metadata for discovery
      this.opts.onChatMetadata(chatJid, timestamp, chatName);

      // Only deliver full message for registered groups
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        logger.debug(
          { chatJid, chatName },
          'Message from unregistered Telegram chat',
        );
        return;
      }

      // Track last processed update_id so restarts don't re-deliver old messages
      setRouterState('last_telegram_update_id', ctx.update.update_id.toString());

      // Deliver message — startMessageLoop() will pick it up
      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });

      logger.info(
        { chatJid, chatName, sender: senderName },
        'Telegram message stored',
      );
    });

    // Handle non-text messages - download media and forward to agent
    const storeNonText = async (
      ctx: any,
      placeholder: string,
      fileId?: string,
    ) => {
      const threadId = ctx.message?.message_thread_id;
      const chatJid = threadId
        ? `tg:${ctx.chat.id}:${threadId}`
        : `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';
      const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';

      let content = `${placeholder}${caption}`;

      // Download and save media files if fileId is provided
      if (fileId && this.bot) {
        try {
          const file = await this.bot.api.getFile(fileId);
          if (file.file_path) {
            const fileUrl = `https://api.telegram.org/file/bot${this.botToken}/${file.file_path}`;
            const fileExt = path.extname(file.file_path) || '.bin';
            const fileName = `${Date.now()}_${ctx.message.message_id}${fileExt}`;

            // Save to group's media directory
            const mediaDir = path.join(DATA_DIR, 'media', group.folder);
            fs.mkdirSync(mediaDir, { recursive: true });
            const localPath = path.join(mediaDir, fileName);

            // Download the file
            const response = await fetch(fileUrl);
            if (response.ok) {
              const buffer = await response.arrayBuffer();
              fs.writeFileSync(localPath, Buffer.from(buffer));

              // Include the container-accessible path in the message
              const containerPath = `/workspace/media/${group.folder}/${fileName}`;
              content = `${placeholder} (saved to: ${containerPath})${caption}`;
              logger.info(
                { localPath, containerPath, group: group.name },
                'Media downloaded from Telegram',
              );
            }
          }
        } catch (err) {
          logger.warn(
            { err, fileId, group: group.name },
            'Failed to download media from Telegram',
          );
          // Fall back to placeholder without path
        }
      }

      this.opts.onChatMetadata(chatJid, timestamp);
      this.opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });
    };

    // Photo: get the largest size (best quality)
    this.bot.on('message:photo', async (ctx) => {
      const photos = ctx.message.photo;
      const largest = photos[photos.length - 1]; // Last one is largest
      await storeNonText(ctx, '[Photo]', largest?.file_id);
    });

    // Video
    this.bot.on('message:video', async (ctx) => {
      await storeNonText(ctx, '[Video]', ctx.message.video?.file_id);
    });

    // Voice message
    this.bot.on('message:voice', async (ctx) => {
      await storeNonText(ctx, '[Voice message]', ctx.message.voice?.file_id);
    });

    // Audio
    this.bot.on('message:audio', async (ctx) => {
      await storeNonText(ctx, '[Audio]', ctx.message.audio?.file_id);
    });

    // Document
    this.bot.on('message:document', async (ctx) => {
      const name = ctx.message.document?.file_name || 'file';
      await storeNonText(
        ctx,
        `[Document: ${name}]`,
        ctx.message.document?.file_id,
      );
    });

    // Sticker (skip download - usually not useful for agents)
    this.bot.on('message:sticker', (ctx) => {
      const emoji = ctx.message.sticker?.emoji || '';
      storeNonText(ctx, `[Sticker ${emoji}]`);
    });

    // Location
    this.bot.on('message:location', (ctx) => {
      const loc = ctx.message.location;
      if (loc) {
        const mapsUrl = `https://maps.google.com/?q=${loc.latitude},${loc.longitude}`;
        storeNonText(ctx, `[Location: ${mapsUrl}]`);
      } else {
        storeNonText(ctx, '[Location]');
      }
    });

    // Contact
    this.bot.on('message:contact', (ctx) => {
      const contact = ctx.message.contact;
      if (contact) {
        const name =
          `${contact.first_name || ''} ${contact.last_name || ''}`.trim();
        storeNonText(ctx, `[Contact: ${name} ${contact.phone_number || ''}]`);
      } else {
        storeNonText(ctx, '[Contact]');
      }
    });

    // Handle errors gracefully
    this.bot.catch((err) => {
      logger.error({ err: err.message }, 'Telegram bot error');
    });

    // On restart, acknowledge updates already processed so Telegram won't re-deliver them
    const lastUpdateId = getRouterState('last_telegram_update_id');
    if (lastUpdateId) {
      try {
        await this.bot.api.getUpdates({ offset: parseInt(lastUpdateId) + 1, timeout: 0 });
        logger.info({ lastUpdateId }, 'Skipped already-processed Telegram updates');
      } catch (err) {
        logger.warn({ err }, 'Failed to skip old Telegram updates on startup');
      }
    }

    // Start polling — returns a Promise that resolves when started
    return new Promise<void>((resolve) => {
      this.bot!.start({
        onStart: (botInfo) => {
          logger.info(
            { username: botInfo.username, id: botInfo.id },
            'Telegram bot connected',
          );
          console.log(`\n  Telegram bot: @${botInfo.username}`);
          console.log(
            `  Send /chatid to the bot to get a chat's registration ID\n`,
          );
          resolve();
        },
      });
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.bot) {
      logger.warn('Telegram bot not initialized');
      return;
    }

    try {
      const parts = jid.replace(/^tg:/, '').split(':');
      const numericId = parts[0];
      const threadId = parts[1] ? parseInt(parts[1]) : undefined;
      const extra = threadId ? { message_thread_id: threadId } : {};

      // Telegram has a 4096 character limit per message — split if needed
      const MAX_LENGTH = 4096;
      if (text.length <= MAX_LENGTH) {
        await this.bot.api.sendMessage(numericId, text, extra as any);
      } else {
        for (let i = 0; i < text.length; i += MAX_LENGTH) {
          await this.bot.api.sendMessage(
            numericId,
            text.slice(i, i + MAX_LENGTH),
            extra as any,
          );
        }
      }
      logger.info({ jid, length: text.length }, 'Telegram message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Telegram message');
    }
  }

  isConnected(): boolean {
    return this.bot !== null;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('tg:');
  }

  async disconnect(): Promise<void> {
    if (this.bot) {
      this.bot.stop();
      this.bot = null;
      logger.info('Telegram bot stopped');
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.bot || !isTyping) return;
    try {
      const parts = jid.replace(/^tg:/, '').split(':');
      const numericId = parts[0];
      const threadId = parts[1] ? parseInt(parts[1]) : undefined;
      const extra = threadId ? { message_thread_id: threadId } : {};
      await this.bot.api.sendChatAction(numericId, 'typing', extra as any);
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Telegram typing indicator');
    }
  }
}
