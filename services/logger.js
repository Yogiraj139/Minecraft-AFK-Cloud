import { EventEmitter } from 'node:events';

export function createLogger({ db, maxRows }) {
  const emitter = new EventEmitter();
  let broadcaster = null;
  let writesSincePrune = 0;

  function write(level, type, message, meta = {}) {
    const entry = db.insertLog({
      level,
      type,
      message,
      meta
    });

    writesSincePrune += 1;

    if (writesSincePrune >= 50) {
      writesSincePrune = 0;
      db.pruneLogs(maxRows);
    }

    const line = `[${level.toUpperCase()}] [${type}] ${message}`;

    if (level === 'error') {
      console.error(line);
    } else if (level === 'warn') {
      console.warn(line);
    } else {
      console.log(line);
    }

    emitter.emit('log', entry);
    broadcaster?.('log', entry);
    return entry;
  }

  return {
    on: emitter.on.bind(emitter),
    off: emitter.off.bind(emitter),
    setBroadcaster(callback) {
      broadcaster = callback;
    },
    debug(type, message, meta) {
      return write('debug', type, message, meta);
    },
    info(type, message, meta) {
      return write('info', type, message, meta);
    },
    warn(type, message, meta) {
      return write('warn', type, message, meta);
    },
    error(type, message, meta) {
      return write('error', type, message, meta);
    }
  };
}
