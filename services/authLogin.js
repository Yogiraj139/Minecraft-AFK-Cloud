const loginPatterns = [
  /please\s+login/i,
  /\/login/i,
  /\/l\b/i,
  /login\s+with/i,
  /authme/i
];

const registerPatterns = [
  /please\s+register/i,
  /\/register/i,
  /\/reg\b/i,
  /register\s+with/i
];

function chatText(message) {
  if (!message) {
    return '';
  }

  if (typeof message === 'string') {
    return message;
  }

  if (typeof message.toString === 'function') {
    return message.toString();
  }

  return String(message);
}

export class AuthLogin {
  constructor({ bot, password, logger }) {
    this.bot = bot;
    this.password = password;
    this.logger = logger;
    this.lastLoginAt = 0;
    this.lastRegisterAt = 0;
    this.lastMissingPasswordWarningAt = 0;
    this.started = false;
    this.boundMessage = this.handleMessage.bind(this);
  }

  start() {
    if (this.started) {
      return;
    }

    this.started = true;
    this.bot.on('message', this.boundMessage);
    this.bot.on('messagestr', this.boundMessage);
  }

  stop() {
    this.started = false;
    this.bot.off('message', this.boundMessage);
    this.bot.off('messagestr', this.boundMessage);
  }

  handleMessage(message) {
    const text = chatText(message);

    if (!text) {
      return;
    }

    if (registerPatterns.some((pattern) => pattern.test(text))) {
      if (!this.password) {
        this.warnMissingPassword('register');
        return;
      }

      this.sendRegister();
      return;
    }

    if (loginPatterns.some((pattern) => pattern.test(text))) {
      if (!this.password) {
        this.warnMissingPassword('login');
        return;
      }

      this.sendLogin();
    }
  }

  warnMissingPassword(action) {
    const now = Date.now();

    if (now - this.lastMissingPasswordWarningAt < 15000) {
      return;
    }

    this.lastMissingPasswordWarningAt = now;
    this.logger.warn(
      'auth',
      `Server requested /${action}, but this profile has no AuthMe Password saved`
    );
  }

  sendLogin() {
    const now = Date.now();

    if (now - this.lastLoginAt < 10000) {
      return;
    }

    this.lastLoginAt = now;
    const delay = 1200 + Math.floor(Math.random() * 2400);
    setTimeout(() => {
      try {
        this.bot.chat(`/login ${this.password}`);
        this.logger.info('auth', 'Sent automatic /login command');
      } catch (error) {
        this.logger.warn('auth', `Automatic /login failed: ${error.message}`);
      }
    }, delay).unref();
  }

  sendRegister() {
    const now = Date.now();

    if (now - this.lastRegisterAt < 15000) {
      return;
    }

    this.lastRegisterAt = now;
    const delay = 1800 + Math.floor(Math.random() * 2800);
    setTimeout(() => {
      try {
        this.bot.chat(`/register ${this.password} ${this.password}`);
        this.logger.info('auth', 'Sent automatic /register command');
      } catch (error) {
        this.logger.warn('auth', `Automatic /register failed: ${error.message}`);
      }
    }, delay).unref();
  }
}
