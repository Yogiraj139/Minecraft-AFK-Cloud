export class Scheduler {
  constructor({ db, botManager, logger }) {
    this.db = db;
    this.botManager = botManager;
    this.logger = logger;
    this.timer = null;
    this.lastDailyRestart = '';
    this.lastScheduledStart = '';
    this.lastReconnectHour = '';
  }

  start() {
    this.timer = setInterval(() => this.tick(), 30000);
    this.timer.unref?.();
    this.logger.info('scheduler', 'Scheduler started');
  }

  stop() {
    clearInterval(this.timer);
  }

  tick() {
    const profile = this.db.getDefaultProfile({ includeSecrets: true });
    if (!profile) return;

    const now = new Date();
    const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const dayKey = now.toISOString().slice(0, 10);

    if (profile.scheduledStart && profile.scheduledStart === hhmm && this.lastScheduledStart !== `${dayKey}-${hhmm}`) {
      this.lastScheduledStart = `${dayKey}-${hhmm}`;
      this.botManager.start(profile.id, { persist: true, reason: 'scheduled start' }).catch((error) => this.logger.error('scheduler', error.message));
    }

    if (profile.dailyRestartTime && profile.dailyRestartTime === hhmm && this.lastDailyRestart !== `${dayKey}-${hhmm}`) {
      this.lastDailyRestart = `${dayKey}-${hhmm}`;
      this.botManager.restart('scheduled daily restart').catch((error) => this.logger.error('scheduler', error.message));
    }

    if (profile.reconnectEveryHours > 0 && this.botManager.getState().status === 'online') {
      const key = `${dayKey}-${now.getHours()}`;
      if (now.getHours() % profile.reconnectEveryHours === 0 && now.getMinutes() === 0 && this.lastReconnectHour !== key) {
        this.lastReconnectHour = key;
        this.botManager.forceReconnect('scheduled reconnect interval').catch((error) => this.logger.error('scheduler', error.message));
      }
    }
  }
}
