function hhmmNow() {
  const date = new Date();
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function todayKey(prefix, id, time) {
  return `${prefix}.${id}.${time}.${new Date().toISOString().slice(0, 10)}`;
}

export class Scheduler {
  constructor({ db, logger, botManager }) {
    this.db = db;
    this.logger = logger;
    this.botManager = botManager;
    this.timer = null;
    this.hourlyTimer = null;
  }

  start() {
    if (this.timer) {
      return;
    }

    this.timer = setInterval(() => {
      this.tick().catch((error) => {
        this.logger.error('scheduler', error.message);
      });
    }, 30000);
    this.timer.unref();

    this.hourlyTimer = setInterval(() => {
      this.reconnectIntervalTick().catch((error) => {
        this.logger.error('scheduler', error.message);
      });
    }, 60000);
    this.hourlyTimer.unref();
    this.logger.info('scheduler', 'Scheduler started');
  }

  async tick() {
    const current = hhmmNow();
    const profiles = this.db.listProfiles();

    for (const profile of profiles) {
      if (profile.scheduledStart === current) {
        const key = todayKey('scheduledStart', profile.id, current);

        if (this.db.getSetting(key) !== 'done') {
          this.db.setSetting(key, 'done');
          this.logger.info('scheduler', `Scheduled start for ${profile.name}`);
          await this.botManager.start(profile.id, { persist: true, reason: 'scheduled start' });
        }
      }

      if (profile.dailyRestartTime === current && this.botManager.getState().profileId === profile.id) {
        const key = todayKey('dailyRestart', profile.id, current);

        if (this.db.getSetting(key) !== 'done') {
          this.db.setSetting(key, 'done');
          this.logger.info('scheduler', `Daily restart for ${profile.name}`);
          await this.botManager.restart('daily scheduled restart');
        }
      }
    }
  }

  async reconnectIntervalTick() {
    const state = this.botManager.getState();

    if (!state.profileId || state.status !== 'online') {
      return;
    }

    const profile = this.db.getProfile(state.profileId);

    if (!profile?.reconnectEveryHours) {
      return;
    }

    const intervalMs = profile.reconnectEveryHours * 60 * 60 * 1000;

    if (intervalMs < 60 * 60 * 1000) {
      return;
    }

    if (state.uptimeSeconds * 1000 >= intervalMs) {
      this.logger.info('scheduler', `Reconnect interval reached for ${profile.name}`);
      await this.botManager.forceReconnect('scheduled interval reconnect');
    }
  }
}
