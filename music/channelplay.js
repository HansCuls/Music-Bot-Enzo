// ==========================================
// FILE: music/channelplay.js
// Play audio/video di Voice Chat CHANNEL
// Semua command via PRIVATE CHAT
//
// Commands (private chat only):
//   /cplay @ch/id <judul/URL>   — audio
//   /cvplay @ch/id <judul/URL>  — video
//   /csearch @ch/id <judul>     — cari audio
//   /cvsearch @ch/id <judul>    — cari video
//   /cpause @ch/id
//   /cresume @ch/id
//   /cskip @ch/id [n]
//   /cprev @ch/id
//   /cstop @ch/id
//   /cqueue @ch/id [page]
//   /cnp @ch/id
//   /cvolume @ch/id <0-200>
//   /cloop @ch/id
//   /cshuffle @ch/id
//   /csettings @ch/id
// ==========================================

const { Markup }  = require('telegraf');
const { safe, writeLog } = require('./error_handler');
const { Api }     = require('teleproto');
const { searchYouTube, getVideoInfo, getStreamUrl, isYouTubeUrl } = require('./ytdl');
const { startStream, stopStream, pauseStream, resumeStream, getElapsed } = require('./streamer');
// Video stream pakai audio stream biasa (ntgcalls tidak support video langsung)
const queue       = require('./queue');
const S           = require('./settings');
const { t }       = require('./i18n');
const { getMusicClient, isVoiceChatActive, startVoiceChat,
        startLeaveTimer, cancelLeaveTimer, userbotLeaveGroup } = require('./musicbot');
const { buildPlayerCaption, buildPlayerButtons, sendPlayer, updatePlayer, buildQueueText, buildQueueButtons,
        buildSearchText, buildSearchButtons } = require('./ui');
const { VIDEO_QUALITY } = require('./settings');

// ─── Parse command: extract channel + query ─
// Input: "/cplay @mychannel shape of you"
// OR:    "/cplay -1001234567890 shape of you"
function parseChannelCommand(text) {
  const parts = text.trim().split(/\s+/);
  parts.shift(); // remove command
  if (!parts.length) return { channel: null, query: '' };

  const first = parts[0];
  // Channel username (@xxx) or numeric ID (-100xxx or plain number)
  const isChannel = first.startsWith('@') || /^-?\d+$/.test(first);
  if (!isChannel) return { channel: null, query: parts.join(' ') };

  const channel = first;
  const query   = parts.slice(1).join(' ').trim();
  return { channel, query };
}

// ─── Resolve channel to numeric ID ────────
async function resolveChannel(ctx, channelInput) {
  try {
    const client = getMusicClient();
    if (!client) throw new Error('Tidak ada userbot aktif');

    // Try numeric ID first
    if (/^-?\d+$/.test(channelInput)) {
      const id = parseInt(channelInput);
      return id;
    }

    // Username → resolve via userbot
    const username = channelInput.replace('@', '');
    const entity   = await client.getEntity(username);
    // entity.id for channels needs -100 prefix
    if (entity.className === 'Channel') {
      return parseInt(`-100${entity.id}`);
    }
    return entity.id;
  } catch (e) {
    throw new Error(`Gagal resolve channel "${channelInput}": ${e.message}`);
  }
}

// ─── Check if user is admin of channel ────
async function isChannelAdmin(ctx, channelId) {
  try {
    const member = await ctx.telegram.getChatMember(channelId, ctx.from.id);
    return ['administrator', 'creator'].includes(member.status);
  } catch { return false; }
}

// ─── Pre-check for channel ────────────────
async function preCheckChannel(ctx, channelId) {
  const l = S.getLang(channelId);

  // Check if user is admin of that channel
  if (!await isChannelAdmin(ctx, channelId)) {
    return { ok: false, reason: `❌ Kamu bukan admin di channel <code>${channelId}</code>.` };
  }

  const client = getMusicClient(channelId);
  if (!client) return { ok: false, reason: t(l, 'userbot_not_login') };

  // Check if bot is admin of channel
  try {
    const botInfo = await ctx.telegram.getMe();
    const member  = await ctx.telegram.getChatMember(channelId, botInfo.id);
    if (!['administrator', 'creator'].includes(member.status)) {
      return { ok: false, reason: `❌ Bot bukan admin di channel tersebut!\n\nTambahkan bot sebagai admin dengan hak:\n• Posting Pesan\n• Kelola Tayangan Langsung` };
    }
  } catch (e) {
    return { ok: false, reason: `❌ Tidak bisa mengecek status bot di channel: ${e.message}` };
  }

  // Check userbot in channel
  try {
    const me     = await client.getMe();
    const entity = await client.getEntity(BigInt(channelId));
    await client.invoke(new Api.channels.GetParticipant({ channel: entity, participant: me }));
  } catch {
    // Try to join
    try {
      const invite = await ctx.telegram.exportChatInviteLink(channelId).catch(() => null);
      if (invite) {
        await client.invoke(new Api.messages.ImportChatInvite({ hash: invite.split('/').pop() })).catch(() => {});
      } else {
        const entity = await client.getEntity(BigInt(channelId));
        await client.invoke(new Api.channels.JoinChannel({ channel: entity })).catch(() => {});
      }
    } catch (e) {
      return { ok: false, reason: `❌ Gagal mengundang userbot ke channel: ${e.message}` };
    }
  }

  // Promote userbot in channel
  try {
    const me = await client.getMe();
    const member = await ctx.telegram.getChatMember(channelId, me.id);
    if (!['administrator', 'creator'].includes(member.status)) {
      await ctx.telegram.promoteChatMember(channelId, me.id, {
        can_manage_chat: true, can_manage_video_chats: true,
        can_post_messages: false, can_invite_users: true,
      });
    }
  } catch (e) {
    return { ok: false, reason: `❌ Gagal promote userbot di channel: ${e.message}` };
  }

  // Start VC if not active
  const vcActive = await isVoiceChatActive(channelId);
  if (!vcActive) {
    try {
      await startVoiceChat(channelId);
    } catch (e) {
      return { ok: false, reason: t(l, 'vc_failed', e.message) };
    }
  }

  return { ok: true };
}

