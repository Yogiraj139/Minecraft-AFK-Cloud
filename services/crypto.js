import crypto from 'node:crypto';

function keyFromSecret(secret) {
  return crypto.createHash('sha256').update(String(secret || 'cloudafk-local-dev-secret')).digest();
}

export class CryptoBox {
  constructor(secret) {
    this.key = keyFromSecret(secret);
  }

  encrypt(value) {
    const text = String(value || '');
    if (!text) return '';
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url');
  }

  decrypt(value) {
    const raw = String(value || '');
    if (!raw) return '';
    try {
      const buffer = Buffer.from(raw, 'base64url');
      const iv = buffer.subarray(0, 12);
      const tag = buffer.subarray(12, 28);
      const encrypted = buffer.subarray(28);
      const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
    } catch {
      return '';
    }
  }
}
