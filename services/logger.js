import { EventEmitter } from 'node:events';

export class Logger extends EventEmitter {
  constructor(db) {
    super();
    this.db = db;
  }

  log(level, type, message, meta = null) {
    const entry = this.db.addLog({ level, type, message, meta });
    this.emit('log', entry);
    const method = level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log';
    console[method](`[${entry.createdAt}] ${level.toUpperCase()} ${type}: ${message}`);
    return entry;
  }

  info(type, message, meta) { return this.log('info', type, message, meta); }
  warn(type, message, meta) { return this.log('warn', type, message, meta); }
  error(type, message, meta) { return this.log('error', type, message, meta); }
}
