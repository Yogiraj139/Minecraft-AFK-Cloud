import { EventEmitter } from 'node:events';
import path from 'node:path';
import mineflayer from 'mineflayer';
import minecraftData from 'minecraft-data';
import minecraftProtocol from 'minecraft-protocol';
import { AfkEngine } from './afkEngine.js';
import { AuthLogin } from './authLogin.js';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cleanReason(reason) {
  if (!reason) {
    return '';
  }

  if (reason instanceof Error) {
    return reason.message;
  }

  if (typeof reason === 'string') {
    return reason.replace(/\s+/g, ' ').trim();
  }

  if (reason?.text) {
    return String(reason.text).replace(/\s+/g, ' ').trim();
  }

  if (reason?.value?.text?.value) {
    return String(reason.value.text.value).replace(/\s+/g, ' ').trim();
  }

  if (reason?.value?.translate?.value) {
    return String(reason.value.translate.value).replace(/\s+/g, ' ').trim();
  }

  try {
    return JSON.stringify(reason);
  } catch {
    return String(reason);
  }
}

function unique(values) {
  return [...new Set(values.filter((value) => value !== undefined && value !== null && value !== ''))];
}

function isSupportedVersion(version) {
  return version === false || minecraftProtocol.supportedVersions.includes(version);
}

function versionFromProtocol(protocol) {
  const versions = minecraftData.postNettyVersionsByProtocolVersion?.pc?.[String(protocol)] || [];
  const release = versions.find((entry) =>
    entry.releaseType === 'release' &&
    minecraftProtocol.supportedVersions.includes(entry.minecraftVersion)
  );

  return release?.minecraftVersion || null;
}

function parseVersionList(profile, config, pingResponse = null) {
  const explicit = Array.isArray(profile.versionFallbacks) ? profile.versionFallbacks : [];
  const fallback = explicit.length ? explicit : config.versionFallbacks;
  const pingVersion = versionFromProtocol(pingResponse?.version?.protocol);

  if (profile.version && profile.version !== 'auto') {
    return unique([profile.version, ...fallback.filter((version) => version !== profile.version)])
      .filter(isSupportedVersion);
  }

  return unique(pingVersion ? [pingVersion, ...fallback] : [false, ...fallback])
    .filter(isSupportedVersion);
}

function versionLabel(version) {
  return version || 'auto';
}

export class MinecraftBotManager extends EventEmitter {
  constructor({ db, logger, proxyManager, discordBridge, dataDir, config }) {
    super();
    this.db = db;
    this.logger = logger;
    this.proxyManager = proxyManager;
    this.discordBridge = discordBridge;
    this.dataDir = dataDir;
    this.config = config;
    this.bot = null;
    this.afkEngine = null;
    this.authLogin = null;
    this.reconnectTimer = null;
    this.timedMessageTimers = new Set();
    this.watchdogTimer = null;
    this.generation = 0;
    this.connectionLoopId = 0;
    this.fallbackInProgress = false;
    this.connectionStartedAt = 0;
    this.onlineSince = null;
    this.lastTimePacket = null;
    this.cpuSnapshot = process.cpuUsage();
    this.cpuSnapshotAt = Date.now();
    this.currentProfile = null;
    this.currentProxy = null;
    this.state = {
      status: 'offline',
      desired: false,
      profileId: null,
      profileName: '',
      host: '',
      port: null,
      username: '',
      displayName: '',
      dimension: '',
      ping: null,
      tps: null,
      uptimeSeconds: 0,
      reconnectAttempts: 0,
      reconnectAt: null,
      lastDisconnectReason: '',
      activeProxy: '',
      memoryMb: 0,
      cpuPercent: 0
    };
    this.startWatchdog();
  }

  getState() {
    const memory = process.memoryUsage();
    const now = Date.now();
    const cpu = process.cpuUsage();
    const elapsedMicros = Math.max((now - this.cpuSnapshotAt) * 1000, 1);
    const usedMicros = (cpu.user - this.cpuSnapshot.user) + (cpu.system - this.cpuSnapshot.system);

    if (now - this.cpuSnapshotAt >= 4000) {
      this.state.cpuPercent = Math.round((usedMicros / elapsedMicros) * 1000) / 10;
      this.cpuSnapshot = cpu;
      this.cpuSnapshotAt = now;
    }

    this.state.memoryMb = Math.round((memory.rss / 1024 / 1024) * 10) / 10;
    this.state.uptimeSeconds = this.onlineSince ? Math.floor((Date.now() - this.onlineSince) / 1000) : 0;

    if (this.bot?.player?.ping !== undefined) {
      this.state.ping = this.bot.player.ping;
    }

    if (this.bot?.game?.dimension) {
      this.state.dimension = this.bot.game.dimension;
    }

    return { ...this.state };
  }

