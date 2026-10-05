"use strict";
/** Penyimpanan SQLite via sql.js (WASM, tanpa native build). Cookie dienkripsi AES-256-GCM. */
const crypto = require("node:crypto");
const fs = require("node:fs");
const initSqlJs = require("sql.js");
const config = require("./config");

let db = null;

async function init() {
  if (db) return;
  const SQL = await initSqlJs();
  db = fs.existsSync(config.DB_PATH)
    ? new SQL.Database(fs.readFileSync(config.DB_PATH))
    : new SQL.Database();
  db.exec(`
    CREATE TABLE IF NOT EXISTS users(
      telegram_id INTEGER PRIMARY KEY,
      cookie_enc TEXT NOT NULL,
      username TEXT, phone_masked TEXT, updated_at INTEGER);
    CREATE TABLE IF NOT EXISTS admins(
      telegram_id INTEGER PRIMARY KEY, added_at INTEGER);
    CREATE TABLE IF NOT EXISTS campaigns(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL, claim_at INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      created_by INTEGER, created_at INTEGER);
    CREATE TABLE IF NOT EXISTS campaign_users(
      campaign_id INTEGER NOT NULL, telegram_id INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'joined',
      attempts INTEGER NOT NULL DEFAULT 0, last_result TEXT,
      PRIMARY KEY(campaign_id, telegram_id));
    CREATE TABLE IF NOT EXISTS seen_vouchers(
      telegram_id INTEGER NOT NULL, promotion_id TEXT NOT NULL,
      first_seen INTEGER, PRIMARY KEY(telegram_id, promotion_id));
    CREATE TABLE IF NOT EXISTS monitor_prefs(
      telegram_id INTEGER PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 1);
  `);
  persist();
}

function persist() {
  fs.writeFileSync(config.DB_PATH, Buffer.from(db.export()));
}

function run(sql, params = []) {
  const st = db.prepare(sql);
  st.run(params);
  st.free();
  // NOTE: db.export() me-reset last_insert_rowid(), jadi ambil dulu
  const lid = db.exec("SELECT last_insert_rowid() AS id")[0].values[0][0];
  persist();
  return lid;
}

function get(sql, params = []) {
  const st = db.prepare(sql);
  st.bind(params);
  const row = st.step() ? st.getAsObject() : null;
  st.free();
  return row;
}

function all(sql, params = []) {
  const st = db.prepare(sql);
  st.bind(params);
  const rows = [];
  while (st.step()) rows.push(st.getAsObject());
  st.free();
  return rows;
}

function getKey() {
  const hex = config.ENCRYPTION_KEY_HEX;
  if (!/^[0-9a-fA-F]{64}$/.test(hex))
    throw new Error("BOT_ENCRYPTION_KEY harus 64 char hex (32 byte)");
  return Buffer.from(hex, "hex");
}

