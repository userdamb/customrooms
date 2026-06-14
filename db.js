'use strict';

require('dotenv').config();
const path = require('path');
const Database = require('better-sqlite3');

// Путь к файлу БД. По умолчанию — рядом с кодом, но на проде задаётся через
// DB_PATH в .env и указывает ВНЕ папки с кодом (например /opt/customrooms-data/rooms.sqlite),
// чтобы обновления кода (git pull/redeploy) никогда не затрагивали базу.
const dbPath = process.env.DB_PATH || path.join(__dirname, 'rooms.sqlite');
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS rooms (
    owner_id   TEXT PRIMARY KEY,
    guild_id   TEXT NOT NULL,
    role_id    TEXT NOT NULL,
    name       TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS room_members (
    owner_id   TEXT NOT NULL,
    member_id  TEXT NOT NULL,
    PRIMARY KEY (owner_id, member_id)
  );
`);

const stmts = {
  getRoomByOwner: db.prepare('SELECT * FROM rooms WHERE owner_id = ?'),
  getRoomByRole: db.prepare('SELECT * FROM rooms WHERE role_id = ?'),
  insertRoom: db.prepare(
    'INSERT INTO rooms (owner_id, guild_id, role_id, name) VALUES (?, ?, ?, ?)'
  ),
  deleteRoom: db.prepare('DELETE FROM rooms WHERE owner_id = ?'),
  addMember: db.prepare(
    'INSERT OR IGNORE INTO room_members (owner_id, member_id) VALUES (?, ?)'
  ),
  removeMember: db.prepare(
    'DELETE FROM room_members WHERE owner_id = ? AND member_id = ?'
  ),
  // Находит запись whitelist, где данный пользователь является участником.
  findMembership: db.prepare(
    'SELECT * FROM room_members WHERE member_id = ? LIMIT 1'
  ),
  isMemberOf: db.prepare(
    'SELECT 1 FROM room_members WHERE owner_id = ? AND member_id = ?'
  ),
  getMembers: db.prepare('SELECT member_id FROM room_members WHERE owner_id = ?'),
  renameRoom: db.prepare('UPDATE rooms SET name = ? WHERE owner_id = ?'),
  deleteMembers: db.prepare('DELETE FROM room_members WHERE owner_id = ?'),
};

module.exports = {
  /** Вернёт запись комнаты по владельцу или undefined. */
  getRoomByOwner(ownerId) {
    return stmts.getRoomByOwner.get(ownerId);
  },

  /** Вернёт запись комнаты по роли или undefined. */
  getRoomByRole(roleId) {
    return stmts.getRoomByRole.get(roleId);
  },

  /** Создаёт комнату и добавляет владельца в whitelist. */
  createRoom(ownerId, guildId, roleId, name) {
    const tx = db.transaction(() => {
      stmts.insertRoom.run(ownerId, guildId, roleId, name);
      stmts.addMember.run(ownerId, ownerId);
    });
    tx();
  },

  /** Удаляет комнату и весь её whitelist. */
  deleteRoom(ownerId) {
    const tx = db.transaction(() => {
      stmts.deleteMembers.run(ownerId);
      stmts.deleteRoom.run(ownerId);
    });
    tx();
  },

  /** Добавляет участника в whitelist комнаты владельца. */
  addMember(ownerId, memberId) {
    stmts.addMember.run(ownerId, memberId);
  },

  /** Убирает участника из whitelist комнаты владельца. */
  removeMember(ownerId, memberId) {
    stmts.removeMember.run(ownerId, memberId);
  },

  /**
   * Вернёт owner_id комнаты, в whitelist которой состоит memberId, либо null.
   */
  isWhitelisted(memberId) {
    const row = stmts.findMembership.get(memberId);
    return row ? row.owner_id : null;
  },

  /** true, если memberId есть в whitelist комнаты ownerId. */
  isMemberOf(ownerId, memberId) {
    return !!stmts.isMemberOf.get(ownerId, memberId);
  },

  /** Массив member_id всех участников комнаты владельца. */
  getMembers(ownerId) {
    return stmts.getMembers.all(ownerId).map((r) => r.member_id);
  },

  /** Переименовать комнату владельца. */
  renameRoom(ownerId, name) {
    stmts.renameRoom.run(name, ownerId);
  },
};
