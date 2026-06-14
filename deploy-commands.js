'use strict';

const { REST, Routes } = require('discord.js');
const config = require('./config');
const roomCommand = require('./commands/room');

async function main() {
  if (!config.TOKEN) {
    console.error('DISCORD_TOKEN не задан в .env');
    process.exit(1);
  }

  const commands = [roomCommand.data.toJSON()];
  const rest = new REST({ version: '10' }).setToken(config.TOKEN);

  // Получаем applicationId из токена (первая часть base64)
  const appId = Buffer.from(config.TOKEN.split('.')[0], 'base64').toString();

  try {
    if (config.GUILD_ID) {
      await rest.put(Routes.applicationGuildCommands(appId, config.GUILD_ID), {
        body: commands,
      });
      console.log(`✅ Команды зарегистрированы на сервере ${config.GUILD_ID} (мгновенно).`);
    } else {
      await rest.put(Routes.applicationCommands(appId), { body: commands });
      console.log('✅ Команды зарегистрированы глобально (появятся в течение ~1 часа).');
    }
  } catch (err) {
    console.error('Ошибка регистрации команд:', err);
    process.exit(1);
  }
}

main();
