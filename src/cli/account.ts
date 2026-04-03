import { login } from '../ilink/auth.js';
import {
  clearCredentials,
  loadAllCredentials,
  loadDefaultAccountId,
  saveCredentials,
  setDefaultAccountId,
} from '../config.js';
import { log } from '../utils/logger.js';

export async function accountCommand(args: string[]): Promise<void> {
  const cmd = (args[0] || 'list').toLowerCase();

  switch (cmd) {
    case 'list':
      listAccounts();
      return;
    case 'add':
      await addAccount();
      return;
    case 'remove':
    case 'rm':
      removeAccount(args[1]);
      return;
    case 'default':
      setDefault(args[1]);
      return;
    default:
      printUsage();
      process.exitCode = 1;
  }
}

function listAccounts(): void {
  const accounts = loadAllCredentials();
  const defaultAccountId = loadDefaultAccountId();
  if (accounts.length === 0) {
    console.log('暂无已绑定微信账号');
    return;
  }

  for (const account of accounts) {
    const mark = account.accountId === defaultAccountId ? '*' : ' ';
    console.log(`${mark} ${account.accountId}  bot=${account.credentials.ilinkBotId}`);
  }
}

async function addAccount(): Promise<void> {
  console.log('请使用新的微信 ClawBot 账号扫码登录');
  const qrGenerate = await loadQrGenerator();

  const credentials = await login((qrContent) => {
    if (qrGenerate) qrGenerate(qrContent, { small: true });
    else log.info(`请用微信扫描二维码: ${qrContent}`);
  });

  saveCredentials(credentials, credentials.ilinkUserId);
  console.log(`已添加账号: ${credentials.ilinkUserId}`);
}

function removeAccount(accountId?: string): void {
  if (!accountId) {
    console.error('用法: cli-in-wechat account remove <accountId>');
    process.exitCode = 1;
    return;
  }

  clearCredentials(accountId);
  console.log(`已移除账号: ${accountId}`);
}

function setDefault(accountId?: string): void {
  if (!accountId) {
    console.error('用法: cli-in-wechat account default <accountId>');
    process.exitCode = 1;
    return;
  }

  const exists = loadAllCredentials().some((record) => record.accountId === accountId);
  if (!exists) {
    console.error(`账号不存在: ${accountId}`);
    process.exitCode = 1;
    return;
  }

  setDefaultAccountId(accountId);
  console.log(`默认账号已切换为: ${accountId}`);
}

async function loadQrGenerator(): Promise<((text: string, opts: { small: boolean }) => void) | null> {
  try {
    const mod = await import('qrcode-terminal');
    const qt = mod.default || mod;
    return qt.generate?.bind(qt) ?? null;
  } catch {
    return null;
  }
}

function printUsage(): void {
  console.log(`用法: cli-in-wechat account <list|add|remove|default>

示例:
  cli-in-wechat account list
  cli-in-wechat account add
  cli-in-wechat account remove <accountId>
  cli-in-wechat account default <accountId>`);
}
