import { readdirSync, readFileSync, statSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { createDecipheriv } from 'node:crypto';
import { log } from '../utils/logger.js';
import { ILinkClient } from '../ilink/client.js';
import type { FileAttachment } from '../ilink/client.js';
import { AdapterRegistry } from '../adapters/registry.js';
import { SessionManager } from './session.js';
import { formatResponse } from './formatter.js';
import type { WeixinMessage } from '../ilink/types.js';
import type { BridgeConfig } from '../config.js';
import type { AskUserRequest } from '../adapters/base.js';
import { DATA_DIR } from '../config.js';

interface ActiveTask { abort: AbortController; tool: string }
interface PendingQuestion { resolve: (answer: string) => void; timeout: ReturnType<typeof setTimeout>; toolName: string }

const TOOL_ALIASES: Record<string, string> = {
  claude: 'claude', cc: 'claude',
  codex: 'codex', cx: 'codex',
  gemini: 'gemini', gm: 'gemini',
  kimi: 'kimi', km: 'kimi',
  opencode: 'opencode', oc: 'opencode',
  qwen: 'qwen', qw: 'qwen',
};

export class Router {
  private ilink: ILinkClient;
  private registry: AdapterRegistry;
  private sessions: SessionManager;
  private config: BridgeConfig;
  private active = new Map<string, ActiveTask>();
  private lastResponse = new Map<string, { tool: string; text: string }>();
  private pendingQuestions = new Map<string, PendingQuestion>();
  private _lastSessionList: Array<{ id: string; date: string; summary: string }> | null = null;

  constructor(ilink: ILinkClient, registry: AdapterRegistry, sessions: SessionManager, config: BridgeConfig) {
    this.ilink = ilink;
    this.registry = registry;
    this.sessions = sessions;
    this.config = config;
  }

  start(): void {
    this.ilink.onMessage((msg, text, refText, files) => {
      this.handle(msg, text, refText, files).catch((e) => log.error('路由异常:', e));
    });
  }

  private resolveToolFromRefText(refText: string): string | undefined {
    // Parse tool from footer: "— DisplayName | ..."
    const footerMatch = refText.match(/— ([^\|\n]+?)(?:\s*\||\s*$)/m);
    if (footerMatch) return this.registry.getNameByDisplayName(footerMatch[1].trim());
    return undefined;
  }

  // ── getCli: determine terminal from @mention → ref footer → current session ──
  private getCli(uid: string, text: string, refText?: string): string {
    const atMatch = text.match(/^@(\w+)/);
    if (atMatch) {
      const resolved = TOOL_ALIASES[atMatch[1].toLowerCase()];
      if (resolved && this.registry.isAvailable(resolved)) return resolved;
    }
    if (refText) {
      const resolved = this.resolveToolFromRefText(refText);
      if (resolved && this.registry.isAvailable(resolved)) return resolved;
    }
    return this.sessions.get(uid).defaultTool || this.config.defaultTool;
  }


  private async handle(msg: WeixinMessage, text: string, refText: string, files: FileAttachment[]): Promise<void> {
    const uid = msg.from_user_id;
    if (this.config.allowedUsers.length > 0 && !this.config.allowedUsers.includes(uid)) return;

    const trimmed = text.trim();

    // ── /command ──
    if (trimmed.startsWith('/')) {
      await this.handleSlash(uid, trimmed);
      return;
    }

    // ── Parse: @tool1>tool2 chain, @tool single, >> relay, plain text ──

    // Pattern: @tool1>tool2 prompt  →  chain: tool1 processes, output feeds tool2
    const chainMatch = trimmed.match(/^@(\w+)>(\w+)\s+([\s\S]+)$/);
    if (chainMatch) {
      const t1 = TOOL_ALIASES[chainMatch[1].toLowerCase()];
      const t2 = TOOL_ALIASES[chainMatch[2].toLowerCase()];
      const prompt = chainMatch[3].trim();
      if (t1 && t2 && this.registry.isAvailable(t1) && this.registry.isAvailable(t2)) {
        const busy = [t1, t2].find(t => this.active.has(`${uid}:${t}`));
        if (busy) { await this.ilink.sendText(uid, `${busy} 在忙`); return; }
        await this.chain(uid, t1, t2, prompt);
        return;
      }
    }

    // Pattern: >> prompt  →  relay: prepend last response as context
    if (trimmed.startsWith('>>')) {
      const rest = trimmed.substring(2).trim();
      const prev = this.lastResponse.get(uid);
      if (!prev) {
        await this.ilink.sendText(uid, '没有上一条回复可接力');
        return;
      }
      const atRelayMatch = rest.match(/^@(\w+)[\s：:]\s*([\s\S]+)$/);
      const prompt = atRelayMatch ? atRelayMatch[2].trim() : rest;
      const toolName = this.getCli(uid, rest, refText);
      this.sessions.update(uid, { defaultTool: toolName });
      if (this.active.has(`${uid}:${toolName}`)) { await this.ilink.sendText(uid, `${toolName} 在忙`); return; }
      const fullPrompt = `以下是 ${prev.tool} 的输出:\n\n${prev.text}\n\n---\n\n${prompt}`;
      await this.exec(uid, toolName, fullPrompt);
      return;
    }

    // ── @mention 合法性校验 ──
    const atMatch = trimmed.match(/^@(\w+)(?:[\s：:]\s*([\s\S]+))?$/);
    if (atMatch && !TOOL_ALIASES[atMatch[1].toLowerCase()]) {
      await this.ilink.sendText(uid, `未知终端: @${atMatch[1]}\n可用: ${Object.keys(TOOL_ALIASES).join(', ')}`);
      return;
    }

    const toolName = this.getCli(uid, trimmed, refText);

    // ── If a tool is waiting for AskUser reply, resolve it before normal execution ──
    const pendingKey = `${uid}:${toolName}`;
    const pending = this.pendingQuestions.get(pendingKey);
    if (pending && trimmed) {
      clearTimeout(pending.timeout);
      this.pendingQuestions.delete(pendingKey);
      pending.resolve(trimmed);
      return;
    }

    // ── getCli 决定终端，立即切换 defaultTool ──
    this.sessions.update(uid, { defaultTool: toolName });

    if (!this.registry.isAvailable(toolName)) {
      await this.ilink.sendText(uid, `"${toolName}" 不可用\n可用: ${this.registry.getAvailableNames().join(', ')}`);
      return;
    }

    // @tool 无 prompt → 仅切换，确认后返回
    if (atMatch && !atMatch[2] && files.length === 0) {
      await this.ilink.sendText(uid, `已切换到 ${toolName}`);
      return;
    }

    if (this.active.has(`${uid}:${toolName}`)) { await this.ilink.sendText(uid, `${toolName} 在忙`); return; }

    // ── Build prompt, including file context if files are received ──
    let prompt = atMatch ? (atMatch[2]?.trim() || '') : trimmed;

    // Handle received files: save locally and mention in prompt
    if (files.length > 0) {
      const savedPaths = await this.saveReceivedFiles(uid, files);
      if (savedPaths.length > 0) {
        const fileInfo = savedPaths.map(p => `- ${p}`).join('\n');
        const fileContext = `[用户发送了以下文件，已保存到本地]:\n${fileInfo}`;
        prompt = prompt ? `${prompt}\n\n${fileContext}` : `请处理以下文件:\n${fileInfo}`;
      }
    }

    const combined = [prompt, refText].filter(Boolean).join('\n\n');
    if (!combined) {
      await this.ilink.sendText(uid, `已切换到 ${toolName}`);
      return;
    }
    await this.exec(uid, toolName, combined);
  }

  // ─── Save received files from WeChat ──────────────────────

  private async saveReceivedFiles(uid: string, files: FileAttachment[]): Promise<string[]> {
    const savedPaths: string[] = [];
    const receiveDir = join(DATA_DIR, 'received_files');
    mkdirSync(receiveDir, { recursive: true });

    for (const file of files) {
      try {
        if (file.mediaInfo) {
          // Download from CDN and decrypt
          const { encrypt_query_param, aes_key } = file.mediaInfo;
          const cdnUrl = encrypt_query_param; // The param is the CDN download URL

          const res = await fetch(cdnUrl);
          if (!res.ok) {
            log.warn(`[文件下载] HTTP ${res.status} for ${file.type}`);
            continue;
          }

          const encryptedBuf = Buffer.from(await res.arrayBuffer());

          // Decode the AES key
          let keyBuf: Buffer;
          if (file.type === 'image') {
            keyBuf = Buffer.from(aes_key, 'base64');
          } else {
            const hexStr = Buffer.from(aes_key, 'base64').toString('utf-8');
            keyBuf = Buffer.from(hexStr, 'hex');
          }

          // AES-128-ECB decrypt
          const decipher = createDecipheriv('aes-128-ecb', keyBuf, null);
          decipher.setAutoPadding(true);
          const decrypted = Buffer.concat([decipher.update(encryptedBuf), decipher.final()]);

          const ext = file.type === 'image' ? '.png' : (file.type === 'voice' ? '.amr' : (file.type === 'video' ? '.mp4' : ''));
          const fileName = file.fileName || `${file.type}_${Date.now()}${ext}`;
          const savePath = join(receiveDir, fileName);
          writeFileSync(savePath, decrypted);
          savedPaths.push(savePath);
          log.debug(`[文件接收] 已保存: ${savePath}`);
        } else if (file.url) {
          // Direct URL download (some images have URL)
          const res = await fetch(file.url);
          if (!res.ok) continue;
          const buf = Buffer.from(await res.arrayBuffer());
          const fileName = file.fileName || `${file.type}_${Date.now()}.dat`;
          const savePath = join(receiveDir, fileName);
          writeFileSync(savePath, buf);
          savedPaths.push(savePath);
          log.debug(`[文件接收] 已保存 (URL): ${savePath}`);
        }
      } catch (err) {
        log.error(`[文件接收] 保存失败:`, err);
      }
    }

    return savedPaths;
  }

  // ─── /command → ALL are commands, never pass through ────

  private async handleSlash(uid: string, text: string): Promise<boolean> {
    const parts = text.substring(1).split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const arg = parts.slice(1).join(' ').trim();
    const settings = this.sessions.get(uid);
    const reply = (msg: string) => this.ilink.sendText(uid, msg);

    switch (cmd) {
      // ═══════════════════════════════════════════
      // 通用
      // ═══════════════════════════════════════════

      case 'help': case 'h':
        await reply([
          '=== cli-in-wechat 命令 ===',
          '',
          '— 设置 —',
          '/status  查看所有配置',
          '/model <名>  切模型',
          '/mode <auto|safe|plan>  权限',
          '/effort <low|med|high|max>  深度',
          '/turns <数>  最大轮次',
          '/budget <$>  预算(off=无限)',
          '/dir <路径>  工作目录',
          '/system <词>  追加系统提示',
          '/tools <列表>  允许工具',
          '/notool <列表>  禁用工具',
          '/verbose  详细输出',
          '/bare  跳过配置加载',
          '/adddir <路径>  额外目录',
          '/name <名>  会话命名',
          '/sandbox <ro|write|full>  沙箱',
          '/search  web搜索(Codex)',
          '/ephemeral  临时模式(Codex)',
          '/profile <名>  配置(Codex)',
          '/approval <模式>  审批(Gemini)',
          '/include <目录>  上下文(Gemini)',
          '/ext <名>  扩展(Gemini)',
          '/thinking  深度思考(Kimi)',
          '',
          '— 操作 —',
          '/diff  查看git差异',
          '/commit  创建git提交',
          '/review  代码审查',
          '/plan [描述]  规划模式/制定计划',
          '/init  创建项目配置文件',
          '/files  列出目录结构',
          '/compact  压缩上下文(清session)',
          '/stats  使用统计',
          '',
          '— 会话 —',
          '/new  新会话',
          '/clear  清除所有',
          '/cancel  取消任务',
          '/fork  分支当前会话',
          '/resume  查看保存的会话',
          '',
          '— 快捷 —',
          '/yolo  auto+effort max',
          '/fast  effort low',
          '/reset  重置所有设置',
          '/cc /cx /gm /km /oc /qw  切工具',
          '',
          '— 发消息 —',
          '@claude/@codex/@gemini/@kimi/@opencode/@qwen  指定工具',
          '>>  接力(传上条结果)',
          '@tool1>tool2  链式调用',
          '',
          '— 文件 —',
          '/sendfile <路径>  发送文件到微信',
        ].join('\n'));
        return true;

      case 'status': case 'st': {
        const def = settings.defaultTool || this.config.defaultTool;
        const sids = Object.entries(settings.sessionIds).map(([k, v]) => `${k}:${String(v).substring(0, 8)}`).join(' ') || '无';
        const lines = [
          `工具: ${def}`,
          `模式: ${settings.mode}`,
          `effort: ${settings.effort}`,
          `model: ${settings.model || '默认'}`,
          `turns: ${settings.maxTurns}`,
          `budget: ${settings.maxBudget > 0 ? '$' + settings.maxBudget : '无限'}`,
          `sandbox: ${settings.sandbox || '无'}`,
          `search: ${settings.search ? 'ON' : 'OFF'}`,
          `verbose: ${settings.verbose ? 'ON' : 'OFF'}`,
          `system: ${settings.systemPrompt ? settings.systemPrompt.substring(0, 40) + '...' : '无'}`,
          `dir: ${settings.workDir || this.config.workDir}`,
          `会话: ${sids}`,
          `可用: ${this.registry.getAvailableNames().join(', ')}`,
        ];
        await reply(lines.join('\n'));
        return true;
      }

      case 'new': case 'n':
        this.sessions.clearSession(uid);
        await reply('新会话');
        return true;

      case 'cancel': case 'c': {
        const tasks = [...this.active.entries()].filter(([k]) => k.startsWith(`${uid}:`));
        if (tasks.length > 0) {
          const seen = new Set<AbortController>();
          tasks.forEach(([k, t]) => { if (!seen.has(t.abort)) { seen.add(t.abort); t.abort.abort(); } this.active.delete(k); });
          await reply(`已取消 ${[...new Set(tasks.map(([, t]) => t.tool))].join(', ')}`);
        } else { await reply('无任务'); }
        return true;
      }

      case 'model': case 'm':
        if (!arg || arg === 'reset' || arg === 'default') {
          this.sessions.update(uid, { model: '' });
          await reply('model → 默认');
        } else {
          this.sessions.update(uid, { model: arg });
          await reply(`model → ${arg}`);
        }
        return true;

      case 'mode': {
        const modes: Record<string, string> = { auto: 'auto', safe: 'safe', plan: 'plan' };
        const v = modes[arg.toLowerCase()];
        if (!v) { await reply('/mode <auto|safe|plan>\nauto=最高权限 safe=需确认 plan=只读'); return true; }
        this.sessions.update(uid, { mode: v as any });
        const desc: Record<string, string> = {
          auto: 'AUTO\nClaude: --dangerously-skip-permissions\nCodex: --yolo\nGemini: --approval-mode yolo\nKimi: --print (自带yolo)\nQwen: --approval-mode yolo',
          safe: 'SAFE\nClaude: 默认权限\nCodex: --full-auto\nGemini: --approval-mode default\nKimi: 默认\nQwen: --approval-mode default',
          plan: 'PLAN\nClaude: --permission-mode plan\nCodex: --sandbox read-only\nGemini: --approval-mode plan\nKimi: /plan\nQwen: --approval-mode plan',
        };
        await reply(desc[v]);
        return true;
      }

      case 'dir': case 'cd':
        if (!arg) { await reply(`当前: ${settings.workDir || this.config.workDir}`); return true; }
        this.sessions.update(uid, { workDir: arg });
        await reply(`dir → ${arg}`);
        return true;

      case 'system': case 'sys':
        if (!arg || arg === 'clear' || arg === 'reset') {
          this.sessions.update(uid, { systemPrompt: '' });
          await reply('system prompt → 清除');
        } else {
          this.sessions.update(uid, { systemPrompt: arg });
          await reply(`system prompt → ${arg.substring(0, 60)}...`);
        }
        return true;

      // ═══════════════════════════════════════════
      // Claude Code
      // ═══════════════════════════════════════════

      case 'effort': case 'e': {
        const map: Record<string, string> = {
          min: 'low', low: 'low', med: 'medium', medium: 'medium', high: 'high', max: 'max',
          '1': 'low', '2': 'low', '3': 'medium', '4': 'high', '5': 'max',
        };
        const v = map[arg.toLowerCase()];
        if (!v) { await reply(`当前: ${settings.effort}\n/effort <low|med|high|max>`); return true; }
        this.sessions.update(uid, { effort: v });
        await reply(`effort → ${v}`);
        return true;
      }

      case 'turns': case 't': {
        const n = parseInt(arg);
        if (!n || n < 1) { await reply(`当前: ${settings.maxTurns}\n/turns <数字>`); return true; }
        this.sessions.update(uid, { maxTurns: n });
        await reply(`turns → ${n}`);
        return true;
      }

      case 'budget': case 'b':
        if (!arg || arg === 'off' || arg === '0') {
          this.sessions.update(uid, { maxBudget: 0 });
          await reply('budget → 无限');
        } else {
          const v = parseFloat(arg);
          if (isNaN(v)) { await reply('/budget <美元> 或 /budget off'); return true; }
          this.sessions.update(uid, { maxBudget: v });
          await reply(`budget → $${v}`);
        }
        return true;

      case 'tools':
        if (!arg || arg === 'reset') {
          this.sessions.update(uid, { allowedTools: '' });
          await reply('allowedTools → 全部');
        } else {
          this.sessions.update(uid, { allowedTools: arg });
          await reply(`allowedTools → ${arg}`);
        }
        return true;

      case 'notool':
        if (!arg || arg === 'reset') {
          this.sessions.update(uid, { disallowedTools: '' });
          await reply('disallowedTools → 无');
        } else {
          this.sessions.update(uid, { disallowedTools: arg });
          await reply(`disallowedTools → ${arg}`);
        }
        return true;

      case 'verbose': case 'v':
        this.sessions.update(uid, { verbose: !settings.verbose });
        await reply(`verbose → ${!settings.verbose ? 'ON' : 'OFF'}`);
        return true;

      // ═══════════════════════════════════════════
      // Codex
      // ═══════════════════════════════════════════

      case 'sandbox': case 'sb': {
        const aliases: Record<string, string> = {
          ro: 'read-only', 'read-only': 'read-only', readonly: 'read-only',
          ws: 'workspace-write', 'workspace-write': 'workspace-write', write: 'workspace-write',
          full: 'danger-full-access', 'danger-full-access': 'danger-full-access', danger: 'danger-full-access',
          off: '', reset: '',
        };
        const v = aliases[arg.toLowerCase()];
        if (v === undefined) { await reply(`当前: ${settings.sandbox || '无'}\n/sandbox <read-only|write|full|off>`); return true; }
        this.sessions.update(uid, { sandbox: v });
        await reply(v ? `sandbox → ${v}` : 'sandbox → OFF (yolo)');
        return true;
      }

      case 'search':
        this.sessions.update(uid, { search: !settings.search });
        await reply(`search → ${!settings.search ? 'ON' : 'OFF'}`);
        return true;

      case 'ephemeral':
        this.sessions.update(uid, { ephemeral: !settings.ephemeral });
        await reply(`ephemeral → ${!settings.ephemeral ? 'ON' : 'OFF'}`);
        return true;

      case 'profile':
        if (!arg) { await reply(`当前: ${settings.profile || '无'}\n/profile <名称> 或 /profile reset`); return true; }
        this.sessions.update(uid, { profile: arg === 'reset' ? '' : arg });
        await reply(arg === 'reset' ? 'profile → 默认' : `profile → ${arg}`);
        return true;

      // ═══════════════════════════════════════════
      // Kimi Code
      // ═══════════════════════════════════════════

      case 'thinking': {
        this.sessions.update(uid, { thinking: !settings.thinking });
        await reply(`thinking → ${!settings.thinking ? 'ON (深度思考)' : 'OFF'}`);
        return true;
      }

      // ═══════════════════════════════════════════
      // Gemini
      // ═══════════════════════════════════════════

      case 'approval': {
        const modes: Record<string, string> = { default: 'default', auto_edit: 'auto_edit', yolo: 'yolo', plan: 'plan' };
        const v = modes[arg.toLowerCase()];
        if (!v) { await reply(`当前: ${settings.approvalMode || 'yolo'}\n/approval <default|auto_edit|yolo|plan>`); return true; }
        this.sessions.update(uid, { approvalMode: v });
        await reply(`approval-mode → ${v}`);
        return true;
      }

      case 'include': case 'inc':
        if (!arg || arg === 'reset') {
          this.sessions.update(uid, { includeDirs: '' });
          await reply('include dirs → 清除');
        } else {
          this.sessions.update(uid, { includeDirs: arg });
          await reply(`include dirs → ${arg}`);
        }
        return true;

      case 'ext': case 'extensions':
        if (!arg || arg === 'reset') {
          this.sessions.update(uid, { extensions: '' });
          await reply('extensions → 默认');
        } else {
          this.sessions.update(uid, { extensions: arg });
          await reply(`extensions → ${arg}`);
        }
        return true;

      // ═══════════════════════════════════════════
      // 快捷组合
      // ═══════════════════════════════════════════

      case 'yolo':
        this.sessions.update(uid, { mode: 'auto', effort: 'max' } as any);
        await reply('YOLO: mode=auto + effort=max');
        return true;

      case 'fast':
        this.sessions.update(uid, { effort: 'low' });
        await reply('effort → low (快速模式)');
        return true;

      case 'reset':
        this.sessions.update(uid, {
          mode: 'auto', effort: 'high', model: '', maxTurns: 30, maxBudget: 0,
          allowedTools: '', disallowedTools: '', verbose: false, sandbox: '',
          search: false, systemPrompt: '', workDir: '', bare: false, addDir: '',
          sessionName: '', ephemeral: false, profile: '', approvalMode: '',
          includeDirs: '', extensions: '',
        } as any);
        await reply('所有设置已重置');
        return true;

      // ═══════════════════════════════════════════
      // Claude 额外
      // ═══════════════════════════════════════════

      case 'bare':
        this.sessions.update(uid, { bare: !settings.bare } as any);
        await reply(`bare → ${!(settings as any).bare ? 'ON (跳过配置加载)' : 'OFF'}`);
        return true;

      case 'adddir': case 'add-dir':
        if (!arg) { await reply(`当前: ${(settings as any).addDir || '无'}\n/adddir <路径>`); return true; }
        this.sessions.update(uid, { addDir: arg } as any);
        await reply(`add-dir → ${arg}`);
        return true;

      case 'name':
        if (!arg) { await reply(`当前: ${(settings as any).sessionName || '无'}\n/name <名称>`); return true; }
        this.sessions.update(uid, { sessionName: arg } as any);
        await reply(`session name → ${arg}`);
        return true;

      // ═══════════════════════════════════════════
      // 操作类 (转化为 prompt 发给当前工具)
      // ═══════════════════════════════════════════

      case 'compact': case 'compress': case 'summarize': {
        // Clear session + start fresh with summary instruction
        this.sessions.clearSession(uid);
        await reply('会话已压缩 (新session, 旧上下文已清除)');
        return true;
      }

      case 'diff': {
        const tool = settings.defaultTool || this.config.defaultTool;
        if (this.registry.isAvailable(tool)) {
          await this.exec(uid, tool, arg || 'Show the current git diff of uncommitted changes. Be concise.');
        }
        return true;
      }

      case 'commit': {
        const tool = settings.defaultTool || this.config.defaultTool;
        if (this.registry.isAvailable(tool)) {
          await this.exec(uid, tool, arg || 'Create a git commit for all staged changes with an appropriate commit message.');
        }
        return true;
      }

      case 'review': {
        const tool = settings.defaultTool || this.config.defaultTool;
        if (this.registry.isAvailable(tool)) {
          await this.exec(uid, tool, arg || 'Review the current code changes (git diff) and provide feedback on quality, bugs, and improvements.');
        }
        return true;
      }

      case 'init': {
        const tool = settings.defaultTool || this.config.defaultTool;
        const file = tool === 'codex' ? 'AGENTS.md' : tool === 'gemini' ? 'GEMINI.md' : 'CLAUDE.md';
        if (this.registry.isAvailable(tool)) {
          await this.exec(uid, tool, arg || `Analyze this project and create a ${file} configuration file with appropriate instructions.`);
        }
        return true;
      }

      case 'fork': case 'branch': {
        // Fork = clear session ID so next call doesn't --resume
        const tool = settings.defaultTool || this.config.defaultTool;
        this.sessions.clearSession(uid, tool);
        await reply(`已 fork ${tool} 会话 (下次消息开始新分支)`);
        return true;
      }

      case 'cost': case 'usage': case 'stats': {
        const last = this.lastResponse.get(uid);
        if (last) {
          await reply(`上次回复:\n工具: ${last.tool}\n长度: ${last.text.length} 字符`);
        } else {
          await reply('暂无回复记录');
        }
        return true;
      }

      case 'files': {
        const tool = settings.defaultTool || this.config.defaultTool;
        if (this.registry.isAvailable(tool)) {
          await this.exec(uid, tool, 'List all files in the current working directory. Show the tree structure concisely.');
        }
        return true;
      }

      case 'plan': {
        if (arg) {
          // /plan <description> → send plan request to tool
          const tool = settings.defaultTool || this.config.defaultTool;
          if (this.registry.isAvailable(tool)) {
            await this.exec(uid, tool, `Create a detailed plan for: ${arg}. Only plan, do not execute.`);
          }
        } else {
          // /plan with no args → switch to plan mode
          this.sessions.update(uid, { mode: 'plan' } as any);
          await reply('PLAN mode ON');
        }
        return true;
      }

      case 'continue': {
        // Alias for /resume
        const sids = Object.entries(settings.sessionIds);
        if (sids.length === 0) {
          await reply('无活跃会话，用 /resume 浏览历史');
        } else {
          const lines = sids.map(([k, v]) => `${k}: ${String(v).substring(0, 12)}...`);
          await reply(`活跃会话:\n${lines.join('\n')}\n\n/resume 浏览所有历史`);
        }
        return true;
      }

      case 'clear': {
        this.sessions.clearSession(uid);
        this.lastResponse.delete(uid);
        await reply('已清除所有会话和历史');
        return true;
      }

      case 'session': {
        const tool = settings.defaultTool || this.config.defaultTool;
        if (arg.startsWith('set ')) {
          const id = arg.substring(4).trim();
          this.sessions.setSession(uid, tool, id);
          await reply(`${tool} session → ${id}\n下条消息将 --resume 此会话`);
        } else {
          const sids = Object.entries(settings.sessionIds);
          const lines = sids.length > 0
            ? sids.map(([k, v]) => `${k}: ${v}`).join('\n')
            : '(无活跃会话)';
          await reply(`活跃会话:\n${lines}\n\n/session set <id> 手动设置\n/resume 浏览所有历史会话`);
        }
        return true;
      }

      case 'resume': case 'sessions': {
        const tool = settings.defaultTool || this.config.defaultTool;
        if (arg) {
          // /resume <number> → pick from list, or /resume <uuid> → direct set
          const num = parseInt(arg);
          if (!isNaN(num) && this._lastSessionList) {
            const pick = this._lastSessionList[num - 1];
            if (pick) {
              this.sessions.setSession(uid, tool, pick.id);
              await reply(`已恢复 ${tool} 会话:\n${pick.summary}\n\nID: ${pick.id}`);
            } else {
              await reply(`无效编号，范围 1-${this._lastSessionList.length}`);
            }
          } else {
            // Treat as UUID
            this.sessions.setSession(uid, tool, arg.trim());
            await reply(`${tool} session → ${arg.trim()}`);
          }
          return true;
        }
        // List all sessions for current tool
        const list = this.listSessions(tool, settings.workDir || this.config.workDir);
        if (list.length === 0) {
          await reply(`${tool} 没有历史会话`);
          return true;
        }
        this._lastSessionList = list;
        const lines = list.map((s, i) =>
          `${i + 1}. ${s.date} ${s.summary}\n   ${s.id}`
        );
        await reply(`${tool} 历史会话 (最近${list.length}条):\n\n${lines.join('\n\n')}\n\n回复 /resume <编号> 恢复`);
        return true;
      }

      // ═══════════════════════════════════════════
      // 文件发送
      // ═══════════════════════════════════════════

      case 'sendfile': case 'sf': case 'file': {
        if (!arg) {
          await reply('/sendfile <路径>\n发送本地文件到微信\n\n示例:\n/sendfile ./output.txt\n/sendfile /tmp/screenshot.png');
          return true;
        }
        const filePath = isAbsolute(arg) ? arg : resolve(settings.workDir || this.config.workDir, arg);
        try {
          await this.ilink.sendFile(uid, filePath);
          await reply(`已发送: ${arg}`);
        } catch (err) {
          await reply(`发送文件失败: ${(err as Error).message}`);
        }
        return true;
      }

      // ═══════════════════════════════════════════
      // 不适用于微信的命令 (给出说明)
      // ═══════════════════════════════════════════

      case 'vim': case 'theme': case 'color': case 'terminal-setup':
      case 'keybindings': case 'chrome': case 'ide': case 'stickers':
      case 'mobile': case 'ios': case 'android': case 'exit': case 'quit':
      case 'login': case 'logout': case 'doctor': case 'upgrade':
      case 'think-back': case 'thinkback':
      case 'output-style': case 'extra-usage': case 'rate-limit-options':
      case 'install-github-app': case 'install-slack-app':
      case 'setup-default-sandbox': case 'sandbox-add-read-dir':
      case 'collab': case 'realtime': case 'personality':
      case 'title': case 'statusline': case 'footer': case 'shortcuts':
      case 'setup-github': case 'remote-env': case 'reload-plugins':
      case 'debug-config':
        await reply(`/${cmd} 仅在本地终端可用，不适用于微信`);
        return true;

      // ═══════════════════════════════════════════
      // 工具切换
      // ═══════════════════════════════════════════

      case 'claude': case 'cc':
        this.sessions.update(uid, { defaultTool: 'claude' }); await reply('→ claude'); return true;
      case 'codex': case 'cx':
        this.sessions.update(uid, { defaultTool: 'codex' }); await reply('→ codex'); return true;
      case 'gemini': case 'gm':
        this.sessions.update(uid, { defaultTool: 'gemini' }); await reply('→ gemini'); return true;
      case 'kimi': case 'km':
        this.sessions.update(uid, { defaultTool: 'kimi' }); await reply('→ kimi'); return true;
      case 'opencode': case 'oc':
        this.sessions.update(uid, { defaultTool: 'opencode' }); await reply('→ opencode'); return true;
      case 'qwen': case 'qw':
        this.sessions.update(uid, { defaultTool: 'qwen' }); await reply('→ qwen'); return true;

      // ═══════════════════════════════════════════
      // 未识别
      // ═══════════════════════════════════════════

      default:
        await reply(`未知命令: /${cmd}\n/help 查看所有命令`);
        return true;
    }
  }

  // ─── List historical sessions ───────────────────────────

  private listSessions(tool: string, workDir: string): Array<{ id: string; date: string; summary: string }> {
    try {
      // Claude: ~/.claude/projects/<encoded-cwd>/<session-id>.jsonl
      // Codex: ~/.codex/sessions/YYYY/MM/DD/*.jsonl
      // Gemini: different structure
      let dir = '';
      if (tool === 'claude') {
        const encoded = workDir.replace(/[^a-zA-Z0-9]/g, '-');
        dir = join(homedir(), '.claude', 'projects', encoded);
      } else if (tool === 'codex') {
        dir = join(homedir(), '.codex', 'sessions');
        return this.listCodexSessions(dir);
      } else {
        return [];
      }

      const files = readdirSync(dir)
        .filter(f => f.endsWith('.jsonl'))
        .map(f => {
          const fullPath = join(dir, f);
          const id = f.replace('.jsonl', '');
          try {
            const stat = statSync(fullPath);
            const firstLines = readFileSync(fullPath, 'utf-8').split('\n').slice(0, 5);
            let summary = '(无摘要)';
            let date = stat.mtime.toISOString().slice(0, 16).replace('T', ' ');
            for (const line of firstLines) {
              if (!line.trim()) continue;
              try {
                const obj = JSON.parse(line);
                if (obj.type === 'user' && obj.message?.content) {
                  const content = typeof obj.message.content === 'string'
                    ? obj.message.content
                    : obj.message.content.map((b: { text?: string }) => b.text || '').join('');
                  summary = content.substring(0, 60) + (content.length > 60 ? '...' : '');
                  if (obj.timestamp) date = obj.timestamp.slice(0, 16).replace('T', ' ');
                  break;
                }
              } catch { continue; }
            }
            return { id, date, summary, mtime: stat.mtime.getTime() };
          } catch {
            return { id, date: '', summary: '(读取失败)', mtime: 0 };
          }
        })
        .sort((a, b) => b.mtime - a.mtime)
        .slice(0, 15);

      return files.map(({ id, date, summary }) => ({ id, date, summary }));
    } catch {
      return [];
    }
  }

  private listCodexSessions(baseDir: string): Array<{ id: string; date: string; summary: string }> {
    try {
      const results: Array<{ id: string; date: string; summary: string; mtime: number }> = [];
      const years = readdirSync(baseDir).filter(f => /^\d{4}$/.test(f));
      for (const year of years) {
        const months = readdirSync(join(baseDir, year)).filter(f => /^\d{2}$/.test(f));
        for (const month of months) {
          const days = readdirSync(join(baseDir, year, month)).filter(f => /^\d{2}$/.test(f));
          for (const day of days) {
            const dayDir = join(baseDir, year, month, day);
            const files = readdirSync(dayDir).filter(f => f.endsWith('.jsonl'));
            for (const f of files) {
              try {
                const stat = statSync(join(dayDir, f));
                const id = f.replace('.jsonl', '').replace('rollout-', '').substring(0, 40);
                results.push({
                  id: 'last', // codex uses --last for resume
                  date: `${year}-${month}-${day}`,
                  summary: f.replace('.jsonl', '').substring(0, 50),
                  mtime: stat.mtime.getTime(),
                });
              } catch { continue; }
            }
          }
        }
      }
      return results.sort((a, b) => b.mtime - a.mtime).slice(0, 10).map(({ id, date, summary }) => ({ id, date, summary }));
    } catch {
      return [];
    }
  }

  // ─── Chain: tool1 → tool2 ─────────────────────────────

  private async chain(uid: string, tool1: string, tool2: string, prompt: string): Promise<void> {
    const adapter1 = this.registry.get(tool1);
    const adapter2 = this.registry.get(tool2);
    if (!adapter1 || !adapter2) return;

    const abort = new AbortController();
    this.active.set(`${uid}:${tool1}`, { abort, tool: `${tool1}>${tool2}` });
    this.active.set(`${uid}:${tool2}`, { abort, tool: `${tool1}>${tool2}` });
    const stopTyping = await this.ilink.startTyping(uid);
    const start = Date.now();

    try {
      // Step 1: run tool1
      log.debug(`[chain] step1: ${tool1}`);
      const { result: r1, notice: n1 } = await this.runOnce(tool1, uid, prompt, abort.signal);

      if (abort.signal.aborted || r1.error) {
        if (!abort.signal.aborted) {
          await this.ilink.sendText(uid, formatResponse(n1 + r1.text, { tool: adapter1.displayName, error: true }));
        }
        return;
      }

      if (r1.sessionId && adapter1.capabilities.sessionResume) {
        this.sessions.setSession(uid, tool1, r1.sessionId);
      }

      // Step 2: run tool2 with tool1's output as context
      log.debug(`[chain] step2: ${tool2}`);
      const chainPrompt = `以下是 ${adapter1.displayName} 对「${prompt}」的分析结果:\n\n${r1.text}\n\n---\n\n请基于以上内容继续工作。`;

      const { result: r2, notice: n2 } = await this.runOnce(tool2, uid, chainPrompt, abort.signal);

      if (abort.signal.aborted) return;

      if (r2.sessionId && adapter2.capabilities.sessionResume) {
        this.sessions.setSession(uid, tool2, r2.sessionId);
      }

      this.sessions.update(uid, { defaultTool: tool2 });
      this.lastResponse.set(uid, { tool: adapter2.displayName, text: r2.text });

      const elapsed = Date.now() - start;
      await this.ilink.sendText(uid, formatResponse(n2 + r2.text, {
        tool: `${adapter1.displayName} → ${adapter2.displayName}`,
        duration: elapsed,
        error: r2.error,
      }));
    } catch (err: unknown) {
      if (!abort.signal.aborted) {
        log.error(`[chain] 失败:`, err);
        await this.ilink.sendText(uid, `链式调用失败: ${(err as Error).message}`);
      }
    } finally {
      stopTyping();
      this.active.delete(`${uid}:${tool1}`);
      this.active.delete(`${uid}:${tool2}`);
    }
  }

  // ─── Execute once, clean up stale session on failure ─
  // Executes the prompt exactly once. On failure, if a session was active,
  // clears it so the next request gets a fresh session — but does NOT
  // re-execute, because the prompt may have had side-effects.

  private async runOnce(
    toolName: string,
    uid: string,
    prompt: string,
    signal: AbortSignal,
  ): Promise<{ result: import('../adapters/base.js').ExecResult; notice: string }> {
    const adapter = this.registry.get(toolName)!;
    const extraArgs = this.config.tools[toolName]?.args;
    const settings = this.sessions.get(uid);
    const hadSession = adapter.capabilities.sessionResume && !!settings.sessionIds[toolName];

    if (signal.aborted) return { result: { text: '已取消', error: true }, notice: '' };
    const result = await adapter.execute(augmentPromptForFileDelivery(prompt, promptRequestsFileDelivery(prompt)), {
      settings,
      workDir: settings.workDir || this.config.workDir,
      timeout: this.config.cliTimeout,
      extraArgs,
      signal,
      askUser: (req) => this.askUserViaWeChat(uid, toolName, req),
    });

    if (result.sessionExpired && hadSession && !signal.aborted) {
      log.warn(`[${toolName}] 会话已过期，已清除旧会话`);
      this.sessions.clearSession(uid, toolName);
      return { result, notice: '[会话已过期并自动清除，如需重试请重新发送]\n\n' };
    }
    return { result, notice: '' };
  }

  // ─── Execute single tool ──────────────────────────────

  // ─── AskUserQuestion via WeChat ─────────────────────────

  private async askUserViaWeChat(uid: string, toolName: string, req: AskUserRequest): Promise<Record<string, string>> {
    const adapter = this.registry.get(toolName);
    const displayName = adapter?.displayName ?? toolName;

    // Format questions for WeChat display
    const lines: string[] = [`${displayName} 需要你的回答:`];
    for (const q of req.questions) {
      lines.push('');
      lines.push(`❓ ${q.question}`);
      q.options.forEach((opt, i) => {
        lines.push(`  ${i + 1}. ${opt.label}${opt.description ? ` — ${opt.description}` : ''}`);
      });
      if (q.multiSelect) lines.push('  (可多选，用逗号分隔数字)');
    }
    lines.push(`— ${displayName} | 等待回复`);

    await this.ilink.sendText(uid, lines.join('\n'));

    // Wait for user reply (timeout 5 min); key: "${uid}:${toolName}" for concurrent support
    const pendingKey = `${uid}:${toolName}`;
    const reply = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingQuestions.delete(pendingKey);
        reject(new Error('回复超时'));
      }, 300_000);
      this.pendingQuestions.set(pendingKey, { resolve, timeout, toolName });
    });

    // Parse reply → map to question answers
    const answers: Record<string, string> = {};
    const replyParts = reply.split(/[,，]/);

    for (let i = 0; i < req.questions.length; i++) {
      const q = req.questions[i];
      const userInput = (replyParts[i] || reply).trim();

      // Try to match by number
      const num = parseInt(userInput);
      if (num >= 1 && num <= q.options.length) {
        answers[q.question] = q.options[num - 1].label;
      } else {
        // Try to match by label
        const match = q.options.find(o => o.label.toLowerCase() === userInput.toLowerCase());
        answers[q.question] = match ? match.label : userInput;
      }
    }

    log.debug(`[askUser] answers: ${JSON.stringify(answers)}`);
    return answers;
  }

  private async exec(uid: string, toolName: string, prompt: string): Promise<void> {
    const adapter = this.registry.get(toolName);
    if (!adapter) return;

    const abort = new AbortController();
    this.active.set(`${uid}:${toolName}`, { abort, tool: toolName });
    const stopTyping = await this.ilink.startTyping(uid);
    const start = Date.now();

    try {
      const { result, notice } = await this.runOnce(toolName, uid, prompt, abort.signal);

      if (abort.signal.aborted) return;

      if (result.sessionId && adapter.capabilities.sessionResume) {
        this.sessions.setSession(uid, toolName, result.sessionId);
      }

      // Store for >> relay; auto-switch defaultTool to last used tool
      this.lastResponse.set(uid, { tool: adapter.displayName, text: result.text });
      this.sessions.update(uid, { defaultTool: toolName });

      await this.ilink.sendText(uid, formatResponse(notice + result.text, {
        tool: adapter.displayName,
        duration: result.duration || (Date.now() - start),
        error: result.error,
      }));

      // ── Post-execution: detect and send files if user requested ──
      if (!result.error) {
        const workDir = this.sessions.get(uid).workDir || this.config.workDir;
        await this.autoSendFiles(uid, prompt, result.text, workDir);
      }
    } catch (err: unknown) {
      if (!abort.signal.aborted) {
        log.error(`[${toolName}] 失败:`, err);
        await this.ilink.sendText(uid, `失败: ${(err as Error).message}`);
      }
    } finally {
      stopTyping();
      this.active.delete(`${uid}:${toolName}`);
    }
  }

  /**
   * After AI executes, scan the output for file paths and auto-send them.
   */
  private async autoSendFiles(uid: string, prompt: string, output: string, workDir: string): Promise<void> {
    // Extract file paths from AI output
    const filePaths = extractFilePaths(output, workDir);
    if (filePaths.length === 0) return;

    log.debug(`[autoSendFiles] 检测到 ${filePaths.length} 个文件路径`);

    let sentCount = 0;
    for (const fp of filePaths.slice(0, 5)) { // limit to 5 files
      try {
        if (existsSync(fp)) {
          await this.ilink.sendFile(uid, fp);
          sentCount++;
          await sleep(500); // rate limit
        }
      } catch (err) {
        log.warn(`[autoSendFiles] 发送 ${fp} 失败: ${(err as Error).message}`);
      }
    }

    if (sentCount > 0) {
      log.debug(`[autoSendFiles] 成功发送 ${sentCount}/${filePaths.length} 个文件`);
    }
  }
}

