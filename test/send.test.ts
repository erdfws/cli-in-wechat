import test from 'node:test';
import assert from 'node:assert/strict';

// ─── Argument parsing tests ─────────────────────────────

function parseArgs(args: string[]): { targetUser: string | null; accountId: string | null; message: string } {
  let targetUser: string | null = null;
  let accountId: string | null = null;
  const messageParts: string[] = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-u' || args[i] === '--user') {
      if (i + 1 >= args.length) {
        throw new Error('-u 需要指定用户 ID');
      }
      targetUser = args[++i];
    } else if (args[i] === '-a' || args[i] === '--account') {
      if (i + 1 >= args.length) {
        throw new Error('-a 需要指定账号 ID');
      }
      accountId = args[++i];
    } else {
      messageParts.push(args[i]);
    }
  }

  return { targetUser, accountId, message: messageParts.join(' ') };
}

test('parseArgs: plain message', () => {
  const result = parseArgs(['hello', 'world']);
  assert.equal(result.message, 'hello world');
  assert.equal(result.targetUser, null);
  assert.equal(result.accountId, null);
});

test('parseArgs: -u flag before message', () => {
  const result = parseArgs(['-u', 'wx123', 'hello']);
  assert.equal(result.message, 'hello');
  assert.equal(result.targetUser, 'wx123');
  assert.equal(result.accountId, null);
});

test('parseArgs: -u flag after message', () => {
  const result = parseArgs(['hello', '-u', 'wx123']);
  assert.equal(result.message, 'hello');
  assert.equal(result.targetUser, 'wx123');
  assert.equal(result.accountId, null);
});

test('parseArgs: --user long flag', () => {
  const result = parseArgs(['--user', 'wx456', 'test', 'message']);
  assert.equal(result.message, 'test message');
  assert.equal(result.targetUser, 'wx456');
  assert.equal(result.accountId, null);
});

test('parseArgs: -u without value throws', () => {
  assert.throws(() => parseArgs(['-u']), { message: '-u 需要指定用户 ID' });
});

test('parseArgs: empty args', () => {
  const result = parseArgs([]);
  assert.equal(result.message, '');
  assert.equal(result.targetUser, null);
  assert.equal(result.accountId, null);
});

test('parseArgs: multiple words with -u in middle', () => {
  const result = parseArgs(['hello', '-u', 'wx789', 'world', 'test']);
  assert.equal(result.message, 'hello world test');
  assert.equal(result.targetUser, 'wx789');
  assert.equal(result.accountId, null);
});

test('parseArgs: account flag', () => {
  const result = parseArgs(['--account', 'acc001', 'hello']);
  assert.equal(result.message, 'hello');
  assert.equal(result.accountId, 'acc001');
  assert.equal(result.targetUser, null);
});

test('parseArgs: account flag without value throws', () => {
  assert.throws(() => parseArgs(['--account']), { message: '-a 需要指定账号 ID' });
});
