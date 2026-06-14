// ==========================================
// FILE: music/ytdl.js
// Primary  : @vreden/youtube_scraper
//            → search, ytmp3, ytmp4
// Backup   : RapidAPI youtube-mp310
// ==========================================

const fs   = require('fs');
const path = require('path');
const os   = require('os');

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

// ─── Map vreden result → track object ─────
function mapVredenResult(v) {
  // vreden search returns different field names
  const title    = v.title    || v.name   || 'Unknown';
  const videoId  = v.videoId  || v.id     || extractVideoId(v.url || '') || '';
  const url      = v.url      || (videoId ? `https://youtube.com/watch?v=${videoId}` : '');
  const uploader = v.channel  || v.author || v.uploader || 'Unknown';
  const views    = v.views    || v.viewCount || 0;

  // Duration: vreden might return seconds or formatted string
  let durationSec = 0;
  let durationFmt = '??:??';
  if (v.duration) {
    if (typeof v.duration === 'number') {
      durationSec = v.duration;
      durationFmt = formatDuration(durationSec);
    } else if (typeof v.duration === 'string') {
      durationFmt = v.duration;
      // Parse mm:ss or hh:mm:ss to seconds
      const parts = v.duration.split(':').map(Number);
      if (parts.length === 2) durationSec = parts[0]*60 + parts[1];
      else if (parts.length === 3) durationSec = parts[0]*3600 + parts[1]*60 + parts[2];
    }
  }

  return {
    title,
    url,
    videoId,
    duration:    durationSec * 1000, // store as ms (consistent with youtube-sr)
    durationFmt,
    thumbnail:   v.thumbnail || v.thumbnails?.[0]?.url || null,
    uploader,
    views,
    viewsFmt:    formatViews(views),
    titleBtn:    sanitizeBtn(title),
  };
}

// ─────────────────────────────────────────
// PRIMARY: @vreden/youtube_scraper
// ─────────────────────────────────────────

let yreden = null;
function getVreden() {
  if (yreden) return yreden;
  try {
    yreden = require('@vreden/youtube_scraper');
    console.log('[ytdl] ✅ @vreden/youtube_scraper loaded');
    return yreden;
  } catch {
    console.warn('[ytdl] ⚠️ @vreden/youtube_scraper tidak tersedia, fallback ke youtube-sr');
    return null;
  }
}

// ─── Search ───────────────────────────────
async function searchYouTube(query, limit = 5) {
  // 1. Coba vreden
  const vr = getVreden();
  if (vr) {
    try {
      const res = await vr.search(query);
      if (res.status && res.results?.length) {
        return res.results.slice(0, limit).map(mapVredenResult);
      }
    } catch (e) {
      console.warn('[ytdl] vreden search error:', e.message);
    }
  }

  // 2. Fallback: youtube-sr
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
    console.error('[ytdl] search fallback error:', e.message);
    return [];
  }
}

// ─── Get video info ────────────────────────
async function getVideoInfo(url) {
  const vr = getVreden();

  // Vreden doesn't have a direct getInfo, so search by videoId
  if (vr) {
    try {
      const videoId = extractVideoId(url);
      if (videoId) {
        const res = await vr.search(videoId);
        if (res.status && res.results?.length) {
          const track = mapVredenResult(res.results[0]);
          if (track.url || track.videoId) return track;
        }
      }
    } catch {}
  }

  // Fallback: youtube-sr
  try {
    const YouTube = require('youtube-sr').default;
    const v = await YouTube.getVideo(url);
    if (!v) throw new Error('Not found');
    return {
      title:       v.title || 'Unknown',
      url:         v.url,
      videoId:     v.id,
      duration:    v.duration || 0,
      durationFmt: v.durationFormatted || '??:??',
      thumbnail:   v.thumbnail?.url || null,
      uploader:    v.channel?.name || 'Unknown',
      views:       v.views || 0,
      viewsFmt:    formatViews(v.views),
      titleBtn:    sanitizeBtn(v.title),
    };
  } catch (e) {
    console.error('[ytdl] getVideoInfo error:', e.message);
    return null;
  }
}

