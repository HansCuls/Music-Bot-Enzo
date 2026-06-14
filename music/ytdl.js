// ==========================================
// FILE: music/ytdl.js
// Primary  : @vreden/youtube_scraper
// Backup 1 : yt-dlp (system binary)
// Backup 2 : RapidAPI youtube-mp310
// ==========================================

const fs    = require('fs');
const path  = require('path');
const os    = require('os');
const { spawn, execSync } = require('child_process');

const RAPIDAPI_KEY  = global.RAPIDAPI_KEY  || '';
const RAPIDAPI_HOST = 'youtube-mp310.p.rapidapi.com';

// ─── Helpers ──────────────────────────────
function formatDuration(seconds) {
  if (!seconds) return '??:??';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  return `${m}:${String(s).padStart(2,'0')}`;
}

function formatViews(n) {
  if (!n) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function sanitizeBtn(str, maxLen = 40) {
  if (!str) return 'Unknown';
  return str.replace(/[^\x20-\x7E\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF]/g,'')
    .replace(/\s+/g,' ').trim().slice(0, maxLen) || 'Unknown';
}

function isYouTubeUrl(str) {
  return /^(https?:\/\/)?(www\.)?(youtube\.com\/(watch\?v=|shorts\/)|youtu\.be\/)[\w-]+/.test(str);
}

function extractVideoId(url) {
  const m = url.match(/(?:v=|youtu\.be\/|shorts\/)([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
}

// ─────────────────────────────────────────
// YT-DLP
// ─────────────────────────────────────────

let _ytdlpPath = null;

function getYtdlpPath() {
  if (_ytdlpPath !== null) return _ytdlpPath;
  const candidates = ['yt-dlp', '/usr/local/bin/yt-dlp', '/usr/bin/yt-dlp'];
  for (const cmd of candidates) {
    try { execSync(`${cmd} --version`, { stdio: 'ignore', timeout: 5000 }); _ytdlpPath = cmd; return cmd; }
    catch {}
  }
  _ytdlpPath = false;
  return false;
}

function spawnYtdlp(args, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const bin = getYtdlpPath();
    if (!bin) return reject(new Error('yt-dlp tidak tersedia'));
    let out = '', err = '';
    const proc = spawn(bin, args, { timeout: timeoutMs });
    proc.stdout.on('data', d => out += d.toString());
    proc.stderr.on('data', d => err += d.toString());
    proc.on('close', code => {
      if (code === 0) resolve(out.trim());
      else reject(new Error(err.trim() || `yt-dlp exit ${code}`));
    });
    proc.on('error', e => reject(e));
  });
}

async function ytdlpSearch(query, limit = 5) {
  const out = await spawnYtdlp([
    `ytsearch${limit}:${query}`,
    '--dump-json', '--flat-playlist',
    '--no-warnings', '--quiet',
  ], 30000);
  return out.split('\n').filter(Boolean).map(line => {
    try {
      const v = JSON.parse(line);
      const dur = v.duration || 0;
      return {
        title:       v.title || 'Unknown',
        url:         v.webpage_url || `https://youtube.com/watch?v=${v.id}`,
        videoId:     v.id,
        duration:    dur * 1000,
        durationFmt: formatDuration(dur),
        thumbnail:   v.thumbnail || null,
        uploader:    v.channel || v.uploader || 'Unknown',
        views:       v.view_count || 0,
        viewsFmt:    formatViews(v.view_count),
        titleBtn:    sanitizeBtn(v.title),
      };
    } catch { return null; }
  }).filter(Boolean);
}

async function ytdlpGetInfo(url) {
  const out = await spawnYtdlp([url, '--dump-json', '--no-warnings', '--quiet'], 30000);
  const v   = JSON.parse(out);
  const dur = v.duration || 0;
  return {
    title:       v.title || 'Unknown',
    url:         v.webpage_url || url,
    videoId:     v.id,
    duration:    dur * 1000,
    durationFmt: formatDuration(dur),
    thumbnail:   v.thumbnail || null,
    uploader:    v.channel || v.uploader || 'Unknown',
    views:       v.view_count || 0,
    viewsFmt:    formatViews(v.view_count),
    titleBtn:    sanitizeBtn(v.title),
  };
}

async function ytdlpGetAudioUrl(url) {
  const out = await spawnYtdlp([
    url,
    '-f', 'bestaudio[ext=m4a]/bestaudio/best',
    '--get-url', '--no-warnings', '--quiet',
  ], 60000);
  const audioUrl = out.split('\n')[0];
  if (!audioUrl?.startsWith('http')) throw new Error('yt-dlp: URL tidak valid');
  return audioUrl;
}

async function ytdlpGetVideoUrl(url) {
  const out = await spawnYtdlp([
    url,
    '-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
    '--get-url', '--no-warnings', '--quiet',
  ], 60000);
  // get-url bisa return 2 baris (video + audio) untuk format gabungan
  const lines = out.split('\n').filter(l => l.startsWith('http'));
  if (!lines.length) throw new Error('yt-dlp: video URL tidak valid');
  return lines[0]; // ambil yang pertama
}

async function ytdlpDownloadAudio(url, outPath) {
  await spawnYtdlp([
    url,
    '-f', 'bestaudio[ext=m4a]/bestaudio/best',
    '-x', '--audio-format', 'mp3', '--audio-quality', '0',
    '-o', outPath,
    '--no-warnings', '--quiet', '--no-playlist',
  ], 300000);
  // yt-dlp mengubah ekstensi, cari file hasil
  const mp3Path = outPath.replace(/\.[^.]+$/, '.mp3');
  if (fs.existsSync(mp3Path)) return mp3Path;
  if (fs.existsSync(outPath)) return outPath;
  throw new Error('yt-dlp: file audio tidak ditemukan setelah download');
}

async function ytdlpDownloadVideo(url, outPath) {
  await spawnYtdlp([
    url,
    '-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
    '--merge-output-format', 'mp4',
    '-o', outPath,
    '--no-warnings', '--quiet', '--no-playlist',
  ], 600000);
  if (fs.existsSync(outPath)) return outPath;
  throw new Error('yt-dlp: file video tidak ditemukan setelah download');
}

// ─────────────────────────────────────────
// @vreden/youtube_scraper
// ─────────────────────────────────────────

let _vreden = null;
function getVreden() {
  if (_vreden) return _vreden;
  try { _vreden = require('@vreden/youtube_scraper'); return _vreden; }
  catch { return null; }
}

function extractVredenUrl(dl) {
  if (!dl) return null;
  if (typeof dl === 'string' && dl.startsWith('http')) return dl;
  const url = dl?.url || dl?.link || dl?.downloadUrl || dl?.download;
  return (typeof url === 'string' && url.startsWith('http')) ? url : null;
}

function mapVredenResult(v) {
  const title   = v.title || v.name || 'Unknown';
  const videoId = v.videoId || v.id || extractVideoId(v.url || '') || '';
  const url     = v.url || (videoId ? `https://youtube.com/watch?v=${videoId}` : '');
  let durSec = 0, durFmt = '??:??';
  if (typeof v.duration === 'number') { durSec = v.duration; durFmt = formatDuration(durSec); }
  else if (typeof v.duration === 'string') {
    durFmt = v.duration;
    const p = v.duration.split(':').map(Number);
    if (p.length === 2) durSec = p[0]*60+p[1];
    else if (p.length === 3) durSec = p[0]*3600+p[1]*60+p[2];
  }
  return {
    title, url, videoId,
    duration:    durSec * 1000,
    durationFmt: durFmt,
    thumbnail:   v.thumbnail || v.thumbnails?.[0]?.url || null,
    uploader:    v.channel || v.author || v.uploader || 'Unknown',
    views:       v.views || v.viewCount || 0,
    viewsFmt:    formatViews(v.views || v.viewCount || 0),
    titleBtn:    sanitizeBtn(title),
  };
}

// ─────────────────────────────────────────
// RapidAPI
// ─────────────────────────────────────────

async function rapidApiGetUrl(url, type = 'mp3') {
  if (!RAPIDAPI_KEY) throw new Error('RAPIDAPI_KEY belum diisi di config.js');
  const endpoint = type === 'mp4'
    ? `https://${RAPIDAPI_HOST}/download/mp4`
    : `https://${RAPIDAPI_HOST}/download/mp3`;
  const res  = await fetch(`${endpoint}?url=${encodeURIComponent(url)}`, {
    headers: { 'x-rapidapi-host': RAPIDAPI_HOST, 'x-rapidapi-key': RAPIDAPI_KEY },
    signal:  AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`RapidAPI HTTP ${res.status}`);
  const data = await res.json();
  const dlUrl = data.downloadUrl || data.link || data.url || data.download_url;
  if (!dlUrl) throw new Error('RapidAPI: tidak ada URL di response');
  return dlUrl;
}

// ─────────────────────────────────────────
// MAIN API - dengan fallback chain
// ─────────────────────────────────────────

// withTimeout: bungkus promise dengan timeout
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, r) => setTimeout(() => r(new Error(`${label} timeout ${ms}ms`)), ms)),
  ]);
}

