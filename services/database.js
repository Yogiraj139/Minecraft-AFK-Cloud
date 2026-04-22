import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_DATA = {
  nextProfileId: 1,
  nextProxyId: 1,
  settings: {},
  profiles: [],
  proxies: [],
  logs: []
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function number(value, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(Math.max(parsed, min), max) : fallback;
}

function lines(value) {
  if (Array.isArray(value)) return value.map(String).map((line) => line.trim()).filter(Boolean);
  return String(value || '').split(/\r?\n|,/).map((line) => line.trim()).filter(Boolean);
}

function parseJson(value, fallback = {}) {
  if (typeof value === 'object' && value !== null) return value;
  try {
    return JSON.parse(String(value || '{}'));
  } catch {
    return fallback;
  }
}

export class Database {
  constructor({ dataDir, cryptoBox, maxLogRows = 2500 }) {
    this.dataDir = dataDir;
    this.cryptoBox = cryptoBox;
    this.maxLogRows = maxLogRows;
    this.file = path.join(dataDir, 'cloudafk-db.json');
    this.data = clone(DEFAULT_DATA);
  }

  init() {
    fs.mkdirSync(this.dataDir, { recursive: true });
    if (fs.existsSync(this.file)) {
      this.data = { ...clone(DEFAULT_DATA), ...JSON.parse(fs.readFileSync(this.file, 'utf8')) };
    } else {
      this.write();
    }
  }

  write() {
    const temp = `${this.file}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(this.data, null, 2));
    fs.renameSync(temp, this.file);
  }

  setSetting(key, value) {
    this.data.settings[key] = String(value);
    this.write();
  }

  getSetting(key, fallback = '') {
    return Object.prototype.hasOwnProperty.call(this.data.settings, key) ? this.data.settings[key] : fallback;
  }

  addLog(entry) {
    const row = {
      id: Date.now() + Math.random(),
      createdAt: new Date().toISOString(),
      level: entry.level || 'info',
      type: entry.type || 'system',
      message: String(entry.message || ''),
      meta: entry.meta || null
    };
    this.data.logs.push(row);
    this.data.logs = this.data.logs.slice(-this.maxLogRows);
    this.write();
    return row;
  }

  listLogs(limit = 200) {
    return this.data.logs.slice(-Math.max(1, Math.min(Number(limit) || 200, 1000)));
  }

  profileFromRow(row, { includeSecrets = false } = {}) {
    const profile = clone(row);
    profile.minecraftPassword = includeSecrets ? this.cryptoBox.decrypt(row.minecraftPasswordEncrypted) : '';
    profile.serverAuthPassword = includeSecrets ? this.cryptoBox.decrypt(row.serverAuthPasswordEncrypted) : '';
    delete profile.minecraftPasswordEncrypted;
    delete profile.serverAuthPasswordEncrypted;
    return profile;
  }

  listProfiles(options = {}) {
    return this.data.profiles.map((profile) => this.profileFromRow(profile, options));
  }

  getProfile(id, options = {}) {
    const profile = this.data.profiles.find((item) => item.id === Number(id));
    return profile ? this.profileFromRow(profile, options) : null;
  }

  getDefaultProfile(options = {}) {
    const id = Number(this.getSetting('bot.last_profile_id', 0));
    return this.getProfile(id, options) || (this.data.profiles[0] ? this.profileFromRow(this.data.profiles[0], options) : null);
  }

  saveProfile(input) {
    const id = Number(input.id || 0);
    const existing = id ? this.data.profiles.find((item) => item.id === id) : null;
    const profile = existing || { id: this.data.nextProfileId++ };
    const previous = existing || {};

    profile.name = String(input.name || previous.name || 'Rvxth Bot').trim();
    profile.host = String(input.host || previous.host || '').trim();
    profile.port = number(input.port ?? previous.port, 25565, 1, 65535);
    profile.username = String(input.username || previous.username || '').trim();
    profile.authMode = input.authMode === 'microsoft' ? 'microsoft' : 'offline';
    profile.version = String(input.version ?? previous.version ?? 'auto').trim() || 'auto';
    profile.versionFallbacks = lines(input.versionFallbacks ?? previous.versionFallbacks);
    profile.reconnectDelayMs = number(input.reconnectDelayMs ?? previous.reconnectDelayMs, 15000, 5000, 600000);
    profile.spawnTimeoutMs = number(input.spawnTimeoutMs ?? previous.spawnTimeoutMs, 45000, 10000, 180000);
    profile.loginTimeoutMs = number(input.loginTimeoutMs ?? previous.loginTimeoutMs, 15000, 8000, 60000);
    profile.proxyMode = ['disabled', 'fixed', 'rotate'].includes(input.proxyMode) ? input.proxyMode : (previous.proxyMode || 'disabled');
    profile.proxyId = input.proxyId ? Number(input.proxyId) : null;
    profile.afkProfile = String(input.afkProfile || previous.afkProfile || 'passive');
    profile.afkConfig = parseJson(input.afkConfigJson ?? input.afkConfig ?? previous.afkConfig, previous.afkConfig || {});
    profile.scheduledStart = String(input.scheduledStart || '');
    profile.dailyRestartTime = String(input.dailyRestartTime || '');
    profile.reconnectEveryHours = number(input.reconnectEveryHours ?? previous.reconnectEveryHours, 0, 0, 168);
    profile.timedMessages = lines(input.timedMessages ?? previous.timedMessages);
    profile.macroCommands = lines(input.macroCommands ?? previous.macroCommands);

    if (input.minecraftPassword) profile.minecraftPasswordEncrypted = this.cryptoBox.encrypt(input.minecraftPassword);
    else if (input.clearMinecraftPassword) profile.minecraftPasswordEncrypted = '';
    else profile.minecraftPasswordEncrypted = previous.minecraftPasswordEncrypted || '';

    if (input.serverAuthPassword) profile.serverAuthPasswordEncrypted = this.cryptoBox.encrypt(input.serverAuthPassword);
    else if (input.clearServerAuthPassword) profile.serverAuthPasswordEncrypted = '';
    else profile.serverAuthPasswordEncrypted = previous.serverAuthPasswordEncrypted || '';

    if (!profile.host || !profile.username) throw new Error('Server IP and username are required');
    if (!existing) this.data.profiles.push(profile);
    this.setSetting('bot.last_profile_id', String(profile.id));
    this.write();
    return this.profileFromRow(profile);
  }

  deleteProfile(id) {
    this.data.profiles = this.data.profiles.filter((item) => item.id !== Number(id));
    this.write();
  }

  proxyFromRow(row, { includeSecrets = false } = {}) {
    const proxy = clone(row);
    proxy.password = includeSecrets ? this.cryptoBox.decrypt(row.passwordEncrypted) : '';
    delete proxy.passwordEncrypted;
    return proxy;
  }

  listProxies(options = {}) {
    return this.data.proxies.map((proxy) => this.proxyFromRow(proxy, options));
  }

  getProxy(id, options = {}) {
    const proxy = this.data.proxies.find((item) => item.id === Number(id));
    return proxy ? this.proxyFromRow(proxy, options) : null;
  }

  saveProxy(input) {
    const duplicate = this.data.proxies.find((item) => item.type === input.type && item.host === input.host && item.port === input.port && item.username === input.username);
    const proxy = duplicate || { id: this.data.nextProxyId++, failureCount: 0, lastFailureAt: '' };
    proxy.name = input.name || `${String(input.type).toUpperCase()} ${input.host}:${input.port}`;
    proxy.type = input.type;
    proxy.host = input.host;
    proxy.port = number(input.port, 0, 1, 65535);
    proxy.username = input.username || '';
    proxy.passwordEncrypted = input.password ? this.cryptoBox.encrypt(input.password) : (proxy.passwordEncrypted || '');
    proxy.enabled = input.enabled !== false;
    if (!duplicate) this.data.proxies.push(proxy);
    this.write();
    return this.proxyFromRow(proxy);
  }

  deleteProxy(id) {
    this.data.proxies = this.data.proxies.filter((item) => item.id !== Number(id));
    for (const profile of this.data.profiles) {
      if (profile.proxyId === Number(id)) profile.proxyId = null;
    }
    this.write();
  }

  markProxyFailure(id) {
    if (!id) return;
    const proxy = this.data.proxies.find((item) => item.id === Number(id));
    if (!proxy) return;
    proxy.failureCount = Number(proxy.failureCount || 0) + 1;
    proxy.lastFailureAt = new Date().toISOString();
    this.write();
  }

  resetProxyFailure(id) {
    if (!id) return;
    const proxy = this.data.proxies.find((item) => item.id === Number(id));
    if (!proxy) return;
    proxy.failureCount = 0;
    this.write();
  }
}
