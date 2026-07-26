/**
 * SQLite 数据库模块
 *
 * 每个账号一个独立数据库文件：data/<account>.db
 * 图片下载到：data/images/<account>/
 *
 * 表结构：
 *   conversations     - 会话列表缓存
 *   messages          - 消息记录缓存
 *   contacts          - 联系人信息缓存
 *   decrypted_images  - 加密图片解密缓存（阅后即焚）
 */

import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT } from '../sprr/config/paths.js';

const DATA_DIR = path.join(PROJECT_ROOT, 'data');
const IMAGES_DIR = path.join(DATA_DIR, 'images');

/** 账号数据库连接缓存 */
const dbCache = new Map<string, Database.Database>();

/** 确保目录存在 */
function ensureDirs(account: string): void {
  const accountDir = path.join(DATA_DIR, 'accounts');
  if (!fs.existsSync(accountDir)) {
    fs.mkdirSync(accountDir, { recursive: true });
  }
  const imgDir = path.join(IMAGES_DIR, account);
  if (!fs.existsSync(imgDir)) {
    fs.mkdirSync(imgDir, { recursive: true });
  }
}

/** 获取账号数据库文件路径 */
function dbPath(account: string): string {
  return path.join(DATA_DIR, 'accounts', `${account}.db`);
}

