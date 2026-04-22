import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import session from 'express-session';
import { Server as SocketServer } from 'socket.io';

import { loadConfig } from './services/config.js';
import { createSecretBox } from './services/crypto.js';
import { createDatabase } from './services/database.js';
import { createLogger } from './services/logger.js';
import { SQLiteSessionStore } from './services/sqliteSessionStore.js';
import { ProxyManager } from './services/proxyManager.js';
import { MinecraftBotManager } from './services/minecraftBotManager.js';
import { Scheduler } from './services/scheduler.js';
import { DiscordBridge } from './services/discordBridge.js';
import { authRoutes, ensureAuthenticated, attachCsrfToken } from './routes/auth.js';
import { dashboardRoutes } from './routes/dashboard.js';
import { apiRoutes } from './routes/api.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const config = loadConfig(path.join(__dirname, 'config.json'));
const dataDir = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const isProduction = process.env.NODE_ENV === 'production';

const secretBox = createSecretBox({
  dataDir,
  appSecret: process.env.APP_SECRET
});

const db = createDatabase({
  dataDir,
  secretBox,
  config
});

const logger = createLogger({
  db,
  maxRows: Number(process.env.MAX_LOG_ROWS || 2500)
});

const sessionStore = new SQLiteSessionStore({
  db: db.raw
});

const app = express();
const server = http.createServer(app);
const io = new SocketServer(server, {
  cors: {
    origin: false
  }
});

const sessionMiddleware = session({
  name: 'cloudafk.sid',
  secret: db.getOrCreateRuntimeSecret('session_secret', process.env.SESSION_SECRET),
  store: sessionStore,
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: isProduction && process.env.FORCE_INSECURE_COOKIES !== 'true',
    maxAge: 1000 * 60 * 60 * 12
  }
});

app.set('trust proxy', 1);
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'ejs');

app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      'default-src': ["'self'"],
      'script-src': ["'self'"],
      'style-src': ["'self'"],
      'img-src': ["'self'", 'data:'],
      'font-src': ["'self'", 'data:'],
      'connect-src': ["'self'", 'ws:', 'wss:']
    }
  }
}));

app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: isProduction ? '7d' : 0,
  etag: true
}));
app.use(express.urlencoded({ extended: false, limit: '64kb' }));
app.use(express.json({ limit: '256kb' }));
app.use(sessionMiddleware);
app.use(attachCsrfToken);

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 240,
  standardHeaders: true,
  legacyHeaders: false
});

const proxyManager = new ProxyManager({
  db,
  logger
});

const discordBridge = new DiscordBridge({
  logger,
  webhookUrl: process.env.DISCORD_WEBHOOK_URL,
  botToken: process.env.DISCORD_BOT_TOKEN,
  clientId: process.env.DISCORD_CLIENT_ID,
  guildId: process.env.DISCORD_GUILD_ID
});

const botManager = new MinecraftBotManager({
  db,
  logger,
  proxyManager,
  discordBridge,
  dataDir,
  config
});

const scheduler = new Scheduler({
  db,
  logger,
  botManager
});

logger.setBroadcaster((event, payload) => {
  io.emit(event, payload);
});

botManager.on('state', (state) => {
  io.emit('state', state);
});

discordBridge.bindBotManager(botManager);

io.use((socket, next) => {
  sessionMiddleware(socket.request, {}, next);
});

io.use((socket, next) => {
  if (socket.request.session?.userId) {
    next();
    return;
  }

  next(new Error('Unauthorized'));
});

io.on('connection', (socket) => {
  socket.emit('state', botManager.getState());
  socket.emit('logs:bulk', db.listLogs(200));

  socket.on('chat:send', async (payload, ack) => {
    try {
      await botManager.sendChat(String(payload?.message || ''));
      ack?.({ ok: true });
    } catch (error) {
      ack?.({ ok: false, error: error.message });
    }
  });
});

app.get('/health', (req, res) => {
  const state = botManager.getState();

  res.status(200).json({
    ok: true,
    status: state.status,
    desired: state.desired,
    uptimeSeconds: Math.floor(process.uptime()),
    lastDisconnectReason: state.lastDisconnectReason || null,
    timestamp: new Date().toISOString()
  });
});

app.use('/', authRoutes({ db, loginLimiter }));
app.use('/', ensureAuthenticated, dashboardRoutes({ db, config }));
app.use('/api', ensureAuthenticated, apiLimiter, apiRoutes({
  db,
  botManager,
  proxyManager,
  logger,
  config
}));

app.use((req, res) => {
  res.status(404).render('error', {
    title: 'Not Found',
    message: 'That route does not exist.'
  });
});

app.use((error, req, res, next) => {
  logger.error('http', error.message, {
    stack: isProduction ? undefined : error.stack,
    path: req.path
  });

  if (res.headersSent) {
    next(error);
    return;
  }

  res.status(error.status || 500);

  if (req.accepts('json') && req.path.startsWith('/api')) {
    res.json({ ok: false, error: error.message || 'Internal server error' });
    return;
  }

  res.render('error', {
    title: 'Server Error',
    message: error.message || 'Internal server error'
  });
});

process.on('unhandledRejection', (error) => {
  logger.error('process', 'Unhandled promise rejection', {
    error: error instanceof Error ? error.stack : String(error)
  });
});

process.on('uncaughtException', (error) => {
  logger.error('process', 'Uncaught exception', {
    error: error.stack
  });
});

process.on('SIGTERM', async () => {
  logger.warn('process', 'SIGTERM received, shutting down gracefully');
  await botManager.stop({ manual: false, persist: false, reason: 'process shutdown' });
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 8000).unref();
});

const port = Number(process.env.PORT || 3000);
const host = '0.0.0.0';

server.listen(port, host, async () => {
  logger.info('system', `CloudAFK Pro X listening on ${host}:${port}`, {
    node: process.version,
    dataDir
  });

  await discordBridge.start();
  scheduler.start();

  if (String(process.env.AUTO_START_ON_BOOT || 'true').toLowerCase() === 'true') {
    botManager.restoreDesiredState().catch((error) => {
      logger.error('bot', `Auto-start failed: ${error.message}`);
    });
  }
});
