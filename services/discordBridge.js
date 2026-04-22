import {
  Client,
  Events,
  GatewayIntentBits,
  REST,
  Routes
} from 'discord.js';

const commands = [
  {
    name: 'start',
    description: 'Start the configured AFK bot',
    options: [
      {
        name: 'profile',
        description: 'Profile ID to start',
        type: 4,
        required: false
      }
    ]
  },
  {
    name: 'stop',
    description: 'Stop the AFK bot'
  },
  {
    name: 'status',
    description: 'Show AFK bot status'
  },
  {
    name: 'say',
    description: 'Send chat as the AFK bot',
    options: [
      {
        name: 'message',
        description: 'Message or command to send',
        type: 3,
        required: true
      }
    ]
  },
  {
    name: 'logs',
    description: 'Show recent AFK logs'
  }
];

function formatStatus(state) {
  return [
    `Status: ${state.status}`,
    `Desired: ${state.desired ? 'yes' : 'no'}`,
    `Profile: ${state.profileName || 'none'}`,
    `Server: ${state.host ? `${state.host}:${state.port}` : 'none'}`,
    `Uptime: ${state.uptimeSeconds}s`,
    `Ping: ${state.ping ?? 'n/a'}`
  ].join('\n');
}

export class DiscordBridge {
  constructor({ logger, webhookUrl, botToken, clientId, guildId }) {
    this.logger = logger;
    this.webhookUrl = webhookUrl;
    this.botToken = botToken;
    this.clientId = clientId;
    this.guildId = guildId;
    this.client = null;
    this.botManager = null;
  }

  bindBotManager(botManager) {
    this.botManager = botManager;
  }

  async start() {
    if (!this.botToken) {
      this.logger.info('discord', 'Discord bot disabled; DISCORD_BOT_TOKEN not set');
      return;
    }

    this.client = new Client({
      intents: [GatewayIntentBits.Guilds]
    });

    this.client.once(Events.ClientReady, async () => {
      this.logger.info('discord', `Discord bot logged in as ${this.client.user.tag}`);
      await this.registerCommands();
    });

    this.client.on(Events.InteractionCreate, (interaction) => {
      this.handleInteraction(interaction).catch((error) => {
        this.logger.error('discord', error.message, { stack: error.stack });

        if (!interaction.replied && !interaction.deferred) {
          interaction.reply({ content: `Error: ${error.message}`, ephemeral: true }).catch(() => {});
        }
      });
    });

    await this.client.login(this.botToken);
  }

  async registerCommands() {
    if (!this.clientId || !this.guildId || !this.botToken) {
      this.logger.warn('discord', 'Slash command registration skipped; DISCORD_CLIENT_ID or DISCORD_GUILD_ID missing');
      return;
    }

    const rest = new REST({ version: '10' }).setToken(this.botToken);
    await rest.put(Routes.applicationGuildCommands(this.clientId, this.guildId), {
      body: commands
    });
    this.logger.info('discord', 'Slash commands registered');
  }

  async handleInteraction(interaction) {
    if (!interaction.isChatInputCommand() || !this.botManager) {
      return;
    }

    await interaction.deferReply({ ephemeral: true });

    if (interaction.commandName === 'start') {
      const profileId = interaction.options.getInteger('profile') || this.botManager.currentProfile?.id;
      const profile = profileId || this.botManager.db.getDefaultProfile()?.id;

      if (!profile) {
        await interaction.editReply('No profile exists yet.');
        return;
      }

      await this.botManager.start(profile, { persist: true, reason: 'discord command' });
      await interaction.editReply('Start requested.');
      return;
    }

    if (interaction.commandName === 'stop') {
      await this.botManager.stop({ manual: true, persist: true, reason: 'discord command' });
      await interaction.editReply('Stop requested.');
      return;
    }

    if (interaction.commandName === 'status') {
      await interaction.editReply(`\`\`\`\n${formatStatus(this.botManager.getState())}\n\`\`\``);
      return;
    }

    if (interaction.commandName === 'say') {
      await this.botManager.sendChat(interaction.options.getString('message', true));
      await interaction.editReply('Sent.');
      return;
    }

    if (interaction.commandName === 'logs') {
      const lines = this.botManager.db.listLogs(10)
        .map((entry) => `[${entry.level}] ${entry.type}: ${entry.message}`)
        .join('\n');
      await interaction.editReply(`\`\`\`\n${lines || 'No logs yet.'}\n\`\`\``);
    }
  }

  async alert(title, description) {
    if (!this.webhookUrl) {
      return;
    }

    try {
      await fetch(this.webhookUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          username: 'CloudAFK Pro X',
          embeds: [
            {
              title,
              description: description || '',
              color: title.toLowerCase().includes('disconnect') || title.toLowerCase().includes('kick')
                ? 0xff5577
                : 0x22c55e,
              timestamp: new Date().toISOString()
            }
          ]
        })
      });
    } catch (error) {
      this.logger.warn('discord', `Webhook alert failed: ${error.message}`);
    }
  }
}
