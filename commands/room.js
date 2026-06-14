'use strict';

const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  UserSelectMenuBuilder,
  ActionRowBuilder,
  MessageFlags,
  Colors,
} = require('discord.js');

const config = require('../config');
const db = require('../db');

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
    sub
      .setName('manage')
      .setDescription('Добавить участников в свою комнату')
  );

/**
 * Парсит цвет: hex (#rrggbb / rrggbb) или именованный цвет discord.js.
 * Возвращает число или null при неудаче.
 */
function parseColor(input) {
  const raw = input.trim();

  // hex
  const hex = raw.replace(/^#/, '');
  if (/^[0-9a-fA-F]{6}$/.test(hex)) {
    return parseInt(hex, 16);
  }

  // именованный цвет (Colors из discord.js), регистронезависимо
  const key = Object.keys(Colors).find(
    (k) => k.toLowerCase() === raw.toLowerCase()
  );
  if (key) return Colors[key];

  return null;
}

async function handleCreate(interaction) {
  const { guild, member, user } = interaction;
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  // 1. Одна комната на создателя
  if (db.getRoomByOwner(user.id)) {
    return interaction.editReply('У тебя уже есть комната. На пользователя — одна комната.');
  }

  // 2. Цвет
  const colorInput = interaction.options.getString('цвет');
  let color = parseColor(colorInput);
  let colorWarning = '';
  if (color === null) {
    color = config.DEFAULT_COLOR;
    colorWarning = `\n⚠️ Цвет \`${colorInput}\` не распознан — использован цвет по умолчанию.`;
  }

  const name = interaction.options.getString('название');

  // 3. Проверка иерархии: роль бота должна быть выше якорной
  const anchor = guild.roles.cache.get(config.ANCHOR_ROLE_ID);
  if (!anchor) {
    return interaction.editReply(
      `Якорная роль (${config.ANCHOR_ROLE_ID}) не найдена на сервере. Проверь конфиг.`
    );
  }
  if (guild.members.me.roles.highest.position <= anchor.position) {
    return interaction.editReply(
      'Роль бота должна быть выше якорной роли, иначе я не смогу создать роль над ней. ' +
        'Подними роль бота в настройках сервера.'
    );
  }

  // 4. Создаём роль прямо над якорной
  let role;
  try {
    role = await guild.roles.create({
      name,
      color,
      reason: `Комната пользователя ${user.tag}`,
    });
    // Ставим роль ПОСЛЕ (ниже) якорной роли в списке.
    // Позиция якорной могла сместиться после создания новой роли — берём свежую.
    const anchorNow = guild.roles.cache.get(config.ANCHOR_ROLE_ID);
    const targetPos = Math.max(1, anchorNow.position - 1);
    await role.setPosition(targetPos).catch(() => {});
  } catch (err) {
    console.error('Ошибка создания роли:', err);
    return interaction.editReply('Не удалось создать роль. Проверь права бота (Manage Roles).');
  }

  // 5. Выдаём роль автору
  try {
    await member.roles.add(role);
  } catch (err) {
    console.error('Ошибка выдачи роли:', err);
  }

  // 6. Сохраняем в БД (владелец автоматически в whitelist)
  db.createRoom(user.id, guild.id, role.id, name);

  return interaction.editReply(
    `✅ Комната **${name}** создана! Роль <@&${role.id}> выдана тебе.\n` +
      `Зайди в триггер-канал, чтобы открыть голосовой канал \`${config.ROOM_PREFIX}${name}\`.` +
      colorWarning
  );
}

async function handleManage(interaction) {
  const { user } = interaction;

  const room = db.getRoomByOwner(user.id);
  if (!room) {
    return interaction.reply({
      content: 'У тебя нет комнаты. Сначала создай её через `/room create`.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const select = new UserSelectMenuBuilder()
    .setCustomId('room_manage')
    .setPlaceholder('Выбери пользователей для добавления в комнату')
    .setMinValues(1)
    .setMaxValues(25);

  const row = new ActionRowBuilder().addComponents(select);

  return interaction.reply({
    content: `Управление комнатой **${room.name}**. Выбери, кого добавить:`,
    components: [row],
    flags: MessageFlags.Ephemeral,
  });
}

/** Обработка выбора пользователей в меню /room manage. */
async function handleManageSelect(interaction) {
  const { guild, user } = interaction;

  const room = db.getRoomByOwner(user.id);
  if (!room) {
    return interaction.update({
      content: 'Комната не найдена. Возможно, она была удалена.',
      components: [],
    });
  }

  const role = guild.roles.cache.get(room.role_id);
  const added = [];

  for (const memberId of interaction.values) {
    db.addMember(user.id, memberId);
    if (role) {
      const target = await guild.members.fetch(memberId).catch(() => null);
      if (target) await target.roles.add(role).catch(() => {});
    }
    added.push(`<@${memberId}>`);
  }

  return interaction.update({
    content: `✅ Добавлены в комнату **${room.name}**: ${added.join(', ')}`,
    components: [],
  });
}

module.exports = {
  data,
  parseColor,
  handleCreate,
  handleManage,
  handleManageSelect,
  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    if (sub === 'create') return handleCreate(interaction);
    if (sub === 'manage') return handleManage(interaction);
  },
};
