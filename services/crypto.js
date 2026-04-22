import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

function normalizeSecret(secret) {
  if (!secret) {
    return null;
  }

  const trimmed = String(secret).trim();

  if (/^[a-f0-9]{64}$/i.test(trimmed)) {
    return Buffer.from(trimmed, 'hex');
  }

  return crypto.createHash('sha256').update(trimmed).digest();
}

function ensureRuntimeSecret(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const secretPath = path.join(dataDir, 'app-secret.key');

  if (fs.existsSync(secretPath)) {
    return normalizeSecret(fs.readFileSync(secretPath, 'utf8'));
  }

  const secret = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(secretPath, `${secret}\n`, { mode: 0o600 });
  return Buffer.from(secret, 'hex');
}

export function createSecretBox({ dataDir, appSecret }) {
  const key = normalizeSecret(appSecret) || ensureRuntimeSecret(dataDir);

  return {
    encrypt(value) {
      if (value === null || value === undefined || value === '') {
        return null;
      }

      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const encrypted = Buffer.concat([
        cipher.update(String(value), 'utf8'),
        cipher.final()
      ]);
      const tag = cipher.getAuthTag();

      return `v1:${iv.toString('base64url')}:${tag.toString('base64url')}:${encrypted.toString('base64url')}`;
    },

    decrypt(payload) {
      if (!payload) {
        return '';
      }

      const [version, ivRaw, tagRaw, encryptedRaw] = String(payload).split(':');

      if (version !== 'v1' || !ivRaw || !tagRaw || !encryptedRaw) {
        throw new Error('Stored secret is not in a supported format');
      }

      const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivRaw, 'base64url'));
      decipher.setAuthTag(Buffer.from(tagRaw, 'base64url'));

      return Buffer.concat([
        decipher.update(Buffer.from(encryptedRaw, 'base64url')),
        decipher.final()
      ]).toString('utf8');
    }
  };
}

export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}
