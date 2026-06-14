'use strict';

const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  UserSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  MessageFlags,
  Colors,
} = require('discord.js');

const config = require('../config');
const db = require('../db');

const EMBED_COLOR = 0x2f3136; // 3092790

const data = new SlashCommandBuilder()
  .setName('room')
  .setDescription('Управление кастомными комнатами')
  .addSubcommand((sub) =>
    sub
      .setName('create')
      .setDescription('Создать свою комнату (роль + приватный голосовой канал)')
      .addStringOption((opt) =>
        opt.setName('название').setDescription('Название комнаты/роли').setRequired(true)
      )
      .addStringOption((opt) =>
        opt
          .setName('цвет')
          .setDescription('Цвет роли: hex (#ff0000) или имя (Red, Blue, ...)')
          .setRequired(true)
      )
  )
  .addSubcommand((sub) =>
    sub.setName('manage').setDescription('Управление своей комнатой')
  );

/**
 * Парсит цвет: hex (#rrggbb / rrggbb) или именованный цвет discord.js.
 * Возвращает число или null при неудаче.
 */
function parseColor(input) {
  const raw = input.trim();
  const hex = raw.replace(/^#/, '');
  if (/^[0-9a-fA-F]{6}$/.test(hex)) return parseInt(hex, 16);
  const key = Object.keys(Colors).find((k) => k.toLowerCase() === raw.toLowerCase());
  if (key) return Colors[key];
  return null;
}

/** Embed с аватаркой того, кто взаимодействует. */
function buildEmbed(interaction, title, description, color = EMBED_COLOR) {
  return new EmbedBuilder()
    .setTitle(title)
    .setDescription(description)
    .setColor(color)
    .setThumbnail(interaction.user.displayAvatarURL({ size: 256 }));
}

/** Панель управления комнатой: 4 кнопки. */
function manageRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('room_list')
      .setLabel('Список пользователей')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId('room_rename')
      .setLabel('Изменить название')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('room_delete')
      .setLabel('Удалить комнату')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId('room_add')
      .setLabel('Добавить пользователей')
      .setStyle(ButtonStyle.Success)
  );
}

/** Ответ-ошибка «нет комнаты». */
function noRoom(interaction) {
  return interaction.reply({
    embeds: [
      buildEmbed(
        interaction,
        'Ошибка',
        'У вас нет личной комнаты. Создайте её через `/room create`.',
        Colors.Red
      ),
    ],
    flags: MessageFlags.Ephemeral,
  });
}

// ───────────────────────── Слэш-команды ─────────────────────────

async function handleCreate(interaction) {
  const { guild, member, user } = interaction;
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  if (db.getRoomByOwner(user.id)) {
    return interaction.editReply({
      embeds: [
        buildEmbed(interaction, 'Создание личной комнаты', 'У вас уже есть комната — на пользователя одна.', Colors.Red),
      ],
    });
  }

  const colorInput = interaction.options.getString('цвет');
  let color = parseColor(colorInput);
  let colorWarning = '';
  if (color === null) {
    color = config.DEFAULT_COLOR;
    colorWarning = `\n⚠️ Цвет \`${colorInput}\` не распознан — использован цвет по умолчанию.`;
  }

  const name = interaction.options.getString('название');

  const anchor = guild.roles.cache.get(config.ANCHOR_ROLE_ID);
  if (!anchor) {
    return interaction.editReply({
      embeds: [buildEmbed(interaction, 'Ошибка', `Якорная роль (${config.ANCHOR_ROLE_ID}) не найдена на сервере.`, Colors.Red)],
    });
  }
  if (guild.members.me.roles.highest.position <= anchor.position) {
    return interaction.editReply({
      embeds: [buildEmbed(interaction, 'Ошибка', 'Роль бота должна быть выше якорной роли. Поднимите её в настройках сервера.', Colors.Red)],
    });
  }

  let role;
  try {
    role = await guild.roles.create({ name, color, reason: `Комната пользователя ${user.tag}` });
    const anchorNow = guild.roles.cache.get(config.ANCHOR_ROLE_ID);
    await role.setPosition(Math.max(1, anchorNow.position - 1)).catch(() => {});
  } catch (err) {
    console.error('Ошибка создания роли:', err);
    return interaction.editReply({
      embeds: [buildEmbed(interaction, 'Ошибка', 'Не удалось создать роль. Проверьте права бота (Manage Roles).', Colors.Red)],
    });
  }

  try {
    await member.roles.add(role);
  } catch (err) {
    console.error('Ошибка выдачи роли:', err);
  }

  db.createRoom(user.id, guild.id, role.id, name);

  return interaction.editReply({
    embeds: [
      buildEmbed(
        interaction,
        'Создание личной комнаты',
        `<@${user.id}>, Вы успешно создали личную комнату <@&${role.id}>${colorWarning}`
      ),
    ],
  });
}

async function handleManage(interaction) {
  const room = db.getRoomByOwner(interaction.user.id);
  if (!room) return noRoom(interaction);

  return interaction.reply({
    embeds: [
      buildEmbed(
        interaction,
        'Управление личной комнатой',
        `<@${interaction.user.id}>, Здесь вы можете управлять своей личной комнатой`
      ),
    ],
    components: [manageRow()],
    flags: MessageFlags.Ephemeral,
  });
}

// ───────────────────────── Кнопки ─────────────────────────

