// ==========================================
// FILE: music/ui.js
// Modern player UI — thumbnail + caption
// Progress bar dengan circle indicator
// Inspired by: AnonXMusic, YukkiMusicBot
// ==========================================

const { Markup } = require('telegraf');
const { t }      = require('./i18n');

// ─────────────────────────────────────────
// PROGRESS BAR — moving circle style
// ─────────────────────────────────────────
// Output: ━━━━━━◉─────────
function progressBar(currentMs, totalMs, length = 13) {
  if (!totalMs || totalMs <= 0 || !currentMs) {
    return '─'.repeat(length);
  }
  const ratio = Math.min(Math.max(currentMs / totalMs, 0), 1);
  const pos   = Math.round(ratio * length);
  let bar = '';
  for (let i = 0; i <= length; i++) {
    if (i === pos)      bar += '◉';
    else if (i < pos)   bar += '━';
    else                bar += '─';
  }
  return bar;
}

// ─────────────────────────────────────────
// TIME HELPERS
// ─────────────────────────────────────────
function fmtMs(ms) {
  if (!ms || ms < 0) return '0:00';
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  return `${m}:${String(s).padStart(2,'0')}`;
}

function escHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function loopIcon(state) {
  if (state.loop)      return '🔂';
  if (state.loopQueue) return '🔁';
  return '➖';
}

function volIcon(vol) {
  if (!vol || vol === 0) return '🔇';
  if (vol < 50)  return '🔈';
  if (vol < 120) return '🔉';
  return '🔊';
}

// ─────────────────────────────────────────
// PLAYER CAPTION — modern compact style
// ─────────────────────────────────────────
// track.duration is in MILLISECONDS (from youtube-sr)
function buildPlayerCaption(track, state, elapsedMs = 0, lang = 'id') {
  // duration is already in ms from youtube-sr
  const totalMs   = track.duration || 0;
  const bar       = progressBar(elapsedMs, totalMs);
  const posStr    = fmtMs(elapsedMs);
  const totalStr  = track.durationFmt || fmtMs(totalMs);
  const vol       = state.volume ?? 100;
  const statusIcon= state.isPaused ? '⏸' : '▶️';
  const loop      = loopIcon(state);
  const vIcon     = volIcon(vol);
  const qPos      = `${state.currentIndex + 1}/${state.tracks.length}`;

  const title     = escHtml(
    track.title.length > 45 ? track.title.slice(0, 45) + '…' : track.title
  );
  const uploader  = escHtml(
    (track.uploader || 'Unknown').length > 30
      ? (track.uploader || 'Unknown').slice(0, 30) + '…'
      : (track.uploader || 'Unknown')
  );

  return `${statusIcon} <b>${title}</b>
👤 ${uploader}
━━━━━━━━━━━━━━━━━━━━
<code>${posStr}</code> ${bar} <code>${totalStr}</code>
━━━━━━━━━━━━━━━━━━━━
${vIcon} <b>${vol}%</b>  ${loop} Loop  📋 <b>${qPos}</b>  👁 ${track.viewsFmt || '0'}`;
}

// ─────────────────────────────────────────
// PLAYER BUTTONS
// ─────────────────────────────────────────
function buildPlayerButtons(state, lang = 'id') {
  const c  = state.chatId;
  const ip = state.isPaused;
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('⏮',                              `music_prev_${c}`),
      Markup.button.callback(ip ? '▶️' : '⏸',                `music_pause_${c}`),
      Markup.button.callback('⏭',                              `music_skip_${c}`),
      Markup.button.callback('⏹',                              `music_stop_${c}`),
    ],
    [
      Markup.button.callback(t(lang,'ui_btn_loop'),             `music_loop_${c}`),
      Markup.button.callback(t(lang,'ui_btn_loopq'),            `music_loopq_${c}`),
      Markup.button.callback(t(lang,'ui_btn_shuffle'),          `music_shuffle_${c}`),
    ],
    [
      Markup.button.callback('🔉',                              `music_voldn_${c}`),
      Markup.button.callback('🔊',                              `music_volup_${c}`),
      Markup.button.callback(t(lang,'ui_btn_queue'),            `music_queue_${c}_0`),
      Markup.button.callback(t(lang,'ui_btn_lyrics'),           `music_lyrics_${c}`),
    ],
    [
      Markup.button.callback('📂 Simpan ke Playlist',           `music_savepl_${c}`),
    ],
    [
      Markup.button.callback(t(lang,'ui_btn_clear'),            `music_clear_${c}`),
      Markup.button.callback('⚙️',                             `set_back_${c}`),
    ],
  ]);
}