  emitState() {
    const state = this.getState();
    this.emit('state', state);
    return state;
  }

  async restoreDesiredState() {
    const enabled = this.db.getSetting('bot.enabled', 'false') === 'true';

    if (!enabled) {
      return;
    }

    const profile = this.db.getDefaultProfile({ includeSecrets: true });

    if (!profile) {
      this.logger.warn('bot', 'Auto-start skipped because no profile exists');
      return;
    }

    await sleep(2500);
    await this.start(profile.id, { persist: false, reason: 'boot restore' });
  }

  async start(profileId, { persist = true, reason = 'manual start' } = {}) {
    const profile = this.db.getProfile(profileId, { includeSecrets: true });

    if (!profile) {
      throw new Error('Profile not found');
    }

    if (persist) {
      this.db.setSetting('bot.enabled', 'true');
      this.db.setSetting('bot.last_profile_id', String(profile.id));
    }

    this.state.desired = true;
    this.state.reconnectAttempts = 0;
    this.connectionLoopId += 1;
    this.fallbackInProgress = false;
    this.connectionStartedAt = Date.now();
    this.state.status = 'connecting';
    this.state.profileId = profile.id;
    this.state.profileName = profile.name;
    this.state.host = profile.host;
    this.state.port = profile.port;
    this.state.username = profile.username;
    this.state.displayName = '';
    this.state.dimension = '';
    this.state.ping = null;
    this.state.tps = null;
    this.state.reconnectAt = null;
    this.state.activeProxy = 'selecting';
    this.emitState();
    this.clearReconnect();
    await this.shutdownCurrentBot({ reason: 'starting selected profile' });
    this.currentProfile = profile;
    this.logger.info('bot', `Starting ${profile.username} on ${profile.host}:${profile.port}`, { reason });
    this.connectWithFallback(profile).catch((error) => {
      this.logger.error('bot', `Connection start failed: ${error.message}`);
      this.scheduleReconnect(error.message);
    });
  }

  async stop({ manual = true, persist = true, reason = 'manual stop' } = {}) {
    if (persist) {
      this.db.setSetting('bot.enabled', 'false');
    }

    if (manual) {
      this.state.desired = false;
    }

    this.clearReconnect();
    this.connectionLoopId += 1;
    this.fallbackInProgress = false;
    await this.shutdownCurrentBot({ reason });
    this.state.status = 'offline';
    this.state.reconnectAt = null;
    this.onlineSince = null;
    this.emitState();
  }

  async restart(reason = 'manual restart') {
    const profileId = this.currentProfile?.id || this.db.getSetting('bot.last_profile_id');
    const profile = profileId ? this.db.getProfile(profileId, { includeSecrets: true }) : this.db.getDefaultProfile({ includeSecrets: true });

    if (!profile) {
      throw new Error('No profile is available to restart');
    }

    await this.stop({ manual: false, persist: false, reason });
    this.state.desired = true;
    await sleep(1000);
    await this.start(profile.id, { persist: true, reason });
  }

  async forceReconnect(reason = 'forced reconnect') {
    const profileId = this.currentProfile?.id || this.db.getSetting('bot.last_profile_id');

    if (!profileId) {
      throw new Error('No profile is selected');
    }

    await this.stop({ manual: false, persist: false, reason });
    this.state.desired = true;
    await this.start(profileId, { persist: true, reason });
  }

  async killProcess() {
    this.logger.warn('process', 'Kill process requested from dashboard');
    await this.stop({ manual: false, persist: false, reason: 'process kill requested' });
    setTimeout(() => process.exit(1), 500).unref();
  }

  async sendChat(message) {
    const text = String(message || '').trim();

    if (!text) {
      throw new Error('Message is empty');
    }

    if (!this.bot || !['connecting', 'online'].includes(this.state.status)) {
      throw new Error('Bot is not connected yet');
    }

    this.bot.chat(text);
    this.logger.info('chat', `Sent: ${text}`);
  }

  async sendCommand(command) {
    const raw = String(command || '').trim();

    if (!raw) {
      throw new Error('Command is empty');
    }

    await this.sendChat(raw.startsWith('/') ? raw : `/${raw}`);
  }

