# CloudAFK Pro X

CloudAFK Pro X is a production-oriented Node.js dashboard that runs a Minecraft Java Edition AFK bot in the cloud. It uses Express, Socket.io, mineflayer, minecraft-protocol, SQLite, secure sessions, encrypted stored secrets, a real-time console, reconnect recovery, scheduler rules, proxy support, and optional Discord control.

## Architecture Choice

This build uses EJS instead of React. EJS keeps the Railway deployment simple, avoids a separate SPA build/runtime, works cleanly with server-side sessions and CSRF, and still gives the dashboard real-time behavior through Socket.io.

SQLite is used through `better-sqlite3` because it provides durable transactional local storage, session persistence, log retention, profile storage, and encrypted Minecraft/proxy secrets without needing an external database. For Railway long-term use, attach a Railway volume and set `DATA_DIR=/data`.

## Features

- Secure dashboard login with bcrypt password hashing, SQLite-backed sessions, rate limiting, Helmet headers, and CSRF checks.
- Start, stop, restart, force reconnect, and kill-process controls.
- Real-time status, logs, chat feed, kicks, disconnect reasons, uptime, RAM, CPU, ping, dimension, and estimated TPS.
- Multiple server profiles with version fallback, reconnect delay, spawn timeout, login timeout, AFK preset, timed messages, macro commands, scheduler fields, and per-profile proxy settings.
- Mineflayer Java Edition connection engine with auto version mode, fallback attempts, slow spawn timeout recovery, Microsoft/offline modes, and cloud session cache folder.
- Human-like AFK engine with random look movement, jumps, sneak taps, movement bursts, and configurable presets.
- AuthMe-style `/login` and `/register` prompt detection with delayed automatic login.
- HTTP, HTTPS, SOCKS4, and SOCKS5 proxy import, rotation, fixed proxy assignment, and failover tracking.
- Watchdog recovery for offline/stuck-connecting states and high-memory restarts.
- `/health` endpoint for Railway health checks.
- Optional Discord slash commands and webhook alerts.

## Local Setup

1. Install Node.js 22 LTS.
2. Install dependencies:

   ```powershell
   npm install
   ```

3. Create `.env`:

   ```powershell
   Copy-Item .env.example .env
   ```

4. Edit `.env` and set:

   ```env
   ADMIN_USERNAME=admin
   ADMIN_PASSWORD=your-long-dashboard-password
   SESSION_SECRET=64-random-hex-or-long-random-string
   APP_SECRET=64-random-hex-or-long-random-string
   ```

5. Build CSS and start:

   ```powershell
   npm run build:css
   npm start
   ```

6. Open `http://localhost:3000`.

If you do not set `ADMIN_PASSWORD` or `ADMIN_PASSWORD_HASH`, the app generates a bootstrap password in `data/bootstrap-admin.txt`.

## Railway Deployment

1. Push this repository to GitHub.
2. Create a Railway project from the GitHub repository.
3. Add these Railway variables:

   ```env
   NODE_ENV=production
   AUTO_START_ON_BOOT=true
   ADMIN_USERNAME=admin
   ADMIN_PASSWORD=your-long-dashboard-password
   SESSION_SECRET=your-long-random-secret
   APP_SECRET=your-long-random-secret
   DATA_DIR=/data
   ```

4. Attach a Railway volume mounted at `/data`.
5. Railway will use:

   ```text
   Build Command: npm install && npm run build:css
   Start Command: npm start
   Health Check: /health
   ```

The server binds to `0.0.0.0` and uses `process.env.PORT`, which is required for Railway.

## Minecraft Account Modes

- `Cracked / Offline`: username-only mineflayer offline auth.
- `Premium / Microsoft`: mineflayer Microsoft auth using its session cache. The first authorization may require completing Microsoft device login from the server logs; keep `DATA_DIR` persistent so the token cache survives deploys/restarts.

Store server `/login` or `/register` passwords in the `AuthMe Password` field. Secrets are encrypted with `APP_SECRET` before being written to SQLite.

## Proxy Import Format

One proxy per line:

```text
socks5://user:pass@127.0.0.1:1080
socks4://127.0.0.1:1080
http://user:pass@127.0.0.1:8080
https://127.0.0.1:8443
127.0.0.1:1080
```

Lines without a scheme default to SOCKS5.

For Railway Guard/IP blocks, use `Proxy Mode: Rotate` with several working SOCKS5 or HTTP CONNECT proxies, test them from the dashboard, then start the bot. If Guard denies entry, CloudAFK pauses before retrying and rotates on the next attempt. Avoid public free proxies for Minecraft accounts; they are often already blocked or unstable.

## Timed Messages And Macros

Timed messages use one line per action:

```text
300:/home
900:Still AFK
```

The number is seconds. Commands and chat messages are rate-limited by the configured interval and sent only while the bot is online.

Macro commands use one command per line and can be triggered from the dashboard or Discord `/say`.

## Discord Integration

Set any of these variables:

```env
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...
DISCORD_BOT_TOKEN=...
DISCORD_CLIENT_ID=...
DISCORD_GUILD_ID=...
```

Webhook alerts report connect, disconnect, and kick events. With bot token, client ID, and guild ID set, CloudAFK registers `/start`, `/stop`, `/status`, `/say`, and `/logs`.

## Production Notes

- Use a strong dashboard password.
- Keep `APP_SECRET` stable. Changing it makes previously stored encrypted Minecraft/proxy secrets unreadable.
- Use a Railway volume for `/data`; otherwise SQLite, sessions, and Microsoft auth cache are reset on redeploy.
- Some Minecraft servers forbid AFK automation. Use accounts and servers you are allowed to automate.
- Running many concurrent bots is not enabled in this single-service build. The code is structured so `MinecraftBotManager` can be sharded later for multi-user SaaS.

## Commands

```powershell
npm start
npm run dev
npm run build:css
npm run check
```
