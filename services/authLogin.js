function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class AuthLogin {
  constructor({ bot, password, logger }) {
    this.bot = bot;
    this.password = password;
    this.logger = logger;
    this.sentLogin = false;
    this.sentRegister = false;
    this.handler = this.onMessage.bind(this);
  }

  start() {
    this.bot.on('messagestr', this.handler);
  }

  stop() {
    this.bot?.off?.('messagestr', this.handler);
  }

  async onMessage(message) {
    if (!this.password) return;
    const text = String(message || '').toLowerCase();

    if (!this.sentRegister && /register|\/register/.test(text)) {
      this.sentRegister = true;
      await sleep(1800 + Math.floor(Math.random() * 1400));
      this.bot.chat(`/register ${this.password} ${this.password}`);
      this.logger.info('auth', 'Sent automatic /register command');
      return;
    }

    if (!this.sentLogin && /(please login|login using|\/login|\/l\b|authme)/i.test(message)) {
      this.sentLogin = true;
      await sleep(1800 + Math.floor(Math.random() * 1400));
      this.bot.chat(`/login ${this.password}`);
      this.logger.info('auth', 'Sent automatic /login command');
    }
  }
}