  async runMacro(commands) {
    const lines = Array.isArray(commands)
      ? commands
      : String(commands || '').split(/\r?\n/);

    for (const line of lines.map((item) => String(item).trim()).filter(Boolean)) {
      await this.sendCommand(line);
      await sleep(900 + Math.floor(Math.random() * 700));
    }
  }

  async probeServer(profile) {
    return new Promise((resolve) => {
      minecraftProtocol.ping({
        host: profile.host,
        port: profile.port,
        closeTimeout: profile.loginTimeoutMs || 30000
      }, (error, response) => {
        if (error) {
          this.logger.warn('bot', `Server ping failed before join: ${error.message}`);
          resolve(null);
          return;
        }

        const version = response?.version?.name || 'unknown';
        const protocol = response?.version?.protocol || 'unknown';
        const mappedVersion = versionFromProtocol(response?.version?.protocol);
        const players = response?.players
          ? `${response.players.online}/${response.players.max}`
          : 'unknown';
        this.logger.info(
          'bot',
          `Server ping OK: ${version} protocol ${protocol}, players ${players}${mappedVersion ? `, mapped ${mappedVersion}` : ''}`
        );
        resolve(response);
      });
    });
  }

  async connectWithFallback(profile) {
    if (this.fallbackInProgress) {
      this.logger.warn('bot', 'Connection request ignored because a connection attempt is already running');
      return;
    }

    const loopId = ++this.connectionLoopId;
    this.fallbackInProgress = true;
    let versions = [];

    try {
      const pingResponse = await this.probeServer(profile);
      versions = parseVersionList(profile, this.config, pingResponse);

      if (!versions.length) {
        throw new Error('No supported Minecraft versions are configured');
      }

      this.logger.info('bot', `Version attempt order: ${versions.map(versionLabel).join(' -> ')}`);

      for (const version of versions) {
        if (!this.state.desired || loopId !== this.connectionLoopId) {
          return;
        }

        try {
          this.logger.info('bot', `Trying Minecraft join with version ${versionLabel(version)}`);
          await this.connect(profile, version);
          return;
        } catch (error) {
          this.logger.warn('bot', `Join attempt failed with ${versionLabel(version)}: ${error.message}`);
          await this.shutdownCurrentBot({ reason: `failed version ${versionLabel(version)}` });
          await sleep(1200);
        }
      }

      throw new Error('All configured Minecraft versions failed');
    } finally {
      if (loopId === this.connectionLoopId) {
        this.fallbackInProgress = false;
      }
    }
  }

  connect(profile, version) {
    return new Promise((resolve, reject) => {
      const generation = ++this.generation;
      const proxy = this.proxyManager.selectProxy(profile);
      this.currentProxy = proxy;
      this.connectionStartedAt = Date.now();
      this.lastTimePacket = null;
      this.state = {
        ...this.state,
        status: 'connecting',
        desired: true,
        profileId: profile.id,
        profileName: profile.name,
        host: profile.host,
        port: profile.port,
        username: profile.username,
        displayName: '',
        dimension: '',
        ping: null,
        tps: null,
        reconnectAt: null,
        activeProxy: proxy ? `${proxy.type}://${proxy.host}:${proxy.port}` : 'direct'
      };
      this.emitState();

      const options = {
        host: profile.host,
        port: profile.port,
        username: profile.username,
        auth: profile.authMode === 'microsoft' ? 'microsoft' : 'offline',
        profilesFolder: path.join(this.dataDir, 'minecraft-sessions'),
        checkTimeoutInterval: profile.loginTimeoutMs,
        connectTimeout: profile.loginTimeoutMs,
        closeTimeout: 10000,
        keepAlive: true,
        hideErrors: false
      };

      if (version) {
        options.version = version;
      }

      if (profile.minecraftPassword && profile.authMode !== 'microsoft') {
        options.password = profile.minecraftPassword;
      }

      if (proxy) {
        options.connect = this.proxyManager.createMinecraftConnect(proxy, profile.host, profile.port);
      }

      let settled = false;
      let loginAccepted = false;
      const clearAttemptTimers = () => {
        clearTimeout(loginTimeout);
        clearTimeout(spawnTimeout);
      };
      const settleReject = (error) => {
        if (settled || generation !== this.generation) {
          return;
        }

        settled = true;
        clearAttemptTimers();
        reject(error instanceof Error ? error : new Error(String(error)));
      };
      const spawnTimeout = setTimeout(() => {
        if (settled || generation !== this.generation) {
          return;
        }

        settleReject(new Error(`Spawn timed out after ${profile.spawnTimeoutMs}ms`));
        this.bot?.end?.();
      }, profile.spawnTimeoutMs);
      const configuredLoginTimeoutMs = Math.max(
        Number(profile.loginTimeoutMs || this.config.defaults.loginTimeoutMs || 15000),
        8000
      );
      const loginTimeoutMs = Math.min(configuredLoginTimeoutMs, 15000);
      const loginTimeout = setTimeout(() => {
        if (settled || loginAccepted || generation !== this.generation) {
          return;
        }

        settleReject(new Error(`Login packet timed out after ${loginTimeoutMs}ms`));
        this.bot?.end?.();
      }, loginTimeoutMs);
      spawnTimeout.unref();
      loginTimeout.unref();

      const bot = mineflayer.createBot(options);
      this.bot = bot;
      this.startAuthLogin(bot, profile);
      this.attachBotEvents(bot, profile, generation);

      bot.once('login', () => {
        loginAccepted = true;
        clearTimeout(loginTimeout);
      });

      bot.once('spawn', () => {
        clearAttemptTimers();

        if (generation !== this.generation) {
          return;
        }

        this.state.status = 'online';
        this.state.displayName = bot.username;
        this.state.dimension = bot.game?.dimension || '';
        this.onlineSince = Date.now();
        this.state.lastDisconnectReason = '';
        this.state.reconnectAttempts = 0;
        this.db.resetProxyFailure(proxy?.id);
        this.startAfk(bot, profile);
        this.startTimedMessages(profile);
        this.logger.info('bot', `${bot.username} spawned in ${this.state.dimension || 'world'}`);
        this.discordBridge.alert('Bot connected', `${profile.username} joined ${profile.host}:${profile.port}`);
        this.emitState();

        if (!settled) {
          settled = true;
          resolve();
        }
      });

        bot.once('error', (error) => {
        if (generation !== this.generation) {
          return;
        }

        if (!settled) {
          settleReject(error);
        }
      });

      bot.once('end', (reason) => {
        if (generation !== this.generation) {
          return;
        }

        clearAttemptTimers();

        if (!settled) {
          settleReject(new Error(cleanReason(reason) || 'Connection ended before spawn'));
        }
      });
    });
  }

