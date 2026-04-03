import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { generateWechatUin } from '../utils/crypto.js';
import { log } from '../utils/logger.js';
import { savePollCursor, loadPollCursor, saveContextTokens } from '../config.js';
import { uploadFile, MediaType } from './media.js';
import type {
  Credentials,
  WeixinMessage,
  GetUpdatesResponse,
  MessageItem,
  GetConfigResponse,
} from './types.js';

const CHANNEL_VERSION = '1.0.2';
const HTTP_TIMEOUT_MS = 45_000;
const TEXT_LIKE_EXTS = new Set([
  'txt', 'md', 'markdown', 'json', 'jsonl', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf',
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs',
  'py', 'pyw', 'rb', 'rs', 'go', 'java', 'kt', 'kts', 'scala', 'clj',
  'c', 'h', 'cpp', 'hpp', 'cc', 'cxx', 'cs', 'swift', 'm', 'mm',
  'html', 'htm', 'css', 'scss', 'less', 'sass', 'xml', 'svg',
  'sh', 'bash', 'zsh', 'fish', 'bat', 'cmd', 'ps1',
  'sql', 'graphql', 'gql',
  'env', 'gitignore', 'dockerignore', 'editorconfig',
  'csv', 'tsv', 'log', 'diff', 'patch',
  'r', 'R', 'rmd', 'lua', 'pl', 'pm', 'php', 'vue', 'svelte',
  'makefile', 'cmake', 'gradle', 'tf', 'hcl',
]);

export interface FileAttachment {
  type: 'image' | 'file' | 'video' | 'voice';
  fileName?: string;
  url?: string;
  mediaInfo?: { encrypt_query_param: string; aes_key: string };
}

export type MessageHandler = (msg: WeixinMessage, text: string, refText: string, files: FileAttachment[]) => void;

export class ILinkClient {
  private credentials: Credentials;
  private accountId: string;
  private pollCursor: string;
  private running = false;
  private contextTokens = new Map<string, string>();
  private typingTickets = new Map<string, { ticket: string; ts: number }>();
  private handlers: MessageHandler[] = [];
  private backoffMs = 1000;
  private abortController: AbortController | null = null;

  constructor(credentials: Credentials, accountId = credentials.ilinkUserId) {
    this.credentials = credentials;
    this.accountId = accountId;
    this.pollCursor = loadPollCursor(this.accountId);
  }