// ─── Search ───────────────────────────────
async function searchYouTube(query, limit = 5) {
  // 1. Vreden
  const vr = getVreden();
  if (vr) {
    try {
      const res = await withTimeout(vr.search(query), 15000, 'vreden.search');
      if (res.status && res.results?.length) {
        return res.results.slice(0, limit).map(mapVredenResult);
      }
    } catch (e) { console.warn('[ytdl] vreden search:', e.message); }
  }

  // 2. yt-dlp
  if (getYtdlpPath()) {
    try {
      const results = await ytdlpSearch(query, limit);
      if (results.length) { console.log('[ytdl] search via yt-dlp'); return results; }
    } catch (e) { console.warn('[ytdl] yt-dlp search:', e.message); }
  }

  // 3. youtube-sr
  try {
    const YouTube = require('youtube-sr').default;
    const results = await YouTube.search(query, { limit, type: 'video' });
    return results.map(v => ({
      title:       v.title || 'Unknown',
      url:         v.url,
      videoId:     v.id,
      duration:    v.duration || 0,
      durationFmt: v.durationFormatted || formatDuration(Math.floor((v.duration||0)/1000)),
      thumbnail:   v.thumbnail?.url || null,
      uploader:    v.channel?.name || 'Unknown',
      views:       v.views || 0,
      viewsFmt:    formatViews(v.views),
      titleBtn:    sanitizeBtn(v.title),
    }));
  } catch (e) {
    console.error('[ytdl] search semua gagal:', e.message);
    return [];
  }
}

