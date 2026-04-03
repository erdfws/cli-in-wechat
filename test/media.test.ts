import test from 'node:test';
import assert from 'node:assert/strict';

import { buildUploadUrlFromParam, encodeUploadAESKey, generateFileKey } from '../src/ilink/media.js';

test('buildUploadUrlFromParam matches official encrypted_query_param format', () => {
  const url = new URL(buildUploadUrlFromParam('abc+/=', 'deadbeef'));

  assert.equal(url.origin + url.pathname, 'https://novac2c.cdn.weixin.qq.com/c2c/upload');
  assert.equal(url.searchParams.get('encrypted_query_param'), 'abc+/=');
  assert.equal(url.searchParams.get('filekey'), 'deadbeef');
});

test('encodeUploadAESKey returns lowercase hex string', () => {
  const key = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
  assert.equal(encodeUploadAESKey(key), '00112233445566778899aabbccddeeff');
});

test('generateFileKey returns 32 hex chars', () => {
  const fileKey = generateFileKey();
  assert.match(fileKey, /^[0-9a-f]{32}$/);
});
