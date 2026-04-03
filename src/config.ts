import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { Credentials } from './ilink/types.js';

const DATA_DIR = join(homedir(), '.wx-ai-bridge');
const CONFIG_FILE = join(DATA_DIR, 'config.json');
const CREDENTIALS_FILE = join(DATA_DIR, 'credentials.json');
const ACCOUNTS_DIR = join(DATA_DIR, 'accounts');
const DEFAULT_ACCOUNT_FILE = join(ACCOUNTS_DIR, 'default.txt');
const SESSIONS_DIR = join(DATA_DIR, 'sessions');
const POLL_CURSOR_FILE = join(DATA_DIR, 'poll_cursor.txt');
const CONTEXT_TOKENS_FILE = join(DATA_DIR, 'context_tokens.json');

export interface ToolConfig {
  args?: string[];
  files?: string[];
}

export interface BridgeConfig {
  defaultTool: string;
  maxResponseChunkSize: number;
  cliTimeout: number;
  typingInterval: number;
  allowedUsers: string[];
  workDir: string;
  tools: Record<string, ToolConfig>;
}

const DEFAULT_CONFIG: BridgeConfig = {
  defaultTool: 'claude',
  maxResponseChunkSize: 2000,
  cliTimeout: 300_000,      // 5 minutes
  typingInterval: 5_000,    // 5 seconds
  allowedUsers: [],          // empty = allow all
  workDir: process.cwd(),
  tools: {},
};

export function ensureDataDir(): void {
  mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  mkdirSync(ACCOUNTS_DIR, { recursive: true, mode: 0o700 });
  mkdirSync(SESSIONS_DIR, { recursive: true, mode: 0o700 });
}

export function loadConfig(): BridgeConfig {
  ensureDataDir();
  if (!existsSync(CONFIG_FILE)) return { ...DEFAULT_CONFIG };
  try {
    const raw = readFileSync(CONFIG_FILE, 'utf-8');
    return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function saveConfig(config: BridgeConfig): void {
  ensureDataDir();
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), { mode: 0o600 });
}

export interface StoredAccount {
  accountId: string;
  credentials: Credentials;
}

export function loadCredentials(accountId?: string): Credentials | null {
  ensureDataDir();
  migrateLegacyCredentials();

  if (accountId) {
    return loadCredentialsFile(accountFilePath(accountId));
  }

  const defaultAccountId = loadDefaultAccountId();
  if (defaultAccountId) {
    return loadCredentialsFile(accountFilePath(defaultAccountId));
  }

  const accounts = loadAllCredentials();
  return accounts[0]?.credentials || null;
}

export function loadAllCredentials(): StoredAccount[] {
  ensureDataDir();
  migrateLegacyCredentials();

  const defaultAccountId = loadDefaultAccountId();
  const records = readdirSync(ACCOUNTS_DIR)
    .filter((name) => name.endsWith('.json'))
    .map((name) => {
      const accountId = name.slice(0, -'.json'.length);
      const credentials = loadCredentialsFile(join(ACCOUNTS_DIR, name));
      return credentials ? { accountId, credentials } : null;
    })
    .filter((record): record is StoredAccount => record !== null)
    .sort((a, b) => {
      if (a.accountId === defaultAccountId) return -1;
      if (b.accountId === defaultAccountId) return 1;
      return a.accountId.localeCompare(b.accountId);
    });

  return records;
}

export function saveCredentials(creds: Credentials, accountId = creds.ilinkUserId): void {
  ensureDataDir();
  writeFileSync(accountFilePath(accountId), JSON.stringify(creds, null, 2), { mode: 0o600 });
  if (!loadDefaultAccountId()) {
    setDefaultAccountId(accountId);
  }
}

