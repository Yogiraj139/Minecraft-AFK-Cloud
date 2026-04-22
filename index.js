import 'dotenv/config';
import path from 'node:path';
import fs from 'node:fs';
import express from 'express';
import session from 'express-session';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './services/config.js';
import { CryptoBox } from './services/crypto.js';
import { Database } from './services/database.js';
import { Logger } from './services/logger.js';
import { ProxyManager } from './services/proxyManager.js';
import { DiscordBridge } from './services/discordBridge.js';
import { MinecraftBotManager } from './services/minecraftBotManager.js';
import { Scheduler } from './services/scheduler.js';
import { authRoutes } from './routes/auth.js';
import { dashboardRoutes } from './routes/dashboard.js';
import { apiRoutes } from './routes/api.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(dataDir, { recursive: true });

const config = loadConfig(__dirname);
const cryptoBox = new CryptoBox(process.env.APP_SECRET || process.env.SESSION_SECRET || 'dev-secret-change-me');
const db = new Database({ dataDir, cryptoBox, maxLogRows: Number(process.env.MAX_LOG_ROWS || 2500) });
db.init();
const logger = new Logger(db);
const proxyManager = new ProxyManager({ db, logger });
const discordBridge = new DiscordBridge({ logger });
const botManager = new MinecraftBotManager({ db, logger, proxyManager, discordBridge, dataDir, config });
const scheduler = new Scheduler({ db, botManager, logger });

const app = express();
const server = createServer(app);
const io = new Server(server, { cors: { origin: false } });
const isProduction = process.env.NODE_ENV === 'production';

app.set('trust proxy', 1);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: isProduction ? '1h' : 0 }));
app.use(session({
  name: 'cloudafk.sid',
  secret: process.env.SESSION_SECRET || 'change-me-in-env',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: isProduction && process.env.FORCE_INSECURE_COOKIES !== 'true',
    maxAge: 1000 * 60 * 60 * 12
  }
}));

app.use(rateLimit({ windowMs: 60 * 1000, limit: 240, standardHeaders: true, legacyHeaders: false }));

app.get('/health', (req, res) => {
  res.json({ ok: true, status: botManager.getState().status, uptime: process.uptime() });
});

app.use(authRoutes({ logger }));
app.use(dashboardRoutes({ db, config }));
app.use('/api', apiRoutes({ db, botManager, proxyManager, logger, config }));

app.use((req, res) => {
  res.status(404).render('error', { title: 'Not Found', message: 'Page not found' });
});

app.use((error, req, res, next) => {
  logger.error('http', error.message, { stack: error.stack });
  if (req.path.startsWith('/api')) {
    res.status(500).json({ ok: false, error: error.message });
    return;
  }
  res.status(500).render('error', { title: 'Error', message: error.message });
});

io.on('connection', (socket) => {
  if (!socket.request.headers.cookie) return;
  socket.emit('state', botManager.getState());
  socket.emit('logs:bulk', db.listLogs(250));
});

logger.on('log', (entry) => io.emit('log', entry));
botManager.on('state', (state) => io.emit('state', state));

discordBridge.start();
scheduler.start();
botManager.restoreDesiredState().catch((error) => logger.error('bot', error.message));

const port = Number(process.env.PORT || 3000);
server.listen(port, '0.0.0.0', () => {
  logger.info('system', `CloudAFK Pro X listening on 0.0.0.0:${port}`);
});

process.on('uncaughtException', (error) => logger.error('process', error.message, { stack: error.stack }));
process.on('unhandledRejection', (error) => logger.error('process', error?.message || String(error)));