  onMessage(handler: MessageHandler): void {
    this.handlers.push(handler);
  }

  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'AuthorizationType': 'ilink_bot_token',
      'Authorization': `Bearer ${this.credentials.botToken}`,
      'X-WECHAT-UIN': generateWechatUin(),
    };
  }

  private baseInfo() {
    return { channel_version: CHANNEL_VERSION };
  }

  // ─── Lifecycle ─────────────────────────────────────────

  start(): void {
    this.running = true;
    log.info(`[${this.accountId}] iLink 消息轮询已启动`);
    this.pollLoop();
  }

  stop(): void {
    this.running = false;
    this.abortController?.abort();
    log.info(`[${this.accountId}] iLink 消息轮询已停止`);
  }

  // ─── Long-polling loop ─────────────────────────────────

  private async pollLoop(): Promise<void> {
    while (this.running) {
      try {
        const msgs = await this.getUpdates();
        this.backoffMs = 1000;

        for (const msg of msgs) {
          this.processMessage(msg);
        }
      } catch (err: unknown) {
        if (!this.running) return;

        const error = err as { name?: string; errcode?: number; message?: string };

        if (error.name === 'AbortError') {
          continue; // normal timeout
        }

        if (error.errcode === -14 || error.errcode === -13) {
          log.error(`[${this.accountId}] 会话已过期，需要重新登录`);
          this.running = false;
          return;
        }

        log.error('轮询错误:', error.message || err);
        await sleep(this.backoffMs);
        this.backoffMs = Math.min(this.backoffMs * 2, 30_000);
      }
    }
  }

  private async getUpdates(): Promise<WeixinMessage[]> {
    this.abortController = new AbortController();
    const timer = setTimeout(() => this.abortController?.abort(), HTTP_TIMEOUT_MS);

    try {
      const res = await fetch(
        `${this.credentials.baseUrl}/ilink/bot/getupdates`,
        {
          method: 'POST',
          headers: this.headers(),
          body: JSON.stringify({
            get_updates_buf: this.pollCursor,
            base_info: this.baseInfo(),
          }),
          signal: this.abortController.signal,
        },
      );

      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const data = (await res.json()) as GetUpdatesResponse;

      // API omits ret/errcode on success; only check when explicitly present and non-zero
      if (data.ret !== undefined && data.ret !== 0) {
        const e: Error & { errcode?: number } = new Error(
          data.errmsg || `ret=${data.ret}`,
        );
        e.errcode = data.errcode;
        throw e;
      }

      if (data.get_updates_buf) {
        this.pollCursor = data.get_updates_buf;
        savePollCursor(this.pollCursor, this.accountId);
      }

      return data.msgs || [];
    } finally {
      clearTimeout(timer);
    }
  }

  // ─── Message handling ──────────────────────────────────

  private processMessage(msg: WeixinMessage): void {
    // Only process user messages, skip bot echoes
    if (msg.message_type !== 1) return;

    // Cache context_token for this user
    this.contextTokens.set(msg.from_user_id, msg.context_token);
    saveContextTokens(this.contextTokens, this.accountId);

    log.debug(`[msg] item_list=${JSON.stringify(msg.item_list)}`);
    const { text, refText, files } = parseMessage(msg);
    if (!text && !refText && files.length === 0) return;

    log.debug(`收到 [${msg.from_user_id.substring(0, 12)}...]: ${text.substring(0, 60)}${files.length > 0 ? ` (+${files.length} files)` : ''}`);

    for (const handler of this.handlers) {
      try {
        handler(msg, text, refText, files);
      } catch (err) {
        log.error('消息处理器异常:', err);
      }
    }
  }

  getContextToken(userId: string): string | undefined {
    return this.contextTokens.get(userId);
  }

  // ─── Sending ───────────────────────────────────────────

  async sendText(userId: string, text: string): Promise<void> {
    const token = this.contextTokens.get(userId);
    if (!token) {
      log.error(`无法发送给 ${userId}: 缺少 context_token (用户必须先发一条消息)`);
      return;
    }

    const chunks = chunkText(text, 2000);
    log.debug(`发送给 [${userId.substring(0, 12)}...] (${chunks.length} 块): ${text.substring(0, 100)}${text.length > 100 ? '…' : ''}`);
    for (let i = 0; i < chunks.length; i++) {
      await this.sendRawMessage(userId, token, [
        { type: 1 as const, text_item: { text: chunks[i] } },
      ]);
      if (i < chunks.length - 1) {
        await sleep(300); // preserve ordering between chunks
      }
    }
  }

  // ─── Send file/image ──────────────────────────────────

  async sendFile(userId: string, filePath: string): Promise<void> {
    if (!existsSync(filePath)) {
      throw new Error(`文件不存在: ${filePath}`);
    }

    const token = this.contextTokens.get(userId);
    if (!token) {
      throw new Error(`无法发送文件给 ${userId}: 缺少 context_token (用户必须先发一条消息)`);
    }

    const fileName = filePath.split('/').pop() || 'file';
    const fileExt = (fileName.split('.').pop() || '').toLowerCase();
    const isTextFile = TEXT_LIKE_EXTS.has(fileExt) || fileExt === '';

    try {
      const result = await uploadFile(this.credentials, filePath, userId);
      const mediaPayload = {
        media: {
          encrypt_query_param: result.encryptQueryParam,
          aes_key: result.aesKey,
          encrypt_type: 1,
        },
      };

      let item: MessageItem;
      switch (result.mediaType) {
        case MediaType.IMAGE:
          item = { type: 2 as const, image_item: mediaPayload };
          break;
        case MediaType.VIDEO:
          item = { type: 5 as const, video_item: mediaPayload };
          break;
        case MediaType.VOICE:
          item = { type: 3 as const, voice_item: mediaPayload };
          break;
        default:
          item = {
            type: 4 as const,
            file_item: { ...mediaPayload, file_name: result.fileName, md5: result.fileMd5, len: String(result.fileSize) },
          };
          break;
      }

      log.debug(`[发送文件] CDN上传成功: ${result.fileName}`);
      await this.sendRawMessage(userId, token, [item]);
      return;
    } catch (err) {
      log.warn(`[发送文件] CDN上传失败: ${(err as Error).message}`);
      if (isTextFile) {
        log.warn(`[发送文件] 作为文本内容回退发送: ${fileName}`);
        await this.sendFileAsText(userId, filePath, fileName);
        return;
      }

      throw new Error(`文件上传失败: ${(err as Error).message}`);
    }
  }

  /** Send file content as formatted text message (reliable fallback) */
  async sendFileAsText(userId: string, filePath: string, fileName?: string): Promise<void> {
    const name = fileName || filePath.split('/').pop() || 'file';
    const raw = readFileSync(filePath);

    // Check if content is valid UTF-8 text
    const text = raw.toString('utf-8');
    const isBinary = text.includes('\uFFFD') || /[\x00-\x08\x0E-\x1F]/.test(text.substring(0, 1000));

    if (isBinary) {
      // Binary file that CDN upload failed for — notify user
      const stat = statSync(filePath);
      await this.sendText(userId, `📎 文件: ${name}\n大小: ${formatBytes(stat.size)}\n路径: ${filePath}\n\n⚠️ 二进制文件无法通过文本发送，请通过其他方式获取`);
      return;
    }

    // Send text content with filename header
    const header = `📄 ${name}`;
    const separator = '─'.repeat(Math.min(name.length + 4, 30));
    const content = `${header}\n${separator}\n${text}`;
    await this.sendText(userId, content);
  }

  private async sendRawMessage(
    userId: string,
    contextToken: string,
    itemList: MessageItem[],
  ): Promise<void> {
    const res = await fetch(
      `${this.credentials.baseUrl}/ilink/bot/sendmessage`,
      {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({
          msg: {
            from_user_id: '',
            to_user_id: userId,
            client_id: randomUUID(),
            message_type: 2,
            message_state: 2,
            context_token: contextToken,
            item_list: itemList,
          },
          base_info: this.baseInfo(),
        }),
      },
    );

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`发送消息失败: HTTP ${res.status} ${body}`);
    }

    const data = (await res.json()) as { ret?: number; errmsg?: string };
    if (data.ret !== undefined && data.ret !== 0) {
      throw new Error(`发送消息失败: ${data.errmsg || `ret=${data.ret}`}`);
    }
  }

  // ─── Typing indicator ─────────────────────────────────

  async startTyping(userId: string): Promise<() => void> {
    const contextToken = this.contextTokens.get(userId);
    if (!contextToken) return () => {};

    try {
      const ticket = await this.getTypingTicket(userId, contextToken);
      if (!ticket) return () => {};

      await this.sendTypingStatus(userId, ticket, 1).catch(() => {});

      const interval = setInterval(() => {
        this.sendTypingStatus(userId, ticket, 1).catch(() => {});
      }, 5000);

      return () => {
        clearInterval(interval);
        this.sendTypingStatus(userId, ticket, 2).catch(() => {});
      };
    } catch {
      return () => {};
    }
  }

  private async getTypingTicket(
    userId: string,
    contextToken: string,
  ): Promise<string | null> {
    const cached = this.typingTickets.get(userId);
    if (cached && Date.now() - cached.ts < 20 * 3600_000) {
      return cached.ticket;
    }

    const res = await fetch(
      `${this.credentials.baseUrl}/ilink/bot/getconfig`,
      {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({
          ilink_user_id: userId,
          context_token: contextToken,
          base_info: this.baseInfo(),
        }),
      },
    );

    if (!res.ok) return null;

    const data = (await res.json()) as GetConfigResponse;
    if (data.ret !== 0 || !data.typing_ticket) return null;

    this.typingTickets.set(userId, {
      ticket: data.typing_ticket,
      ts: Date.now(),
    });
    return data.typing_ticket;
  }

  private async sendTypingStatus(
    userId: string,
    ticket: string,
    status: 1 | 2,
  ): Promise<void> {
    await fetch(`${this.credentials.baseUrl}/ilink/bot/sendtyping`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        ilink_user_id: userId,
        typing_ticket: ticket,
        status,
        base_info: this.baseInfo(),
      }),
    });
  }
}

