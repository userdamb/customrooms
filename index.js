'use strict';

const {
  Client,
  GatewayIntentBits,
  Events,
  ChannelType,
  PermissionFlagsBits,
} = require('discord.js');

const config = require('./config');
const db = require('./db');
const roomCommand = require('./commands/room');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers,
  ],
});

// owner_id -> channel_id активного временного голосового канала
const activeRooms = new Map();

client.once(Events.ClientReady, (c) => {
  console.log(`✅ Logged in as ${c.user.tag}`);
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand() && interaction.commandName === 'room') {
      await roomCommand.execute(interaction);
    } else if (interaction.isButton() && interaction.customId.startsWith('room_')) {
      await roomCommand.handleButton(interaction, activeRooms);
    } else if (interaction.isUserSelectMenu() && interaction.customId === 'room_add_select') {
      await roomCommand.handleAddSelect(interaction);
    } else if (interaction.isModalSubmit() && interaction.customId === 'room_rename_modal') {
      await roomCommand.handleRenameModal(interaction, activeRooms);
    }
  } catch (err) {
    console.error('Ошибка обработки взаимодействия:', err);
    if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
      interaction
        .reply({ content: 'Произошла ошибка при выполнении команды.', ephemeral: true })
        .catch(() => {});
    }
  }
});

/** Создаёт временный приватный голосовой канал для владельца. */
async function createRoomChannel(guild, trigger, room) {
  const role = guild.roles.cache.get(room.role_id);

  const channel = await guild.channels.create({
    name: `${config.ROOM_PREFIX}${room.name}`,
    type: ChannelType.GuildVoice,
    parent: trigger.parentId ?? undefined,
    reason: `Комната пользователя ${room.owner_id}`,
    permissionOverwrites: [
      {
        id: guild.roles.everyone.id,
        deny: [PermissionFlagsBits.Connect],
      },
      ...(role
        ? [{ id: role.id, allow: [PermissionFlagsBits.Connect] }]
        : []),
      {
        id: guild.members.me.id,
        allow: [
          PermissionFlagsBits.Connect,
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.MoveMembers,
        ],
      },
    ],
  });

  activeRooms.set(room.owner_id, channel.id);
  return channel;
}

client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
  const guild = newState.guild;

  // --- Вход в триггер-канал ---
  if (newState.channelId === config.TRIGGER_CHANNEL_ID) {
    const member = newState.member;
    const trigger = newState.channel;

    try {
      const ownedRoom = db.getRoomByOwner(member.id);

      if (ownedRoom) {
        // Владелец: открываем/создаём его канал и перемещаем туда
        let channelId = activeRooms.get(member.id);
        let channel = channelId ? guild.channels.cache.get(channelId) : null;
        if (!channel) {
          channel = await createRoomChannel(guild, trigger, ownedRoom);
        }
        await member.voice.setChannel(channel).catch(() => {});
        return;
      }

      // Не владелец: проверяем whitelist
      const ownerId = db.isWhitelisted(member.id);
      if (ownerId) {
        const channelId = activeRooms.get(ownerId);
        const channel = channelId ? guild.channels.cache.get(channelId) : null;
        if (channel) {
          await member.voice.setChannel(channel).catch(() => {});
          return;
        }
      }

      // Нет в БД или комната не активна → отключаем
      await member.voice.disconnect().catch(() => {});
    } catch (err) {
      console.error('Ошибка обработки входа в триггер:', err);
    }
  }

  // --- Защита самого канала комнаты: выкидываем чужих, кто зашёл напрямую ---
  if (
    newState.channelId &&
    newState.channelId !== config.TRIGGER_CHANNEL_ID &&
    newState.channelId !== oldState.channelId
  ) {
    // Является ли это активным каналом комнаты?
    let roomOwnerId = null;
    for (const [ownerId, chId] of activeRooms) {
      if (chId === newState.channelId) {
        roomOwnerId = ownerId;
        break;
      }
    }
    if (roomOwnerId) {
      const member = newState.member;
      const allowed =
        member.id === roomOwnerId || db.isMemberOf(roomOwnerId, member.id);
      if (!allowed) {
        await member.voice.disconnect('Не в whitelist комнаты').catch(() => {});
      }
    }
  }

  // --- Выход/перемещение из временного канала: удалить пустой ---
  if (oldState.channelId && oldState.channelId !== newState.channelId) {
    const leftId = oldState.channelId;
    // Найти владельца, чей канал покинули
    let ownerOfLeft = null;
    for (const [ownerId, chId] of activeRooms) {
      if (chId === leftId) {
        ownerOfLeft = ownerId;
        break;
      }
    }
    if (ownerOfLeft) {
      const channel = guild.channels.cache.get(leftId);
      if (channel && channel.members.size === 0) {
        await channel.delete('Комната опустела').catch(() => {});
        activeRooms.delete(ownerOfLeft);
      }
    }
  }
});

if (!config.TOKEN) {
  console.error('DISCORD_TOKEN не задан в .env');
  process.exit(1);
}

client.login(config.TOKEN);