  attachBotEvents(bot, profile, generation) {
    bot.on('login', () => {
      if (generation !== this.generation) return;
      this.logger.info('bot', `Login packet accepted using ${bot.version || 'auto-detected version'}`);
    });

    bot.on('messagestr', (message) => {
      if (generation !== this.generation) return;
      this.logger.info('chat', message);
    });

    bot.on('whisper', (username, message) => {
      if (generation !== this.generation) return;
      this.logger.info('chat', `[whisper] ${username}: ${message}`);
    });

    bot.on('death', () => {
      if (generation !== this.generation) return;
      this.logger.warn('bot', 'Bot died and will continue AFK after respawn');
    });

    bot.on('kicked', (reason) => {
      if (generation !== this.generation) return;
      const detail = cleanReason(reason);
      this.state.lastDisconnectReason = detail || 'Kicked';
      this.logger.warn('bot', `Kicked: ${this.state.lastDisconnectReason}`);
      this.discordBridge.alert('Bot kicked', this.state.lastDisconnectReason);
    });

    bot.on('error', (error) => {
      if (generation !== this.generation) return;
      this.logger.error('bot', error.message, { stack: error.stack });
    });

    bot.on('end', (reason) => {
      if (generation !== this.generation) return;
      const detail = cleanReason(reason) || this.state.lastDisconnectReason || 'Disconnected';
      this.state.status = 'offline';
      this.state.lastDisconnectReason = detail;
      this.onlineSince = null;
      this.stopRuntimeEngines();
      this.db.markProxyFailure(this.currentProxy?.id);
      this.logger.warn('bot', `Disconnected: ${detail}`);
      this.discordBridge.alert('Bot disconnected', detail);
      this.emitState();

      if (this.state.desired && !this.fallbackInProgress) {
        this.scheduleReconnect(detail);
      }
    });

    bot.on('time', () => {
      if (generation !== this.generation) return;
      const age = bot.time?.age;
      const now = Date.now();

      if (!Number.isFinite(age)) {
        return;
      }

      if (this.lastTimePacket) {
        const tickDelta = age - this.lastTimePacket.age;
        const secondDelta = (now - this.lastTimePacket.at) / 1000;

        if (tickDelta > 0 && secondDelta > 0) {
          this.state.tps = Math.round(Math.min(20, tickDelta / secondDelta) * 10) / 10;
        }
      }

      this.lastTimePacket = { age, at: now };
    });
  }

