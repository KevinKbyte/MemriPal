// @ts-check
// Pal chats in the on-device SQLite db (MEM-099, ADR 0064 amendment 2026-11-03): tables chats +
// chat_messages from schema.js V2. Never sent to the server. Soft delete only (deleted_at); Undo is
// reviveChat. Every input is validated before the first write, and multi-row writes share one
// transaction, so a refused call writes nothing.
import { newId as randomId } from "./uuid.js";

export const ROLES = ["user", "assistant"];
export const MAX_TITLE_CHARS = 100;
export const MAX_MESSAGE_CHARS = 4000;
// Per chat; palace_export.js caps backups at the same count, so one long chat can't make export refuse.
export const MAX_CHAT_MESSAGES = 1000;

const DEFAULT_TITLE = "New chat";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CHAT_KEYS = ["created_at", "id", "messages", "title"];
const MESSAGE_KEYS = ["created_at", "id", "role", "text"];

/**
 * @typedef {{id: string, title: string, created_at: string, updated_at: string}} Chat
 * @typedef {{id: string, chat_id: string, role: string, text: string, created_at: string}} Message
 * @typedef {{id: string, role: string, text: string, created_at: string}} BackupMessage
 * @typedef {{id: string, title: string, created_at: string, messages: BackupMessage[]}} BackupChat
 * @typedef {{
 *   exec: (sql: string, params?: unknown[]) => Promise<unknown>,
 *   query: (sql: string, params?: unknown[]) => Promise<Record<string, any>[]>,
 *   transaction: (stmts: {sql: string, params: unknown[]}[]) => Promise<unknown>,
 * }} AsyncDb
 */

/** @param {unknown} v @returns {v is Record<string, any>} */
const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

/** @param {Record<string, any>} obj @param {string[]} keys */
const hasExactKeys = (obj, keys) => {
  const own = Object.keys(obj).sort();
  return own.length === keys.length && own.every((k, i) => k === keys[i]);
};

/** @param {unknown} t */
export const isTitle = (t) => typeof t === "string" && t.trim().length > 0 && t.length <= MAX_TITLE_CHARS;
/** @param {unknown} t */
const isText = (t) => typeof t === "string" && t.length > 0 && t.length <= MAX_MESSAGE_CHARS;
/** @param {unknown} id */
const isUuid = (id) => typeof id === "string" && UUID_RE.test(id);
/** @param {unknown} t */
const isIso = (t) => typeof t === "string" && !Number.isNaN(new Date(t).getTime()) && new Date(t).toISOString() === t;

/** @param {unknown} m @returns {BackupMessage | null} */
function backupMessageOf(m) {
  if (!isObject(m) || !hasExactKeys(m, MESSAGE_KEYS)) return null;
  if (!isUuid(m.id) || !ROLES.includes(m.role) || !isText(m.text) || !isIso(m.created_at)) return null;
  return { id: m.id, role: m.role, text: m.text, created_at: m.created_at };
}

/**
 * The backup allow-list (shared with palace_export.js): a fresh chat with exactly the backup keys, or
 * null. Message ids must be unique in the chat (the table key is (chat_id, id)).
 * @param {unknown} c
 * @returns {BackupChat | null}
 */
export function backupChatOf(c) {
  if (!isObject(c) || !hasExactKeys(c, CHAT_KEYS)) return null;
  if (!isUuid(c.id) || !isTitle(c.title) || !isIso(c.created_at) || !Array.isArray(c.messages)) return null;
  const messages = c.messages.map(backupMessageOf);
  if (messages.some((m) => m === null)) return null;
  const ids = new Set(messages.map((m) => /** @type {BackupMessage} */ (m).id));
  if (ids.size !== messages.length) return null;
  return { id: c.id, title: c.title, created_at: c.created_at, messages: /** @type {BackupMessage[]} */ (messages) };
}

const CHAT_COLS = "id, title, created_at, updated_at";
const MESSAGE_COLS = "id, chat_id, role, text, created_at";

/**
 * @param {AsyncDb} db async client over a db migrated with schema.js MIGRATIONS
 * @param {{now?: () => string, newId?: () => string}} [opts]
 */
