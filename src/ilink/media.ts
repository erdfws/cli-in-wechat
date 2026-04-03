/**
 * iLink Bot API — 媒体上传模块
 *
 * 上传流程:
 * 1. generateAESKey() → 随机 16 字节密钥
 * 2. encryptFile(buffer, key) → AES-128-ECB + PKCS7 加密
 * 3. getUploadUrl(credentials, params) → 获取 CDN 上传链接
 * 4. uploadToCDN(uploadUrl, encrypted) → 上传并取回 encrypt_query_param
 * 5. 用 encrypt_query_param + aesKey 构造 sendmessage 请求
 */

import { createCipheriv, randomBytes, createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { generateWechatUin } from '../utils/crypto.js';
import { log } from '../utils/logger.js';
import type { Credentials } from './types.js';

const CHANNEL_VERSION = '1.0.2';
const DEFAULT_CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c';

// ─── Media types ────────────────────────────────────────────

export const enum MediaType {
  IMAGE = 1,
  VIDEO = 2,
  FILE  = 3,
  VOICE = 4,
}

// ─── AES-128-ECB helpers ────────────────────────────────────

/** Generate a random 16-byte AES key */
export function generateAESKey(): Buffer {
  return randomBytes(16);
}

/** Generate a random filekey used by the CDN upload endpoint (32 hex chars). */
export function generateFileKey(): string {
  return randomBytes(16).toString('hex');
}

/** AES-128-ECB encrypt with PKCS7 padding */
export function encryptFile(plainBuffer: Buffer, key: Buffer): Buffer {
  const cipher = createCipheriv('aes-128-ecb', key, null);
  cipher.setAutoPadding(true);
  return Buffer.concat([cipher.update(plainBuffer), cipher.final()]);
}

/**
 * Encode AES key for the iLink protocol.
 * - Images: base64(raw 16 bytes)
 * - Files/Voice/Video: base64(hex string of 16 bytes)
 */
export function encodeAESKey(key: Buffer, mediaType: MediaType): string {
  if (mediaType === MediaType.IMAGE) {
    return key.toString('base64');
  }
  return Buffer.from(key.toString('hex')).toString('base64');
}

/** getUploadUrl expects the raw AES key as a hex string. */
export function encodeUploadAESKey(key: Buffer): string {
  return key.toString('hex');
}

// ─── File metadata helpers ──────────────────────────────────

export function getFileInfo(filePath: string) {
  const stat = statSync(filePath);
  const raw = readFileSync(filePath);
  const md5 = createHash('md5').update(raw).digest('hex');
  const name = basename(filePath);
  const ext = extname(filePath).toLowerCase();
  return { raw, size: stat.size, md5, name, ext };
}

/** Infer media type from file extension */
export function inferMediaType(ext: string): MediaType {
  const imageExts = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.svg', '.ico', '.tiff', '.tif'];
  const videoExts = ['.mp4', '.avi', '.mov', '.mkv', '.wmv', '.flv', '.webm', '.m4v'];
  const voiceExts = ['.mp3', '.wav', '.ogg', '.aac', '.m4a', '.wma', '.amr', '.silk'];
  if (imageExts.includes(ext)) return MediaType.IMAGE;
  if (videoExts.includes(ext)) return MediaType.VIDEO;
  if (voiceExts.includes(ext)) return MediaType.VOICE;
  return MediaType.FILE;
}

// ─── API: get upload URL ────────────────────────────────────

interface UploadUrlParams {
  filekey: string;
  mediaType: MediaType;
  toUserId: string;
  rawSize: number;
  rawFileMd5: string;
  fileSize: number;   // encrypted size
  aesKey: string;     // raw AES key as hex string
}

interface UploadUrlResponse {
  ret?: number;
  errmsg?: string;
  upload_url?: string;
  upload_full_url?: string;
  upload_param?: string;
  uploadUrl?: string;
  uploadFullUrl?: string;
  uploadParam?: string;
  file_key?: string;
}

export async function getUploadUrl(credentials: Credentials, params: UploadUrlParams): Promise<UploadUrlResponse> {
  const res = await fetch(`${credentials.baseUrl}/ilink/bot/getuploadurl`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'AuthorizationType': 'ilink_bot_token',
      'Authorization': `Bearer ${credentials.botToken}`,
      'X-WECHAT-UIN': generateWechatUin(),
    },
    body: JSON.stringify({
      filekey: params.filekey,
      media_type: params.mediaType,
      to_user_id: params.toUserId,
      rawsize: params.rawSize,
      rawfilemd5: params.rawFileMd5,
      filesize: params.fileSize,
      aeskey: params.aesKey,
      base_info: { channel_version: CHANNEL_VERSION },
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`getUploadUrl failed: HTTP ${res.status} ${body}`);
  }

  const data = await res.json() as UploadUrlResponse;
  if (data.ret !== undefined && data.ret !== 0) {
    throw new Error(`getUploadUrl failed: ${data.errmsg || `ret=${data.ret}`}`);
  }
  log.debug(`[media] getuploadurl response keys: ${Object.keys(data).join(', ')}`);
  return data;
}

// ─── API: upload to CDN ─────────────────────────────────────

export async function uploadToCDN(uploadUrl: string, encryptedBuffer: Buffer): Promise<string> {
  const res = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
    },
    body: new Uint8Array(encryptedBuffer),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`CDN upload failed: HTTP ${res.status} ${body}`);
  }

  // The CDN returns encrypt_query_param in the response header or body
  const encryptParam = res.headers.get('x-encrypted-param')
    || res.headers.get('x-encrypt-param');

  if (encryptParam) return encryptParam;

  // Try response body as JSON fallback
  try {
    const data = await res.json() as {
      encrypt_query_param?: string;
      encrypted_param?: string;
      download_param?: string;
      downloadParam?: string;
    };
    if (data.encrypt_query_param) return data.encrypt_query_param;
    if (data.encrypted_param) return data.encrypted_param;
    if (data.download_param) return data.download_param;
    if (data.downloadParam) return data.downloadParam;
  } catch { /* not JSON */ }

  // Some CDN impls return it as plain text
  const bodyText = await res.text().catch(() => '');
  if (bodyText && bodyText.length < 2000) return bodyText;

  throw new Error('CDN upload: no encrypt_query_param in response');
}

