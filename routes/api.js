import express from 'express';
import { requireAuth, requireCsrf } from './auth.js';

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

function ok(res, data = {}) {
  res.json({ ok: true, ...data });
}

function normalizeProfileBody(body) {
  return {
    id: body.id ? Number(body.id) : undefined,
    name: body.name,
    host: body.host,
    port: body.port,
    username: body.username,
    authMode: body.authMode,
    minecraftPassword: body.minecraftPassword,
    clearMinecraftPassword: body.clearMinecraftPassword,
    serverAuthPassword: body.serverAuthPassword,
    clearServerAuthPassword: body.clearServerAuthPassword,
    version: body.version,
    versionFallbacks: body.versionFallbacks,
    reconnectDelayMs: body.reconnectDelayMs,
    spawnTimeoutMs: body.spawnTimeoutMs,
    loginTimeoutMs: body.loginTimeoutMs,
    proxyMode: body.proxyMode,
    proxyId: body.proxyId,
    afkProfile: body.afkProfile,
    afkConfigJson: body.afkConfigJson,
    scheduledStart: body.scheduledStart,
    dailyRestartTime: body.dailyRestartTime,
    reconnectEveryHours: body.reconnectEveryHours,
    timedMessages: body.timedMessages,
    macroCommands: body.macroCommands
  };
}

export function apiRoutes({ db, botManager, proxyManager, logger, config }) {
  const router = express.Router();
  router.use(requireAuth, requireCsrf);

  router.get('/state', (req, res) => ok(res, { state: botManager.getState() }));
  router.get('/logs', (req, res) => ok(res, { logs: db.listLogs(Number(req.query.limit || 200)) }));
  router.get('/profiles', (req, res) => ok(res, { profiles: db.listProfiles(), afkPresets: Object.keys(config.afkPresets) }));

  router.post('/profiles', asyncHandler(async (req, res) => {
    const profile = db.saveProfile(normalizeProfileBody(req.body));
    logger.info('profile', `Profile saved: ${profile.name}`);
    ok(res, { profile });
  }));

  router.put('/profiles/:id', asyncHandler(async (req, res) => {
    const profile = db.saveProfile({ ...normalizeProfileBody(req.body), id: Number(req.params.id) });
    logger.info('profile', `Profile updated: ${profile.name}`);
    ok(res, { profile });
  }));

  router.delete('/profiles/:id', asyncHandler(async (req, res) => {
    db.deleteProfile(Number(req.params.id));
    logger.warn('profile', `Profile deleted: ${req.params.id}`);
    ok(res);
  }));

  router.post('/profiles/:id/duplicate', asyncHandler(async (req, res) => {
    const original = db.getProfile(Number(req.params.id), { includeSecrets: true });
    if (!original) throw new Error('Profile not found');
    const copy = db.saveProfile({ ...original, id: undefined, name: `${original.name} Copy` });
    ok(res, { profile: copy });
  }));

  router.get('/proxies', (req, res) => ok(res, { proxies: db.listProxies() }));

  router.post('/proxies/import', asyncHandler(async (req, res) => {
    const result = proxyManager.importList(req.body.proxies);
    logger.info('proxy', `Imported ${result.created.length} proxies`, { errors: result.errors });
    ok(res, { proxies: db.listProxies(), imported: result.created.length, errors: result.errors });
  }));

  router.post('/proxies/:id/test', asyncHandler(async (req, res) => {
    const result = await proxyManager.testProxy(Number(req.params.id), req.body.destinationHost || 'play.bananasmp.net', Number(req.body.destinationPort || 25565));
    logger.info('proxy', `Proxy test OK: ${result.id} in ${result.latencyMs}ms`, { destination: result.destination });
    ok(res, { result });
  }));

  router.delete('/proxies/:id', asyncHandler(async (req, res) => {
    db.deleteProxy(Number(req.params.id));
    logger.warn('proxy', `Proxy deleted: ${req.params.id}`);
    ok(res);
  }));

  router.post('/bot/start', asyncHandler(async (req, res) => {
    const profile = req.body.profileId ? db.getProfile(Number(req.body.profileId)) : db.getDefaultProfile();
    if (!profile) throw new Error('Create or select a profile first');
    await botManager.start(profile.id, { persist: true, reason: 'dashboard start' });
    ok(res, { state: botManager.getState() });
  }));

  router.post('/bot/stop', asyncHandler(async (req, res) => {
    await botManager.stop({ manual: true, persist: true, reason: 'dashboard stop' });
    ok(res, { state: botManager.getState() });
  }));

  router.post('/bot/restart', asyncHandler(async (req, res) => {
    if (req.body.profileId) {
      await botManager.stop({ manual: false, persist: false, reason: 'dashboard restart' });
      await botManager.start(Number(req.body.profileId), { persist: true, reason: 'dashboard restart' });
    } else {
      await botManager.restart('dashboard restart');
    }
    ok(res, { state: botManager.getState() });
  }));

  router.post('/bot/reconnect', asyncHandler(async (req, res) => {
    if (req.body.profileId) {
      await botManager.stop({ manual: false, persist: false, reason: 'dashboard force reconnect' });
      await botManager.start(Number(req.body.profileId), { persist: true, reason: 'dashboard force reconnect' });
    } else {
      await botManager.forceReconnect('dashboard force reconnect');
    }
    ok(res, { state: botManager.getState() });
  }));

  router.post('/bot/kill', asyncHandler(async (req, res) => {
    ok(res, { exiting: true });
    await botManager.killProcess();
  }));

  router.post('/chat/send', asyncHandler(async (req, res) => {
    await botManager.sendChat(req.body.message);
    ok(res);
  }));

  router.post('/command/send', asyncHandler(async (req, res) => {
    await botManager.sendCommand(req.body.command);
    ok(res);
  }));

  router.post('/macro/run', asyncHandler(async (req, res) => {
    await botManager.runMacro(req.body.commands);
    ok(res);
  }));

  return router;
}
