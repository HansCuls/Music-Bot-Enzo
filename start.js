// ==========================================
// FILE: start.js
// Handler /start command
// ==========================================

const { Markup } = require('telegraf');
const { t }      = require('./music/i18n');
const { getLang, setLang } = require('./music/settings');

module.exports = (bot) => {

  // /start
  bot.command('start', async (ctx) => {
    const lang    = getLang(ctx.chat.id);
    const botName = ctx.botInfo?.first_name || 'Music Bot';

    const text = t(lang, 'start_text', botName);

    const buttons = Markup.inlineKeyboard([
      [
        Markup.button.callback('🇮🇩 Indonesia', 'setlang_id'),
        Markup.button.callback('🇬🇧 English',   'setlang_en'),
      ],
      [
        Markup.button.callback('🇲🇾 Melayu',    'setlang_ms'),
        Markup.button.callback('🇸🇦 العربية',   'setlang_ar'),
        Markup.button.callback('🇹🇷 Türkçe',    'setlang_tr'),
      ],
      [
        Markup.button.url('➕ Tambah ke Grup', `https://t.me/${ctx.botInfo?.username}?startgroup=true`),
      ],
      [
        Markup.button.callback('❓ Bantuan / Help', 'help_menu'),
      ],
    ]);

    await ctx.replyWithHTML(`<blockquote>${text}</blockquote>`, buttons);
  });

  // Callback: pilih bahasa dari tombol /start
  bot.action(/^setlang_(id|en|ms|ar|tr)$/, async (ctx) => {
    const code     = ctx.match[1];
    const chatId   = ctx.chat.id;
    const langNames = {
      id: '🇮🇩 Bahasa Indonesia',
      en: '🇬🇧 English',
      ms: '🇲🇾 Bahasa Melayu',
      ar: '🇸🇦 العربية',
      tr: '🇹🇷 Türkçe',
    };
    setLang(chatId, code);
    await ctx.answerCbQuery(`✅ ${langNames[code]}`);

    // Refresh pesan /start dalam bahasa baru
    const botName = ctx.botInfo?.first_name || 'Music Bot';
    const text    = t(code, 'start_text', botName);

    const buttons = Markup.inlineKeyboard([
      [
        Markup.button.callback('🇮🇩 Indonesia', 'setlang_id'),
        Markup.button.callback('🇬🇧 English',   'setlang_en'),
      ],
      [
        Markup.button.callback('🇲🇾 Melayu',    'setlang_ms'),
        Markup.button.callback('🇸🇦 العربية',   'setlang_ar'),
        Markup.button.callback('🇹🇷 Türkçe',    'setlang_tr'),
      ],
      [
        Markup.button.url('➕ Tambah ke Grup', `https://t.me/${ctx.botInfo?.username}?startgroup=true`),
      ],
      [
        Markup.button.callback('❓ Bantuan / Help', 'help_menu'),
      ],
    ]);

    await ctx.editMessageText(`<blockquote>${text}</blockquote>`, {
      parse_mode: 'HTML', ...buttons,
    });
  });

  // Callback: tombol bantuan
  bot.action('help_menu', async (ctx) => {
    const lang = getLang(ctx.chat.id);
    await ctx.answerCbQuery();
    await ctx.replyWithHTML(t(lang, 'help_text'));
  });
};
