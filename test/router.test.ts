import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { Router, extractFilePaths, promptRequestsFileDelivery } from '../src/bridge/router.js';
import type { BridgeConfig } from '../src/config.js';
import type { WeixinMessage } from '../src/ilink/types.js';

function createRouter() {
  const messages: Array<{ uid: string; text: string }> = [];
  const files: Array<{ uid: string; path: string }> = [];
  const starts: string[] = [];
  let lastExecute: { prompt: string; workDir?: string } | null = null;

  const ilink = {
    sendText: async (uid: string, text: string) => {
      messages.push({ uid, text });
    },
    sendFile: async (uid: string, path: string) => {
      files.push({ uid, path });
    },
    startTyping: async (uid: string) => {
      starts.push(uid);
      return () => {};
    },
    onMessage: () => {},
  };

  const registry = {
    isAvailable: (name: string) => ['claude', 'codex', 'gemini'].includes(name),
    getNameByDisplayName: (displayName: string) => ({ Claude: 'claude', Codex: 'codex', Gemini: 'gemini' }[displayName]),
    getAvailableNames: () => ['claude', 'codex', 'gemini'],
    get: (name: string) => ({
      name,
      displayName: name === 'claude' ? 'Claude' : name === 'codex' ? 'Codex' : 'Gemini',
      capabilities: { sessionResume: false },
      execute: async (prompt: string, opts: { workDir?: string }) => {
        lastExecute = { prompt, workDir: opts.workDir };
        return { text: 'ok', error: false };
      },
    }),
  };

  const state = new Map<string, { defaultTool?: string; sessionIds: Record<string, string> }>();
  const sessions = {
    get: (uid: string) => {
      if (!state.has(uid)) state.set(uid, { defaultTool: '', sessionIds: {} });
      return state.get(uid)!;
    },
    update: (uid: string, partial: { defaultTool?: string }) => Object.assign(sessions.get(uid), partial),
    setSession: () => {},
    clearSession: () => {},
  };

  const config: BridgeConfig = {
    defaultTool: 'gemini',
    maxResponseChunkSize: 2000,
    cliTimeout: 300_000,
    typingInterval: 5000,
    allowedUsers: [],
    workDir: process.cwd(),
    tools: {},
  };

  const router = new Router(ilink as any, registry as any, sessions as any, config);
  return { router: router as any, messages, files, starts, sessions, getLastExecute: () => lastExecute };
}

function makeMessage(uid: string): WeixinMessage {
  return {
    message_id: 1,
    from_user_id: uid,
    to_user_id: 'bot',
    client_id: 'client',
    create_time_ms: Date.now(),
    message_type: 1,
    message_state: 0,
    context_token: 'ctx',
    item_list: [],
  };
}

test('getCli prefers @tool in text over quoted footer tool', () => {
  const { router, sessions } = createRouter();
  sessions.update('u1', { defaultTool: 'gemini' });

  const tool = router.getCli('u1', '@codex explain this', 'something\n— Claude | 1.2s');

  assert.equal(tool, 'codex');
});

test('getCli fallback to refText if no @tool mention', () => {
  const { router, sessions } = createRouter();
  sessions.update('u1', { defaultTool: 'gemini' });

  const tool = router.getCli('u1', 'explain this', 'something\n— Claude | 1.2s');

  assert.equal(tool, 'claude');
});

test('pending question resolution follows getCli-selected tool', async () => {
  const { router, sessions } = createRouter();
  sessions.update('u1', { defaultTool: 'gemini' });

  let resolvedAnswer = '';
  router.pendingQuestions.set('u1:codex', {
    resolve: (answer: string) => {
      resolvedAnswer = answer;
    },
    timeout: setTimeout(() => {}, 1000),
    toolName: 'codex',
  });

  let execCalled = false;
  router.exec = async () => {
    execCalled = true;
  };

  await router.handle(makeMessage('u1'), '@codex 2', 'question body\n— Claude | 等待回复', []);

  assert.equal(resolvedAnswer, '@codex 2');
  assert.equal(execCalled, false);
  assert.equal(router.pendingQuestions.has('u1:codex'), false);
});

test('handle() rejects unknown @tool mention', async () => {
  const { router, messages } = createRouter();

  await router.handle(makeMessage('u1'), '@unknown hello', '', []);

  assert.ok(messages[0].text.includes('未知终端: @unknown'));
});

test('handle() combines prompt and refText with double newline', async () => {
  const { router } = createRouter();
  let capturedPrompt = '';
  router.exec = async (uid: string, tool: string, prompt: string) => {
    capturedPrompt = prompt;
  };

  await router.handle(makeMessage('u1'), 'explain', 'source code', []);

  assert.equal(capturedPrompt, 'explain\n\nsource code');
});

test('handle() omits refText in combined prompt if refText is empty', async () => {
  const { router } = createRouter();
  let capturedPrompt = '';
  router.exec = async (uid: string, tool: string, prompt: string) => {
    capturedPrompt = prompt;
  };

  await router.handle(makeMessage('u1'), 'explain', '', []);

  assert.equal(capturedPrompt, 'explain');
});

test('extractFilePaths resolves explicit sendfile markers against workDir', () => {
  const workDir = '/tmp/project';
  const paths = extractFilePaths('已生成文件 [[sendfile:./dist/report.pdf]]', workDir);

  assert.deepEqual(paths, ['/tmp/project/dist/report.pdf']);
});

test('extractFilePaths resolves plain relative output paths against workDir', () => {
  const workDir = '/tmp/project';
  const paths = extractFilePaths('Saved file: dist/output.json', workDir);

  assert.deepEqual(paths, ['/tmp/project/dist/output.json']);
});

test('runOnce passes session workDir and file-delivery hint to adapter', async () => {
  const { router, sessions, getLastExecute } = createRouter();
  sessions.get('u1').workDir = '/tmp/custom-workdir';

  await router.runOnce('gemini', 'u1', '生成一个文件', new AbortController().signal);

  const executed = getLastExecute();
  assert.ok(executed);
  assert.equal(executed?.workDir, '/tmp/custom-workdir');
  assert.match(executed?.prompt || '', /\[\[sendfile:相对或绝对路径\]\]/);
});

test('promptRequestsFileDelivery detects natural language delivery intent', () => {
  assert.equal(promptRequestsFileDelivery('生成报告后把文件发给我'), true);
  assert.equal(promptRequestsFileDelivery('Please generate the report and send me the file'), true);
  assert.equal(promptRequestsFileDelivery('解释一下这段代码'), false);
});

test('runOnce upgrades delivery hint when user explicitly asks to send the file', async () => {
  const { router, getLastExecute } = createRouter();

  await router.runOnce('gemini', 'u1', '生成报告并把文件发给我', new AbortController().signal);

  const executed = getLastExecute();
  assert.ok(executed);
  assert.match(executed?.prompt || '', /用户明确要求把生成的文件发回微信/);
  assert.match(executed?.prompt || '', /必须在最终回复末尾逐行输出/);
});

test('autoSendFiles sends resolved relative files back to user', async () => {
  const { router, files } = createRouter();
  const workDir = mkdtempSync(join(tmpdir(), 'cli-in-wechat-router-'));
  const targetFile = join(workDir, 'dist', 'result.txt');
  mkdirSync(join(workDir, 'dist'), { recursive: true });
  writeFileSync(targetFile, 'ok');

  try {
    await router.autoSendFiles('u1', '请生成文件', '[[sendfile:dist/result.txt]]', workDir);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }

  assert.deepEqual(files, [{ uid: 'u1', path: targetFile }]);
});