// ─── Play track in channel ─────────────────
async function playChannelTrack(ctx, channelId, track, state) {
  cancelLeaveTimer(channelId);
  const l   = S.getLang(channelId);
  const vol = S.getVolume(channelId);

  const streamUrl = await getStreamUrl(track.url);

  await startStream(getMusicClient(channelId), channelId, streamUrl, {
    onFinish: async () => {
      state.isPlaying = false;
      const next = queue.next(channelId);
      if (next) {
        state.isPlaying = true; state.isPaused = false; state.startedAt = Date.now();
        await playChannelTrack(ctx, channelId, next, state).catch(console.error);
      } else {
        state.isPlaying = false;
        try {
          await ctx.replyWithHTML(
            `<blockquote>✅ Semua lagu di channel <code>${channelId}</code> selesai diputar.\n\n⏳ Userbot keluar otomatis 15 menit.</blockquote>`
          );
        } catch {}
        startLeaveTimer(channelId, async (id) => {
          await userbotLeaveGroup(id);
          queue.delete(id);
        });
      }
    },
  }, vol);

  state.isPlaying = true; state.isPaused = false; state.startedAt = Date.now();
  state.volume = vol;

  if (state.msgId) {
    const ok = await updatePlayer(ctx.telegram, ctx.chat.id, state.msgId, state.isPhoto, track, state, 0, l);
    if (ok) return;
  }
  const result = await sendPlayer(ctx.telegram, ctx.chat.id, track, state, 0, l);
  state.msgId   = result.msgId;
  state.isPhoto = result.isPhoto;
}

// ─── Channel player buttons (in private chat) ──
function buildChannelPlayerButtons(channelId, state, lang = 'id') {
  const ip = state.isPaused;
  return Markup.inlineKeyboard([
    [
      Markup.button.callback(t(lang,'ui_btn_prev'),   `ch_prev_${channelId}`),
      Markup.button.callback(ip ? t(lang,'ui_btn_resume') : t(lang,'ui_btn_pause'), `ch_pause_${channelId}`),
      Markup.button.callback(t(lang,'ui_btn_skip'),   `ch_skip_${channelId}`),
    ],
    [
      Markup.button.callback(t(lang,'ui_btn_stop'),    `ch_stop_${channelId}`),
      Markup.button.callback(t(lang,'ui_btn_queue'),   `ch_queue_${channelId}_0`),
      Markup.button.callback(t(lang,'ui_btn_shuffle'), `ch_shuffle_${channelId}`),
    ],
    [
      Markup.button.callback(t(lang,'ui_btn_loop'),    `ch_loop_${channelId}`),
      Markup.button.callback(t(lang,'ui_btn_vol_dn'),  `ch_voldn_${channelId}`),
      Markup.button.callback(t(lang,'ui_btn_vol_up'),  `ch_volup_${channelId}`),
    ],
    [
      Markup.button.callback(`⚙️ Settings Channel`, `ch_settings_${channelId}`),
    ],
  ]);
}

// ─── Search cache ──────────────────────────
const chSearchCache = new Map();