// ─── Get video info ────────────────────────
async function getVideoInfo(url) {
  // 1. yt-dlp (paling akurat untuk info)
  if (getYtdlpPath()) {
    try { return await ytdlpGetInfo(url); } catch (e) { console.warn('[ytdl] yt-dlp info:', e.message); }
  }

  // 2. Vreden via search videoId
  const vr = getVreden();
  if (vr) {
    try {
      const id  = extractVideoId(url);
      const res = await withTimeout(vr.search(id || url), 15000, 'vreden.info');
      if (res.status && res.results?.length) return mapVredenResult(res.results[0]);
    } catch (e) { console.warn('[ytdl] vreden info:', e.message); }
  }

  // 3. youtube-sr
  try {
    const YouTube = require('youtube-sr').default;
    const v = await YouTube.getVideo(url);
    if (!v) throw new Error('Not found');
    return {
      title: v.title || 'Unknown', url: v.url, videoId: v.id,
      duration: v.duration || 0, durationFmt: v.durationFormatted || '??:??',
      thumbnail: v.thumbnail?.url || null, uploader: v.channel?.name || 'Unknown',
      views: v.views || 0, viewsFmt: formatViews(v.views), titleBtn: sanitizeBtn(v.title),
    };
  } catch (e) { console.error('[ytdl] getVideoInfo gagal:', e.message); return null; }
}

