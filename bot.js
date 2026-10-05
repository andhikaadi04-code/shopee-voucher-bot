"use strict";
/** Self-install: kalau node_modules belum ada (fresh upload ke panel),
 *  install otomatis sekali jalan. */
const _path = require("node:path");
const _fs = require("node:fs");
if (!_fs.existsSync(_path.join(__dirname, "node_modules"))) {
  console.log("[setup] node_modules belum ada — install dependencies dulu (sekali saja)...");
  require("node:child_process").execSync("npm install --no-audit --no-fund", { cwd: __dirname, stdio: "inherit" });
  console.log("[setup] install selesai.");
}

/** Bot Telegram auto-klaim voucher ShopeeFood — Node.js.
 *  Alur: monitor -> admin /set KODE JAM -> user kirim kode -> verifikasi ->
 *  cookie -> verifikasi nama+nomor -> YA -> auto-klaim tepat jadwal. */
const TelegramBot = require("node-telegram-bot-api");
const config = require("./config");
const store = require("./store");
const scheduler = require("./scheduler");
const { ShopeeAuthError, verifyCookie, validateVoucher } = require("./shopee");

const state = new Map(); // userId -> {flow, ...}
const WIB_MS = 7 * 3600 * 1000;

function parseSchedule(hh, mm) {
  const wibNow = new Date(Date.now() + WIB_MS);
  const t = new Date(wibNow);
  t.setUTCHours(hh, mm, 0, 0);
  if (t.getTime() <= wibNow.getTime()) t.setUTCDate(t.getUTCDate() + 1);
  return new Date(t.getTime() - WIB_MS);
}
function fmtWib(d) {
  return new Date(d).toLocaleString("id-ID", { timeZone: config.TIMEZONE, day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}
function maskPhone(p) {
  const d = String(p || "").replace(/\D/g, "");
  return d.length <= 7 ? "****" : `${d.slice(0, 4)}****${d.slice(-4)}`;
}
const looksLikeCookie = (t) => t.length > 80 && (t.includes("SPC_") || t.includes("csrftoken="));
const looksLikeCode = (t) => /^[A-Z0-9]{4,24}$/i.test(t.trim());

let bot;
const send = (tid, text, opts = {}) => bot.sendMessage(tid, text, { parse_mode: "HTML", ...opts });

async function validateWithAdminCookie(code) {
  const atid = store.adminWithCookie();
  if (!atid) return { ok: null, message: "admin belum simpan cookie" };
  const u = store.getUser(atid);
  const cookie = store.decryptCookie(u.cookieEnc);
  return validateVoucher(cookie, code);
}

// ---------- commands ----------
async function cmdStart(msg) {
  const tid = msg.from.id;
  store.seedAdmins();
  if (!store.getAdmins().length) {
    store.addAdmin(tid);
    await send(tid, "👑 Kamu user pertama — otomatis jadi <b>admin</b> bot ini.");
  }
  if (store.isAdmin(tid)) {
    await send(tid,
      "👋 <b>Bot Klaim Voucher ShopeeFood</b> (mode ADMIN)\n\n" +
      "Alur:\n" +
      "1️⃣ <code>/pantau on</code> — notifikasi event voucher baru\n" +
      "2️⃣ <code>/set KODE HH:MM</code> — buat event klaim (contoh: <code>/set SF80 18:00</code>)\n" +
      "3️⃣ Bagikan kode ke user — mereka kirim kode ke bot, ikut otomatis\n\n" +
      "Perintah: /set /campaigns /batal /pantau /jadwal /hapus /help\n" +
      "Tempel cookie di sini untuk validasi kode & monitor.");
  } else {
    await send(tid,
      "👋 <b>Bot Klaim Voucher ShopeeFood</b>\n\n" +
      "Kirim <b>kode voucher</b> yang diumumkan admin.\n" +
      "Bot verifikasi kode → minta cookie → verifikasi akun → " +
      "klaim otomatis tepat jadwal.\n\n" +
      "Perintah: /jadwal /batal /hapus /help");
  }
}

async function cmdHelp(msg) {
  const admin = store.isAdmin(msg.from.id);
  await send(msg.from.id,
    "<b>Perintah:</b>\n" +
    (admin ? "/set <code>KODE HH:MM</code> — buat event klaim\n/campaigns — daftar event\n" : "") +
    "/jadwal — event yang kamu ikuti\n" +
    "/batal <code>ID</code> — " + (admin ? "batalkan event / " : "") + "keluar dari event\n" +
    (admin ? "/pantau <code>on/off</code> — notifikasi voucher baru\n" : "") +
    "/hapus — hapus cookie & dataku");
}

async function cmdSet(msg, args) {
  const tid = msg.from.id;
  if (!store.isAdmin(tid)) return send(tid, "⛔ Khusus admin.");
  if (args.length !== 2)
    return send(tid, "Format: <code>/set KODE HH:MM</code>\ncontoh: <code>/set SF80 18:00</code>");
  const code = args[0].toUpperCase().trim();
  const m = /^(\d{1,2}):(\d{2})$/.exec(args[1]);
  if (!looksLikeCode(code) || !m) return send(tid, "Kode/jam tidak valid. Contoh: <code>/set SF80 18:00</code>");
  const me = store.getUser(tid);
  if (!me) return send(tid, "Simpan cookie dulu (tempel di sini) — dipakai untuk validasi kode.");
  const runAt = parseSchedule(+m[1], +m[2]);
  await send(tid, "🔍 Memvalidasi kode ke Shopee…");
  let res;
  try {
    res = await validateVoucher(store.decryptCookie(me.cookieEnc), code);
  } catch (e) {
    return send(tid, `❌ Gagal validasi: ${e.message}`);
  }
  const create = () => {
    const cid = store.createCampaign(code, Math.floor(runAt.getTime() / 1000), tid);
    scheduler.scheduleCampaign(cid);
    send(tid, `✅ <b>Event dibuat!</b>\n\n🎟️ Kode: <b>${code}</b>\n🕐 Klaim: <b>${fmtWib(runAt)} WIB</b>\n🆔 ID: <code>${cid}</code>\n\nBagikan kode <b>${code}</b> ke user — mereka tinggal kirim kode itu ke bot.`);
  };
  if (res.ok) {
    create();
    if (res.title) await send(tid, `📌 ${res.title}`);
  } else {
    state.set(tid, { flow: "pending_set", code, runAt: runAt.getTime() });
    await send(tid, `⚠️ Kode tidak lolos validasi: ${res.message}\n\nTetap buat event? Balas <b>YA</b>.`);
  }
}

async function cmdCampaigns(msg) {
  const tid = msg.from.id;
  if (!store.isAdmin(tid)) return send(tid, "⛔ Khusus admin.");
  const rows = store.listCampaigns(false);
  if (!rows.length) return send(tid, "Belum ada event.");
  const L = ["<b>Daftar event:</b>"];
  for (const c of rows) {
    const n = store.joinedUsers(c.id).length;
    L.push(`• <code>${c.id}</code> <b>${c.code}</b> @ ${fmtWib(c.claim_at * 1000)} — ${c.status} (${n} peserta)`);
  }
  await send(tid, L.join("\n"));
}

async function cmdJadwal(msg) {
  const rows = store.myCampaigns(msg.from.id);
  if (!rows.length) return send(msg.from.id, "Kamu belum ikut event apa pun.");
  const L = ["<b>Event yang kamu ikuti:</b>"];
  for (const c of rows)
    L.push(`• <code>${c.id}</code> <b>${c.code}</b> @ ${fmtWib(c.claim_at * 1000)} — ${c.status}/${c.ustatus}`);
  await send(msg.from.id, L.join("\n"));
}

async function cmdBatal(msg, args) {
  const tid = msg.from.id;
  if (args.length !== 1 || !/^\d+$/.test(args[0]))
    return send(tid, "Format: <code>/batal ID</code> — lihat ID di /jadwal");
  const cid = +args[0];
  const camp = store.getCampaign(cid);
  if (!camp) return send(tid, "ID tidak ditemukan.");
  if (store.isAdmin(tid)) {
    store.setCampaignStatus(cid, "cancelled");
    scheduler.cancelCampaign(cid);
    for (const u of store.joinedUsers(cid)) {
      store.leaveCampaign(cid, u);
      await send(u, `🚫 Event <b>${camp.code}</b> dibatalkan admin.`);
    }
    return send(tid, `✅ Event <b>${camp.code}</b> dibatalkan.`);
  }
  store.leaveCampaign(cid, tid);
  await send(tid, `✅ Kamu keluar dari event <b>${camp.code}</b>.`);
}

async function cmdPantau(msg, args) {
  const tid = msg.from.id;
  if (!store.isAdmin(tid)) return send(tid, "⛔ Khusus admin.");
  const a = (args[0] || "").toLowerCase();
  if (a === "on") {
    if (!store.getUser(tid)) return send(tid, "Simpan cookie dulu (tempel di sini).");
    store.setMonitor(tid, true);
    await send(tid, `👀 Monitor AKTIF — cek tiap ${config.MONITOR_INTERVAL_MIN} menit, notifikasi ke admin.`);
  } else if (a === "off") {
    store.setMonitor(tid, false);
    await send(tid, "🔕 Monitor dimatikan.");
  } else {
    await send(tid, `Monitor: <b>${store.monitorEnabled(tid) ? "AKTIF ✅" : "MATI ❌"}</b>\n\n<code>/pantau on</code> / <code>/pantau off</code>`);
  }
}

async function cmdHapus(msg) {
  store.deleteUser(msg.from.id);
  store.setMonitor(msg.from.id, false);
  state.delete(msg.from.id);
  await send(msg.from.id, "🗑️ Cookie dan datamu sudah dihapus.");
}

// ---------- text flow ----------
async function onText(msg) {
  const tid = msg.from.id;
  const text = (msg.text || "").trim();
  if (!text || text.startsWith("/")) return;
  const st = state.get(tid) || {};

  // --- YA: konfirmasi ---
  if (/^ya$/i.test(text)) {
    if (st.flow === "pending_set") {
      state.delete(tid);
      const cid = store.createCampaign(st.code, Math.floor(st.runAt / 1000), tid);
      scheduler.scheduleCampaign(cid);
      return send(tid, `✅ Event <b>${st.code}</b> dibuat @ ${fmtWib(st.runAt)} WIB (ID <code>${cid}</code>).`);
    }
    if (st.flow === "pending_cookie") {
      state.delete(tid);
      store.saveUser(tid, store.encryptCookie(st.cookie), st.username, st.phoneMasked);
      if (st.campaignId) {
        store.joinCampaign(st.campaignId, tid);
        const c = store.getCampaign(st.campaignId);
        return send(tid, `✅ Kamu terdaftar!\n\n🎟️ <b>${c.code}</b> akan diklaim otomatis pada <b>${fmtWib(c.claim_at * 1000)} WIB</b>.\nTunggu notifikasi hasilnya ya.`);
      }
      return send(tid, `✅ Akun <b>${st.username}</b> tersimpan.`);
    }
    if (st.flow === "pending_join") {
      state.delete(tid);
      store.joinCampaign(st.campaignId, tid);
      const c = store.getCampaign(st.campaignId);
      return send(tid, `✅ Kamu terdaftar!\n\n🎟️ <b>${c.code}</b> akan diklaim otomatis pada <b>${fmtWib(c.claim_at * 1000)} WIB</b>.`);
    }
    return send(tid, "Tidak ada yang perlu dikonfirmasi. Ketik /help.");
  }

  // --- cookie ---
  if (looksLikeCookie(text)) {
    await send(tid, "🔍 Memverifikasi cookie ke Shopee…");
    let info;
    try { info = await verifyCookie(text); }
    catch (e) { return send(tid, `❌ Cookie tidak valid: ${e.message}\nAmbil cookie baru lalu tempel ulang.`); }
    const masked = maskPhone(info.phone);
    state.set(tid, { flow: "pending_cookie", cookie: text, username: info.username, phoneMasked: masked, campaignId: st.flow === "await_cookie" ? st.campaignId : null });
    return send(tid,
      `✅ <b>Akun Terdeteksi</b>\n\n👤 Username: <b>${info.username}</b>\n📱 Nomor: <b>${masked}</b>\n\n` +
      `Benar? Balas <b>YA</b> untuk menyimpan.`);
  }

  // --- kode voucher ---
  if (looksLikeCode(text)) {
    const code = text.toUpperCase();
    const camp = store.getCampaignByCode(code);
    if (!camp) return send(tid, `Kode <b>${code}</b> belum dibuka admin.\nMinta admin buat event dulu dengan <code>/set ${code} HH:MM</code>`);
    if (store.isJoined(camp.id, tid)) return send(tid, `Kamu sudah terdaftar di event <b>${code}</b> ✅`);
    await send(tid, "🔍 Memverifikasi kode voucher…");
    let vres = { ok: null };
    try { vres = await validateWithAdminCookie(code); } catch {}
    if (vres.ok === false)
      return send(tid, `⚠️ Kode <b>${code}</b> tidak lolos verifikasi: ${vres.message}\nPastikan kode dari admin benar.`);
    const validNote = vres.ok ? `✅ Kode valid${vres.title ? `: <b>${vres.title}</b>` : ""}\n\n` : "";
    const me = store.getUser(tid);
    if (me) {
      state.set(tid, { flow: "pending_join", campaignId: camp.id });
      return send(tid, `${validNote}Pakai akun tersimpan (<b>${me.username}</b>, ${me.phoneMasked})?\nBalas <b>YA</b> untuk ikut event ini.`);
    }
    state.set(tid, { flow: "await_cookie", campaignId: camp.id });
    return send(tid, `${validNote}Sekarang tempel <b>cookie</b> Shopee kamu di sini.`);
  }

  await send(tid, "Kirim <b>kode voucher</b> dari admin, atau ketik /help.");
}

// ---------- main ----------
async function main() {
  if (!config.BOT_TOKEN) { console.error("Set TELEGRAM_BOT_TOKEN dulu"); process.exit(1); }
  await store.init();
  try { store.encryptCookie("test"); }
  catch (e) { console.error("ENCRYPTION:", e.message); process.exit(1); }
  bot = new TelegramBot(config.BOT_TOKEN, { polling: true });
  store.seedAdmins();
  scheduler.init(bot);

  bot.onText(/^\/start$/, cmdStart);
  bot.onText(/^\/help$/, cmdHelp);
  bot.onText(/^\/set(?:\s+(.*))?$/, (m, mm) => cmdSet(m, (mm[1] || "").trim().split(/\s+/).filter(Boolean)));
  bot.onText(/^\/campaigns$/, cmdCampaigns);
  bot.onText(/^\/jadwal$/, cmdJadwal);
  bot.onText(/^\/batal(?:\s+(.*))?$/, (m, mm) => cmdBatal(m, (mm[1] || "").trim().split(/\s+/).filter(Boolean)));
  bot.onText(/^\/pantau(?:\s+(.*))?$/, (m, mm) => cmdPantau(m, (mm[1] || "").trim().split(/\s+/).filter(Boolean)));
  bot.onText(/^\/hapus$/, cmdHapus);
  bot.on("message", (m) => { if (m.text && !m.text.startsWith("/")) onText(m).catch((e) => console.error(e.message)); });

  bot.on("polling_error", (e) => console.error("[polling]", e.message));
  console.log("Bot jalan. Ctrl+C untuk berhenti.");
}

main();
