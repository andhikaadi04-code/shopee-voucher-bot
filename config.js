"use strict";
/** Konfigurasi — dari environment variable ATAU file .env di folder bot. */
const path = require("node:path");
try { require("dotenv").config({ path: path.join(__dirname, ".env") }); } catch {}

module.exports = {
  BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || "",
  // 64 char hex (32 byte). Generate: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
  ENCRYPTION_KEY_HEX: process.env.BOT_ENCRYPTION_KEY || "",
  ADMIN_IDS: (process.env.ADMIN_IDS || "")
    .split(",").map((s) => s.trim()).filter((s) => /^\d+$/.test(s)).map(Number),
  TIMEZONE: "Asia/Jakarta",
  DB_PATH: process.env.BOT_DB_PATH || path.join(__dirname, "bot_data.db"),

  SHOPEE_API_BASE: "https://shopee.co.id",
  // Verifikasi cookie -> GET, respon {"error":0,"data":{"username","phone",...}} (terverifikasi 2026-10-05)
  ENDPOINT_VERIFY: "/api/v4/account/basic/get_account_info",
  // Klaim -> POST {"voucher_code","need_user_voucher_status":true} (terverifikasi 2026-10-05)
  ENDPOINT_CLAIM: "/api/v2/voucher_wallet/save_voucher",
  // Validasi kode tanpa klaim — dari JS resmi Shopee, BELUM terverifikasi live
  ENDPOINT_VALIDATE: "/api/v2/voucher_wallet/validate_platform_voucher_by_voucher_code",
  // Monitor daftar voucher — dari JS resmi Shopee
  ENDPOINT_META: "/api/v4/voucher_wallet/get_user_voucher_list_meta",
  ENDPOINT_LIST: "/api/v2/voucher_wallet/get_user_voucher_list",

  CLAIM_MAX_RETRIES: 3,
  CLAIM_RETRY_DELAY_MS: 2000,
  MONITOR_INTERVAL_MIN: 10,
};