// ─────────────────────────────────────────
// SEND PLAYER (photo + caption)
// ─────────────────────────────────────────
async function sendPlayer(telegram, chatId, track, state, elapsedMs = 0, lang = 'id') {
  const caption = buildPlayerCaption(track, state, elapsedMs, lang);
  const buttons = buildPlayerButtons(state, lang);
  const thumb   = track.thumbnail;

  if (thumb) {
    try {
      const msg = await telegram.sendPhoto(chatId, thumb, {
        caption,
        parse_mode: 'HTML',
        ...buttons,
      });
      return { msgId: msg.message_id, isPhoto: true };
    } catch {
      // Fallback to text if photo fails
    }
  }

  // Fallback: text with blockquote
  const msg = await telegram.sendMessage(chatId,
    `<blockquote>${caption}</blockquote>`,
    { parse_mode: 'HTML', ...buttons }
  );
  return { msgId: msg.message_id, isPhoto: false };
}

// ─────────────────────────────────────────
// UPDATE PLAYER (edit caption or text)
// ─────────────────────────────────────────
async function updatePlayer(telegram, chatId, msgId, isPhoto, track, state, elapsedMs = 0, lang = 'id') {
  const caption = buildPlayerCaption(track, state, elapsedMs, lang);
  const buttons = buildPlayerButtons(state, lang);

  try {
    if (isPhoto) {
      await telegram.editMessageCaption(chatId, msgId, null, caption, {
        parse_mode: 'HTML',
        ...buttons,
      });
    } else {
      await telegram.editMessageText(chatId, msgId, null,
        `<blockquote>${caption}</blockquote>`,
        { parse_mode: 'HTML', ...buttons }
      );
    }
    return true;
  } catch (e) {
    if (!e.message?.includes('message is not modified')) {
      return false;
    }
    return true;
  }
}

// ─────────────────────────────────────────
// QUEUE TEXT (paginated)
// ─────────────────────────────────────────
function buildQueueText(state, page = 0, lang = 'id') {
  const perPage = 10;
  const total   = state.tracks.length;

  if (total === 0) return `<blockquote>${t(lang,'queue_empty_view')}</blockquote>`;

  const pages = Math.ceil(total / perPage) || 1;
  const p     = Math.max(0, Math.min(page, pages - 1));
  const start = p * perPage;
  const items = state.tracks.slice(start, start + perPage);

  const loopStatus = state.loop ? '🔂 Lagu' : state.loopQueue ? '🔁 Antrian' : '➖ Mati';

  let text = `<blockquote>${t(lang, 'queue_header', total)}`;
  items.forEach((track, i) => {
    const realIdx   = start + i;
    const isCurrent = realIdx === state.currentIndex;
    const icon      = isCurrent ? '▶️' : `${realIdx + 1}.`;
    const dur       = track.durationFmt || fmtMs(track.duration);
    const title     = escHtml(
      track.title.length > 35 ? track.title.slice(0, 35) + '…' : track.title
    );
    const bold = isCurrent ? `<b>${title}</b>` : title;
    text += `${icon} ${bold} [${dur}]\n`;
  });

  text += t(lang, 'queue_footer', loopStatus);
  if (pages > 1) text += `\n${t(lang, 'queue_page', p + 1, pages)}`;
  text += `</blockquote>`;
  return text;
}

function buildQueueButtons(chatId, page = 0, totalPages = 1, lang = 'id') {
  const rows = [];
  if (totalPages > 1) {
    const navRow = [];
    if (page > 0)
      navRow.push(Markup.button.callback('◀️', `music_queue_${chatId}_${page - 1}`));
    navRow.push(Markup.button.callback(`${page + 1}/${totalPages}`, `noop`));
    if (page < totalPages - 1)
      navRow.push(Markup.button.callback('▶️', `music_queue_${chatId}_${page + 1}`));
    if (navRow.length) rows.push(navRow);
  }
  rows.push([Markup.button.callback(t(lang, 'ui_btn_back'), `music_player_${chatId}`)]);
  return Markup.inlineKeyboard(rows);
}

