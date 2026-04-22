function randomInt(min, max) {
  return Math.floor(min + Math.random() * (max - min + 1));
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class AfkEngine {
  constructor({ bot, profile, config, logger }) {
    this.bot = bot;
    this.profile = profile;
    this.config = config;
    this.logger = logger;
    this.timers = new Set();
    this.running = false;
    this.currentYaw = 0;
    this.currentPitch = 0;
  }

  start() {
    if (this.running) {
      return;
    }

    this.running = true;
    this.currentYaw = this.bot.entity?.yaw || 0;
    this.currentPitch = this.bot.entity?.pitch || 0;
    this.scheduleNext();
    this.logger.info('afk', `AFK engine started with ${this.profile.afkProfile} behavior`);
  }

  stop() {
    this.running = false;

    for (const timer of this.timers) {
      clearTimeout(timer);
    }

    this.timers.clear();
    this.clearMovement();
    this.logger.info('afk', 'AFK engine stopped');
  }

  settings() {
    const preset = this.config.afkPresets[this.profile.afkProfile] || this.config.afkPresets['human-like'];

    return {
      ...preset,
      ...(this.profile.afkConfig || {}),
      minDelayMs: clamp(Number(this.profile.afkConfig?.minDelayMs || preset.minDelayMs), 1500, 300000),
      maxDelayMs: clamp(Number(this.profile.afkConfig?.maxDelayMs || preset.maxDelayMs), 2500, 600000)
    };
  }

  scheduleNext() {
    if (!this.running) {
      return;
    }

    const settings = this.settings();
    const min = Math.min(settings.minDelayMs, settings.maxDelayMs);
    const max = Math.max(settings.minDelayMs, settings.maxDelayMs);
    const timer = setTimeout(async () => {
      this.timers.delete(timer);

      try {
        await this.performAction(settings);
      } catch (error) {
        this.logger.warn('afk', `AFK action failed: ${error.message}`);
      }

      this.scheduleNext();
    }, randomInt(min, max));

    timer.unref();
    this.timers.add(timer);
  }

  async performAction(settings) {
    if (!this.running || !this.bot?.entity) {
      return;
    }

    const actions = [];

    if (settings.headMovement) actions.push(() => this.lookAround());
    if (settings.movementBursts) actions.push(() => this.moveBurst());
    if (settings.jump) actions.push(() => this.jump());
    if (settings.sneak) actions.push(() => this.sneakTap());

    if (!actions.length) {
      return;
    }

    const action = actions[randomInt(0, actions.length - 1)];
    await action();
  }

  async lookAround() {
    this.currentYaw += (Math.random() - 0.5) * 1.4;
    this.currentPitch = clamp(this.currentPitch + (Math.random() - 0.5) * 0.5, -1.1, 1.1);
    await this.bot.look(this.currentYaw, this.currentPitch, true);
  }

  async moveBurst() {
    const directions = ['forward', 'back', 'left', 'right'];
    const primary = directions[randomInt(0, directions.length - 1)];
    const shouldStrafe = Math.random() > 0.65;
    const strafe = shouldStrafe ? directions[randomInt(2, 3)] : null;
    const duration = randomInt(450, 1800);

    this.bot.setControlState(primary, true);

    if (strafe && strafe !== primary) {
      this.bot.setControlState(strafe, true);
    }

    await sleep(duration);
    this.bot.setControlState(primary, false);

    if (strafe && strafe !== primary) {
      this.bot.setControlState(strafe, false);
    }

    if (Math.random() > 0.5) {
      await this.lookAround();
    }
  }

  async jump() {
    this.bot.setControlState('jump', true);
    await sleep(randomInt(120, 260));
    this.bot.setControlState('jump', false);
  }

  async sneakTap() {
    this.bot.setControlState('sneak', true);
    await sleep(randomInt(400, 1400));
    this.bot.setControlState('sneak', false);
  }

  clearMovement() {
    for (const control of ['forward', 'back', 'left', 'right', 'jump', 'sneak', 'sprint']) {
      try {
        this.bot?.setControlState(control, false);
      } catch {
        // The bot may already be fully destroyed.
      }
    }
  }
}
