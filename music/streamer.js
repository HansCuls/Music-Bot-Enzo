// ==========================================
// FILE: music/streamer.js
// Stream audio ke Telegram Voice Chat
// Mode: DOWNLOAD DULU → stream dari file lokal
// Lebih stabil, tidak putus di tengah jalan
// ==========================================

const { Api }  = require('teleproto');
const fs       = require('fs');
const path     = require('path');
const { getCacheDir, deleteFile } = require('./cache');

let NtgCalls     = null;
let ntgAvailable = false;

try {
  NtgCalls     = require('@arnabxd/ntgcalls-napi').NtgCalls;
  ntgAvailable = true;
  console.log('[streamer] ✅ ntgcalls-napi loaded');
} catch (e) {
  console.warn('[streamer] ⚠️ ntgcalls-napi tidak tersedia:', e.message);
}

const sessions = new Map(); // chatId => { ntg, filePath, startedAt, paused }

function getSession(chatId)    { return sessions.get(String(chatId)) || null; }
function deleteSession(chatId) {
  const s = sessions.get(String(chatId));
  if (s) {
    try { s.ntg?.stop(Number(chatId)); } catch {}
    // Jangan hapus file di sini — biarkan cache manager yang urus
  }
  sessions.delete(String(chatId));
}

// ─── Download audio ke cache ───────────────
async function downloadToCache(audioUrl, videoId) {
  const cacheDir = getCacheDir();
  // Cek apakah sudah ada di cache
  if (videoId) {
    const cached = path.join(cacheDir, `${videoId}.mp3`);
    if (fs.existsSync(cached)) {
      console.log(`[streamer] 💾 Cache hit: ${videoId}`);
      return cached;
    }
  }

  const filename = videoId
    ? `${videoId}.mp3`
    : `audio_${Date.now()}.mp3`;
  const filePath = path.join(cacheDir, filename);

  console.log(`[streamer] ⬇️ Downloading audio: ${filename}`);
  const res = await fetch(audioUrl, {
    signal: AbortSignal.timeout(120000),
    headers: { 'User-Agent': 'Mozilla/5.0' },
  });
  if (!res.ok) throw new Error(`Download HTTP ${res.status}`);

  const buffer = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(filePath, buffer);
  console.log(`[streamer] ✅ Downloaded: ${filename} (${(buffer.length/1024/1024).toFixed(1)}MB)`);
  return filePath;
}

// ─── Build ffmpeg command dari file lokal ──
function buildAudioCmd(filePath, volume = 100, seekSeconds = 0) {
  const vol = Math.max(0, Math.min(200, volume)) / 100;

  return [
    'ffmpeg',
    seekSeconds > 0 ? `-ss ${seekSeconds}` : '',
    '-re',
    `-i "${filePath}"`,
    vol !== 1 ? `-af "volume=${vol}"` : '',
    '-vn',
    '-f s16le',
    '-ar 48000',
    '-ac 1',
    '-'
  ].filter(Boolean).join(' ');
}
// Legacy alias
const buildFfmpegCmd = buildAudioCmd;

// ─── Join Voice Chat via MTProto ───────────
async function joinVoiceChat(client, chatId, offerSdp) {
  const entity = await client.getEntity(BigInt(chatId));
  const full   = await client.invoke(new Api.channels.GetFullChannel({ channel: entity }));
  if (!full.fullChat?.call) throw new Error('Voice Chat tidak aktif.');

  let joinResult = null, lastErr = null;
  for (let i = 0; i < 3; i++) {
    try {
      joinResult = await client.invoke(new Api.phone.JoinGroupCall({
        call:         full.fullChat.call,
        params:       new Api.DataJSON({ data: offerSdp }),
        muted:        false,
        videoStopped: true,
        joinAs:       new Api.InputPeerSelf(),
      }));
      break;
    } catch (e) {
      lastErr = e;
      if (i < 2) await new Promise(r => setTimeout(r, 2000));
    }
  }
  if (!joinResult) throw new Error(`Gagal join VC: ${lastErr?.message}`);

  let answerSdp = null;
  for (const u of joinResult.updates || []) {
    if (u?.params?.data) { answerSdp = u.params.data; break; }
  }
  if (!answerSdp) throw new Error('Gagal mendapatkan Answer SDP.');
  return answerSdp;
}