function encryptCookie(s) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", getKey(), iv);
  const enc = Buffer.concat([c.update(s, "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString("base64");
}

function decryptCookie(t) {
  const b = Buffer.from(t, "base64");
  const d = crypto.createDecipheriv("aes-256-gcm", getKey(), b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString("utf8");
}

const now = () => Math.floor(Date.now() / 1000);

module.exports = {
  init, encryptCookie, decryptCookie,

  // ---- users ----
  saveUser(tid, cookieEnc, username, phoneMasked) {
    run("INSERT OR REPLACE INTO users VALUES(?,?,?,?,?)", [tid, cookieEnc, username, phoneMasked, now()]);
  },
  getUser(tid) {
    const r = get("SELECT cookie_enc, username, phone_masked FROM users WHERE telegram_id=?", [tid]);
    return r ? { cookieEnc: r.cookie_enc, username: r.username, phoneMasked: r.phone_masked } : null;
  },
  deleteUser(tid) {
    run("DELETE FROM users WHERE telegram_id=?", [tid]);
    run("DELETE FROM campaign_users WHERE telegram_id=?", [tid]);
  },

  // ---- admins ----
  seedAdmins() {
    for (const tid of config.ADMIN_IDS) run("INSERT OR IGNORE INTO admins VALUES(?,?)", [tid, now()]);
  },
  isAdmin(tid) { return !!get("SELECT 1 FROM admins WHERE telegram_id=?", [tid]); },
  addAdmin(tid) { run("INSERT OR IGNORE INTO admins VALUES(?,?)", [tid, now()]); },
  getAdmins() { return all("SELECT telegram_id FROM admins ORDER BY added_at").map((r) => r.telegram_id); },
  adminWithCookie() {
    for (const tid of this.getAdmins()) if (this.getUser(tid)) return tid;
    return null;
  },

  // ---- campaigns ----
  createCampaign(code, claimAt, createdBy) {
    return run("INSERT INTO campaigns(code,claim_at,created_by,created_at) VALUES(?,?,?,?)",
      [code.toUpperCase(), claimAt, createdBy, now()]);
  },
  getCampaign(cid) {
    return get("SELECT id,code,claim_at,status,created_by FROM campaigns WHERE id=?", [cid]);
  },
  getCampaignByCode(code) {
    return get("SELECT id,code,claim_at,status,created_by FROM campaigns WHERE code=? AND status='open' ORDER BY id DESC LIMIT 1", [code.toUpperCase()]);
  },
  listCampaigns(openOnly = true) {
    return all("SELECT id,code,claim_at,status FROM campaigns" + (openOnly ? " WHERE status='open'" : "") + " ORDER BY claim_at");
  },
  setCampaignStatus(cid, status) { run("UPDATE campaigns SET status=? WHERE id=?", [status, cid]); },
  joinCampaign(cid, tid) {
    const before = get("SELECT 1 FROM campaign_users WHERE campaign_id=? AND telegram_id=?", [cid, tid]);
    run("INSERT OR IGNORE INTO campaign_users(campaign_id,telegram_id) VALUES(?,?)", [cid, tid]);
    return !before;
  },
  leaveCampaign(cid, tid) {
    run("UPDATE campaign_users SET status='left' WHERE campaign_id=? AND telegram_id=?", [cid, tid]);
  },
  isJoined(cid, tid) {
    return !!get("SELECT 1 FROM campaign_users WHERE campaign_id=? AND telegram_id=? AND status='joined'", [cid, tid]);
  },
  joinedUsers(cid) {
    return all("SELECT telegram_id FROM campaign_users WHERE campaign_id=? AND status='joined'", [cid]).map((r) => r.telegram_id);
  },
  myCampaigns(tid) {
    return all(`SELECT c.id,c.code,c.claim_at,c.status,cu.status AS ustatus FROM campaigns c
      JOIN campaign_users cu ON cu.campaign_id=c.id
      WHERE cu.telegram_id=? AND cu.status!='left' ORDER BY c.claim_at`, [tid]);
  },
  markCampaignUser(cid, tid, status, attempts, lastResult = "") {
    run("UPDATE campaign_users SET status=?,attempts=?,last_result=? WHERE campaign_id=? AND telegram_id=?",
      [status, attempts, String(lastResult).slice(0, 500), cid, tid]);
  },

  // ---- monitor ----
  setMonitor(tid, enabled) { run("INSERT OR REPLACE INTO monitor_prefs VALUES(?,?)", [tid, enabled ? 1 : 0]); },
  monitorEnabled(tid) {
    const r = get("SELECT enabled FROM monitor_prefs WHERE telegram_id=?", [tid]);
    return r ? !!r.enabled : false;
  },
  seenVoucher(tid, pid) { return !!get("SELECT 1 FROM seen_vouchers WHERE telegram_id=? AND promotion_id=?", [tid, pid]); },
  markSeen(tid, pid) { run("INSERT OR IGNORE INTO seen_vouchers VALUES(?,?,?)", [tid, pid, now()]); },
  hasSeenAny(tid) { return !!get("SELECT 1 FROM seen_vouchers WHERE telegram_id=? LIMIT 1", [tid]); },
};