// ─── Helpers ───────────────────────────────────────────────

function parseMessage(msg: WeixinMessage): { text: string; refText: string; files: FileAttachment[] } {
  const parts: string[] = [];
  const files: FileAttachment[] = [];
  let refText = '';
  for (const item of msg.item_list) {
    if (item.type === 1 && item.text_item?.text) {
      parts.push(item.text_item.text);
    } else if (item.type === 3 && item.voice_item?.text) {
      parts.push(item.voice_item.text); // voice-to-text transcription
    }

    // Extract file attachments
    if (item.type === 2 && item.image_item) {
      files.push({
        type: 'image',
        url: item.image_item.url,
        mediaInfo: item.image_item.media ? {
          encrypt_query_param: item.image_item.media.encrypt_query_param,
          aes_key: item.image_item.media.aes_key,
        } : undefined,
      });
    } else if (item.type === 4 && item.file_item) {
      files.push({
        type: 'file',
        fileName: item.file_item.file_name,
        mediaInfo: item.file_item.media ? {
          encrypt_query_param: item.file_item.media.encrypt_query_param,
          aes_key: item.file_item.media.aes_key,
        } : undefined,
      });
    } else if (item.type === 5 && item.video_item) {
      files.push({
        type: 'video',
        mediaInfo: item.video_item.media ? {
          encrypt_query_param: item.video_item.media.encrypt_query_param,
          aes_key: item.video_item.media.aes_key,
        } : undefined,
      });
    } else if (item.type === 3 && item.voice_item?.media) {
      files.push({
        type: 'voice',
        mediaInfo: {
          encrypt_query_param: item.voice_item.media.encrypt_query_param,
          aes_key: item.voice_item.media.aes_key,
        },
      });
    }

    // Extract quoted message content (WeChat 引用消息)
    const ref = item.ref_msg;
    if (ref) {
      const refItem = ref.message_item;
      if (refItem?.text_item?.text) refText = refItem.text_item.text;
      else if (refItem?.voice_item?.text) refText = refItem.voice_item.text;
      else if (ref.title) refText = ref.title;
      log.debug(`[parseMessage] ref_msg extracted=${JSON.stringify(refText.substring(0, 80))}`);
    }
  }
  // WeChat embeds quoted content inline as "[引用]:\n<content>" — strip the prefix
  const text = parts.join('\n').trim().replace(/^\[引用\]:\n?/, '');
  return { text, refText, files };
}

function chunkText(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }

    // Try breaking at paragraph, then line, then space
    let idx = remaining.lastIndexOf('\n\n', maxLen);
    if (idx < maxLen * 0.3) idx = remaining.lastIndexOf('\n', maxLen);
    if (idx < maxLen * 0.3) idx = remaining.lastIndexOf(' ', maxLen);
    if (idx < maxLen * 0.3) idx = maxLen;

    chunks.push(remaining.substring(0, idx));
    remaining = remaining.substring(idx).trimStart();
  }

  return chunks;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}
