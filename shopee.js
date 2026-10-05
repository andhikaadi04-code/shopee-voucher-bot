"use strict";
/** Client API Shopee (fetch bawaan Node 18+). */
const config = require("./config");

class ShopeeAuthError extends Error {}

function csrftoken(cookie) {
  const m = /csrftoken=([^;]+)/.exec(cookie);
  return m ? m[1] : "";
}

function headers(cookie) {
  return {
    "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36",
    "Cookie": cookie,
    "Accept": "application/json",
    "Content-Type": "application/json",
    "Origin": config.SHOPEE_API_BASE,
    "Referer": config.SHOPEE_API_BASE + "/user/voucher-wallet",
    "x-api-source": "pc",
    "x-csrftoken": csrftoken(cookie),
    "x-requested-with": "XMLHttpRequest",
    "x-shopee-language": "id",
  };
}

async function post(path, cookie, body) {
  const r = await fetch(config.SHOPEE_API_BASE + path, {
    method: "POST", headers: headers(cookie), body: JSON.stringify(body),
  });
  if (r.status === 401 || r.status === 403) throw new ShopeeAuthError("cookie ditolak Shopee (401/403)");
  let data;
  try { data = await r.json(); } catch { return { _http: r.status, _raw: true }; }
  if (data && data.is_login === false) throw new ShopeeAuthError("sesi tidak login lagi menurut Shopee");
  return data;
}

async function get(path, cookie) {
  const r = await fetch(config.SHOPEE_API_BASE + path, { headers: headers(cookie) });
  if (r.status === 401 || r.status === 403) throw new ShopeeAuthError("cookie ditolak Shopee (401/403)");
  return r.json();
}

function firstOf(d, keys) {
  for (const k of keys) if (d && d[k]) return String(d[k]);
  return "";
}

module.exports = {
  ShopeeAuthError,

  /** -> {username, phone}. Throw ShopeeAuthError bila cookie mati. */
  async verifyCookie(cookie) {
    const data = await get(config.ENDPOINT_VERIFY, cookie);
    if (!data || data.error !== 0)
      throw new ShopeeAuthError(`Shopee menolak verifikasi (error ${data && data.error})`);
    const d = data.data || {};
    if (!d.username) throw new ShopeeAuthError("tidak dapat membaca identitas dari respon");
    return { username: d.username, phone: d.phone || "" };
  },

  /** -> {ok, message}. */
  async claimVoucher(cookie, voucherCode) {
    const data = await post(config.ENDPOINT_CLAIM, cookie,
      { voucher_code: voucherCode, need_user_voucher_status: true });
    if (data._raw) return { ok: false, message: `HTTP ${data._http} tanpa body JSON` };
    if (data.error === 0) return { ok: true, message: String(data.error_msg || "voucher berhasil diklaim").slice(0, 200) };
    const msg = String(data.error_msg || data.message || "").trim();
    const detail = data.error != null ? `${msg} (error ${data.error})`.trim() : (msg || "klaim ditolak");
    return { ok: false, message: detail.slice(0, 200) };
  },

  /** Validasi kode TANPA mengklaim -> {ok, message, title}. Best effort. */
  async validateVoucher(cookie, voucherCode) {
    const data = await post(config.ENDPOINT_VALIDATE, cookie, { voucher_code: voucherCode });
    if (data._raw) return { ok: false, message: `HTTP ${data._http} tanpa body JSON`, title: "" };
    const d = (data.data && typeof data.data === "object") ? data.data : {};
    const title = firstOf(d, ["title", "voucher_title", "name", "label", "promotion_title"]).slice(0, 120);
    if (data.error === 0) return { ok: true, message: String(data.error_msg || "kode valid"), title };
    const msg = String(data.error_msg || data.message || "").trim();
    const detail = data.error != null ? `${msg} (error ${data.error})`.trim() : (msg || "kode tidak valid");
    return { ok: false, message: detail.slice(0, 200), title };
  },

  /** POST generik untuk monitor. */
  postJson: post,
};