// ─── Helpers ───────────────────────────────────────────────

/** Extract file paths from AI output text */
export function extractFilePaths(text: string, workDir: string): string[] {
  const paths = new Set<string>();

  // Pre-process: strip ANSI codes, normalize whitespace
  const clean = text.replace(/\x1b\[[0-9;]*m/g, '');
  const addPath = (rawPath: string) => {
    const normalized = normalizeExtractedPath(rawPath, workDir);
    if (normalized) paths.add(normalized);
  };

  // Strategy 0: explicit delivery marker
  const markerRegex = /\[\[\s*sendfile\s*:\s*([^\]\n]+?)\s*\]\]/gi;
  let match: RegExpExecArray | null;
  while ((match = markerRegex.exec(clean)) !== null) {
    addPath(match[1]);
  }

  // Strategy 1: Match absolute paths (handles backtick-wrapped, quoted, bare)
  // Captures paths starting with /Users, /home, /tmp, /var, etc.
  const absPathRegex = /[`'"]*(\/?(?:Users|home|tmp|var|opt|etc|mnt|srv|private)\/[^\s`'"<>|;,)\]}>]+)/g;
  while ((match = absPathRegex.exec(clean)) !== null) {
    addPath('/' + match[1].replace(/^\//, ''));
  }

  // Strategy 2: Match paths in markdown code blocks: `path` or ```\npath\n```
  const backtickRegex = /`([^`\n]+(?:\.[A-Za-z0-9_-]+|\/[^`\n]+))`/g;
  while ((match = backtickRegex.exec(clean)) !== null) {
    addPath(match[1]);
  }

  // Strategy 3: Match "Created/Wrote/Saved/file:" style patterns
  const actionRegex = /(?:created?|wrote?|saved?|generated?|exported?|produced?|file|output|path)[:\s]+[`'"]*([^\s`'"<>|;,)\]}>]+)/gi;
  while ((match = actionRegex.exec(clean)) !== null) {
    addPath(match[1]);
  }

  // Strategy 4: Match relative paths like ./dist/a.pdf or dist/a.pdf
  const relPathRegex = /[`'"]*((?:\.{1,2}\/|[A-Za-z0-9_-]+\/)[^\s`'"<>|;,)\]}>]+)/g;
  while ((match = relPathRegex.exec(clean)) !== null) {
    addPath(match[1]);
  }

  return [...paths];
}

/** Clean up extracted path by removing trailing/surrounding junk */
function cleanPath(p: string): string {
  return p
    .replace(/^[`'"]+/, '')     // strip leading quotes/backticks
    .replace(/[`'"]+$/, '')     // strip trailing quotes/backticks
    .replace(/[.,:;!?]+$/, '')  // strip trailing punctuation
    .replace(/\)$/, '')         // strip trailing paren
    .trim();
}

function normalizeExtractedPath(rawPath: string, workDir: string): string | null {
  const cleaned = cleanPath(rawPath);
  if (!isValidPath(cleaned)) return null;
  if (cleaned.startsWith('/')) return cleaned;
  return resolve(workDir, cleaned);
}

/** Check if a cleaned path looks valid (not a URL, has extension, etc.) */
function isValidPath(p: string): boolean {
  if (p.length < 4) return false;
  if (p.includes('*') || p.includes('?') || p.includes('{')) return false;
  if (p.startsWith('http://') || p.startsWith('https://')) return false;
  if (!p.includes('.')) return false;  // must have file extension
  return true;
}

export function promptRequestsFileDelivery(prompt: string): boolean {
  return [
    /发送(?:这个|该)?文件(?:给我|给用户|回微信|回来)?/,
    /把(?:生成的|结果)?文件发给我/,
    /发给我(?:文件)?/,
    /回传(?:文件|给我|给用户)/,
    /send (?:me|the user) (?:the )?file/i,
    /send (?:it|them) back/i,
    /attach (?:the )?file/i,
    /deliver (?:the )?file/i,
  ].some((pattern) => pattern.test(prompt));
}

function augmentPromptForFileDelivery(prompt: string, mustDeliver: boolean): string {
  const instruction = mustDeliver
    ? '用户明确要求把生成的文件发回微信。只要你产出了最终要交付的本地文件，必须在最终回复末尾逐行输出 `[[sendfile:相对或绝对路径]]`，这样系统会自动把文件发给用户。不要遗漏。'
    : '如果你在本机创建了需要发回微信给用户的文件，请在最终回复中单独列出 `[[sendfile:相对或绝对路径]]`。只写真实存在且最终要交付的文件路径。';

  return [
    prompt,
    instruction,
  ].join('\n\n');
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