export function createChatStore(db, { now = () => new Date().toISOString(), newId = () => randomId() } = {}) {
  /** @param {unknown} id @returns {Promise<Chat | null>} */
  async function getChat(id) {
    if (typeof id !== "string") return null;
    const rows = await db.query(`SELECT ${CHAT_COLS} FROM chats WHERE id = ? AND deleted_at IS NULL`, [id]);
    return /** @type {Chat | undefined} */ (rows[0]) ?? null;
  }

  /** @param {unknown} id */
  async function liveChat(id) {
    const chat = await getChat(id);
    if (!chat) throw new Error("unknown chat");
    return chat;
  }

  /** A stored chat id, live or deleted. @param {unknown} id */
  async function stored(id) {
    if (typeof id !== "string") return false;
    return (await db.query("SELECT 1 AS one FROM chats WHERE id = ?", [id])).length > 0;
  }

  /** @param {unknown} id */
  async function storedChat(id) {
    if (!(await stored(id))) throw new Error("unknown chat");
  }

  /** @param {unknown} id @returns {Promise<Message[]>} */
  async function listMessages(id) {
    return /** @type {Message[]} */ (await db.query(
      `SELECT ${MESSAGE_COLS} FROM chat_messages WHERE chat_id = ? ORDER BY created_at, seq`, [id]));
  }

  /** Live chats, most recently active first. @returns {Promise<Chat[]>} */
  async function listChats() {
    return /** @type {Chat[]} */ (await db.query(
      `SELECT ${CHAT_COLS} FROM chats WHERE deleted_at IS NULL ORDER BY updated_at DESC, seq DESC`));
  }

  return {
    getChat,
    listChats,
    listMessages,

    /** @param {{title?: unknown}} [opts] @returns {Promise<Chat>} */
    async createChat({ title = DEFAULT_TITLE } = {}) {
      if (!isTitle(title)) throw new Error("bad chat title");
      const t = now();
      const chat = { id: newId(), title: /** @type {string} */ (title), created_at: t, updated_at: t };
      await db.exec(`INSERT INTO chats (${CHAT_COLS}) VALUES (?, ?, ?, ?)`,
        [chat.id, chat.title, chat.created_at, chat.updated_at]);
      return chat;
    },

    /** @param {unknown} id @param {unknown} title @returns {Promise<Chat>} */
    async renameChat(id, title) {
      if (!isTitle(title)) throw new Error("bad chat title");
      await liveChat(id);
      await db.exec("UPDATE chats SET title = ? WHERE id = ?", [title, id]);
      return /** @type {Promise<Chat>} */ (liveChat(id));
    },

    /** @param {unknown} chatId @param {{role?: unknown, text?: unknown}} msg @returns {Promise<Message>} */
    async appendMessage(chatId, { role, text } = {}) {
      if (typeof role !== "string" || !ROLES.includes(role)) throw new Error("bad message role");
      if (!isText(text)) throw new Error("bad message text");
      const chat = await liveChat(chatId);
      const t = now();
      const message = { id: newId(), chat_id: chat.id, role, text: /** @type {string} */ (text), created_at: t };
      // The cap check lives in the INSERT itself so a concurrent append can't slip past it; the bump
      // (to the top of listChats) only lands when the message did.
      await db.transaction([
        { sql: `INSERT INTO chat_messages (${MESSAGE_COLS}) SELECT ?, ?, ?, ?, ?
                WHERE (SELECT count(*) FROM chat_messages WHERE chat_id = ?) < ?`,
          params: [message.id, message.chat_id, message.role, message.text, message.created_at, chat.id, MAX_CHAT_MESSAGES] },
        { sql: "UPDATE chats SET updated_at = ? WHERE id = ? AND EXISTS (SELECT 1 FROM chat_messages WHERE chat_id = ? AND id = ?)",
          params: [t, chat.id, chat.id, message.id] },
      ]);
      const landed = await db.query("SELECT 1 AS one FROM chat_messages WHERE chat_id = ? AND id = ?", [chat.id, message.id]);
      if (landed.length === 0) throw new Error("chat is full");
      return message;
    },

    /** Soft delete; deleting an already-deleted chat keeps its first deleted_at. @param {unknown} id */
    async deleteChat(id) {
      await storedChat(id);
      await db.exec("UPDATE chats SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL", [now(), id]);
    },

    /** Undo of deleteChat. @param {unknown} id @returns {Promise<Chat>} */
    async reviveChat(id) {
      await storedChat(id);
      await db.exec("UPDATE chats SET deleted_at = NULL WHERE id = ?", [id]);
      return /** @type {Promise<Chat>} */ (liveChat(id));
    },

    /** Live chats as backup objects (backupChatOf keys), messages oldest first. @returns {Promise<BackupChat[]>} */
    async exportChats() {
      const chats = await listChats();
      const out = [];
      for (const c of chats) {
        const messages = (await listMessages(c.id)).map(({ id, role, text, created_at }) => ({ id, role, text, created_at }));
        out.push({ id: c.id, title: c.title, created_at: c.created_at, messages });
      }
      return out;
    },

    /**
     * Writes a whole backup chat or nothing. A stored id (live or deleted) counts as present: false,
     * nothing written, a deleted chat stays deleted.
     * @param {unknown} input
     * @returns {Promise<boolean>}
     */
    async restoreChat(input) {
      const chat = backupChatOf(input);
      if (!chat) throw new Error("bad chat");
      if (await stored(chat.id)) return false;
      // updated_at = the latest activity, so a restored chat sorts by its own history, not import time.
      const updated = chat.messages.reduce((t, m) => (m.created_at > t ? m.created_at : t), chat.created_at);
      await db.transaction([
        { sql: `INSERT INTO chats (${CHAT_COLS}) VALUES (?, ?, ?, ?)`, params: [chat.id, chat.title, chat.created_at, updated] },
        ...chat.messages.map((m) => ({
          sql: `INSERT INTO chat_messages (${MESSAGE_COLS}) VALUES (?, ?, ?, ?, ?)`,
          params: [m.id, chat.id, m.role, m.text, m.created_at],
        })),
      ]);
      return true;
    },
  };
}
