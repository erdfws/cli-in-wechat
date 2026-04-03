import { openSync, readFileSync, unlinkSync, writeFileSync, existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { DATA_DIR } from '../config.js';

const PID_FILE = join(DATA_DIR, 'daemon.pid');
const LOG_FILE = join(DATA_DIR, 'daemon.log');

export async function daemonCommand(args: string[]): Promise<void> {
  mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });

  const cmd = (args[0] || 'status').toLowerCase();
  switch (cmd) {
    case 'start':
      startDaemon(args.slice(1));
      return;
    case 'stop':
      stopDaemon();
      return;
    case 'restart':
      stopDaemon({ quiet: true });
      startDaemon(args.slice(1));
      return;
    case 'status':
      printStatus();
      return;
    case 'logs':
      printLogs();
      return;
    default:
      printUsage();
      process.exitCode = 1;
  }
}

function startDaemon(extraArgs: string[]): void {
  const currentPid = readPid();
  if (currentPid && isPidRunning(currentPid)) {
    console.log(`已在后台运行 (PID ${currentPid})`);
    console.log(`日志: ${LOG_FILE}`);
    return;
  }

  cleanupPidFile();

  const stdoutFd = openSync(LOG_FILE, 'a', 0o600);
  const stderrFd = openSync(LOG_FILE, 'a', 0o600);
  const entryUrl = new URL('../index.js', import.meta.url);
  const nodeArgs = [entryUrl.pathname, ...extraArgs];

  const child = spawn(process.execPath, nodeArgs, {
    detached: true,
    stdio: ['ignore', stdoutFd, stderrFd],
    cwd: process.cwd(),
    env: { ...process.env },
  });

  child.unref();
  writeFileSync(PID_FILE, `${child.pid}\n`, { mode: 0o600 });

  console.log(`后台已启动 (PID ${child.pid})`);
  console.log(`日志: ${LOG_FILE}`);
}

function stopDaemon(opts: { quiet?: boolean } = {}): void {
  const pid = readPid();
  if (!pid) {
    if (!opts.quiet) console.log('后台未运行');
    return;
  }

  if (!isPidRunning(pid)) {
    cleanupPidFile();
    if (!opts.quiet) console.log('后台未运行（已清理旧 PID）');
    return;
  }

  process.kill(pid, 'SIGTERM');
  cleanupPidFile();
  if (!opts.quiet) console.log(`后台已停止 (PID ${pid})`);
}

function printStatus(): void {
  const pid = readPid();
  if (pid && isPidRunning(pid)) {
    console.log(`运行中 (PID ${pid})`);
    console.log(`日志: ${LOG_FILE}`);
    return;
  }

  cleanupPidFile();
  console.log('未运行');
}

function printLogs(): void {
  if (!existsSync(LOG_FILE)) {
    console.log('暂无日志');
    return;
  }

  const text = readFileSync(LOG_FILE, 'utf-8');
  const lines = text.trimEnd().split('\n');
  const tail = lines.slice(-80).join('\n');
  console.log(tail || '暂无日志');
}

function readPid(): number | null {
  if (!existsSync(PID_FILE)) return null;
  const raw = readFileSync(PID_FILE, 'utf-8').trim();
  const pid = Number.parseInt(raw, 10);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function isPidRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function cleanupPidFile(): void {
  if (existsSync(PID_FILE)) {
    unlinkSync(PID_FILE);
  }
}

function printUsage(): void {
  console.log(`用法: node dist/cli/daemon.js <start|stop|restart|status|logs> [--debug]

示例:
  npm run up
  npm run down
  npm run check
  npm run logs`);
}