// ─────────────────────────────────────────
// SEARCH RESULTS
// ─────────────────────────────────────────
function buildSearchText(results, query, lang = 'id') {
  let text = `<blockquote>${t(lang, 'search_results', escHtml(query))}`;
  results.forEach((r, i) => {
    const title = escHtml(r.title.length > 42 ? r.title.slice(0, 42) + '…' : r.title);
    text += `${i + 1}. <b>${title}</b>\n`;
    text += `   👤 ${escHtml(r.uploader)} · ⏱ ${r.durationFmt} · 👁 ${r.viewsFmt}\n`;
  });
  text += t(lang, 'search_pick_hint');
  text += `</blockquote>`;
  return text;
}

function buildSearchButtons(results, chatId, lang = 'id') {
  const rows = results.map((r, i) => [
    Markup.button.callback(
      `${i + 1}. ${sanitizeBtn(r.title)}`,
      `music_pick_${chatId}_${i}`
    )
  ]);
  rows.push([
    Markup.button.callback('❌ ' + (lang === 'id' ? 'Batal' : 'Cancel'), `music_cancel_${chatId}`)
  ]);
  return Markup.inlineKeyboard(rows);
}

// ─────────────────────────────────────────
// HISTORY
// ─────────────────────────────────────────
function buildHistoryText(history, lang = 'id') {
  if (!history || history.length === 0) {
    return `<blockquote>${t(lang, 'history_empty')}</blockquote>`;
  }
  let text = `<blockquote>${t(lang, 'history_header')}`;
  history.slice(0, 15).forEach((track, i) => {
    const title = escHtml(
      track.title.length > 37 ? track.title.slice(0, 37) + '…' : track.title
    );
    const ago = timeAgo(track.playedAt);
    text += `${i + 1}. <b>${title}</b>\n   👤 ${escHtml(track.uploader)} · 🕐 ${ago}\n`;
  });
  text += `</blockquote>`;
  return text;
}

function timeAgo(ts) {
  if (!ts) return '?';
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 60)   return `${diff}s lalu`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m lalu`;
  return `${Math.floor(diff / 3600)}j lalu`;
}

// ─────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────
function sanitizeBtn(str, maxLen = 38) {
  if (!str) return 'Unknown';
  return str
    .replace(/[^\x20-\x7E\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen) || 'Unknown';
}


// ─────────────────────────────────────────
// SAFE EDIT — handles both photo and text messages
// Automatically uses editMessageCaption for photos
// ─────────────────────────────────────────
async function safeEdit(ctx, text, extra = {}) {
  const msg  = ctx.callbackQuery?.message;
  const isPhoto = msg && (msg.photo || msg.animation || msg.video || msg.document);
  try {
    if (isPhoto) {
      await ctx.editMessageCaption(text, { parse_mode: 'HTML', ...extra });
    } else {
      await ctx.editMessageText(
        text.startsWith('<blockquote>') ? text : `<blockquote>${text}</blockquote>`,
        { parse_mode: 'HTML', ...extra }
      );
    }
  } catch (e) {
    if (!e.message?.includes('message is not modified') &&
        !e.message?.includes('no text in the message')) {
      throw e;
    }
  }
}

// DELETE message then SEND new player (for when song changes)
async function deleteAndSendPlayer(telegram, chatId, oldMsgId, track, state, lang) {
  // Delete old player message
  if (oldMsgId) {
    try { await telegram.deleteMessage(chatId, oldMsgId); } catch {}
  }
  // Send fresh new player
  return sendPlayer(telegram, chatId, track, state, 0, lang);
}

module.exports = {
  progressBar,
  buildPlayerCaption,
  buildPlayerButtons,
  sendPlayer,
  updatePlayer,
  safeEdit,
  deleteAndSendPlayer,
  buildQueueText,
  buildQueueButtons,
  buildSearchText,
  buildSearchButtons,
  buildHistoryText,
  fmtMs,
  escHtml,
};
