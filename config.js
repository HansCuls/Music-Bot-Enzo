// ==========================================
// FILE: config.js
// Isi nilai di bawah ini sesuai akun kamu
// ==========================================

// Token bot dari @BotFather
global.BOT_TOKEN = '8617802921:AAFYdWDIJBwVSKGFw-CCfKVXVB0jOK4DHyg';

// Dari my.telegram.org/apps
global.API_ID   = 24476920; // contoh: 12345678
global.API_HASH = 'bfd1f5f48a599e143e6db0a9d05b8381';

// RapidAPI Key untuk download MP3 (youtube-mp310)
// Daftar gratis di: https://rapidapi.com/ytjar/api/youtube-mp310
global.RAPIDAPI_KEY = '534975bde8msh532479a47a3c189p13eadfjsn4c0c37d0dbf3';

// ID Telegram admin bot (pisahkan koma jika lebih dari satu)
// Dapatkan ID kamu dari @userinfobot
global.BOT_ADMINS = '7977259554,987654321';

// Path file session userbot (tidak perlu diubah)
global.MUSIC_SESSION_FILE = 'database/music_session.json';

// ─── Validasi ──────────────────────────────
if (!global.BOT_TOKEN || global.BOT_TOKEN === 'ISI_TOKEN_BOT_DISINI')
  console.warn('[config] ⚠️  BOT_TOKEN belum diisi!');
if (!global.API_ID || global.API_ID === 0)
  console.warn('[config] ⚠️  API_ID belum diisi!');
if (!global.API_HASH || global.API_HASH === 'ISI_API_HASH_DISINI')
  console.warn('[config] ⚠️  API_HASH belum diisi!');
if (!global.RAPIDAPI_KEY || global.RAPIDAPI_KEY === 'ISI_RAPIDAPI_KEY_DISINI')
  console.warn('[config] ⚠️  RAPIDAPI_KEY belum diisi!');