/** 获取账号图片目录 */
export function getAccountImageDir(account: string): string {
  const dir = path.join(IMAGES_DIR, account);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/** 打开（或复用）账号数据库 */
export function getDb(account: string): Database.Database {
  let db = dbCache.get(account);
  if (db) return db;

  ensureDirs(account);
  db = new Database(dbPath(account));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  initSchema(db);
  // 兼容已有数据库：添加新列（如果不存在）
  tryAddColumn(db, 'messages', 'is_permanent', 'INTEGER DEFAULT 0');
  tryAddColumn(db, 'messages', 'image_skey', 'TEXT');
  tryAddColumn(db, 'messages', 'image_oid', 'TEXT');
  dbCache.set(account, db);
  return db;
}

/** 关闭所有数据库连接 */
export function closeAllDbs(): void {
  for (const db of dbCache.values()) {
    try {
      db.close();
    } catch {}
  }
  dbCache.clear();
}

/** 尝试添加列（如果不存在），用于兼容已有数据库 */
function tryAddColumn(db: Database.Database, table: string, column: string, def: string): void {
  try {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (!cols.some((c) => c.name === column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`);
    }
  } catch {}
}

/** 建表 */
function initSchema(db: Database.Database): void {
  db.exec(`
    -- 会话列表缓存
    CREATE TABLE IF NOT EXISTS conversations (
      conversation_id    TEXT PRIMARY KEY,
      uid                TEXT,
      sec_uid            TEXT,
      nickname           TEXT,
      remark             TEXT,
      last_message       TEXT,
      last_message_ts    INTEGER,
      unread_count       INTEGER,
      read_index         INTEGER,
      is_pinned          INTEGER DEFAULT 0,
      is_stranger        INTEGER DEFAULT 0,
      is_ai_bot          INTEGER DEFAULT 0,
      conversation_type  INTEGER,
      conversation_short_id TEXT,
      updated_at         INTEGER DEFAULT (strftime('%s','now') * 1000)
    );

    -- 消息记录缓存
    CREATE TABLE IF NOT EXISTS messages (
      msg_id             TEXT PRIMARY KEY,
      server_msg_id      TEXT,
      conversation_id    TEXT NOT NULL,
      sender_id          TEXT,
      sender_label       TEXT,
      is_self            INTEGER DEFAULT 0,
      is_from_robot      INTEGER DEFAULT 0,
      message_type       INTEGER,
      category           TEXT,
      awe_type           INTEGER,
      text               TEXT,
      video_author       TEXT,
      video_url          TEXT,
      sticker_url        TEXT,
      is_encrypted_image INTEGER DEFAULT 0,
      is_permanent       INTEGER DEFAULT 0,
      image_skey         TEXT,
      image_oid          TEXT,
      content_json       TEXT,
      timestamp          INTEGER,
      status             TEXT,
      is_recalled        INTEGER DEFAULT 0,
      FOREIGN KEY (conversation_id) REFERENCES conversations(conversation_id)
    );
    CREATE INDEX IF NOT EXISTS idx_messages_conv_ts ON messages(conversation_id, timestamp);

    -- 如果旧表缺少 is_recalled 字段，则迁移数据
    BEGIN EXCLUSIVE;
    DROP TABLE IF EXISTS new_messages;
    CREATE TABLE new_messages (
      msg_id             TEXT PRIMARY KEY,
      server_msg_id      TEXT,
      conversation_id    TEXT NOT NULL,
      sender_id          TEXT,
      sender_label       TEXT,
      is_self            INTEGER DEFAULT 0,
      is_from_robot      INTEGER DEFAULT 0,
      message_type       INTEGER,
      category           TEXT,
      awe_type           INTEGER,
      text               TEXT,
      video_author       TEXT,
      video_url          TEXT,
      sticker_url        TEXT,
      is_encrypted_image INTEGER DEFAULT 0,
      is_permanent       INTEGER DEFAULT 0,
      image_skey         TEXT,
      image_oid          TEXT,
      content_json       TEXT,
      timestamp          INTEGER,
      status             TEXT,
      is_recalled        INTEGER DEFAULT 0,
      FOREIGN KEY (conversation_id) REFERENCES conversations(conversation_id)
    );
    INSERT OR IGNORE INTO new_messages (
      msg_id, server_msg_id, conversation_id, sender_id, sender_label,
      is_self, is_from_robot, message_type, category, awe_type,
      text, video_author, video_url, sticker_url,
      is_encrypted_image, is_permanent, image_skey, image_oid,
      content_json, timestamp, status, is_recalled
    )
    SELECT
      msg_id, server_msg_id, conversation_id, sender_id, sender_label,
      is_self, is_from_robot, message_type, category, awe_type,
      text, video_author, video_url, sticker_url,
      is_encrypted_image, is_permanent, image_skey, image_oid,
      content_json, timestamp, status, 0
    FROM messages;
    DROP TABLE IF EXISTS messages;
    ALTER TABLE new_messages RENAME TO messages;
    CREATE INDEX IF NOT EXISTS idx_messages_conv_ts ON messages(conversation_id, timestamp);
    COMMIT;

    -- 联系人信息缓存
    CREATE TABLE IF NOT EXISTS contacts (
      uid                TEXT PRIMARY KEY,
      sec_uid            TEXT,
      nickname           TEXT,
      remark             TEXT,
      avatar_url         TEXT,
      updated_at         INTEGER DEFAULT (strftime('%s','now') * 1000)
    );

    -- 加密图片解密缓存（阅后即焚图片下载后的本地路径）
    CREATE TABLE IF NOT EXISTS decrypted_images (
      msg_id             TEXT PRIMARY KEY,
      conversation_id    TEXT,
      local_path         TEXT NOT NULL,
      oid                TEXT,
      md5                TEXT,
      data_size          INTEGER,
      sender_id          TEXT,
      decrypted_at       INTEGER DEFAULT (strftime('%s','now') * 1000)
    );
  `);
}

/* ======================== 会话列表操作 ======================== */

export interface ConversationRow {
  conversation_id: string;
  uid: string;
  sec_uid: string | null;
  nickname: string;
  remark: string | null;
  last_message: string;
  last_message_ts: number | null;
  unread_count: number | null;
  read_index: number | null;
  is_pinned: number;
  is_stranger: number;
  is_ai_bot: number;
  conversation_type: number | null;
  conversation_short_id: string | null;
}

/** 批量 upsert 会话（存在则更新，不存在则插入） */
export function upsertConversations(account: string, rows: ConversationRow[]): void {
  const db = getDb(account);
  const stmt = db.prepare(`
    INSERT INTO conversations (
      conversation_id, uid, sec_uid, nickname, remark,
      last_message, last_message_ts, unread_count, read_index,
      is_pinned, is_stranger, is_ai_bot, conversation_type,
      conversation_short_id, updated_at
    ) VALUES (
      @conversation_id, @uid, @sec_uid, @nickname, @remark,
      @last_message, @last_message_ts, @unread_count, @read_index,
      @is_pinned, @is_stranger, @is_ai_bot, @conversation_type,
      @conversation_short_id, @updated_at
    )
    ON CONFLICT(conversation_id) DO UPDATE SET
      uid=excluded.uid, sec_uid=excluded.sec_uid, nickname=excluded.nickname,
      remark=excluded.remark,
      last_message=COALESCE(NULLIF(excluded.last_message, ''), conversations.last_message),
      last_message_ts=COALESCE(excluded.last_message_ts, conversations.last_message_ts),
      unread_count=excluded.unread_count,
      read_index=excluded.read_index, is_pinned=excluded.is_pinned,
      is_stranger=excluded.is_stranger, is_ai_bot=excluded.is_ai_bot,
      conversation_type=excluded.conversation_type,
      conversation_short_id=excluded.conversation_short_id,
      updated_at=excluded.updated_at
  `);
  const now = Date.now();
  const tx = db.transaction((items: ConversationRow[]) => {
    for (const r of items) {
      stmt.run({ ...r, updated_at: now });
    }
  });
  tx(rows);
}

/** 读取所有缓存的会话 */
export function getCachedConversations(account: string): ConversationRow[] {
  const db = getDb(account);
  return db.prepare(`
    SELECT * FROM conversations
    ORDER BY
      is_pinned DESC,
      last_message_ts DESC,
      nickname ASC
  `).all() as ConversationRow[];
}

/** 更新单个会话的最后消息（收到/发出新消息时调用） */
export function updateConversationLastMessage(
  account: string,
  conversationId: string,
  lastMessage: string,
  lastMessageTs: number,
): void {
  const db = getDb(account);
  db.prepare(`
    UPDATE conversations
    SET last_message = ?, last_message_ts = ?, updated_at = ?
    WHERE conversation_id = ?
  `).run(lastMessage, lastMessageTs, Date.now(), conversationId);
}

/* ======================== 消息记录操作 ======================== */

export interface MessageRow {
  msg_id: string;
  server_msg_id: string | null;
  conversation_id: string;
  sender_id: string | null;
  sender_label: string | null;
  is_self: number;
  is_from_robot: number;
  message_type: number | null;
  category: string | null;
  awe_type: number | null;
  text: string | null;
  video_author: string | null;
  video_url: string | null;
  sticker_url: string | null;
  is_encrypted_image: number;
  is_permanent: number;
  image_skey: string | null;
  image_oid: string | null;
  content_json: string | null;
  timestamp: number | null;
  status: string | null;
  is_recalled: number;
}

/** 批量 upsert 消息 */
export function upsertMessages(account: string, rows: MessageRow[]): void {
  const db = getDb(account);
  const stmt = db.prepare(`
    INSERT INTO messages (
      msg_id, server_msg_id, conversation_id, sender_id, sender_label,
      is_self, is_from_robot, message_type, category, awe_type,
      text, video_author, video_url, sticker_url, is_encrypted_image, is_permanent, image_skey, image_oid,
      content_json, timestamp, status, is_recalled
    ) VALUES (
      @msg_id, @server_msg_id, @conversation_id, @sender_id, @sender_label,
      @is_self, @is_from_robot, @message_type, @category, @awe_type,
      @text, @video_author, @video_url, @sticker_url, @is_encrypted_image, @is_permanent, @image_skey, @image_oid,
      @content_json, @timestamp, @status, @is_recalled
    )
    ON CONFLICT(msg_id) DO UPDATE SET
      server_msg_id=excluded.server_msg_id, sender_id=excluded.sender_id,
      sender_label=excluded.sender_label, is_self=excluded.is_self,
      is_from_robot=excluded.is_from_robot, message_type=excluded.message_type,
      awe_type=excluded.awe_type,
      text=excluded.text, video_author=excluded.video_author,
      video_url=excluded.video_url,
      content_json=excluded.content_json, timestamp=excluded.timestamp,
      status=excluded.status,
      is_recalled=excluded.is_recalled,
      category=CASE WHEN excluded.is_recalled = 1 THEN messages.category ELSE excluded.category END,
      sticker_url=CASE WHEN excluded.is_recalled = 1 THEN messages.sticker_url ELSE excluded.sticker_url END,
      is_encrypted_image=CASE WHEN excluded.is_recalled = 1 THEN messages.is_encrypted_image ELSE excluded.is_encrypted_image END,
      is_permanent=CASE WHEN excluded.is_recalled = 1 THEN messages.is_permanent ELSE excluded.is_permanent END,
      image_skey=CASE WHEN excluded.is_recalled = 1 THEN messages.image_skey ELSE excluded.image_skey END,
      image_oid=CASE WHEN excluded.is_recalled = 1 THEN messages.image_oid ELSE excluded.image_oid END
  `);
  const tx = db.transaction((items: MessageRow[]) => {
    for (const r of items) {
      stmt.run(r);
    }
  });
  tx(rows);
}

/** 读取缓存的会话消息（按时间正序） */
export function getCachedMessages(
  account: string,
  conversationId: string,
  limit = 30,
  beforeTs?: number,
): MessageRow[] {
  const db = getDb(account);
  if (beforeTs) {
    return db.prepare(`
      SELECT * FROM messages
      WHERE conversation_id = ? AND timestamp < ?
      ORDER BY timestamp DESC
      LIMIT ?
    `).all(conversationId, beforeTs, limit).reverse() as MessageRow[];
  }
  return db.prepare(`
    SELECT * FROM messages
    WHERE conversation_id = ?
    ORDER BY timestamp DESC
    LIMIT ?
  `).all(conversationId, limit).reverse() as MessageRow[];
}

/** 按 msgId 查询单条消息（同时匹配 msg_id 和 server_msg_id，用于图片解密） */
export function getMessageById(account: string, msgId: string): MessageRow | null {
  const db = getDb(account);
  return (db.prepare(`SELECT * FROM messages WHERE msg_id = ? OR server_msg_id = ?`).get(msgId, msgId) as MessageRow | undefined) || null;
}

/* ======================== 联系人信息操作 ======================== */

export interface ContactRow {
  uid: string;
  sec_uid: string | null;
  nickname: string;
  remark: string | null;
  avatar_url: string | null;
}

/** 批量 upsert 联系人 */
export function upsertContacts(account: string, rows: ContactRow[]): void {
  const db = getDb(account);
  const stmt = db.prepare(`
    INSERT INTO contacts (uid, sec_uid, nickname, remark, avatar_url, updated_at)
    VALUES (@uid, @sec_uid, @nickname, @remark, @avatar_url, @updated_at)
    ON CONFLICT(uid) DO UPDATE SET
      sec_uid=excluded.sec_uid, nickname=excluded.nickname,
      remark=excluded.remark, avatar_url=excluded.avatar_url,
      updated_at=excluded.updated_at
  `);
  const now = Date.now();
  const tx = db.transaction((items: ContactRow[]) => {
    for (const r of items) {
      stmt.run({ ...r, updated_at: now });
    }
  });
  tx(rows);
}

/**
 * 按 uid 批量查询联系人头像 URL
 *
 * @returns Map<uid, avatar_url>
 */
export function getContactAvatars(account: string, uids: string[]): Map<string, string> {
  const db = getDb(account);
  const result = new Map<string, string>();
  if (uids.length === 0) return result;
  const placeholders = uids.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT uid, avatar_url FROM contacts WHERE uid IN (${placeholders})`,
  ).all(...uids) as Array<{ uid: string; avatar_url: string | null }>;
  for (const r of rows) {
    if (r.avatar_url) result.set(r.uid, r.avatar_url);
  }
  return result;
}

/* ======================== 加密图片缓存操作 ======================== */

export interface DecryptedImageRow {
  msg_id: string;
  conversation_id: string;
  local_path: string;
  oid: string | null;
  md5: string | null;
  data_size: number | null;
  sender_id: string | null;
}

/** 保存解密图片记录 */
export function saveDecryptedImage(account: string, row: DecryptedImageRow): void {
  const db = getDb(account);
  db.prepare(`
    INSERT INTO decrypted_images (msg_id, conversation_id, local_path, oid, md5, data_size, sender_id)
    VALUES (@msg_id, @conversation_id, @local_path, @oid, @md5, @data_size, @sender_id)
    ON CONFLICT(msg_id) DO UPDATE SET
      local_path=excluded.local_path, oid=excluded.oid, md5=excluded.md5,
      data_size=excluded.data_size, sender_id=excluded.sender_id
  `).run(row);
}

/** 查询解密图片缓存 */
export function getDecryptedImage(account: string, msgId: string): DecryptedImageRow | null {
  const db = getDb(account);
  return (db.prepare(`
    SELECT * FROM decrypted_images WHERE msg_id = ?
  `).get(msgId) as DecryptedImageRow) || null;
}
