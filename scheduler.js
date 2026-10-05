"use strict";
/** Scheduler: klaim campaign tepat waktu utk semua peserta + monitor interval. */
const schedule = require("node-schedule");
const config = require("./config");
const store = require("./store");
const { ShopeeAuthError, claimVoucher } = require("./shopee");

let bot = null;
const jobs = new Map();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function notify(tid, text) {
  try { await bot.sendMessage(tid, text, { parse_mode: "HTML" }); } catch {}
}

function init(b) {
  bot = b;
  // monitor voucher tiap N menit
  const cron = `*/${config.MONITOR_INTERVAL_MIN} * * * *`;
  schedule.scheduleJob(cron, () => {
    require("./monitor").checkAll(bot).catch((e) => console.error("[monitor]", e.message));
  });
  // pulihkan campaign open saat restart
  const nowS = Math.floor(Date.now() / 1000);
  for (const c of store.listCampaigns(true)) {
    if (c.claim_at <= nowS + 5) store.setCampaignStatus(c.id, "cancelled");
    else scheduleCampaign(c.id);
  }
  console.log("Scheduler aktif.");
}

function scheduleCampaign(cid) {
  const row = store.getCampaign(cid);
  if (!row || row.status !== "open") return;
  cancelCampaign(cid);
  const job = schedule.scheduleJob(new Date(row.claim_at * 1000), () => runCampaign(cid));
  if (job) jobs.set(cid, job);
}

function cancelCampaign(cid) {
  const j = jobs.get(cid);
  if (j) { j.cancel(); jobs.delete(cid); }
}

async function claimForUser(tid, code) {
  const user = store.getUser(tid);
  if (!user) return [false, "cookie belum disimpan"];
  let cookie;
  try { cookie = store.decryptCookie(user.cookieEnc); }
  catch { return [false, "cookie tidak bisa dibaca — kirim ulang"]; }
  let last = "";
  for (let a = 1; a <= config.CLAIM_MAX_RETRIES; a++) {
    try {
      const res = await claimVoucher(cookie, code);
      if (res.ok) return [true, res.message];
      last = res.message;
      await sleep(config.CLAIM_RETRY_DELAY_MS);
    } catch (e) {
      if (e instanceof ShopeeAuthError) return [false, `cookie kedaluwarsa — kirim cookie baru`];
      last = `error: ${e.message}`;
      await sleep(config.CLAIM_RETRY_DELAY_MS);
    }
  }
  return [false, `gagal ${config.CLAIM_MAX_RETRIES}x: ${last}`];
}

async function runCampaign(cid) {
  const row = store.getCampaign(cid);
  if (!row || row.status !== "open") return; // idempoten
  const code = row.code;
  store.setCampaignStatus(cid, "claiming");
  const users = store.joinedUsers(cid);
  let okN = 0;
  for (const tid of users) {
    const [ok, msg] = await claimForUser(tid, code);
    store.markCampaignUser(cid, tid, ok ? "claimed" : "failed", config.CLAIM_MAX_RETRIES, msg);
    if (ok) okN++;
    await notify(tid, `${ok ? "✅" : "❌"} Klaim <b>${code}</b>: ${msg}`);
    await sleep(1000);
  }
  store.setCampaignStatus(cid, "done");
  for (const a of store.getAdmins())
    await notify(a, `🏁 Campaign <b>${code}</b> selesai: ${okN}/${users.length} berhasil diklaim.`);
}

module.exports = { init, scheduleCampaign, cancelCampaign };