// ─── Get audio stream/download URL ────────
async function getStreamUrl(url) {
  const vr = getVreden();

  // 1. Vreden ytmp3
  if (vr) {
    try {
      console.log('[ytdl] 🎵 vreden ytmp3...');
      const res = await Promise.race([vr.ytmp3(url), new Promise((_,r) => setTimeout(() => r(new Error('vreden timeout')), 20000))]);
      if (res.status) {
        // vreden may return string or object
        const dl = res.download;
        const dlUrl = typeof dl === 'string' ? dl
                    : dl?.url || dl?.link || dl?.downloadUrl || null;
        if (dlUrl && dlUrl.startsWith('http')) {
          console.log('[ytdl] ✅ Audio URL via vreden');
          return dlUrl;
        }
        console.warn('[ytdl] vreden ytmp3 invalid URL:', JSON.stringify(dl));
      }
    } catch (e) {
      console.warn('[ytdl] vreden ytmp3 error:', e.message);
    }
  }

  // 2. Fallback: RapidAPI
  if (RAPIDAPI_KEY) {
    try {
      console.log('[ytdl] 🎵 RapidAPI fallback...');
      const res = await fetch(
        `https://${RAPIDAPI_HOST}/download/mp3?url=${encodeURIComponent(url)}`,
        {
          headers: { 'x-rapidapi-host': RAPIDAPI_HOST, 'x-rapidapi-key': RAPIDAPI_KEY },
          signal:  AbortSignal.timeout(30000),
        }
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data   = await res.json();
      const mp3Url = data.downloadUrl || data.link || data.url || data.download_url;
      if (!mp3Url) throw new Error('No URL in response');
      console.log('[ytdl] ✅ Audio URL via RapidAPI');
      return mp3Url;
    } catch (e) {
      console.warn('[ytdl] RapidAPI error:', e.message);
    }
  }

  throw new Error('Semua metode gagal mendapatkan audio URL');
}

// ─── Get video download URL ────────────────
async function getVideoUrl(url) {
  const vr = getVreden();

  // 1. Vreden ytmp4
  if (vr) {
    try {
      console.log('[ytdl] 📹 vreden ytmp4...');
      const res = await Promise.race([vr.ytmp4(url), new Promise((_,r) => setTimeout(() => r(new Error('vreden timeout')), 30000))]);
      if (res.status) {
        const dl = res.download;
        const dlUrl = typeof dl === 'string' ? dl
                    : dl?.url || dl?.link || dl?.downloadUrl || null;
        if (dlUrl && dlUrl.startsWith('http')) {
          console.log('[ytdl] ✅ Video URL via vreden');
          return dlUrl;
        }
        console.warn('[ytdl] vreden ytmp4 invalid URL:', JSON.stringify(dl));
      }
    } catch (e) {
      console.warn('[ytdl] vreden ytmp4 error:', e.message);
    }
  }

  throw new Error('Tidak bisa mendapatkan video URL. Install: npm i @vreden/youtube_scraper');
}

// ─── Download audio to file ────────────────
async function downloadAudio(url, outputDir = os.tmpdir()) {
  const { getCacheDir } = require('./cache');
  const cacheDir = getCacheDir();
  const videoId  = extractVideoId(url);
  const cached   = videoId ? path.join(cacheDir, `${videoId}.mp3`) : null;

  if (cached && fs.existsSync(cached)) {
    console.log(`[ytdl] 💾 Cache hit audio: ${videoId}`);
    return cached;
  }

  const outPath = cached || path.join(outputDir, `audio_${Date.now()}.mp3`);

  // Get download URL then fetch
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      console.log(`[ytdl] ⬇️ Download audio attempt ${attempt}/3`);
      const dlUrl = await getStreamUrl(url);
      const res   = await fetch(dlUrl, { signal: AbortSignal.timeout(180000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      fs.writeFileSync(outPath, buf);
      console.log(`[ytdl] ✅ Audio saved: ${(buf.length/1024/1024).toFixed(1)}MB`);
      return outPath;
    } catch (e) {
      console.warn(`[ytdl] Download attempt ${attempt} gagal: ${e.message}`);
      if (attempt < 3) await new Promise(r => setTimeout(r, 2000 * attempt));
    }
  }

  throw new Error('Gagal download audio setelah 3x percobaan');
}

// ─── Download video to file ────────────────
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

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      console.log(`[ytdl] ⬇️ Download video attempt ${attempt}/2`);
      const dlUrl = await getVideoUrl(url);
      const res   = await fetch(dlUrl, { signal: AbortSignal.timeout(300000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      fs.writeFileSync(outPath, buf);
      console.log(`[ytdl] ✅ Video saved: ${(buf.length/1024/1024).toFixed(1)}MB`);
      return outPath;
    } catch (e) {
      console.warn(`[ytdl] Video download attempt ${attempt} gagal: ${e.message}`);
      if (attempt < 2) await new Promise(r => setTimeout(r, 3000));
    }
  }

  throw new Error('Gagal download video');
}

// ─── Startup check ─────────────────────────
(function checkDeps() {
  const vr = getVreden();
  if (!vr) {
    console.warn('[ytdl] ⚠️  Install: npm i @vreden/youtube_scraper');
  }
  if (!RAPIDAPI_KEY) {
    console.warn('[ytdl] ⚠️  RAPIDAPI_KEY kosong — backup tidak aktif');
  }
})();

module.exports = {
  searchYouTube,
  getVideoInfo,
  downloadAudio,
  downloadVideo,
  getStreamUrl,
  getVideoUrl,
  isYouTubeUrl,
  extractVideoId,
  formatDuration,
  sanitizeBtn,
};