// ─── High-level: upload a local file ────────────────────────

export interface UploadResult {
  encryptQueryParam: string;
  aesKey: string;       // encoded for protocol
  rawAesKey: Buffer;
  mediaType: MediaType;
  fileName: string;
  fileSize: number;     // original size
  fileMd5: string;
}

export async function uploadFile(
  credentials: Credentials,
  filePath: string,
  toUserId: string,
): Promise<UploadResult> {
  const { raw, size, md5, name, ext } = getFileInfo(filePath);
  const mediaType = inferMediaType(ext);
  const key = generateAESKey();
  const messageAesKey = encodeAESKey(key, mediaType);
  const uploadAesKey = encodeUploadAESKey(key);
  const encrypted = encryptFile(raw, key);

  log.debug(`[media] uploading ${name} (${size} bytes, type=${mediaType})`);

  const filekey = generateFileKey();

  const uploadInfo = await getUploadUrl(credentials, {
    filekey,
    mediaType,
    toUserId,
    rawSize: size,
    rawFileMd5: md5,
    fileSize: encrypted.length,
    aesKey: uploadAesKey,
  });

  const uploadUrl = pickUploadUrl(uploadInfo, filekey);
  if (!uploadUrl) {
    throw new Error(`getUploadUrl returned no usable upload URL: ${safeJson(uploadInfo)}`);
  }

  const encryptQueryParam = await uploadToCDN(uploadUrl, encrypted);

  log.debug(`[media] upload complete: ${name}`);
  return {
    encryptQueryParam,
    aesKey: messageAesKey,
    rawAesKey: key,
    mediaType,
    fileName: name,
    fileSize: size,
    fileMd5: md5,
  };
}

function pickUploadUrl(uploadInfo: UploadUrlResponse, filekey: string): string | null {
  const direct = uploadInfo.upload_full_url || uploadInfo.uploadFullUrl || uploadInfo.upload_url || uploadInfo.uploadUrl;
  if (isHttpUrl(direct)) return direct;

  const param = uploadInfo.upload_param || uploadInfo.uploadParam;
  if (isHttpUrl(param)) return param;
  if (param) return buildUploadUrlFromParam(param, uploadInfo.file_key || filekey);

  return null;
}

function isHttpUrl(value?: string): value is string {
  return !!value && /^https?:\/\//i.test(value);
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return '[unserializable]';
  }
}

export function buildUploadUrlFromParam(uploadParam: string, filekey: string): string {
  const url = new URL(`${DEFAULT_CDN_BASE_URL}/upload`);
  url.searchParams.set('encrypted_query_param', uploadParam);
  url.searchParams.set('filekey', filekey);
  return url.toString();
}
