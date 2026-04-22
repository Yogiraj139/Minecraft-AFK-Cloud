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
    const withScheme = /^[a-z]+:\/\//i.test(trimmed) ? trimmed : `socks5://${trimmed}`;
    const url = new URL(withScheme);
    const type = url.protocol.replace(':', '').toLowerCase();

    if (!['http', 'https', 'socks4', 'socks5'].includes(type)) {
      throw new Error(`Unsupported proxy type "${type}"`);
    }

    return {
      name: `${type.toUpperCase()} ${url.hostname}:${url.port}`,
      type,
      host: url.hostname,
      port: Number.parseInt(url.port, 10),
      username: decodeURIComponent(url.username || ''),
      password: decodeURIComponent(url.password || ''),
      enabled: true
    };
  } catch (error) {
    throw new Error(`Invalid proxy "${trimmed}": ${error.message}`);
  }
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

    for (const line of String(text || '').split(/\r?\n/)) {
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
      return this.db.getProxy(profile.proxyId, { includeSecrets: true });
    }

    const proxies = this.db.listProxies({ includeSecrets: true })
      .filter((proxy) => proxy.enabled);

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
}
