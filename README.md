# Bot Klaim Voucher ShopeeFood (Node.js)

Bot Telegram auto-klaim voucher ShopeeFood dengan 2 peran:

- **Admin**: terima notifikasi event voucher baru dari monitor, buat event klaim
  dengan `/set KODE HH:MM`, bagikan kode ke user.
- **User**: kirim kode dari admin → bot verifikasi kode → minta cookie →
  verifikasi nama + nomor tersamar → balas **YA** → bot klaim otomatis tepat jadwal.

## Struktur

| File | Fungsi |
|---|---|
| `bot.js` | Handler Telegram: alur admin & user |
| `scheduler.js` | Eksekusi klaim campaign tepat waktu (semua peserta), retry, notifikasi |
| `monitor.js` | Polling daftar voucher tiap 10 menit → notifikasi event baru ke admin |
| `shopee.js` | Client API Shopee (fetch bawaan Node) |
| `store.js` | SQLite via sql.js (WASM, tanpa native build) + enkripsi cookie AES-256-GCM |
| `config.js` | Konfigurasi + environment variable |

## Perintah

**Admin**: `/set KODE HH:MM`, `/campaigns`, `/batal ID`, `/pantau on|off`
**User**: kirim kode → cookie → YA · `/jadwal`, `/batal ID`, `/hapus`

## Jalankan lokal (Node 18+)

```bash
cd shopee-voucher-bot
npm install
export TELEGRAM_BOT_TOKEN="token-dari-@BotFather"
export BOT_ENCRYPTION_KEY="$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")"
# opsional: export ADMIN_IDS="123456,789012"  (kosong = user pertama jadi admin)
npm start
```

Simpan `BOT_ENCRYPTION_KEY` baik-baik — kalau hilang, cookie tersimpan tidak bisa dibaca.

## Deploy ke Pterodactyl (24/7)

1. Panel → buat **Server** baru, egg **Node.js**.
2. Upload semua file ini ke folder server (atau clone dari GitHub).
3. Bot **install dependency otomatis** saat pertama jalan — tidak perlu `npm install` manual.
4. Startup command: `node bot.js` (atau `npm start`).
5. **Token & kunci** — JANGAN di Console (itu cuma log). Buat file `.env`
   di folder bot (Files → New File → nama `.env`), isi:
   ```
   TELEGRAM_BOT_TOKEN=token-dari-@BotFather
   BOT_ENCRYPTION_KEY=64-char-hex-dari-perintah-di-atas
   ADMIN_IDS=
   ```
   `ADMIN_IDS` opsional: ID Telegram admin dipisah koma. Kosong = user
   pertama yang `/start` jadi admin.
6. Jalankan server. Database `bot_data.db` otomatis dibuat.

Campaign yang masih open dipulihkan otomatis saat server restart.

## Status endpoint Shopee

✅ **Terverifikasi 2026-10-05** dari capture asli + test replay:
- Verifikasi cookie: `GET /api/v4/account/basic/get_account_info`
- Klaim: `POST /api/v2/voucher_wallet/save_voucher`
  body `{"voucher_code": "...", "need_user_voucher_status": true}`
- Replay hanya butuh cookie sesi + `x-csrftoken` (otomatis dari cookie).

⚠️ **Belum terverifikasi live** (dari JS resmi Shopee, parsing defensif):
- Validasi kode: `POST /api/v2/voucher_wallet/validate_platform_voucher_by_voucher_code`
- Monitor: `POST /api/v4/voucher_wallet/get_user_voucher_list_meta` (meta terverifikasi ✅)
  + `POST /api/v2/voucher_wallet/get_user_voucher_list`

Kalau Shopee mengubah endpoint, ulangi capture (Kiwi → DevTools → Network → copy as cURL)
dan sesuaikan `shopee.js` / `monitor.js`.
