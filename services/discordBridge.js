export class DiscordBridge {
  constructor({ logger }) {
    this.logger = logger;
    this.webhookUrl = process.env.DISCORD_WEBHOOK_URL || '';
  }

  start() {
    if (!process.env.DISCORD_BOT_TOKEN) {
      this.logger.info('discord', 'Discord bot disabled; DISCORD_BOT_TOKEN not set');
    }
  }

  async alert(title, description) {
    if (!this.webhookUrl) return;
    try {
      await fetch(this.webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ embeds: [{ title, description: String(description || '').slice(0, 1800), color: 0x2dd4bf }] })
      });
    } catch (error) {
      this.logger.warn('discord', error.message);
    }
  }
}