// ─── Register all commands ─────────────────
module.exports = (bot) => {

  // ──────────── /cplay @ch judul ────────────
  bot.command('cplay', safe(async (ctx) => {
    if (ctx.chat.type !== 'private')
      return ctx.replyWithHTML(`<blockquote>❌ Perintah ini hanya bisa digunakan di <b>private chat</b>.\n\nFormat: /cplay @channel judul lagu</blockquote>`);

    const { channel, query } = parseChannelCommand(ctx.message.text);
    if (!channel) return ctx.replyWithHTML(`<blockquote>❓ <b>Cara pakai:</b>\n/cplay @channel judul lagu\n/cplay -1001234567890 judul lagu\n\nContoh: /cplay @mychannel Shape of You</blockquote>`);
    if (!query)   return ctx.replyWithHTML(`<blockquote>❓ Tambahkan judul lagu.\n\nContoh: /cplay @mychannel Dewa 19 Kangen</blockquote>`);

    const loadMsg = await ctx.replyWithHTML(`<blockquote>🔍 Memproses...</blockquote>`);

    try {
      const channelId = await resolveChannel(ctx, channel);
      const l = S.getLang(channelId);

      await ctx.telegram.editMessageText(ctx.chat.id, loadMsg.message_id, null,
        `<blockquote>🔍 Memeriksa channel <code>${channel}</code>...</blockquote>`, { parse_mode: 'HTML' }
      );

      const check = await preCheckChannel(ctx, channelId);
      if (!check.ok) {
        return ctx.telegram.editMessageText(ctx.chat.id, loadMsg.message_id, null,
          `<blockquote>${check.reason}</blockquote>`, { parse_mode: 'HTML' }
        );
      }

      // Search / fetch track
      let track;
      if (isYouTubeUrl(query)) {
        await ctx.telegram.editMessageText(ctx.chat.id, loadMsg.message_id, null,
          `<blockquote>${t(l,'fetching_info')}</blockquote>`, { parse_mode:'HTML' }
        );
        track = await getVideoInfo(query);
      } else {
        await ctx.telegram.editMessageText(ctx.chat.id, loadMsg.message_id, null,
          `<blockquote>${t(l,'searching_yt')}</blockquote>`, { parse_mode:'HTML' }
        );
        const results = await searchYouTube(query, 1);
        if (!results.length) {
          return ctx.telegram.editMessageText(ctx.chat.id, loadMsg.message_id, null,
            `<blockquote>${t(l,'not_found')}</blockquote>`, { parse_mode:'HTML' }
          );
        }
        track = results[0];
      }
      if (!track) throw new Error('Gagal ambil info lagu');
      track.requestedBy = ctx.from.id;

      queue.add(channelId, track);
      const state = queue.get(channelId);

      if (state.isPlaying) {
        await ctx.telegram.editMessageText(ctx.chat.id, loadMsg.message_id, null,
          `<blockquote>✅ <b>Ditambahkan ke antrian channel ${channel}!</b>\n\n🎵 ${track.title}\n👤 ${track.uploader}\n⏱ ${track.durationFmt}\n📋 Posisi: #${state.tracks.length}</blockquote>`,
          { parse_mode: 'HTML' }
        );
      } else {
        state.currentIndex = state.tracks.length - 1;
        await ctx.telegram.editMessageText(ctx.chat.id, loadMsg.message_id, null,
          `<blockquote>🎶 Memulai putar di channel ${channel}...</blockquote>`, { parse_mode:'HTML' }
        );
        await playChannelTrack(ctx, channelId, track, state);
        await ctx.telegram.deleteMessage(ctx.chat.id, loadMsg.message_id).catch(() => {});
      }
    } catch (e) {
      await ctx.telegram.editMessageText(ctx.chat.id, loadMsg.message_id, null,
        `<blockquote>❌ <b>Error:</b> ${e.message}</blockquote>`, { parse_mode: 'HTML' }
      ).catch(() => {});
    }
  }));

  // ──────────── /cvplay @ch judul ───────────
  bot.command('cvplay', safe(async (ctx) => {
    if (ctx.chat.type !== 'private')
      return ctx.replyWithHTML(`<blockquote>❌ Gunakan di private chat.\n\nFormat: /cvplay @channel judul video</blockquote>`);

    const { channel, query } = parseChannelCommand(ctx.message.text);
    if (!channel) return ctx.replyWithHTML(`<blockquote>❓ <b>Cara pakai:</b>\n/cvplay @channel judul video\n\nContoh: /cvplay @mychannel Rick Astley Never Gonna Give You Up</blockquote>`);
    if (!query)   return ctx.replyWithHTML(`<blockquote>❓ Tambahkan judul video.</blockquote>`);

    const loadMsg = await ctx.replyWithHTML(`<blockquote>🔍 Memproses...</blockquote>`);

    try {
      const channelId = await resolveChannel(ctx, channel);
      const l = S.getLang(channelId);

      const check = await preCheckChannel(ctx, channelId);
      if (!check.ok) {
        return ctx.telegram.editMessageText(ctx.chat.id, loadMsg.message_id, null,
          `<blockquote>${check.reason}</blockquote>`, { parse_mode: 'HTML' }
        );
      }

      let track;
      if (isYouTubeUrl(query)) {
        track = await getVideoInfo(query);
      } else {
        await ctx.telegram.editMessageText(ctx.chat.id, loadMsg.message_id, null,
          `<blockquote>🔍 Mencari video...</blockquote>`, { parse_mode:'HTML' }
        );
        const results = await searchYouTube(query, 1);
        if (!results.length) {
          return ctx.telegram.editMessageText(ctx.chat.id, loadMsg.message_id, null,
            `<blockquote>${t(l,'not_found')}</blockquote>`, { parse_mode:'HTML' }
          );
        }
        track = results[0];
      }
      if (!track) throw new Error('Gagal ambil info video');

      const quality = S.getVideoQuality(channelId);
      const volume  = S.getVolume(channelId);
      const vqLabel = VIDEO_QUALITY[quality].label;
      const client  = getMusicClient(channelId);
      const streamUrl = await getStreamUrl(track.url);
      const state   = queue.get(channelId);

      await ctx.telegram.editMessageText(ctx.chat.id, loadMsg.message_id, null,
        `<blockquote>📹 Memulai stream video ke channel ${channel}...</blockquote>`, { parse_mode:'HTML' }
      );

      await startVideoStream(client, channelId, streamUrl, {
        onFinish: async () => {
          state.isPlaying = false;
          try { await ctx.replyWithHTML(`<blockquote>✅ Video selesai di channel ${channel}.</blockquote>`); } catch {}
        },
      }, quality, volume);

      state.isPlaying = true; state.isPaused = false;

      await ctx.telegram.editMessageText(ctx.chat.id, loadMsg.message_id, null,
        `<blockquote>📹 <b>Sedang Stream Video</b>
━━━━━━━━━━━━━━━━━━━━
📺 Channel  : ${channel}
🎬 Judul    : <b>${track.title}</b>
👤 Channel  : ${track.uploader}
⏱ Durasi   : ${track.durationFmt}
📺 Kualitas : ${vqLabel}
🔊 Volume   : ${volume}%
━━━━━━━━━━━━━━━━━━━━</blockquote>`,
        {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([
            [
              Markup.button.callback('⏹ Stop Video', `ch_vstop_${channelId}`),
              Markup.button.callback('⚙️ Settings', `ch_settings_${channelId}`),
            ],
          ]),
        }
      );
    } catch (e) {
      await ctx.telegram.editMessageText(ctx.chat.id, loadMsg.message_id, null,
        `<blockquote>❌ <b>Gagal stream video:</b>\n${e.message}</blockquote>`, { parse_mode: 'HTML' }
      ).catch(() => {});
    }
  }));

  // ──────────── /csearch @ch judul ──────────
  bot.command('csearch', safe(async (ctx) => {
    if (ctx.chat.type !== 'private')
      return ctx.replyWithHTML(`<blockquote>❌ Gunakan di private chat.</blockquote>`);

    const { channel, query } = parseChannelCommand(ctx.message.text);
    if (!channel || !query) return ctx.replyWithHTML(
      `<blockquote>❓ Cara pakai: /csearch @channel judul lagu</blockquote>`
    );

    const loadMsg = await ctx.replyWithHTML(`<blockquote>🔍 Mencari lagu...</blockquote>`);
    try {
      const channelId = await resolveChannel(ctx, channel);
      const results   = await searchYouTube(query, 5);
      if (!results.length) {
        return ctx.telegram.editMessageText(ctx.chat.id, loadMsg.message_id, null,
          `<blockquote>❌ Tidak ditemukan.</blockquote>`, { parse_mode: 'HTML' }
        );
      }
      chSearchCache.set(`${ctx.from.id}_${channelId}`, { results, channelId, channel });

      let text = `<blockquote>🔍 <b>Hasil Pencarian Audio</b>\n`;
      text += `📺 Channel: ${channel}\nQuery: <i>${query}</i>\n━━━━━━━━━━━━━━━━━━━━\n\n`;
      results.forEach((r, i) => {
        const title = r.title.length > 38 ? r.title.slice(0,38)+'…' : r.title;
        text += `${i+1}. <b>${title}</b>\n   👤 ${r.uploader} • ⏱ ${r.durationFmt}\n`;
      });
      text += `\n━━━━━━━━━━━━━━━━━━━━\n🎵 Pilih lagu:</blockquote>`;

      const buttons = results.map((r, i) => [
        Markup.button.callback(`${i+1}. ${r.title.slice(0,35)}`, `ch_pick_${ctx.from.id}_${channelId}_${i}`)
      ]);
      buttons.push([Markup.button.callback('❌ Batal', `ch_cancel_search_${ctx.from.id}`)]);

      await ctx.telegram.editMessageText(ctx.chat.id, loadMsg.message_id, null, text, {
        parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons)
      });
    } catch (e) {
      await ctx.telegram.editMessageText(ctx.chat.id, loadMsg.message_id, null,
        `<blockquote>❌ ${e.message}</blockquote>`, { parse_mode: 'HTML' }
      ).catch(() => {});
    }
  }));

  // ──────────── /cvsearch @ch judul ─────────
  bot.command('cvsearch', safe(async (ctx) => {
    if (ctx.chat.type !== 'private')
      return ctx.replyWithHTML(`<blockquote>❌ Gunakan di private chat.</blockquote>`);

    const { channel, query } = parseChannelCommand(ctx.message.text);
    if (!channel || !query) return ctx.replyWithHTML(
      `<blockquote>❓ Cara pakai: /cvsearch @channel judul video</blockquote>`
    );

    const loadMsg = await ctx.replyWithHTML(`<blockquote>🔍 Mencari video...</blockquote>`);
    try {
      const channelId = await resolveChannel(ctx, channel);
      const results   = await searchYouTube(query, 5);
      if (!results.length) {
        return ctx.telegram.editMessageText(ctx.chat.id, loadMsg.message_id, null,
          `<blockquote>❌ Tidak ditemukan.</blockquote>`, { parse_mode: 'HTML' }
        );
      }
      chSearchCache.set(`${ctx.from.id}_${channelId}_v`, { results, channelId, channel, isVideo: true });

      let text = `<blockquote>📹 <b>Hasil Pencarian Video</b>\n`;
      text += `📺 Channel: ${channel}\nQuery: <i>${query}</i>\n━━━━━━━━━━━━━━━━━━━━\n\n`;
      results.forEach((r, i) => {
        const title = r.title.length > 38 ? r.title.slice(0,38)+'…' : r.title;
        text += `${i+1}. <b>${title}</b>\n   👤 ${r.uploader} • ⏱ ${r.durationFmt}\n`;
      });
      text += `\n━━━━━━━━━━━━━━━━━━━━\n📹 Pilih video:</blockquote>`;

      const buttons = results.map((r, i) => [
        Markup.button.callback(`${i+1}. ${r.title.slice(0,35)}`, `ch_vpick_${ctx.from.id}_${channelId}_${i}`)
      ]);
      buttons.push([Markup.button.callback('❌ Batal', `ch_cancel_search_${ctx.from.id}`)]);

      await ctx.telegram.editMessageText(ctx.chat.id, loadMsg.message_id, null, text, {
        parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons)
      });
    } catch (e) {
      await ctx.telegram.editMessageText(ctx.chat.id, loadMsg.message_id, null,
        `<blockquote>❌ ${e.message}</blockquote>`, { parse_mode: 'HTML' }
      ).catch(() => {});
    }
  }));

  // ──────────── Simple controls ──────────────
  const simpleControls = {
    cpause:   async (ctx, chId, l) => {
      const st = queue.get(chId);
      if (!st.isPlaying) return `${t(l,'no_playing')}`;
      if (st.isPaused)   return `${t(l,'already_paused')}`;
      await pauseStream(chId); st.isPaused = true;
      return `${t(l,'paused')}`;
    },
    cresume:  async (ctx, chId, l) => {
      const st = queue.get(chId);
      if (!st.isPlaying) return `${t(l,'no_playing')}`;
      if (!st.isPaused)  return `${t(l,'already_playing')}`;
      await resumeStream(chId); st.isPaused = false;
      cancelLeaveTimer(chId);
      return `${t(l,'resumed')}`;
    },
    cstop:    async (ctx, chId, l) => {
      stopStream(chId); queue.clear(chId);
      startLeaveTimer(chId, async (id) => { await userbotLeaveGroup(id); queue.delete(id); });
      return `${t(l,'stopped')}`;
    },
    cshuffle: async (ctx, chId, l) => {
      if (!queue.shuffle(chId)) return `${t(l,'no_queue_to_shuffle')}`;
      return `${t(l,'shuffled')}`;
    },
    cnp:      async (ctx, chId, l) => {
      const track = queue.current(chId);
      const st    = queue.get(chId);
      if (!st.isPlaying || !track) return `${t(l,'no_playing')}`;
      return buildPlayerCaption(track, st, getElapsed(chId), l);
    },
  };

  for (const [cmd, handler] of Object.entries(simpleControls)) {
    bot.command(cmd, safe(async (ctx) => {
      if (ctx.chat.type !== 'private')
        return ctx.replyWithHTML(`<blockquote>❌ Gunakan di private chat.\n\nFormat: /${cmd} @channel</blockquote>`);
      const { channel } = parseChannelCommand(ctx.message.text);
      if (!channel) return ctx.replyWithHTML(`<blockquote>❓ Format: /${cmd} @channel</blockquote>`);
      try {
        const chId = await resolveChannel(ctx, channel);
        const l    = S.getLang(chId);
        const msg  = await handler(ctx, chId, l);
        await ctx.replyWithHTML(`<blockquote>${msg}</blockquote>`);
      } catch (e) {
        await ctx.replyWithHTML(`<blockquote>❌ ${e.message}</blockquote>`);
      }
    }));
  }

  // ──────────── /cskip @ch [n] ──────────────
  bot.command('cskip', safe(async (ctx) => {
    if (ctx.chat.type !== 'private') return ctx.replyWithHTML(`<blockquote>❌ Gunakan di private chat.</blockquote>`);
    const parts   = ctx.message.text.split(/\s+/);
    const channel = parts[1];
    const n       = parseInt(parts[2]) || 1;
    if (!channel) return ctx.replyWithHTML(`<blockquote>❓ Format: /cskip @channel [n]</blockquote>`);
    try {
      const chId = await resolveChannel(ctx, channel);
      const l    = S.getLang(chId);
      const st   = queue.get(chId);
      if (!st.isPlaying) return ctx.replyWithHTML(`<blockquote>${t(l,'no_playing')}</blockquote>`);
      let next = null;
      for (let i = 0; i < n; i++) next = queue.next(chId);
      if (!next) {
        stopStream(chId); st.isPlaying = false;
        return ctx.replyWithHTML(`<blockquote>${t(l,'no_next')}</blockquote>`);
      }
      stopStream(chId);
      st.isPlaying = true; st.isPaused = false; st.startedAt = Date.now();
      await ctx.replyWithHTML(`<blockquote>${t(l,'skipped',next.title)}</blockquote>`);
      await playChannelTrack(ctx, chId, next, st);
    } catch (e) { await ctx.replyWithHTML(`<blockquote>❌ ${e.message}</blockquote>`); }
  }));

  // ──────────── /cprev @ch ──────────────────
  bot.command('cprev', safe(async (ctx) => {
    if (ctx.chat.type !== 'private') return ctx.replyWithHTML(`<blockquote>❌ Gunakan di private chat.</blockquote>`);
    const channel = ctx.message.text.split(/\s+/)[1];
    if (!channel) return ctx.replyWithHTML(`<blockquote>❓ Format: /cprev @channel</blockquote>`);
    try {
      const chId = await resolveChannel(ctx, channel);
      const l    = S.getLang(chId);
      const prev = queue.prev(chId);
      if (!prev) return ctx.replyWithHTML(`<blockquote>${t(l,'no_prev')}</blockquote>`);
      stopStream(chId);
      const st = queue.get(chId);
      st.isPlaying = true; st.isPaused = false; st.startedAt = Date.now();
      await ctx.replyWithHTML(`<blockquote>${t(l,'prev_track',prev.title)}</blockquote>`);
      await playChannelTrack(ctx, chId, prev, st);
    } catch (e) { await ctx.replyWithHTML(`<blockquote>❌ ${e.message}</blockquote>`); }
  }));

  // ──────────── /cqueue @ch [page] ──────────
  bot.command('cqueue', safe(async (ctx) => {
    if (ctx.chat.type !== 'private') return ctx.replyWithHTML(`<blockquote>❌ Gunakan di private chat.</blockquote>`);
    const parts   = ctx.message.text.split(/\s+/);
    const channel = parts[1];
    const page    = Math.max(0, (parseInt(parts[2]) || 1) - 1);
    if (!channel) return ctx.replyWithHTML(`<blockquote>❓ Format: /cqueue @channel [halaman]</blockquote>`);
    try {
      const chId  = await resolveChannel(ctx, channel);
      const l     = S.getLang(chId);
      const st    = queue.get(chId);
      const pages = Math.ceil(st.tracks.length / 10) || 1;
      await ctx.replyWithHTML(buildQueueText(st, page, l), buildQueueButtons(chId, page, pages, l));
    } catch (e) { await ctx.replyWithHTML(`<blockquote>❌ ${e.message}</blockquote>`); }
  }));

  // ──────────── /cvolume @ch <0-200> ────────
  bot.command('cvolume', safe(async (ctx) => {
    if (ctx.chat.type !== 'private') return ctx.replyWithHTML(`<blockquote>❌ Gunakan di private chat.</blockquote>`);
    const parts   = ctx.message.text.split(/\s+/);
    const channel = parts[1];
    const vol     = parseInt(parts[2]);
    if (!channel) return ctx.replyWithHTML(`<blockquote>❓ Format: /cvolume @channel 0-200</blockquote>`);
    if (isNaN(vol) || vol < 0 || vol > 200) return ctx.replyWithHTML(`<blockquote>❌ Volume harus 0-200.</blockquote>`);
    try {
      const chId = await resolveChannel(ctx, channel);
      const l    = S.getLang(chId);
      S.setVolume(chId, vol);
      queue.get(chId).volume = vol;
      await ctx.replyWithHTML(`<blockquote>${t(l,'volume_set',vol)}</blockquote>`);
    } catch (e) { await ctx.replyWithHTML(`<blockquote>❌ ${e.message}</blockquote>`); }
  }));

  // ──────────── /cloop @ch ──────────────────
  bot.command('cloop', safe(async (ctx) => {
    if (ctx.chat.type !== 'private') return ctx.replyWithHTML(`<blockquote>❌ Gunakan di private chat.</blockquote>`);
    const channel = ctx.message.text.split(/\s+/)[1];
    if (!channel) return ctx.replyWithHTML(`<blockquote>❓ Format: /cloop @channel</blockquote>`);
    try {
      const chId = await resolveChannel(ctx, channel);
      const l    = S.getLang(chId);
      const st   = queue.get(chId);
      if (!st.loop && !st.loopQueue)    { st.loop = true;  st.loopQueue = false; }
      else if (st.loop)                 { st.loop = false; st.loopQueue = true; }
      else                              { st.loop = false; st.loopQueue = false; }
      const mode = st.loop ? t(l,'loop_song') : st.loopQueue ? t(l,'loop_queue') : t(l,'loop_off');
      await ctx.replyWithHTML(`<blockquote>${mode}</blockquote>`);
    } catch (e) { await ctx.replyWithHTML(`<blockquote>❌ ${e.message}</blockquote>`); }
  }));

  // ──────────── /csettings @ch ──────────────
  bot.command('csettings', safe(async (ctx) => {
    if (ctx.chat.type !== 'private')
      return ctx.replyWithHTML(`<blockquote>❌ Gunakan di private chat.\n\nFormat: /csettings @channel</blockquote>`);

    const channel = ctx.message.text.split(/\s+/)[1];
    if (!channel) return ctx.replyWithHTML(
      `<blockquote>❓ <b>Cara pakai:</b>\n/csettings @channel\n/csettings -1001234567890\n\nContoh: /csettings @mychannel</blockquote>`
    );

    try {
      const chId = await resolveChannel(ctx, channel);

      // Check if user is admin of channel
      if (!await isChannelAdmin(ctx, chId)) {
        return ctx.replyWithHTML(`<blockquote>❌ Kamu bukan admin di channel ${channel}.</blockquote>`);
      }

      const s    = S.getSettings(chId);
      const aq   = S.AUDIO_QUALITY[s.audioQuality];
      const vq   = S.VIDEO_QUALITY[s.videoQuality];
      const ad   = s.autoDelete === 0 ? '❌ Off' : `✅ ${s.autoDelete}s`;
      const pm   = s.playMode === 'all' ? '👥 Semua' : s.playMode === 'admin' ? '👑 Admin' : '🎧 DJ';
      const al   = s.autoLeave ? `✅ ${s.autoLeaveTime}m` : '❌ Off';
      const lang = { id:'🇮🇩 ID', en:'🇬🇧 EN', ms:'🇲🇾 MS', ar:'🇸🇦 AR', tr:'🇹🇷 TR' }[s.lang] || s.lang;

      const text = `<blockquote>⚙️ <b>Settings Channel</b>
📺 ${channel} (<code>${chId}</code>)
━━━━━━━━━━━━━━━━━━━━

🔈 Kualitas Audio  : ${aq.label}
📹 Kualitas Video  : ${vq.label}
🔊 Volume Default  : ${s.volume}%
⏱ Auto-Leave      : ${al}
🌐 Bahasa          : ${lang}
━━━━━━━━━━━━━━━━━━━━</blockquote>`;

      await ctx.replyWithHTML(text, Markup.inlineKeyboard([
        [
          Markup.button.callback('🔈 Audio Quality', `ch_set_audio_${chId}`),
          Markup.button.callback('📹 Video Quality', `ch_set_video_${chId}`),
        ],
        [
          Markup.button.callback('🔊 Volume', `ch_set_vol_${chId}`),
          Markup.button.callback('⏱ Auto-Leave', `ch_set_al_${chId}`),
        ],
        [
          Markup.button.callback('🌐 Bahasa', `ch_set_lang_${chId}`),
          Markup.button.callback('🔄 Reset', `ch_set_reset_${chId}`),
        ],
        [Markup.button.callback('❌ Tutup', `ch_set_close_${chId}`)],
      ]));
    } catch (e) {
      await ctx.replyWithHTML(`<blockquote>❌ ${e.message}</blockquote>`);
    }
  }));

  // ──────────── Channel settings callbacks ──

  // Audio quality
  bot.action(/^ch_set_audio_(-?\d+)$/, async (ctx) => {
    const chId = parseInt(ctx.match[1]);
    const cur  = S.getAudioQuality(chId);
    await ctx.answerCbQuery();
    await ctx.editMessageText(
      `<blockquote>🔈 <b>Kualitas Audio Channel</b>\nSaat ini: ${S.AUDIO_QUALITY[cur].label}</blockquote>`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback(cur==='low'   ?'✅ 🔈 Low (64kbps)'   :'🔈 Low (64kbps)',    `ch_aq_low_${chId}`)],
          [Markup.button.callback(cur==='medium'?'✅ 🔉 Medium (128kbps)':'🔉 Medium (128kbps)',`ch_aq_medium_${chId}`)],
          [Markup.button.callback(cur==='high'  ?'✅ 🔊 High (320kbps)' :'🔊 High (320kbps)',  `ch_aq_high_${chId}`)],
          [Markup.button.callback('◀️ Kembali', `ch_settings_${chId}`)],
        ]),
      }
    );
  });

  for (const q of ['low','medium','high']) {
    bot.action(new RegExp(`^ch_aq_${q}_(-?\\d+)$`), async (ctx) => {
      const chId = parseInt(ctx.match[1]);
      S.setAudioQuality(chId, q);
      await ctx.answerCbQuery(`✅ ${S.AUDIO_QUALITY[q].label}`);
      await ctx.editMessageText(
        `<blockquote>✅ Kualitas audio channel diatur ke: <b>${S.AUDIO_QUALITY[q].label}</b></blockquote>`,
        { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('◀️ Kembali ke Settings', `ch_settings_${chId}`)]]) }
      );
    });
  }

  // Video quality
  bot.action(/^ch_set_video_(-?\d+)$/, async (ctx) => {
    const chId = parseInt(ctx.match[1]);
    const cur  = S.getVideoQuality(chId);
    await ctx.answerCbQuery();
    await ctx.editMessageText(
      `<blockquote>📹 <b>Kualitas Video Channel</b>\nSaat ini: ${S.VIDEO_QUALITY[cur].label}</blockquote>`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback(cur==='low'   ?'✅ 📱 Low (360p)'   :'📱 Low (360p)',    `ch_vq_low_${chId}`)],
          [Markup.button.callback(cur==='medium'?'✅ 💻 Medium (480p)':'💻 Medium (480p)', `ch_vq_medium_${chId}`)],
          [Markup.button.callback(cur==='high'  ?'✅ 🖥 High (720p)'  :'🖥 High (720p)',   `ch_vq_high_${chId}`)],
          [Markup.button.callback('◀️ Kembali', `ch_settings_${chId}`)],
        ]),
      }
    );
  });

  for (const q of ['low','medium','high']) {
    bot.action(new RegExp(`^ch_vq_${q}_(-?\\d+)$`), async (ctx) => {
      const chId = parseInt(ctx.match[1]);
      S.setVideoQuality(chId, q);
      await ctx.answerCbQuery(`✅ ${S.VIDEO_QUALITY[q].label}`);
      await ctx.editMessageText(
        `<blockquote>✅ Kualitas video channel diatur ke: <b>${S.VIDEO_QUALITY[q].label}</b></blockquote>`,
        { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('◀️ Kembali', `ch_settings_${chId}`)]]) }
      );
    });
  }

  // Volume setting
  bot.action(/^ch_set_vol_(-?\d+)$/, async (ctx) => {
    const chId = parseInt(ctx.match[1]);
    const vol  = S.getVolume(chId);
    await ctx.answerCbQuery();
    await ctx.editMessageText(
      `<blockquote>🔊 <b>Volume Channel</b>\nSaat ini: <b>${vol}%</b></blockquote>`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback('🔉 -10', `ch_vol_dn_${chId}`),
            Markup.button.callback(`${vol}%`, `ch_vol_noop_${chId}`),
            Markup.button.callback('🔊 +10', `ch_vol_up_${chId}`),
          ],
          [[50,75,100,150,200].map(v => Markup.button.callback(vol===v?`✅ ${v}%`:`${v}%`, `ch_vol_set_${v}_${chId}`))],
          [Markup.button.callback('◀️ Kembali', `ch_settings_${chId}`)],
        ]),
      }
    );
  });

  bot.action(/^ch_vol_(up|dn)_(-?\d+)$/, async (ctx) => {
    const dir  = ctx.match[1];
    const chId = parseInt(ctx.match[2]);
    const cur  = S.getVolume(chId);
    const vol  = Math.max(0, Math.min(200, cur + (dir==='up'?10:-10)));
    S.setVolume(chId, vol);
    await ctx.answerCbQuery(`🔊 ${vol}%`);
    await ctx.editMessageText(
      `<blockquote>🔊 <b>Volume Channel</b>\nSaat ini: <b>${vol}%</b></blockquote>`,
      { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('◀️ Kembali', `ch_settings_${chId}`)]]) }
    );
  });

  bot.action(/^ch_vol_set_(\d+)_(-?\d+)$/, async (ctx) => {
    const vol  = parseInt(ctx.match[1]);
    const chId = parseInt(ctx.match[2]);
    S.setVolume(chId, vol);
    await ctx.answerCbQuery(`✅ Volume ${vol}%`);
    await ctx.editMessageText(
      `<blockquote>✅ Volume channel diatur ke: <b>${vol}%</b></blockquote>`,
      { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('◀️ Kembali', `ch_settings_${chId}`)]]) }
    );
  });
  bot.action(/^ch_vol_noop_/, ctx => ctx.answerCbQuery());

  // Lang setting
  bot.action(/^ch_set_lang_(-?\d+)$/, async (ctx) => {
    const chId = parseInt(ctx.match[1]);
    const cur  = S.getLang(chId);
    const langs = [['id','🇮🇩 Indonesia'],['en','🇬🇧 English'],['ms','🇲🇾 Melayu'],['ar','🇸🇦 العربية'],['tr','🇹🇷 Türkçe']];
    await ctx.answerCbQuery();
    await ctx.editMessageText(
      `<blockquote>🌐 <b>Bahasa Channel</b></blockquote>`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          ...langs.map(([code, label]) => [
            Markup.button.callback(cur===code?`✅ ${label}`:label, `ch_lang_${code}_${chId}`)
          ]),
          [Markup.button.callback('◀️ Kembali', `ch_settings_${chId}`)],
        ]),
      }
    );
  });

  bot.action(/^ch_lang_([a-z]+)_(-?\d+)$/, async (ctx) => {
    const code = ctx.match[1];
    const chId = parseInt(ctx.match[2]);
    S.setLang(chId, code);
    const names = { id:'🇮🇩 Indonesia', en:'🇬🇧 English', ms:'🇲🇾 Melayu', ar:'🇸🇦 العربية', tr:'🇹🇷 Türkçe' };
    await ctx.answerCbQuery(`✅ ${names[code]}`);
    await ctx.editMessageText(
      `<blockquote>✅ Bahasa channel diatur ke: <b>${names[code]}</b></blockquote>`,
      { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('◀️ Kembali', `ch_settings_${chId}`)]]) }
    );
  });

  // Auto-leave
  bot.action(/^ch_set_al_(-?\d+)$/, async (ctx) => {
    const chId = parseInt(ctx.match[1]);
    const s    = S.getSettings(chId);
    await ctx.answerCbQuery();
    await ctx.editMessageText(
      `<blockquote>⏱ <b>Auto-Leave Channel</b>\nStatus: ${s.autoLeave ? `✅ ${s.autoLeaveTime} menit` : '❌ Off'}</blockquote>`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback(s.autoLeave ?'✅ ON':'ON',   `ch_al_on_${chId}`),
            Markup.button.callback(!s.autoLeave?'✅ OFF':'OFF', `ch_al_off_${chId}`),
          ],
          [[5,10,15,30,60].map(m => Markup.button.callback(s.autoLeaveTime===m?`✅ ${m}m`:`${m}m`, `ch_alt_${m}_${chId}`))],
          [Markup.button.callback('◀️ Kembali', `ch_settings_${chId}`)],
        ]),
      }
    );
  });

  bot.action(/^ch_al_(on|off)_(-?\d+)$/, async (ctx) => {
    const on   = ctx.match[1] === 'on';
    const chId = parseInt(ctx.match[2]);
    S.setAutoLeave(chId, on);
    await ctx.answerCbQuery(on ? '✅ Auto-leave ON' : '❌ Auto-leave OFF');
    await ctx.editMessageText(
      `<blockquote>✅ Auto-leave: <b>${on ? 'Aktif' : 'Nonaktif'}</b></blockquote>`,
      { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('◀️ Kembali', `ch_settings_${chId}`)]]) }
    );
  });

  bot.action(/^ch_alt_(\d+)_(-?\d+)$/, async (ctx) => {
    const mins = parseInt(ctx.match[1]);
    const chId = parseInt(ctx.match[2]);
    S.setAutoLeaveTime(chId, mins);
    await ctx.answerCbQuery(`✅ ${mins} menit`);
    await ctx.editMessageText(
      `<blockquote>✅ Auto-leave diatur ke: <b>${mins} menit</b></blockquote>`,
      { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('◀️ Kembali', `ch_settings_${chId}`)]]) }
    );
  });

  // Reset
  bot.action(/^ch_set_reset_(-?\d+)$/, async (ctx) => {
    const chId = parseInt(ctx.match[1]);
    Object.assign(S.getSettings(chId), S.DEFAULTS);
    S.updateSetting(chId, '__reset', Date.now());
    await ctx.answerCbQuery('✅ Reset ke default');
    await ctx.editMessageText(
      `<blockquote>✅ Settings channel direset ke default.</blockquote>`,
      { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('◀️ Kembali', `ch_settings_${chId}`)]]) }
    );
  });

  // Close settings
  bot.action(/^ch_set_close_(-?\d+)$/, async (ctx) => {
    await ctx.answerCbQuery('✅ Ditutup');
    await ctx.deleteMessage().catch(() => {});
  });

  // ── Re-open settings from player button ──
  bot.action(/^ch_settings_(-?\d+)$/, async (ctx) => {
    const chId = parseInt(ctx.match[1]);
    if (!await isChannelAdmin(ctx, chId)) return ctx.answerCbQuery('❌ Bukan admin channel', { show_alert: true });
    await ctx.answerCbQuery();
    const s    = S.getSettings(chId);
    const aq   = S.AUDIO_QUALITY[s.audioQuality];
    const vq   = S.VIDEO_QUALITY[s.videoQuality];
    const lang = { id:'🇮🇩 ID', en:'🇬🇧 EN', ms:'🇲🇾 MS', ar:'🇸🇦 AR', tr:'🇹🇷 TR' }[s.lang] || s.lang;
    await ctx.editMessageText(
      `<blockquote>⚙️ <b>Settings Channel</b> <code>${chId}</code>
━━━━━━━━━━━━━━━━━━━━
🔈 Audio  : ${aq.label}
📹 Video  : ${vq.label}
🔊 Volume : ${s.volume}%
⏱ Leave  : ${s.autoLeave ? s.autoLeaveTime+'m' : 'Off'}
🌐 Lang   : ${lang}
━━━━━━━━━━━━━━━━━━━━</blockquote>`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('🔈 Audio', `ch_set_audio_${chId}`), Markup.button.callback('📹 Video', `ch_set_video_${chId}`)],
          [Markup.button.callback('🔊 Volume', `ch_set_vol_${chId}`),  Markup.button.callback('⏱ Auto-Leave', `ch_set_al_${chId}`)],
          [Markup.button.callback('🌐 Bahasa', `ch_set_lang_${chId}`), Markup.button.callback('🔄 Reset', `ch_set_reset_${chId}`)],
          [Markup.button.callback('❌ Tutup', `ch_set_close_${chId}`)],
        ]),
      }
    );
  });

  // ── Player control callbacks ──
  bot.action(/^ch_pause_(-?\d+)$/, async (ctx) => {
    const chId = parseInt(ctx.match[1]);
    const st   = queue.get(chId);
    const l    = S.getLang(chId);
    if (!st.isPlaying) return ctx.answerCbQuery(t(l,'no_playing'), { show_alert:true });
    if (st.isPaused) { await resumeStream(chId); st.isPaused = false; cancelLeaveTimer(chId); await ctx.answerCbQuery('▶️'); }
    else             { await pauseStream(chId);  st.isPaused = true;  await ctx.answerCbQuery('⏸'); }
    const track = queue.current(chId);
    if (track) await updatePlayer(ctx.telegram, ctx.chat.id, ctx.callbackQuery.message.message_id, st.isPhoto, track, st, getElapsed(chId), l);
  });

  bot.action(/^ch_skip_(-?\d+)$/, async (ctx) => {
    const chId = parseInt(ctx.match[1]);
    const st   = queue.get(chId);
    const l    = S.getLang(chId);
    const next = queue.next(chId);
    if (!next) { stopStream(chId); st.isPlaying = false; return ctx.answerCbQuery(t(l,'no_next')); }
    stopStream(chId);
    await ctx.answerCbQuery(`⏭ ${next.title.slice(0,20)}`);
    st.isPlaying=true; st.isPaused=false; st.startedAt=Date.now();
    await playChannelTrack(ctx, chId, next, st).catch(console.error);
  });

  bot.action(/^ch_prev_(-?\d+)$/, async (ctx) => {
    const chId = parseInt(ctx.match[1]);
    const st   = queue.get(chId);
    const prev = queue.prev(chId);
    const l    = S.getLang(chId);
    if (!prev) return ctx.answerCbQuery(t(l,'no_prev'), { show_alert:true });
    stopStream(chId);
    await ctx.answerCbQuery(`⏮ ${prev.title.slice(0,20)}`);
    st.isPlaying=true; st.isPaused=false; st.startedAt=Date.now();
    await playChannelTrack(ctx, chId, prev, st).catch(console.error);
  });

  bot.action(/^ch_stop_(-?\d+)$/, async (ctx) => {
    const chId = parseInt(ctx.match[1]);
    const l    = S.getLang(chId);
    stopStream(chId); queue.clear(chId);
    startLeaveTimer(chId, async (id) => { await userbotLeaveGroup(id); queue.delete(id); });
    await ctx.answerCbQuery('⏹');
    await ctx.editMessageText(`<blockquote>${t(l,'stopped')}</blockquote>`, { parse_mode:'HTML' });
  });

  bot.action(/^ch_shuffle_(-?\d+)$/, async (ctx) => {
    const chId = parseInt(ctx.match[1]);
    const l    = S.getLang(chId);
    queue.shuffle(chId);
    await ctx.answerCbQuery('🔀');
  });

  bot.action(/^ch_loop_(-?\d+)$/, async (ctx) => {
    const chId = parseInt(ctx.match[1]);
    const st   = queue.get(chId);
    const l    = S.getLang(chId);
    if (!st.loop && !st.loopQueue) { st.loop = true; st.loopQueue = false; }
    else if (st.loop)              { st.loop = false; st.loopQueue = true; }
    else                           { st.loop = false; st.loopQueue = false; }
    const mode = st.loop ? '🔂' : st.loopQueue ? '🔁 Q' : '🔁 Off';
    await ctx.answerCbQuery(mode);
    const track = queue.current(chId);
    if (track) await updatePlayer(ctx.telegram, ctx.chat.id, ctx.callbackQuery.message.message_id, st.isPhoto, track, st, getElapsed(chId), l);
  });

  bot.action(/^ch_volup_(-?\d+)$/, async (ctx) => {
    const chId = parseInt(ctx.match[1]);
    const vol  = Math.min(S.getVolume(chId) + 10, 200);
    S.setVolume(chId, vol); queue.get(chId).volume = vol;
    await ctx.answerCbQuery(`🔊 ${vol}%`);
  });

  bot.action(/^ch_voldn_(-?\d+)$/, async (ctx) => {
    const chId = parseInt(ctx.match[1]);
    const vol  = Math.max(S.getVolume(chId) - 10, 0);
    S.setVolume(chId, vol); queue.get(chId).volume = vol;
    await ctx.answerCbQuery(`🔉 ${vol}%`);
  });

  bot.action(/^ch_vstop_(-?\d+)$/, async (ctx) => {
    const chId = parseInt(ctx.match[1]);
    const { videoSessions } = require('./videoplay');
    const sess = videoSessions?.get(String(chId));
    if (sess) { try { sess.ntg?.stop(Number(chId)); } catch {} videoSessions.delete(String(chId)); }
    queue.get(chId).isPlaying = false;
    await ctx.answerCbQuery('⏹ Video dihentikan');
    await ctx.editMessageText(`<blockquote>⏹ <b>Video channel dihentikan.</b></blockquote>`, { parse_mode:'HTML' });
  });

  // Search pick callbacks
  bot.action(/^ch_pick_(\d+)_(-?\d+)_(\d+)$/, async (ctx) => {
    const userId = parseInt(ctx.match[1]);
    const chId   = parseInt(ctx.match[2]);
    const idx    = parseInt(ctx.match[3]);
    if (ctx.from.id !== userId) return ctx.answerCbQuery('❌ Bukan milikmu', { show_alert: true });
    const cache  = chSearchCache.get(`${userId}_${chId}`);
    if (!cache?.results?.[idx]) return ctx.answerCbQuery('❌');
    const track  = cache.results[idx];
    await ctx.answerCbQuery(`🎵 ${track.title.slice(0,25)}`);
    await ctx.deleteMessage().catch(() => {});
    const check = await preCheckChannel(ctx, chId);
    if (!check.ok) return ctx.replyWithHTML(`<blockquote>${check.reason}</blockquote>`);
    track.requestedBy = userId;
    queue.add(chId, track);
    const st = queue.get(chId);
    if (st.isPlaying) {
      return ctx.replyWithHTML(`<blockquote>✅ <b>Ditambahkan ke antrian!</b>\n\n🎵 ${track.title}\n📋 Posisi: #${st.tracks.length}</blockquote>`);
    }
    st.currentIndex = st.tracks.length - 1;
    await playChannelTrack(ctx, chId, track, st).catch(console.error);
  });

  bot.action(/^ch_vpick_(\d+)_(-?\d+)_(\d+)$/, async (ctx) => {
    const userId = parseInt(ctx.match[1]);
    const chId   = parseInt(ctx.match[2]);
    const idx    = parseInt(ctx.match[3]);
    if (ctx.from.id !== userId) return ctx.answerCbQuery('❌', { show_alert: true });
    const cache  = chSearchCache.get(`${userId}_${chId}_v`);
    if (!cache?.results?.[idx]) return ctx.answerCbQuery('❌');
    const track  = cache.results[idx];
    await ctx.answerCbQuery(`📹 ${track.title.slice(0,25)}`);
    await ctx.deleteMessage().catch(() => {});
    const check = await preCheckChannel(ctx, chId);
    if (!check.ok) return ctx.replyWithHTML(`<blockquote>${check.reason}</blockquote>`);
    const quality   = S.getVideoQuality(chId);
    const volume    = S.getVolume(chId);
    const client    = getMusicClient(chId);
    const streamUrl = await getStreamUrl(track.url);
    const loadMsg   = await ctx.replyWithHTML(`<blockquote>📹 Memulai stream video...</blockquote>`);
    try {
      const { startStream: startSt } = require('./streamer');
      await startSt(client, chId, streamUrl, { onFinish: async () => { queue.get(chId).isPlaying = false; } }, volume, track.videoId);
      queue.get(chId).isPlaying = true;
      await ctx.telegram.editMessageText(ctx.chat.id, loadMsg.message_id, null,
        `<blockquote>📹 <b>Stream Video Channel</b>\n🎬 ${track.title}\n📺 ${VIDEO_QUALITY[quality].label} • 🔊 ${volume}%</blockquote>`,
        { parse_mode:'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('⏹ Stop', `ch_vstop_${chId}`)]]) }
      );
    } catch (e) {
      await ctx.telegram.editMessageText(ctx.chat.id, loadMsg.message_id, null,
        `<blockquote>❌ ${e.message}</blockquote>`, { parse_mode:'HTML' }
      ).catch(() => {});
    }
  });

  bot.action(/^ch_cancel_search_(\d+)$/, async (ctx) => {
    if (ctx.from.id !== parseInt(ctx.match[1])) return ctx.answerCbQuery('❌');
    await ctx.answerCbQuery('❌ Dibatalkan');
    await ctx.deleteMessage().catch(() => {});
  });

  // Queue pagination for channel
  bot.action(/^music_queue_(-?\d+)_(\d+)$/, async (ctx) => {
    const chId  = parseInt(ctx.match[1]);
    const page  = parseInt(ctx.match[2]);
    const st    = queue.get(chId);
    const l     = S.getLang(chId);
    const pages = Math.ceil(st.tracks.length / 10) || 1;
    await ctx.answerCbQuery();
    await ctx.editMessageText(buildQueueText(st, page, l), { parse_mode:'HTML', ...buildQueueButtons(chId, page, pages, l) });
  });
};
