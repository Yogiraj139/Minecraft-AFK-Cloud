import net from 'node:net';
import tls from 'node:tls';
import { SocksClient } from 'socks';

function timeoutPromise(ms, label) {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms).unref();
  });
}

function parseProxyLine(line) {
  const trimmed = String(line || '').trim();

  if (!trimmed || trimmed.startsWith('#')) {
    return null;
  }

  try {
    let normalized = trimmed;

    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(normalized)) {
      const colonParts = normalized.split(':');

      if (colonParts.length === 4) {
        const [host, port, username, password] = colonParts;
        normalized = `socks5://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}:${port}`;
      } else if (colonParts.length === 2) {
        normalized = `socks5://${normalized}`;
      } else {
        throw new Error('Expected proxy URL, host:port, or host:port:user:pass');
      }
    }

    const withScheme = normalized;
    const url = new URL(withScheme);
    const type = url.protocol.replace(':', '').toLowerCase();

    if (!['http', 'https', 'socks4', 'socks5'].includes(type)) {
      throw new Error(`Unsupported proxy type "${type}"`);
    }

    const port = Number.parseInt(url.port, 10);

    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error('Proxy port is required and must be between 1 and 65535');
    }

    return {
      name: `${type.toUpperCase()} ${url.hostname}:${url.port}`,
      type,
      host: url.hostname,
      port,
      username: decodeURIComponent(url.username || ''),
      password: decodeURIComponent(url.password || ''),
      enabled: true
    };
  } catch (error) {
    throw new Error(`Invalid proxy "${trimmed}": ${error.message}`);
  }
}

function looksLikeHost(value) {
  return /^[a-z0-9.-]+$/i.test(value) && value.includes('.');
}

function looksLikePort(value) {
  const port = Number.parseInt(value, 10);
  return Number.isInteger(port) && port > 0 && port <= 65535 && String(port) === String(value).trim();
}

function looksLikeProxyLine(value) {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(value) || value.split(':').length === 2 || value.split(':').length === 4;
}

function normalizeProxyEntries(text) {
  const rawLines = String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
  const entries = [];

  for (let index = 0; index < rawLines.length; index += 1) {
    const line = rawLines[index];

    if (looksLikeProxyLine(line)) {
      entries.push(line);
      continue;
    }

    if (looksLikeHost(line) && looksLikePort(rawLines[index + 1])) {
      const host = line;
      const port = rawLines[index + 1];
      const username = rawLines[index + 2] || '';
      const password = rawLines[index + 3] || '';

      if (username && password && !looksLikeProxyLine(username) && !looksLikeHost(username)) {
        entries.push(`socks5://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}:${port}`);
        index += 3;
      } else {
        entries.push(`socks5://${host}:${port}`);
        index += 1;
      }
    }
  }

  return entries;
}

async function connectHttpProxy(proxy, destinationHost, destinationPort) {
  const socket = proxy.type === 'https'
    ? tls.connect(proxy.port, proxy.host, { servername: proxy.host })
    : net.connect(proxy.port, proxy.host);

  await Promise.race([
    new Promise((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('secureConnect', resolve);
      socket.once('error', reject);
    }),
    timeoutPromise(15000, 'Proxy TCP connection')
  ]);

  const authHeader = proxy.username
    ? `Proxy-Authorization: Basic ${Buffer.from(`${proxy.username}:${proxy.password || ''}`).toString('base64')}\r\n`
    : '';
  const headers = [
    `CONNECT ${destinationHost}:${destinationPort} HTTP/1.1`,
    `Host: ${destinationHost}:${destinationPort}`,
    authHeader.trimEnd(),
    'Proxy-Connection: keep-alive'
  ].filter(Boolean);
  const request = `${headers.join('\r\n')}\r\n\r\n`;

  socket.write(request);

  const response = await Promise.race([
    new Promise((resolve, reject) => {
      let buffer = '';

      function cleanup() {
        socket.off('data', onData);
        socket.off('error', reject);
      }

      function onData(chunk) {
        buffer += chunk.toString('utf8');

        if (!buffer.includes('\r\n\r\n')) {
          return;
        }

        cleanup();
        resolve(buffer);
      }

      socket.on('data', onData);
      socket.once('error', reject);
    }),
    timeoutPromise(15000, 'Proxy CONNECT handshake')
  ]);

  if (!/^HTTP\/1\.[01] 2\d\d/i.test(response)) {
    socket.destroy();
    throw new Error(`Proxy CONNECT failed: ${response.split('\r\n')[0] || 'empty response'}`);
  }

  return socket;
}

