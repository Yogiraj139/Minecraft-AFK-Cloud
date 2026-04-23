function randomBetween(range, fallback) {
  if (!Array.isArray(range) || range.length < 2) return fallback;
  const min = Number(range[0]);
  const max = Number(range[1]);
  return Math.floor(min + Math.random() * Math.max(1, max - min));
}

function chance(value) {
  return Math.random() < Number(value || 0);
}

export class AfkEngine {
  constructor({ bot, profile, config, logger }) {
    this.bot = bot;
    this.profile = profile;
    this.config = config;
    this.logger = logger;
    this.timer = null;
    this.running = false;
  }

  start() {
    this.running = true;
    this.logger.info('afk', `AFK engine started with ${this.profile.afkProfile} behavior`);
    this.loop();
  }

  stop() {
    this.running = false;
    clearTimeout(this.timer);
    for (const control of ['forward', 'back', 'left', 'right', 'jump', 'sneak']) {
      try { this.bot.setControlState(control, false); } catch {}
    }
  }

  loop() {
    if (!this.running || !this.bot?.entity) return;
    const preset = {
      ...(this.config.afkPresets?.[this.profile.afkProfile] || this.config.afkPresets?.passive || {}),
      ...(this.profile.afkConfig || {})
    };

    try {
      const yaw = this.bot.entity.yaw + (Math.random() - 0.5) * 0.9;
      const pitch = Math.max(-1.2, Math.min(1.2, this.bot.entity.pitch + (Math.random() - 0.5) * 0.45));
      this.bot.look(yaw, pitch, true).catch(() => {});

      if (chance(preset.jumpChance)) {
        this.tap('jump', randomBetween([250, 650], 350));
      }

      if (chance(preset.sneakChance)) {
        this.tap('sneak', randomBetween([500, 1800], 900));
      }

      if (chance(preset.moveChance)) {
        const controls = ['forward', 'back', 'left', 'right'];
        this.tap(controls[Math.floor(Math.random() * controls.length)], randomBetween(preset.moveMs, 700));
      }
    } catch (error) {
      this.logger.warn('afk', error.message);
    }

    this.timer = setTimeout(() => this.loop(), randomBetween(preset.lookEveryMs, 15000));
    this.timer.unref?.();
  }

  tap(control, ms) {
    this.bot.setControlState(control, true);
    setTimeout(() => {
      try { this.bot.setControlState(control, false); } catch {}
    }, ms).unref?.();
  }
}
