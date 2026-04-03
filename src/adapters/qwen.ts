import { log } from '../utils/logger.js';
import type { CLIAdapter, ExecOptions, ExecResult, AdapterCapabilities } from './base.js';
import { commandExists, spawnProc, setupAbort, setupTimeout, stripAnsi } from './base.js';

export class QwenAdapter implements CLIAdapter {
  readonly name = 'qwen';
  readonly displayName = 'Qwen Code';
  readonly command = 'qwen';
  readonly capabilities: AdapterCapabilities = {
    streaming: true, jsonOutput: true, sessionResume: true,
    modes: ['auto', 'safe', 'plan'], hasEffort: false, hasModel: true, hasSearch: false, hasBudget: false,
  };

  async isAvailable(): Promise<boolean> { return commandExists(this.command); }

  execute(prompt: string, opts: ExecOptions): Promise<ExecResult> {
    return new Promise((resolve) => {
      const { settings } = opts;
      const args: string[] = [];

      // ── Prompt (positional — qwen uses positional prompt for non-interactive) ──
      args.push(prompt);

      // ── Output format ──
      args.push('--output-format', 'text');

      // ── Mode ──
      switch (settings.mode) {
        case 'auto':
          args.push('--approval-mode', 'yolo');
          break;
        case 'safe':
          args.push('--approval-mode', 'default');
          break;
        case 'plan':
          args.push('--approval-mode', 'plan');
          break;
      }

      // ── Model ──
      if (settings.model) args.push('--model', settings.model);

      // ── Session resume ──
      const sid = settings.sessionIds[this.name];
      if (sid) {
        if (sid === 'continue') {
          args.push('--continue');
        } else {
          args.push('--resume', sid);
        }
      }

      // ── Max turns ──
      if (settings.maxTurns) {
        args.push('--max-session-turns', String(settings.maxTurns));
      }

      // ── Working directory (handled via cwd) ──

      // ── Additional directories ──
      if (settings.addDir) {
        args.push('--add-dir', settings.addDir);
      }

      // ── System prompt ──
      if (settings.systemPrompt) {
        args.push('--append-system-prompt', settings.systemPrompt);
      }

      // ── Allowed tools ──
      if (settings.allowedTools) {
        for (const t of settings.allowedTools.split(',').map(s => s.trim()).filter(Boolean)) {
          args.push('--allowed-tools', t);
        }
      }

      // ── Excluded tools ──
      if (settings.disallowedTools) {
        for (const t of settings.disallowedTools.split(',').map(s => s.trim()).filter(Boolean)) {
          args.push('--exclude-tools', t);
        }
      }

      if (opts.extraArgs) args.push(...opts.extraArgs);

      log.debug(`[qwen] model=${settings.model || 'default'} mode=${settings.mode}`);

      const proc = spawnProc(this.command, args, {
        cwd: settings.workDir || opts.workDir, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env },
      });

      setupAbort(proc, opts.signal);
      const timer = setupTimeout(proc, opts.timeout);

      let stdout = '';
      let stderr = '';
      proc.stdout!.on('data', (c: Buffer) => { stdout += c.toString(); });
      proc.stderr!.on('data', (c: Buffer) => { stderr += c.toString(); });

      proc.on('close', (code) => {
        if (timer) clearTimeout(timer);
        if (opts.signal?.aborted) { resolve({ text: '已取消', error: true }); return; }

        const output = stripAnsi(stdout.trim() || stderr.trim());

        // Try to extract session ID from output
        const sidMatch = stderr.match(/session[_\s-]?id[:\s]+([a-f0-9-]+)/i)
          || stdout.match(/session[_\s-]?id[:\s]+([a-f0-9-]+)/i);
        const sessionId = sidMatch?.[1] || (code === 0 ? 'continue' : undefined);

        resolve({
          text: output || `exit ${code}`,
          sessionId,
          error: code !== 0,
        });
      });

      proc.on('error', (err) => {
        if (timer) clearTimeout(timer);
        resolve({ text: `无法启动 Qwen Code: ${err.message}`, error: true });
      });
    });
  }
}
