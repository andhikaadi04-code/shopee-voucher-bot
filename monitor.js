"use strict";
/** Monitor voucher otomatis: polling daftar voucher, notifikasi ke ADMIN saat ada yang baru. */
const config = require("./config");
const store = require("./store");
const { ShopeeAuthError, postJson } = require("./shopee");

function firstOf(d, keys) {
  for (const k of keys) if (d && d[k]) return String(d[k]);
  return "";
}

/** Cari rekursif semua objek voucher (punya voucher_identifier.promotion_id). */
function extractVouchers(obj) {
  const found = [];
  (function walk(o) {
    if (Array.isArray(o)) return o.forEach(walk);
    if (o && typeof o === "object") {
      const vi = o.voucher_identifier;
      if (vi && typeof vi === "object" && vi.promotion_id) { found.push(o); return; }
      Object.values(o).forEach(walk);
    }
  })(obj);
  const seen = new Set();
  return found.filter((v) => {
    const pid = String(v.voucher_identifier.promotion_id);
    if (seen.has(pid)) return false;
    seen.add(pid);
    return true;
  });
}

function voucherSummary(v) {
  const pid = String(v.voucher_identifier.promotion_id);
  const title = firstOf(v, ["title", "voucher_title", "name", "label", "promotion_title", "voucher_name", "desc"]).slice(0, 120);
  const benefit = firstOf(v, ["benefit_text", "reward_text", "discount_text", "promotion_benefit", "subtitle"]).slice(0, 120);
  let when = "";
  for (const k of ["start_time", "valid_from_time", "claim_start_time", "promotion_start_time"]) {
    let ts = v[k];
    if (typeof ts === "number" && ts > 1e9) {
      if (ts > 1e12) ts = ts / 1000;
      when = new Date(ts * 1000).toLocaleString("id-ID", { timeZone: config.TIMEZONE, day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) + " WIB";
      break;
    }
  }
  return { pid, title, benefit, when, soldout: !!(v.sold_out || v.is_sold_out) };
}

function formatNew(s) {
  const L = ["🎟️ <b>Voucher baru terdeteksi!</b>"];
  if (s.title) L.push(`📌 ${s.title}`);
  if (s.benefit) L.push(`💰 ${s.benefit}`);
  if (s.when) L.push(`🕐 Mulai: ${s.when}`);
  if (s.soldout) L.push("⚠️ Status: habis");
  L.push(`\nID: <code>${s.pid}</code>`);
  return L.join("\n");
}

async function notify(bot, tid, text) {
  try { await bot.sendMessage(tid, text, { parse_mode: "HTML" }); } catch {}
}

async function fetchTabs(cookie) {
  const d = await postJson(config.ENDPOINT_META, cookie, {});
  if (!d || d.error !== 0) throw new Error(`meta gagal (error ${d && d.error})`);
  const tabs = ((d.data || {}).tab_info || []).filter((t) => t && typeof t === "object");
  return tabs;
}

async function fetchVouchers(cookie, listType) {
  const body = { limit: 30, cursor: "", voucher_sort_flag: 1 };
  if (listType) body.user_voucher_list_type = listType;
  const d = await postJson(config.ENDPOINT_LIST, cookie, body);
  if (d && d.error != null && d.error !== 0) throw new Error(`list gagal (error ${d.error})`);
  return extractVouchers(d);
}

/** Satu putaran cek pakai cookie user tertentu -> {status, baru[], total}. */
async function checkUser(tid) {
  const user = store.getUser(tid);
  if (!user) return { status: "no-user", baru: [], total: 0 };
  let cookie;
  try { cookie = store.decryptCookie(user.cookieEnc); }
  catch { return { status: "bad-cookie", baru: [], total: 0 }; }
  let tabs;
  try { tabs = await fetchTabs(cookie); }
  catch (e) {
    if (e instanceof ShopeeAuthError) return { status: "auth-error", baru: [], total: 0 };
    return { status: `meta-error: ${e.message}`, baru: [], total: 0 };
  }
  const baru = [];
  let total = 0;
  for (const tab of tabs) {
    let vs;
    try { vs = await fetchVouchers(cookie, tab.user_voucher_list_type || 0); }
    catch { continue; }
    for (const v of vs) {
      const s = voucherSummary(v);
      total++;
      if (!s.pid || store.seenVoucher(tid, s.pid)) continue;
      store.markSeen(tid, s.pid);
      if (!s.soldout) baru.push(s);
    }
  }
  return { status: `ok tabs=${tabs.length} total=${total} baru=${baru.length}`, baru, total };
}

/** Dipanggil scheduler tiap interval. Notifikasi ke semua admin. */
async function checkAll(bot) {
  const admins = store.getAdmins();
  if (!admins.length) return;
  const checker = admins.find((tid) => store.monitorEnabled(tid) && store.getUser(tid));
  if (!checker) return;
  const firstRun = !store.hasSeenAny(checker);
  let res;
  try { res = await checkUser(checker); }
  catch (e) { console.error("[monitor]", e.message); return; }
  console.log("[monitor]", res.status);
  if (res.status === "auth-error") {
    for (const a of admins) {
      store.setMonitor(a, false);
      await notify(bot, a, "🔑 Cookie admin kedaluwarsa, monitor dijeda. Kirim cookie baru untuk lanjut.");
    }
    return;
  }
  if (firstRun) {
    for (const a of admins)
      await notify(bot, a, `👀 Monitor voucher aktif — ${res.total} voucher terpantau. Aku kabari kalau ada event baru.`);
    return;
  }
  for (const s of res.baru)
    for (const a of admins)
      await notify(bot, a, formatNew(s) + "\n\nBuat event klaim: <code>/set KODE HH:MM</code>");
}

module.exports = { checkAll, extractVouchers, voucherSummary };