async function handleButton(interaction, activeRooms) {
  switch (interaction.customId) {
    case 'room_list':
      return listMembers(interaction);
    case 'room_add':
      return showAddSelect(interaction);
    case 'room_rename':
      return showRenameModal(interaction);
    case 'room_delete':
      return deleteRoom(interaction, activeRooms);
    default:
      return;
  }
}

async function listMembers(interaction) {
  const room = db.getRoomByOwner(interaction.user.id);
  if (!room) return noRoom(interaction);

  const ids = db.getMembers(interaction.user.id);
  const list = ids.length ? ids.map((id) => `• <@${id}>`).join('\n') : 'Пока никого нет.';

  return interaction.reply({
    embeds: [buildEmbed(interaction, 'Список пользователей', `Комната **${room.name}**:\n${list}`)],
    flags: MessageFlags.Ephemeral,
  });
}

async function showAddSelect(interaction) {
  const room = db.getRoomByOwner(interaction.user.id);
  if (!room) return noRoom(interaction);

  const select = new UserSelectMenuBuilder()
    .setCustomId('room_add_select')
    .setPlaceholder('Выберите пользователей для добавления')
    .setMinValues(1)
    .setMaxValues(25);

  return interaction.reply({
    embeds: [buildEmbed(interaction, 'Добавить пользователей', `Комната **${room.name}**: выберите, кого добавить.`)],
    components: [new ActionRowBuilder().addComponents(select)],
    flags: MessageFlags.Ephemeral,
  });
}

async function showRenameModal(interaction) {
  const room = db.getRoomByOwner(interaction.user.id);
  if (!room) return noRoom(interaction);

  const modal = new ModalBuilder().setCustomId('room_rename_modal').setTitle('Изменить название комнаты');
  const input = new TextInputBuilder()
    .setCustomId('room_name')
    .setLabel('Новое название')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(90)
    .setValue(room.name);
  modal.addComponents(new ActionRowBuilder().addComponents(input));

  return interaction.showModal(modal);
}

async function deleteRoom(interaction, activeRooms) {
  const room = db.getRoomByOwner(interaction.user.id);
  if (!room) return noRoom(interaction);

  const { guild } = interaction;
  const role = guild.roles.cache.get(room.role_id);
  if (role) await role.delete('Комната удалена владельцем').catch(() => {});

  const chId = activeRooms.get(interaction.user.id);
  if (chId) {
    const ch = guild.channels.cache.get(chId);
    if (ch) await ch.delete('Комната удалена владельцем').catch(() => {});
    activeRooms.delete(interaction.user.id);
  }

  db.deleteRoom(interaction.user.id);

  return interaction.update({
    embeds: [
      buildEmbed(
        interaction,
        'Удаление личной комнаты',
        `<@${interaction.user.id}>, ваша комната **${room.name}** удалена.`,
        Colors.Red
      ),
    ],
    components: [],
  });
}

// ───────────────── Подтверждения меню/модалки ─────────────────

/** Выбор пользователей в меню «Добавить пользователей». */
async function handleAddSelect(interaction) {
  const room = db.getRoomByOwner(interaction.user.id);
  if (!room) {
    return interaction.update({
      embeds: [buildEmbed(interaction, 'Ошибка', 'Комната не найдена.', Colors.Red)],
      components: [],
    });
  }

  const { guild } = interaction;
  const role = guild.roles.cache.get(room.role_id);
  const added = [];

  for (const memberId of interaction.values) {
    db.addMember(interaction.user.id, memberId);
    if (role) {
      const target = await guild.members.fetch(memberId).catch(() => null);
      if (target) await target.roles.add(role).catch(() => {});
    }
    added.push(`<@${memberId}>`);
  }

  return interaction.update({
    embeds: [buildEmbed(interaction, 'Добавление пользователей', `В комнату **${room.name}** добавлены: ${added.join(', ')}`)],
    components: [],
  });
}

/** Сабмит модалки «Изменить название». */
async function handleRenameModal(interaction, activeRooms) {
  const room = db.getRoomByOwner(interaction.user.id);
  if (!room) return noRoom(interaction);

  const newName = interaction.fields.getTextInputValue('room_name').trim();
  if (!newName) {
    return interaction.reply({
      embeds: [buildEmbed(interaction, 'Ошибка', 'Название не может быть пустым.', Colors.Red)],
      flags: MessageFlags.Ephemeral,
    });
  }

  const { guild } = interaction;
  const role = guild.roles.cache.get(room.role_id);
  if (role) await role.setName(newName).catch(() => {});

  const chId = activeRooms.get(interaction.user.id);
  if (chId) {
    const ch = guild.channels.cache.get(chId);
    if (ch) await ch.setName(`${config.ROOM_PREFIX}${newName}`).catch(() => {});
  }

  db.renameRoom(interaction.user.id, newName);

  return interaction.reply({
    embeds: [
      buildEmbed(
        interaction,
        'Изменение названия',
        `<@${interaction.user.id}>, название комнаты изменено на **${newName}** (роль <@&${room.role_id}>).`
      ),
    ],
    flags: MessageFlags.Ephemeral,
  });
}

module.exports = {
  data,
  parseColor,
  handleCreate,
  handleManage,
  handleButton,
  handleAddSelect,
  handleRenameModal,
  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    if (sub === 'create') return handleCreate(interaction);
    if (sub === 'manage') return handleManage(interaction);
  },
};