// ─── START STREAM ──────────────────────────
async function startStream(client, chatId, audioUrl, callbacks = {}, volume = 100, videoId = null) {
  if (!ntgAvailable) throw new Error('ntgcalls-napi tidak tersedia.');

  stopStream(chatId);

  // ✅ FIX: await and capture the file path
  const filePath = await downloadToCache(audioUrl, videoId);

  try {
    const ntg       = new NtgCalls();
    const offerSdp  = await ntg.create(Number(chatId));
    const answerSdp = await joinVoiceChat(client, chatId, offerSdp);

    await ntg.connect(Number(chatId), answerSdp, false);
    
    // ✅ FIX: Use filePath (local file), NOT audioUrl
    await ntg.set_stream_sources(Number(chatId), 0, {
      microphone: {
        mediaSource: 2,
        input: buildAudioCmd(filePath, volume, 0),  // ← LOCAL FILE PATH
        sampleRate: 48000,
        channelCount: 1,
        keepOpen: false,
      },
    });

    ntg.on('stream-end', (cid) => {
      if (Number(cid) !== Number(chatId)) return;
      sessions.delete(String(chatId));
      if (callbacks.onFinish) callbacks.onFinish();
    });

    // ✅ FIX: Store BOTH filePath and audioUrl
    sessions.set(String(chatId), {
      ntg,
      filePath,   // ← now defined
      audioUrl,   // ← store for seekStream
      videoId,
      startedAt: Date.now(),
      paused: false,
      volume,
    });

    return true;
  } catch (e) {
    deleteSession(chatId);
    const { writeLog } = require('./error_handler');
    writeLog(`[streamer.startStream] chat:${chatId} | ${e.message}\n${e.stack?.split('\n').slice(0,4).join('\n')}`);
    throw e;
  }
}

// Also fix seekStream to use filePath instead of audioUrl
async function seekStream(client, chatId, seconds, callbacks = {}) {
  const s = getSession(chatId);
  if (!s) throw new Error('Tidak ada stream aktif.');

  try { s.ntg?.stop(Number(chatId)); } catch {}

  const ntg       = new NtgCalls();
  const offerSdp  = await ntg.create(Number(chatId));
  const answerSdp = await joinVoiceChat(client, chatId, offerSdp);

  await ntg.connect(Number(chatId), answerSdp, false);
  await ntg.set_stream_sources(Number(chatId), 0, {
    microphone: {
      mediaSource: 2,
      input: buildAudioCmd(s.filePath, s.volume, seconds),  // ← Use filePath, not audioUrl
      sampleRate: 48000,
      channelCount: 1,
      keepOpen: false,
    },
  });

  ntg.on('stream-end', (cid) => {
    if (Number(cid) !== Number(chatId)) return;
    sessions.delete(String(chatId));
    if (callbacks.onFinish) callbacks.onFinish();
  });

  s.ntg       = ntg;
  s.startedAt = Date.now() - (seconds * 1000);
  s.paused    = false;
  return true;
}

function stopStream(chatId)   { deleteSession(chatId); }

async function pauseStream(chatId) {
  const s = getSession(chatId);
  if (!s || s.paused) return false;
  try { await s.ntg.pause(Number(chatId)); s.paused = true; return true; } catch { return false; }
}

async function resumeStream(chatId) {
  const s = getSession(chatId);
  if (!s || !s.paused) return false;
  try { await s.ntg.resume(Number(chatId)); s.paused = false; return true; } catch { return false; }
}

function isStreaming(chatId) { return sessions.has(String(chatId)); }
function isPaused(chatId)    { return getSession(chatId)?.paused || false; }
function getElapsed(chatId)  {
  const s = getSession(chatId);
  return s ? Date.now() - s.startedAt : 0;
}

module.exports = {
  startStream, stopStream, pauseStream, resumeStream,
  joinVoiceChat,
  seekStream, isStreaming, isPaused, getElapsed,
  get available() { return ntgAvailable; },
};