// ─── Get audio stream URL ──────────────────
async function getStreamUrl(url) {
  // 1. Vreden ytmp3
  const vr = getVreden();
  if (vr) {
    try {
      const res    = await withTimeout(vr.ytmp3(url), 20000, 'vreden.ytmp3');
      const dlUrl  = res.status ? extractVredenUrl(res.download) : null;
      if (dlUrl) { console.log('[ytdl] ✅ stream URL via vreden'); return dlUrl; }
      console.warn('[ytdl] vreden ytmp3 invalid:', JSON.stringify(res.download));
    } catch (e) { console.warn('[ytdl] vreden ytmp3:', e.message); }
  }

  // 2. yt-dlp
  if (getYtdlpPath()) {
    try {
      const dlUrl = await ytdlpGetAudioUrl(url);
      console.log('[ytdl] ✅ stream URL via yt-dlp');
      return dlUrl;
    } catch (e) { console.warn('[ytdl] yt-dlp audio URL:', e.message); }
  }

  // 3. RapidAPI
  try {
    const dlUrl = await rapidApiGetUrl(url, 'mp3');
    console.log('[ytdl] ✅ stream URL via RapidAPI');
    return dlUrl;
  } catch (e) { throw new Error(`Semua metode gagal: ${e.message}`); }
}

// ─── Get video URL ─────────────────────────
async function getVideoUrl(url) {
  // 1. Vreden ytmp4
  const vr = getVreden();
  if (vr) {
    try {
      const res   = await withTimeout(vr.ytmp4(url), 30000, 'vreden.ytmp4');
      const dlUrl = res.status ? extractVredenUrl(res.download) : null;
      if (dlUrl) { console.log('[ytdl] ✅ video URL via vreden'); return dlUrl; }
    } catch (e) { console.warn('[ytdl] vreden ytmp4:', e.message); }
  }

  // 2. yt-dlp
  if (getYtdlpPath()) {
    try {
      const dlUrl = await ytdlpGetVideoUrl(url);
      console.log('[ytdl] ✅ video URL via yt-dlp');
      return dlUrl;
    } catch (e) { console.warn('[ytdl] yt-dlp video URL:', e.message); }
  }

  // 3. RapidAPI
  try {
    const dlUrl = await rapidApiGetUrl(url, 'mp4');
    console.log('[ytdl] ✅ video URL via RapidAPI');
    return dlUrl;
  } catch (e) { throw new Error(`Semua metode video gagal: ${e.message}`); }
}

