import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import { safeJsonParse } from './config.js';

function nowIso() {
  return new Date().toISOString();
}

function asInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function asNullableInteger(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  if (typeof value === 'boolean') {
    return value;
  }

  return ['true', '1', 'yes', 'on'].includes(String(value).toLowerCase());
}

function normalizeLines(value) {
  if (Array.isArray(value)) {
    return value.map((line) => String(line).trim()).filter(Boolean);
  }

  return String(value || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export function createDatabase({ dataDir, secretBox, config }) {
  fs.mkdirSync(dataDir, { recursive: true });
  const dbPath = path.join(dataDir, 'cloudafk.sqlite');
  const db = new Database(dbPath);

  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'admin',
      created_at TEXT NOT NULL,
      last_login_at TEXT
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS profiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      host TEXT NOT NULL,
      port INTEGER NOT NULL,
      username TEXT NOT NULL,
      auth_mode TEXT NOT NULL DEFAULT 'offline',
      minecraft_password_secret TEXT,
      server_auth_password_secret TEXT,
      version TEXT NOT NULL DEFAULT 'auto',
      version_fallbacks_json TEXT NOT NULL DEFAULT '[]',
      reconnect_delay_ms INTEGER NOT NULL DEFAULT 15000,
      spawn_timeout_ms INTEGER NOT NULL DEFAULT 45000,
      login_timeout_ms INTEGER NOT NULL DEFAULT 30000,
      proxy_mode TEXT NOT NULL DEFAULT 'disabled',
      proxy_id INTEGER REFERENCES proxies(id) ON DELETE SET NULL,
      afk_profile TEXT NOT NULL DEFAULT 'human-like',
      afk_config_json TEXT NOT NULL DEFAULT '{}',
      schedule_json TEXT NOT NULL DEFAULT '{}',
      chat_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS proxies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      host TEXT NOT NULL,
      port INTEGER NOT NULL,
      username TEXT,
      password_secret TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      failure_count INTEGER NOT NULL DEFAULT 0,
      last_failure_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      level TEXT NOT NULL,
      type TEXT NOT NULL,
      message TEXT NOT NULL,
      meta_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      sid TEXT PRIMARY KEY,
      sess TEXT NOT NULL,
      expires INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_logs_created_at ON logs(created_at);
    CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires);
  `);

  const api = {
    raw: db,
    dataDir,
    secretBox,

    ensureAdminUser() {
      const username = (process.env.ADMIN_USERNAME || 'admin').trim();
      const existing = db.prepare('SELECT * FROM users WHERE username = ?').get(username);

      if (existing) {
        return existing;
      }

      const suppliedHash = process.env.ADMIN_PASSWORD_HASH?.trim();
      const suppliedPassword = process.env.ADMIN_PASSWORD?.trim();
      let password = suppliedPassword;
      let hash = suppliedHash;

      if (!hash && !password) {
        password = crypto.randomBytes(18).toString('base64url');
        const bootstrapPath = path.join(dataDir, 'bootstrap-admin.txt');
        fs.writeFileSync(
          bootstrapPath,
          `CloudAFK Pro X bootstrap login\nusername=${username}\npassword=${password}\n`,
          { mode: 0o600 }
        );
        console.warn(`CloudAFK Pro X generated a bootstrap dashboard password at ${bootstrapPath}`);
      }

      if (!hash) {
        hash = bcrypt.hashSync(password, 12);
      }

      db.prepare(`
        INSERT INTO users (username, password_hash, role, created_at)
        VALUES (?, ?, 'admin', ?)
      `).run(username, hash, nowIso());

      return db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    },

    verifyUser(username, password) {
      const user = db.prepare('SELECT * FROM users WHERE username = ?').get(String(username || '').trim());

      if (!user || !bcrypt.compareSync(String(password || ''), user.password_hash)) {
        return null;
      }

      db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(nowIso(), user.id);
      return user;
    },

    getUserById(id) {
      return db.prepare('SELECT id, username, role, created_at, last_login_at FROM users WHERE id = ?').get(id);
    },

    getSetting(key, fallback = null) {
      const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
      return row ? row.value : fallback;
    },

    setSetting(key, value) {
      db.prepare(`
        INSERT INTO settings (key, value, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      `).run(key, String(value), nowIso());
    },

    getOrCreateRuntimeSecret(key, preferred) {
      if (preferred && String(preferred).trim().length >= 32) {
        return String(preferred).trim();
      }

      const existing = api.getSetting(key);

      if (existing) {
        return existing;
      }

      const generated = crypto.randomBytes(48).toString('hex');
      api.setSetting(key, generated);
      return generated;
    },

    listProfiles({ includeSecrets = false } = {}) {
      return db.prepare('SELECT * FROM profiles ORDER BY name COLLATE NOCASE ASC').all()
        .map((row) => api.profileFromRow(row, { includeSecrets }));
    },

    getProfile(id, { includeSecrets = false } = {}) {
      const row = db.prepare('SELECT * FROM profiles WHERE id = ?').get(id);
      return row ? api.profileFromRow(row, { includeSecrets }) : null;
    },

    getDefaultProfile({ includeSecrets = false } = {}) {
      const lastId = api.getSetting('bot.last_profile_id');
      const lastProfile = lastId ? api.getProfile(lastId, { includeSecrets }) : null;

      if (lastProfile) {
        return lastProfile;
      }

      const row = db.prepare('SELECT * FROM profiles ORDER BY updated_at DESC, id DESC LIMIT 1').get();
      return row ? api.profileFromRow(row, { includeSecrets }) : null;
    },

    saveProfile(input) {
      const existing = input.id ? db.prepare('SELECT * FROM profiles WHERE id = ?').get(input.id) : null;
      const timestamp = nowIso();
      const schedule = {
        scheduledStart: String(input.scheduledStart || '').trim(),
        dailyRestartTime: String(input.dailyRestartTime || '').trim(),
        reconnectEveryHours: asInteger(input.reconnectEveryHours, 0)
      };
      const chat = {
        timedMessages: normalizeLines(input.timedMessages),
        macroCommands: normalizeLines(input.macroCommands)
      };
      const versionFallbacks = normalizeLines(input.versionFallbacks || config.versionFallbacks);
      const afkConfig = typeof input.afkConfig === 'object'
        ? input.afkConfig
        : safeJsonParse(input.afkConfigJson, {});
      const values = {
        name: String(input.name || '').trim(),
        host: String(input.host || '').trim(),
        port: asInteger(input.port, config.defaultMinecraftPort),
        username: String(input.username || '').trim(),
        authMode: ['offline', 'microsoft'].includes(input.authMode) ? input.authMode : 'offline',
        version: String(input.version || 'auto').trim() || 'auto',
        versionFallbacksJson: JSON.stringify(versionFallbacks),
        reconnectDelayMs: asInteger(input.reconnectDelayMs, config.defaults.reconnectDelayMs),
        spawnTimeoutMs: asInteger(input.spawnTimeoutMs, config.defaults.spawnTimeoutMs),
        loginTimeoutMs: asInteger(input.loginTimeoutMs, config.defaults.loginTimeoutMs),
        proxyMode: ['disabled', 'fixed', 'rotate'].includes(input.proxyMode) ? input.proxyMode : 'disabled',
        proxyId: asNullableInteger(input.proxyId),
        afkProfile: String(input.afkProfile || config.defaults.afkProfile).trim(),
        afkConfigJson: JSON.stringify(afkConfig),
        scheduleJson: JSON.stringify(schedule),
        chatJson: JSON.stringify(chat),
        updatedAt: timestamp
      };

      if (!values.name) {
        throw new Error('Profile name is required');
      }

      if (!values.host) {
        throw new Error('Server IP or hostname is required');
      }

      if (!values.username) {
        throw new Error('Minecraft username is required');
      }

      const minecraftSecret = input.clearMinecraftPassword
        ? null
        : input.minecraftPassword
          ? secretBox.encrypt(input.minecraftPassword)
          : existing?.minecraft_password_secret || null;
      const serverAuthSecret = input.clearServerAuthPassword
        ? null
        : input.serverAuthPassword
          ? secretBox.encrypt(input.serverAuthPassword)
          : existing?.server_auth_password_secret || null;

      if (existing) {
        db.prepare(`
          UPDATE profiles
          SET name = ?, host = ?, port = ?, username = ?, auth_mode = ?,
              minecraft_password_secret = ?, server_auth_password_secret = ?,
              version = ?, version_fallbacks_json = ?, reconnect_delay_ms = ?,
              spawn_timeout_ms = ?, login_timeout_ms = ?, proxy_mode = ?, proxy_id = ?,
              afk_profile = ?, afk_config_json = ?, schedule_json = ?, chat_json = ?,
              updated_at = ?
          WHERE id = ?
        `).run(
          values.name,
          values.host,
          values.port,
          values.username,
          values.authMode,
          minecraftSecret,
          serverAuthSecret,
          values.version,
          values.versionFallbacksJson,
          values.reconnectDelayMs,
          values.spawnTimeoutMs,
          values.loginTimeoutMs,
          values.proxyMode,
          values.proxyId,
          values.afkProfile,
          values.afkConfigJson,
          values.scheduleJson,
          values.chatJson,
          values.updatedAt,
          existing.id
        );

        return api.getProfile(existing.id, { includeSecrets: false });
      }

      const result = db.prepare(`
        INSERT INTO profiles (
          name, host, port, username, auth_mode, minecraft_password_secret,
          server_auth_password_secret, version, version_fallbacks_json,
          reconnect_delay_ms, spawn_timeout_ms, login_timeout_ms, proxy_mode, proxy_id,
          afk_profile, afk_config_json, schedule_json, chat_json, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        values.name,
        values.host,
        values.port,
        values.username,
        values.authMode,
        minecraftSecret,
        serverAuthSecret,
        values.version,
        values.versionFallbacksJson,
        values.reconnectDelayMs,
        values.spawnTimeoutMs,
        values.loginTimeoutMs,
        values.proxyMode,
        values.proxyId,
        values.afkProfile,
        values.afkConfigJson,
        values.scheduleJson,
        values.chatJson,
        timestamp,
        timestamp
      );

      return api.getProfile(result.lastInsertRowid, { includeSecrets: false });
    },

    deleteProfile(id) {
      db.prepare('DELETE FROM profiles WHERE id = ?').run(id);
    },

    profileFromRow(row, { includeSecrets = false } = {}) {
      const schedule = safeJsonParse(row.schedule_json, {});
      const chat = safeJsonParse(row.chat_json, {});

      return {
        id: row.id,
        name: row.name,
        host: row.host,
        port: row.port,
        username: row.username,
        authMode: row.auth_mode,
        minecraftPassword: includeSecrets && row.minecraft_password_secret ? secretBox.decrypt(row.minecraft_password_secret) : '',
        serverAuthPassword: includeSecrets && row.server_auth_password_secret ? secretBox.decrypt(row.server_auth_password_secret) : '',
        hasMinecraftPassword: Boolean(row.minecraft_password_secret),
        hasServerAuthPassword: Boolean(row.server_auth_password_secret),
        version: row.version,
        versionFallbacks: safeJsonParse(row.version_fallbacks_json, []),
        reconnectDelayMs: row.reconnect_delay_ms,
        spawnTimeoutMs: row.spawn_timeout_ms,
        loginTimeoutMs: row.login_timeout_ms,
        proxyMode: row.proxy_mode,
        proxyId: row.proxy_id,
        afkProfile: row.afk_profile,
        afkConfig: safeJsonParse(row.afk_config_json, {}),
        scheduledStart: schedule.scheduledStart || '',
        dailyRestartTime: schedule.dailyRestartTime || '',
        reconnectEveryHours: Number(schedule.reconnectEveryHours || 0),
        timedMessages: chat.timedMessages || [],
        macroCommands: chat.macroCommands || [],
        createdAt: row.created_at,
        updatedAt: row.updated_at
      };
    },

    listProxies({ includeSecrets = false } = {}) {
      return db.prepare('SELECT * FROM proxies ORDER BY id DESC').all()
        .map((row) => api.proxyFromRow(row, { includeSecrets }));
    },

    getProxy(id, { includeSecrets = false } = {}) {
      const row = db.prepare('SELECT * FROM proxies WHERE id = ?').get(id);
      return row ? api.proxyFromRow(row, { includeSecrets }) : null;
    },

    saveProxy(input) {
      const timestamp = nowIso();
      const result = db.prepare(`
        INSERT INTO proxies (name, type, host, port, username, password_secret, enabled, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.name,
        input.type,
        input.host,
        input.port,
        input.username || null,
        input.password ? secretBox.encrypt(input.password) : null,
        parseBoolean(input.enabled, true) ? 1 : 0,
        timestamp,
        timestamp
      );

      return api.getProxy(result.lastInsertRowid);
    },

    deleteProxy(id) {
      db.prepare('DELETE FROM proxies WHERE id = ?').run(id);
    },

    markProxyFailure(id) {
      if (!id) {
        return;
      }

      db.prepare(`
        UPDATE proxies
        SET failure_count = failure_count + 1, last_failure_at = ?, updated_at = ?
        WHERE id = ?
      `).run(nowIso(), nowIso(), id);
    },

    resetProxyFailure(id) {
      if (!id) {
        return;
      }

      db.prepare(`
        UPDATE proxies
        SET failure_count = 0, last_failure_at = NULL, updated_at = ?
        WHERE id = ?
      `).run(nowIso(), id);
    },

    proxyFromRow(row, { includeSecrets = false } = {}) {
      return {
        id: row.id,
        name: row.name,
        type: row.type,
        host: row.host,
        port: row.port,
        username: row.username || '',
        password: includeSecrets && row.password_secret ? secretBox.decrypt(row.password_secret) : '',
        hasPassword: Boolean(row.password_secret),
        enabled: Boolean(row.enabled),
        failureCount: row.failure_count,
        lastFailureAt: row.last_failure_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at
      };
    },

    insertLog({ level, type, message, meta }) {
      const result = db.prepare(`
        INSERT INTO logs (level, type, message, meta_json, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(level, type, message, JSON.stringify(meta || {}), nowIso());

      return {
        id: result.lastInsertRowid,
        level,
        type,
        message,
        meta: meta || {},
        createdAt: nowIso()
      };
    },

    listLogs(limit = 200) {
      return db.prepare('SELECT * FROM logs ORDER BY id DESC LIMIT ?').all(Math.min(Number(limit) || 200, 1000))
        .reverse()
        .map((row) => ({
          id: row.id,
          level: row.level,
          type: row.type,
          message: row.message,
          meta: safeJsonParse(row.meta_json, {}),
          createdAt: row.created_at
        }));
    },

    pruneLogs(maxRows) {
      db.prepare(`
        DELETE FROM logs
        WHERE id NOT IN (
          SELECT id FROM logs ORDER BY id DESC LIMIT ?
        )
      `).run(maxRows);
    }
  };

  api.ensureAdminUser();

  return api;
}