  startAfk(bot, profile) {
    this.afkEngine?.stop();
    this.afkEngine = new AfkEngine({
      bot,
      profile,
      config: this.config,
      logger: this.logger
    });
    this.afkEngine.start();
  }

  startAuthLogin(bot, profile) {
    this.authLogin?.stop();
    this.authLogin = new AuthLogin({
      bot,
      password: profile.serverAuthPassword,
      logger: this.logger
    });
    this.authLogin.start();
  }

  startTimedMessages(profile) {
    this.clearTimedMessages();

    for (const line of profile.timedMessages || []) {
      const match = String(line).match(/^(\d+)\s*:\s*(.+)$/);

      if (!match) {
        continue;
      }

      const intervalSeconds = Math.max(Number(match[1]), 30);
      const message = match[2].trim();
      const timer = setInterval(() => {
        if (this.state.status === 'online' && this.bot) {
          this.bot.chat(message);
          this.logger.info('chat', `Timed message sent: ${message}`);
        }
      }, intervalSeconds * 1000);

      timer.unref();
      this.timedMessageTimers.add(timer);
    }
  }

  clearTimedMessages() {
    for (const timer of this.timedMessageTimers) {
      clearInterval(timer);
    }

    this.timedMessageTimers.clear();
  }

  stopRuntimeEngines() {
    this.afkEngine?.stop();
    this.afkEngine = null;
    this.authLogin?.stop();
    this.authLogin = null;
    this.clearTimedMessages();
  }

  async shutdownCurrentBot({ reason }) {
    this.generation += 1;
    this.stopRuntimeEngines();

    if (!this.bot) {
      return;
    }

    const bot = this.bot;
    this.bot = null;

    try {
      bot.removeAllListeners('end');
      bot.removeAllListeners('error');
      bot.quit(reason || 'CloudAFK Pro X shutdown');
    } catch {
      try {
        bot.end();
      } catch {
        // Already closed.
      }
    }

    await sleep(350);
  }

  scheduleReconnect(reason) {
    if (this.reconnectTimer || !this.currentProfile || this.fallbackInProgress) {
      return;
    }

    const baseDelay = Math.max(this.currentProfile.reconnectDelayMs || 15000, 5000);
    const attempt = this.state.reconnectAttempts + 1;
    const backoff = Math.min(baseDelay * attempt, 5 * 60 * 1000);
    const jitter = Math.floor(Math.random() * Math.min(10000, baseDelay));
    const delay = backoff + jitter;

    this.state.reconnectAttempts = attempt;
    this.state.reconnectAt = new Date(Date.now() + delay).toISOString();
    this.logger.warn('bot', `Reconnect scheduled in ${Math.round(delay / 1000)}s`, { reason, attempt });
    this.emitState();

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;

      if (!this.state.desired || !this.currentProfile) {
        return;
      }

      const profile = this.db.getProfile(this.currentProfile.id, { includeSecrets: true });

      if (!profile) {
        this.logger.error('bot', 'Reconnect aborted because profile no longer exists');
        return;
      }

      this.currentProfile = profile;
      this.connectWithFallback(profile).catch((error) => {
        this.logger.error('bot', `Reconnect failed: ${error.message}`);
        this.scheduleReconnect(error.message);
      });
    }, delay);

    this.reconnectTimer.unref();
  }

  clearReconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  startWatchdog() {
    if (this.watchdogTimer) {
      return;
    }

    this.watchdogTimer = setInterval(() => {
      const state = this.getState();
      const maxRss = Number(process.env.MAX_RSS_MB || 0);

      if (maxRss > 0 && state.memoryMb > maxRss && state.desired) {
        this.logger.warn('watchdog', `RSS ${state.memoryMb}MB exceeded ${maxRss}MB; restarting bot`);
        this.restart('watchdog memory restart').catch((error) => {
          this.logger.error('watchdog', error.message);
        });
        return;
      }

      if (state.desired && state.status === 'offline' && !this.reconnectTimer && !this.fallbackInProgress) {
        this.scheduleReconnect('watchdog offline repair');
      }

      if (
        state.status === 'connecting' &&
        this.connectionStartedAt > 0 &&
        !this.fallbackInProgress &&
        Date.now() - this.connectionStartedAt > 90000
      ) {
        this.logger.warn('watchdog', 'Connection attempt stuck; forcing reconnect');
        this.forceReconnect('watchdog stuck connecting').catch((error) => {
          this.logger.error('watchdog', error.message);
        });
      }

      this.emitState();
    }, 10000);

    this.watchdogTimer.unref();
  }
}
