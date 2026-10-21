import { env } from 'cloudflare:workers';

function bytesToBase64(bytes: Uint8Array) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string) {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function encryptionKey() {
  const secret = env.FEISHU_TOKEN_ENCRYPTION_KEY;
  if (!secret) throw new Error('FEISHU_TOKEN_ENCRYPTION_KEY_NOT_CONFIGURED');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
  return crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function sealSecret(value: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    await encryptionKey(),
    new TextEncoder().encode(value),
  );
  return `v1.${bytesToBase64(iv)}.${bytesToBase64(new Uint8Array(encrypted))}`;
}

export async function openSecret(value: string) {
  const [version, iv, encrypted] = value.split('.');
  if (version !== 'v1' || !iv || !encrypted) throw new Error('INVALID_ENCRYPTED_SECRET');
  const clear = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: base64ToBytes(iv) },
    await encryptionKey(),
    base64ToBytes(encrypted),
  );
  return new TextDecoder().decode(clear);
}

export async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