async function connectSocksProxy(proxy, destinationHost, destinationPort) {
  const result = await SocksClient.createConnection({
    command: 'connect',
    timeout: 15000,
    destination: {
      host: destinationHost,
      port: destinationPort
    },
    proxy: {
      host: proxy.host,
      port: proxy.port,
      type: proxy.type === 'socks4' ? 4 : 5,
      userId: proxy.username || undefined,
      password: proxy.password || undefined
    }
  });

  return result.socket;
}

export class ProxyManager {
  constructor({ db, logger }) {
    this.db = db;
    this.logger = logger;
    this.rotationCursor = 0;
  }

  importList(text) {
    const created = [];
    const errors = [];

    for (const line of normalizeProxyEntries(text)) {
      try {
        const parsed = parseProxyLine(line);

        if (!parsed) {
          continue;
        }

        created.push(this.db.saveProxy(parsed));
      } catch (error) {
        errors.push(error.message);
      }
    }

    return { created, errors };
  }

  selectProxy(profile) {
    if (!profile || profile.proxyMode === 'disabled') {
      return null;
    }

    if (profile.proxyMode === 'fixed' && profile.proxyId) {
      const proxy = this.db.getProxy(profile.proxyId, { includeSecrets: true });

      return proxy?.enabled ? proxy : null;
    }

    const proxies = this.db.listProxies({ includeSecrets: true })
      .filter((proxy) => proxy.enabled)
      .sort((a, b) => {
        if (a.failureCount !== b.failureCount) {
          return a.failureCount - b.failureCount;
        }

        return a.id - b.id;
      });

    if (!proxies.length) {
      return null;
    }

    const proxy = proxies[this.rotationCursor % proxies.length];
    this.rotationCursor += 1;
    return proxy;
  }

  createMinecraftConnect(proxy, destinationHost, destinationPort) {
    return (client) => {
      this.connect(proxy, destinationHost, destinationPort)
        .then((socket) => {
          client.setSocket(socket);
          client.emit('connect');
        })
        .catch((error) => {
          client.emit('error', error);
        });
    };
  }

  async connect(proxy, destinationHost, destinationPort) {
    if (!proxy) {
      throw new Error('Proxy is not configured');
    }

    this.logger.info('proxy', `Connecting through ${proxy.type.toUpperCase()} proxy ${proxy.host}:${proxy.port}`);

    if (proxy.type === 'http' || proxy.type === 'https') {
      return connectHttpProxy(proxy, destinationHost, destinationPort);
    }

    return connectSocksProxy(proxy, destinationHost, destinationPort);
  }

  async testProxy(proxyId, destinationHost = 'play.bananasmp.net', destinationPort = 25565) {
    const proxy = this.db.getProxy(proxyId, { includeSecrets: true });

    if (!proxy) {
      throw new Error('Proxy not found');
    }

    const startedAt = Date.now();
    let socket = null;

    try {
      socket = await this.connect(proxy, destinationHost, destinationPort);
      const latencyMs = Date.now() - startedAt;
      this.db.resetProxyFailure(proxy.id);

      return {
        id: proxy.id,
        ok: true,
        latencyMs,
        destination: `${destinationHost}:${destinationPort}`
      };
    } catch (error) {
      this.db.markProxyFailure(proxy.id);
      throw error;
    } finally {
      socket?.destroy();
    }
  }
}