export function clearCredentials(accountId?: string): void {
  if (accountId) {
    const p = accountFilePath(accountId);
    if (existsSync(p)) unlinkSync(p);
    const defaultAccountId = loadDefaultAccountId();
    if (defaultAccountId === accountId) {
      const next = loadAllCredentials().find((record) => record.accountId !== accountId);
      if (next) setDefaultAccountId(next.accountId);
      else clearDefaultAccountId();
    }
    return;
  }

  if (existsSync(CREDENTIALS_FILE)) {
    writeFileSync(CREDENTIALS_FILE, '{}', { mode: 0o600 });
  }
}

export function loadDefaultAccountId(): string | null {
  if (!existsSync(DEFAULT_ACCOUNT_FILE)) return null;
  try {
    return readFileSync(DEFAULT_ACCOUNT_FILE, 'utf-8').trim() || null;
  } catch {
    return null;
  }
}

export function setDefaultAccountId(accountId: string): void {
  ensureDataDir();
  writeFileSync(DEFAULT_ACCOUNT_FILE, `${accountId}\n`, { mode: 0o600 });
}

export function clearDefaultAccountId(): void {
  if (existsSync(DEFAULT_ACCOUNT_FILE)) unlinkSync(DEFAULT_ACCOUNT_FILE);
}

export function loadPollCursor(accountId = 'default'): string {
  const file = scopedFilePath(POLL_CURSOR_FILE, accountId);
  if (!existsSync(file)) return '';
  try {
    return readFileSync(file, 'utf-8').trim();
  } catch {
    return '';
  }
}

export function savePollCursor(cursor: string, accountId = 'default'): void {
  ensureDataDir();
  writeFileSync(scopedFilePath(POLL_CURSOR_FILE, accountId), cursor, { mode: 0o600 });
}

export function saveContextTokens(tokens: Map<string, string>, accountId = 'default'): void {
  ensureDataDir();
  const obj: Record<string, string> = {};
  for (const [k, v] of tokens) obj[k] = v;
  const target = scopedFilePath(CONTEXT_TOKENS_FILE, accountId);
  const tmp = target + '.tmp';
  writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode: 0o600 });
  renameSync(tmp, target);
}

export function loadContextTokens(accountId = 'default'): Map<string, string> {
  const file = scopedFilePath(CONTEXT_TOKENS_FILE, accountId);
  if (!existsSync(file)) return new Map();
  try {
    const raw = readFileSync(file, 'utf-8');
    const obj = JSON.parse(raw) as Record<string, string>;
    return new Map(Object.entries(obj));
  } catch {
    return new Map();
  }
}

export function getSessionsDir(): string {
  return SESSIONS_DIR;
}

function loadCredentialsFile(filePath: string): Credentials | null {
  if (!existsSync(filePath)) return null;
  try {
    const data = JSON.parse(readFileSync(filePath, 'utf-8'));
    if (!data.botToken) return null;
    return data as Credentials;
  } catch {
    return null;
  }
}

function accountFilePath(accountId: string): string {
  return join(ACCOUNTS_DIR, `${accountId}.json`);
}

function scopedFilePath(baseFile: string, accountId: string): string {
  const suffix = `.${accountId}`;
  if (baseFile.endsWith('.json')) return baseFile.replace(/\.json$/, `${suffix}.json`);
  return `${baseFile}${suffix}`;
}

function migrateLegacyCredentials(): void {
  if (!existsSync(CREDENTIALS_FILE)) return;
  const hasAccountFiles = readdirSync(ACCOUNTS_DIR).some((name) => name.endsWith('.json'));
  if (hasAccountFiles) return;
  const legacy = loadCredentialsFile(CREDENTIALS_FILE);
  if (!legacy) return;
  const target = accountFilePath(legacy.ilinkUserId);
  if (!existsSync(target)) {
    writeFileSync(target, JSON.stringify(legacy, null, 2), { mode: 0o600 });
  }
  if (!loadDefaultAccountId()) {
    setDefaultAccountId(legacy.ilinkUserId);
  }
}

export { DATA_DIR };