// ─── Download audio to cache ───────────────
async function downloadAudio(url, outputDir = os.tmpdir()) {
  const { getCacheDir } = require('./cache');
  const cacheDir = getCacheDir();
  const videoId  = extractVideoId(url);
  const cached   = videoId ? path.join(cacheDir, `${videoId}.mp3`) : null;
  if (cached && fs.existsSync(cached)) {
    console.log(`[ytdl] 💾 Cache hit audio: ${videoId}`);
    return cached;
  }
  const outPath = cached || path.join(cacheDir, `audio_${Date.now()}.mp3`);

  // 1. yt-dlp (download langsung, paling reliable)
  if (getYtdlpPath()) {
    for (let i = 1; i <= 3; i++) {
      try {
        console.log(`[ytdl] ⬇️ yt-dlp download audio (${i}/3)`);
        return await ytdlpDownloadAudio(url, outPath);
      } catch (e) {
        console.warn(`[ytdl] yt-dlp attempt ${i}: ${e.message}`);
        if (i < 3) await new Promise(r => setTimeout(r, 2000 * i));
      }
    }
  }

  // 2. Vreden + fetch
  const vr = getVreden();
  if (vr) {
    try {
      const res   = await withTimeout(vr.ytmp3(url), 20000, 'vreden.ytmp3');
      const dlUrl = res.status ? extractVredenUrl(res.download) : null;
      if (dlUrl) {
        console.log('[ytdl] ⬇️ download via vreden URL');
        const r = await fetch(dlUrl, { signal: AbortSignal.timeout(180000) });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        fs.writeFileSync(outPath, Buffer.from(await r.arrayBuffer()));
        return outPath;
      }
    } catch (e) { console.warn('[ytdl] vreden download:', e.message); }
  }

  // 3. RapidAPI + fetch
  try {
    const dlUrl = await rapidApiGetUrl(url, 'mp3');
    console.log('[ytdl] ⬇️ download via RapidAPI URL');
    const r = await fetch(dlUrl, { signal: AbortSignal.timeout(180000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    fs.writeFileSync(outPath, Buffer.from(await r.arrayBuffer()));
    return outPath;
  } catch (e) { throw new Error(`Semua metode download audio gagal: ${e.message}`); }
}

// ─── Download video to cache ───────────────
async function downloadVideo(url, videoId = null) {
  const { getCacheDir } = require('./cache');
  const cacheDir = getCacheDir();
  const id       = videoId || extractVideoId(url);
  const cached   = id ? path.join(cacheDir, `${id}_video.mp4`) : null;
  if (cached && fs.existsSync(cached)) {
    console.log(`[ytdl] 💾 Cache hit video: ${id}`);
    return cached;
  }
  const outPath = cached || path.join(cacheDir, `video_${Date.now()}.mp4`);

  // 1. yt-dlp
  if (getYtdlpPath()) {
    try {
      console.log('[ytdl] ⬇️ yt-dlp download video');
      return await ytdlpDownloadVideo(url, outPath);
    } catch (e) { console.warn('[ytdl] yt-dlp video:', e.message); }
  }

  // 2. Vreden + fetch
  const vr = getVreden();
  if (vr) {
    try {
      const res   = await withTimeout(vr.ytmp4(url), 30000, 'vreden.ytmp4');
      const dlUrl = res.status ? extractVredenUrl(res.download) : null;
      if (dlUrl) {
        console.log('[ytdl] ⬇️ download video via vreden URL');
        const r = await fetch(dlUrl, { signal: AbortSignal.timeout(300000) });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        fs.writeFileSync(outPath, Buffer.from(await r.arrayBuffer()));
        return outPath;
      }
    } catch (e) { console.warn('[ytdl] vreden video download:', e.message); }
  }

  // 3. RapidAPI
  try {
    const dlUrl = await rapidApiGetUrl(url, 'mp4');
    const r = await fetch(dlUrl, { signal: AbortSignal.timeout(300000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    fs.writeFileSync(outPath, Buffer.from(await r.arrayBuffer()));
    return outPath;
  } catch (e) { throw new Error(`Semua metode download video gagal: ${e.message}`); }
}

// ─── Startup check ─────────────────────────
(function checkDeps() {
  const bin = getYtdlpPath();
  if (bin) {
    try {
      const ver = execSync(`${bin} --version`, { timeout: 5000 }).toString().trim();
      console.log(`[ytdl] ✅ yt-dlp: v${ver}`);
    } catch {}
  } else {
    console.warn('[ytdl] ⚠️  yt-dlp tidak ditemukan. Install: pip install yt-dlp');
  }
  if (getVreden()) console.log('[ytdl] ✅ @vreden/youtube_scraper loaded');
  else console.warn('[ytdl] ⚠️  vreden tidak tersedia. Install: npm i @vreden/youtube_scraper');
  if (!RAPIDAPI_KEY) console.warn('[ytdl] ⚠️  RAPIDAPI_KEY kosong — RapidAPI backup tidak aktif');
})();

module.exports = {
  searchYouTube, getVideoInfo,
  downloadAudio, downloadVideo,
  getStreamUrl,  getVideoUrl,
  isYouTubeUrl,  extractVideoId,
  formatDuration, sanitizeBtn,
  getYtdlpPath,
};
