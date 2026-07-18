/* =========================================================================
   快速背單字  app.js
   - 純前端，資料存在 localStorage
   - 呼叫 Gemini API 把歐路詞典內容整理成結構化 JSON
   - Anki 風格的間隔重複（SRS）背誦
   ========================================================================= */

'use strict';

/* ---------------------- 常數 ---------------------- */
const LS_CARDS = 'vocab_cards_v1';
const LS_SETTINGS = 'vocab_settings_v1';
const LS_THEME = 'vocab_theme_v1';
const LS_FOLDERS = 'vocab_folders_v1';
const LS_DAILY = 'vocab_daily_v1';
const LS_DAILY_HIST = 'vocab_daily_hist_v1'; // { 'YYYY-MM-DD': 翻閱張數 }
const LS_LANG = 'vocab_lang_v1';
const LS_READER = 'vocab_reader_v1'; // 閱讀書架（每語言、每使用者分開）
const LS_LISTEN = 'vocab_listen_v1'; // 聽力清單（每語言、每使用者分開）

// 計入每日目標的模式（中英、克漏字為主）
const DAILY_MODES = ['en2zh', 'zh2en', 'spelling'];
const NO_FOLDER = '__none__';

/* ---------------------- 多語言（各語言資料完全分開） ---------------------- */
const LS_CUSTOM_LANGS = 'vocab_custom_langs_v1';
// 由簡短規格產生一個語言設定
function makeLang(code, label, name, speech, dictLang) {
  return {
    code, label, name, teacher: `${name}單字整理老師`,
    collection: code === 'en' ? 'cards' : `cards_${code}`,
    dictLang: dictLang || (speech ? speech.split('-')[0] : code),
    speech: { us: speech, uk: speech, def: speech },
    fwd: `${label} → 中`, bwd: `中 → ${label}`,
    fwdDesc: `看${name}單字，回想中文意思`, bwdDesc: `看中文意思，回想${name}單字`,
    askMeaning: '這個字的意思是？', askWord: `對應的${name}單字是？`,
    custom: false,
  };
}
const BUILTIN_LANGS = {
  en: makeLang('en', '英', '英文', 'en-US', 'en'),
  de: makeLang('de', '德', '德文', 'de-DE', 'de'),
  ja: makeLang('ja', '日', '日文', 'ja-JP', 'ja'),
  fr: makeLang('fr', '法', '法文', 'fr-FR', 'fr'),
  ko: makeLang('ko', '韓', '韓文', 'ko-KR', 'ko'),
  es: makeLang('es', '西', '西班牙文', 'es-ES', 'es'),
  nl: makeLang('nl', '荷', '荷蘭文', 'nl-NL', 'nl'),
  ru: makeLang('ru', '俄', '俄文', 'ru-RU', 'ru'),
  // 越南文（vi）暫時隱藏
};
// 英文標題單字保留美式/英式之分
BUILTIN_LANGS.en.speech = { us: 'en-US', uk: 'en-GB', def: 'en-US' };

let customLangs = {}; // { code: langConfig }（使用者自訂，存 localStorage）
function loadCustomLangs() {
  const raw = loadJSON(LS_CUSTOM_LANGS, {});
  customLangs = {};
  Object.keys(raw || {}).forEach(code => {
    const c = raw[code];
    if (c && c.name) { const l = makeLang(code, c.label || c.name.slice(0, 1), c.name, c.speech || '', c.dictLang || ''); l.custom = true; customLangs[code] = l; }
  });
}
function saveCustomLangs() {
  const out = {};
  Object.values(customLangs).forEach(l => { out[l.code] = { label: l.label, name: l.name, speech: l.speech.def, dictLang: l.dictLang }; });
  localStorage.setItem(LS_CUSTOM_LANGS, JSON.stringify(out));
}
function allLangs() { return { ...BUILTIN_LANGS, ...customLangs }; }

let currentLang = localStorage.getItem(LS_LANG) || 'en';
let currentUid = null; // 目前登入者 uid（每位使用者資料分開）
function L() { return allLangs()[currentLang] || BUILTIN_LANGS.en; }
// 依語言＋使用者取得 localStorage key（各語言、各使用者資料互不干擾）
function nsKey(base) {
  const lang = currentLang === 'en' ? base : `${base}_${currentLang}`;
  return currentUid ? `${lang}__u_${currentUid}` : lang;
}
// 依語言調整背誦模式的顯示名稱
function applyLangToModes() {
  const l = L();
  STUDY_MODES.forEach(m => {
    if (m.id === 'en2zh') { m.name = l.fwd; m.desc = l.fwdDesc; }
    if (m.id === 'zh2en') { m.name = l.bwd; m.desc = l.bwdDesc; }
  });
}

// 背誦模式定義：id、名稱、說明、判斷該卡是否有此模式內容
const STUDY_MODES = [
  { id: 'en2zh', name: '英 → 中', desc: '看英文單字，回想中文意思', has: d => (d.definitions || []).length > 0 },
  { id: 'zh2en', name: '中 → 英', desc: '看中文意思，回想英文單字', has: d => (d.definitions || []).length > 0 },
  { id: 'collocation', name: '搭配詞', desc: '回想常見搭配詞', has: d => (d.collocations || []).length > 0 },
  { id: 'context', name: '情境詞', desc: '回想常一起出現的前後文單詞', has: d => (d.context_words || []).length > 0 },
  { id: 'synonym', name: '同義詞', desc: '回想同義／近義詞', has: d => (d.synonyms || []).length > 0 },
  { id: 'phrase', name: '片語', desc: '回想相關片語與慣用語', has: d => (d.phrases || []).length > 0 },
  { id: 'forms', name: '詞形變化', desc: '回想單複數/三態/詞性變換', has: d => (d.word_forms || []).length > 0 || (d.derivatives || []).length > 0 },
  { id: 'spelling', name: '拼字（克漏字）', desc: '聽發音＋看例句填空，拼出單字', has: d => !!d.word },
];

// 基礎模式：其他模式要先熟悉這兩個之一才會解鎖
const BASIC_MODES = ['en2zh', 'zh2en'];
// 這張卡是否已在某個基礎模式熟悉（成功複習過至少一次，未在最近一次按「重來」）
function cardBasicLearned(card) {
  return BASIC_MODES.some(id => (card.srs[id]?.reps || 0) >= 1);
}
// 該模式對這張卡是否已解鎖
function modeUnlocked(card, modeId) {
  if (BASIC_MODES.includes(modeId)) return true;
  return cardBasicLearned(card);
}
// 這個字是否「還沒遇到」（基礎模式都沒學過）
function cardNeverStudied(card) {
  return BASIC_MODES.every(id => isNew(card.srs[id] || {}));
}
// 這個字今天是否有「已解鎖且到期」的複習項目（且已開始學過）
function cardHasDueToday(card) {
  if (cardNeverStudied(card)) return false;
  return STUDY_MODES.some(m => m.has(card.data) && modeUnlocked(card, m.id) && isDue(card.srs[m.id]));
}

// 金鑰不寫死在會被公開的程式碼裡。
// 本機開發時可放在 config.local.js（已被 .gitignore 忽略）：window.DEFAULT_KEYS = [...]
// 部署後（如 Vercel）請到「設定」頁輸入金鑰，會存在該裝置的瀏覽器。
const DEFAULT_KEYS = (typeof window !== 'undefined' && Array.isArray(window.DEFAULT_KEYS)) ? window.DEFAULT_KEYS : [];
const DEFAULT_SETTINGS = {
  apiKeys: DEFAULT_KEYS.slice(),
  model: 'gemini-3-flash-preview',
  accent: 'us', // us | uk
  dailyGoal: 20,
  listenBackend: 'https://whisper-api-1016448029865.asia-east1.run.app/api', // 雲端轉錄後端（Cloud Run + Replicate）
};

let keyIndex = 0;          // 金鑰輪詢游標

// 環境變數金鑰（部署時由 Vercel Serverless /api/keys 提供）；設定頁手動輸入者優先
let envKeys = [];
function activeKeys() {
  const s = (settings.apiKeys || []).filter(Boolean);
  return s.length ? s : envKeys.filter(Boolean);
}
async function loadEnvKeys() {
  try {
    const res = await fetch('/api/keys', { cache: 'no-store' });
    if (!res.ok) return;
    const data = await res.json();
    if (Array.isArray(data.keys)) envKeys = data.keys.filter(Boolean);
  } catch { /* 本機或未部署時忽略 */ }
}

/* ---------------------- 狀態 ---------------------- */
let cards = [];        // 全部卡片
let settings = { ...DEFAULT_SETTINGS };
let pendingCard = null; // 尚未存檔的整理結果
let folders = [];      // 自訂資料夾名稱
let daily = null;      // { date, count, streak, lastMetDate }
let deckFolder = '';   // 詞庫篩選：'' 全部、NO_FOLDER 未分類、否則資料夾名
let deckSort = 'created_desc';
let starOnly = false;  // 詞庫是否只顯示加星號的單字
let selectMode = false;          // 詞庫批次選取模式
let lastFilteredIds = [];        // 目前畫面上顯示的卡片 id（供全選使用）
const selectedIds = new Set();   // 已勾選的卡片 id

/* ---------------------- 工具 ---------------------- */
const $ = sel => document.querySelector(sel);
const $$ = sel => Array.from(document.querySelectorAll(sel));
const now = () => Date.now();
const DAY = 86400000;

function uid() {
  return 'c_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function dateStr(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function todayStr() { return dateStr(); }
function yesterdayStr() { const d = new Date(); d.setDate(d.getDate() - 1); return dateStr(d); }

// 詞庫中是否已有這個字（不分大小寫、去頭尾空白）
function findExistingCard(word) {
  const w = (word || '').trim().toLowerCase();
  return cards.find(c => (c.data.word || '').trim().toLowerCase() === w);
}

function loadJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch { return fallback; }
}
function saveCards() { localStorage.setItem(nsKey(LS_CARDS), JSON.stringify(cards)); }
function saveSettings() { localStorage.setItem(LS_SETTINGS, JSON.stringify(settings)); }
function saveFolders() { localStorage.setItem(nsKey(LS_FOLDERS), JSON.stringify(folders)); }
function saveDaily() { localStorage.setItem(nsKey(LS_DAILY), JSON.stringify(daily)); }
// 每翻閱一張卡就在當日 +1（供 GitHub 風格熱力圖使用）
function bumpHistory() {
  const hist = loadJSON(nsKey(LS_DAILY_HIST), {});
  const k = todayStr();
  hist[k] = (hist[k] || 0) + 1;
  localStorage.setItem(nsKey(LS_DAILY_HIST), JSON.stringify(hist));
  saveHistoryToCloud();
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---- 朗讀 ----
// (1) 瀏覽器語音（Web Speech API）
function speak(text, lang) {
  lang = lang || (settings.accent === 'uk' ? L().speech.uk : L().speech.us) || L().speech.def;
  if (!text || !window.speechSynthesis) { toast('這個瀏覽器不支援朗讀', true); return; }
  try {
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = lang;
    u.rate = ($('#view-reader') && $('#view-reader').classList.contains('active')) ? getReaderSpeed() : 0.95;
    const voices = window.speechSynthesis.getVoices();
    const same = voices.filter(x => x.lang && x.lang.toLowerCase().startsWith(lang.slice(0, 2).toLowerCase()));
    const best = same.find(x => x.lang.toLowerCase() === lang.toLowerCase() && /google|microsoft|natural/i.test(x.name))
      || same.find(x => x.lang.toLowerCase() === lang.toLowerCase())
      || same[0];
    if (best) u.voice = best;
    window.speechSynthesis.speak(u);
  } catch (e) { console.error(e); }
}

// (2) 真人錄音字典發音（dictionaryapi.dev），可指定美式/英式
const wordAudioCache = new Map(); // word -> {us,uk,any} 或 null
async function fetchWordAudio(word) {
  const key = word.trim().toLowerCase();
  if (wordAudioCache.has(key)) return wordAudioCache.get(key);
  let entry = null;
  try {
    const res = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/${L().dictLang}/${encodeURIComponent(key)}`);
    if (res.ok) {
      const data = await res.json();
      const found = { us: '', uk: '', any: '' };
      (data || []).forEach(en => (en.phonetics || []).forEach(p => {
        if (!p.audio) return;
        if (!found.any) found.any = p.audio;
        const u = p.audio.toLowerCase();
        if (u.includes('-us.') && !found.us) found.us = p.audio;
        if (u.includes('-uk.') && !found.uk) found.uk = p.audio;
      }));
      if (found.any) entry = found;
    }
  } catch (e) { /* 忽略 */ }
  wordAudioCache.set(key, entry);
  return entry;
}
async function speakWordAccent(word, accent) {
  const w = (word || '').trim();
  if (!w) return;
  const entry = await fetchWordAudio(w);
  const spLang = (accent === 'uk' ? L().speech.uk : L().speech.us) || L().speech.def;
  if (entry) {
    const url = accent === 'uk' ? (entry.uk || entry.us || entry.any) : (entry.us || entry.uk || entry.any);
    if (url) {
      try { new Audio(url.startsWith('//') ? 'https:' + url : url).play().catch(() => speak(w, spLang)); return; }
      catch { /* 落到語音 */ }
    }
  }
  toast(`找不到${accent === 'uk' ? '英式' : '美式'}真人錄音，改用瀏覽器語音`);
  speak(w, spLang);
}
// 依設定口音播放（給非標題的單字用）
function speakWord(word) { return speakWordAccent(word, settings.accent === 'uk' ? 'uk' : 'us'); }

// (3) Gemini AI 語音（TTS，臨時生成；走 Vertex 通道）
const TTS_MODELS = ['gemini-3.1-flash-tts-preview', 'gemini-2.5-flash-preview-tts'];
function pcmB64ToWavUrl(b64, sampleRate) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const dataLen = bytes.length;
  const buffer = new ArrayBuffer(44 + dataLen);
  const view = new DataView(buffer);
  const w = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); view.setUint32(4, 36 + dataLen, true); w(8, 'WAVE'); w(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); w(36, 'data'); view.setUint32(40, dataLen, true);
  new Uint8Array(buffer, 44).set(bytes);
  return URL.createObjectURL(new Blob([buffer], { type: 'audio/wav' }));
}
// 生成單段 AI 語音，回傳 { b64, rate } 或 null（不播放）
// preferredKey：並行時指定先用哪一把金鑰，避免多請求搶同一把
async function geminiTTSChunk(text, preferredKey) {
  const all = activeKeys();
  if (!all.length || !text) return null;
  const keys = preferredKey
    ? [preferredKey, ...all.filter(k => k !== preferredKey)]
    : all;
  const body = {
    contents: [{ role: 'user', parts: [{ text }] }],
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } },
    },
  };
  for (const model of TTS_MODELS) {
    for (let attempt = 0; attempt < keys.length; attempt++) {
      const key = keys[attempt];
      try {
        const url = `https://aiplatform.googleapis.com/v1/publishers/google/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`;
        const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        if (!res.ok) {
          if ([429, 500, 502, 503, 504].includes(res.status)) continue; // 換金鑰
          break; // 這個模型不行（如 400/404），換下一個模型
        }
        const data = await res.json();
        const part = data?.candidates?.[0]?.content?.parts?.find(p => p.inlineData);
        if (!part) break;
        const rate = parseInt((part.inlineData.mimeType || '').match(/rate=(\d+)/)?.[1] || '24000', 10);
        return { b64: part.inlineData.data, rate };
      } catch (e) { /* 換下一把金鑰 */ }
    }
  }
  return null;
}

// 固定並行度的 map（用來讓多把 API 金鑰同時生成語音）
async function mapPool(items, concurrency, fn) {
  const results = new Array(items.length);
  let next = 0;
  const n = Math.max(1, Math.min(concurrency, items.length));
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: n }, () => worker()));
  return results;
}

function b64ToBytes(b64) {
  const bin = atob(b64);
  const a = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
  return a;
}
// 把多段 PCM（同取樣率）串成一個 WAV Blob
function pcmChunksToWavBlob(chunks, sampleRate) {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const buffer = new ArrayBuffer(44 + total);
  const view = new DataView(buffer);
  const w = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); view.setUint32(4, 36 + total, true); w(8, 'WAVE'); w(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); w(36, 'data'); view.setUint32(40, total, true);
  let off = 44;
  for (const c of chunks) { new Uint8Array(buffer, off, c.length).set(c); off += c.length; }
  return new Blob([buffer], { type: 'audio/wav' });
}
function pcmDurationSec(bytes, sampleRate) {
  return (bytes.length / 2) / (sampleRate || 24000); // 16-bit mono
}

let ttsBusy = false;
/** 新增預覽尚未存檔時，暫存已生成的 AI 語音網址 */
let pendingTtsHolder = { ttsUrls: {} };
/** 本機 AI 語音快取（Cache API；即使雲端上傳失敗，同瀏覽器也可重播） */
const TTS_CACHE_NAME = 'beidanzi-tts-v1';

function ttsCacheKey(text) {
  const t = String(text || '').trim().replace(/\s+/g, ' ');
  if (!t) return '';
  if (t.length <= 160) return t;
  let h = 5381;
  for (let i = 0; i < t.length; i++) h = ((h << 5) + h) ^ t.charCodeAt(i);
  return `${t.slice(0, 48)}#${(h >>> 0).toString(36)}`;
}

function ttsLocalCacheKey(cardId, textKey) {
  return `https://tts.local/${encodeURIComponent(String(cardId || '_'))}/${encodeURIComponent(textKey)}`;
}

async function getLocalTtsBlob(cardId, textKey) {
  if (!textKey || !('caches' in window)) return null;
  try {
    const cache = await caches.open(TTS_CACHE_NAME);
    const res = await cache.match(ttsLocalCacheKey(cardId, textKey));
    if (!res) return null;
    return await res.blob();
  } catch { return null; }
}

async function putLocalTtsBlob(cardId, textKey, blob) {
  if (!textKey || !blob || !('caches' in window)) return;
  try {
    const cache = await caches.open(TTS_CACHE_NAME);
    await cache.put(ttsLocalCacheKey(cardId, textKey), new Response(blob, { headers: { 'Content-Type': 'audio/wav' } }));
  } catch (e) { console.warn('本機 AI 語音快取寫入失敗', e); }
}

/** 找出目前操作中的字卡（詞庫卡／詳情／編輯／背誦／新增預覽） */
function resolveTtsCard(el) {
  if (el && el.closest) {
    const wc = el.closest('.word-card[data-id]');
    if (wc?.dataset?.id) {
      const c = cards.find(x => x.id === wc.dataset.id);
      if (c) return c;
    }
    if (el.closest('#cardModal, #modalBody') && modalCardId) {
      const c = cards.find(x => x.id === modalCardId);
      if (c) return c;
    }
    if (el.closest('#studyCard, #view-study, #cardFront, #cardBack')) {
      try {
        if (session?.queue?.length) {
          const item = currentItem();
          if (item) {
            const c = cards.find(x => x.id === item.cardId);
            if (c) return c;
          }
        }
      } catch { /* ignore */ }
    }
  }
  if (currentEntry?.card) return currentEntry.card;
  if (typeof modalCardId === 'string' && modalCardId) {
    const c = cards.find(x => x.id === modalCardId);
    if (c) return c;
  }
  try {
    if (session?.queue?.length && $('#studyCard') && !$('#studyCard').hidden) {
      const item = currentItem();
      if (item) {
        const c = cards.find(x => x.id === item.cardId);
        if (c) return c;
      }
    }
  } catch { /* session 未就緒 */ }
  if (pendingCard) return pendingTtsHolder;
  return null;
}

async function uploadTtsWavBlob(blob, filename = 'card-tts.wav') {
  const fd = new FormData();
  fd.append('file', new File([blob], filename, { type: 'audio/wav' }));
  const res = await fetch(listenBackend() + '/beidanzi/store_audio', { method: 'POST', body: fd });
  if (!res.ok) throw new Error('上傳失敗 ' + res.status);
  const j = await res.json();
  if (!j?.url) throw new Error('未回傳網址');
  return j.url;
}

function saveTtsUrlToCard(card, key, url) {
  if (!card || !key || !url) return;
  if (!card.ttsUrls || typeof card.ttsUrls !== 'object') card.ttsUrls = {};
  card.ttsUrls[key] = url;
  // 已存檔字卡：寫入本機 + Firestore（音檔在 Storage，網址在卡片文件）
  if (card.id && cards.some(c => c.id === card.id)) {
    saveCards();
    cloudUpsert(card);
  }
}

async function playAudioUrl(url) {
  return new Promise((resolve, reject) => {
    const a = new Audio(url);
    let settled = false;
    const ok = () => { if (!settled) { settled = true; resolve(); } };
    const fail = (err) => { if (!settled) { settled = true; reject(err || new Error('play failed')); } };
    a.onended = () => ok();
    a.onerror = () => fail(new Error('load failed'));
    a.onplaying = () => { /* 開始播就算成功，不必等播完才繼續 */ if (!settled) { settled = true; resolve(); } };
    const p = a.play();
    if (p && typeof p.then === 'function') p.catch(fail);
    setTimeout(() => fail(new Error('timeout')), 12000);
  });
}

async function playAudioBlob(blob) {
  const url = URL.createObjectURL(blob);
  try {
    await playAudioUrl(url);
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
}

async function speakGeminiTTS(text, el) {
  if (!text) return;
  const key = ttsCacheKey(text);
  const card = resolveTtsCard(el);
  const cardId = card?.id || (card === pendingTtsHolder ? '_pending' : '_');
  const remote = key && card?.ttsUrls?.[key];

  // 1) 字卡上已存的雲端網址
  if (remote) {
    try {
      await playAudioUrl(remote);
      return;
    } catch {
      if (card?.ttsUrls) {
        delete card.ttsUrls[key];
        if (card.id) { saveCards(); cloudUpsert(card); }
      }
    }
  }

  // 2) 本機 Cache（同瀏覽器已生成過就直接播）
  if (key) {
    const localBlob = await getLocalTtsBlob(cardId, key)
      || (cardId !== '_' ? await getLocalTtsBlob('_', key) : null);
    if (localBlob) {
      try {
        await playAudioBlob(localBlob);
        // 有字卡但還沒雲端網址：背景補上傳
        if (card && key && !card.ttsUrls?.[key]) {
          uploadTtsWavBlob(localBlob, `tts-${Date.now()}.wav`)
            .then(url => saveTtsUrlToCard(card, key, url))
            .catch(() => {});
        }
        return;
      } catch { /* 本機壞掉就重新生成 */ }
    }
  }

  if (!activeKeys().length) { toast('尚未設定 API 金鑰', true); return; }
  if (ttsBusy) return;
  ttsBusy = true;
  toast('🤖 AI 生成語音中…');
  let generated = null;
  try {
    generated = await geminiTTSChunk(text);
    if (!generated) {
      toast('AI 語音失敗，改用瀏覽器語音', true);
      speak(text);
      return;
    }
    const localUrl = pcmB64ToWavUrl(generated.b64, generated.rate);
    try { new Audio(localUrl).play(); } catch { /* ignore */ }
  } finally {
    ttsBusy = false;
  }

  if (!generated || !key) return;

  // 3) 寫入本機快取；有字卡則上傳 Storage 並存進 ttsUrls（下次／換裝置可重用）
  try {
    const blob = pcmChunksToWavBlob([b64ToBytes(generated.b64)], generated.rate);
    await putLocalTtsBlob(cardId, key, blob);
    if (cardId !== '_') await putLocalTtsBlob('_', key, blob);
    if (card) {
      try {
        const url = await uploadTtsWavBlob(blob, `tts-${Date.now()}.wav`);
        saveTtsUrlToCard(card, key, url);
      } catch (e) {
        console.warn('AI 語音雲端保存失敗（本機已快取）', e);
      }
    }
  } catch (e) {
    console.warn('AI 語音保存失敗', e);
  }
}

// ---- 喇叭按鈕 HTML ----
// 標題單字：英文=美式/英式/瀏覽器/AI；德文=真人/瀏覽器/AI（德語無美英之分）
function spkWord3(text) {
  if (!text) return '';
  const t = esc(text);
  const btn = (src, label, title) => `<button class="speak-btn" data-speak="${t}" data-src="${src}" title="${title}" type="button">${label}</button>`;
  let inner;
  if (currentLang === 'en') {
    inner = btn('us', '🔊美', '美式真人錄音') + btn('uk', '🔊英', '英式真人錄音');
  } else {
    inner = btn('dict', '🔊真人', `${L().label}真人錄音`);
  }
  inner += btn('browser', '🔊瀏', '瀏覽器語音') + btn('ai', '🤖', 'AI 語音（會記住，下次直接播放）');
  return `<span class="spk-group">${inner}</span>`;
}
// 一般單字（詞形變化、派生詞）：依設定口音的字典發音 + AI
function spkw(word) {
  if (!word) return '';
  const t = esc(word);
  return `<button class="speak-btn" data-speak="${t}" data-src="dict" title="真人錄音發音" type="button">🔊</button>`
    + `<button class="speak-btn" data-speak="${t}" data-src="ai" title="AI 語音（會記住）" type="button">🤖</button>`;
}
// 句子：瀏覽器語音 + AI
function spk(text) {
  if (!text) return '';
  const t = esc(text);
  return `<button class="speak-btn" data-speak="${t}" data-src="browser" title="瀏覽器語音" type="button">🔊</button>`
    + `<button class="speak-btn" data-speak="${t}" data-src="ai" title="AI 語音（會記住）" type="button">🤖</button>`;
}
// 中文：瀏覽器中文語音 + AI
function spkZh(text) {
  if (!text) return '';
  const t = esc(text);
  return `<button class="speak-btn" data-speak="${t}" data-src="zh" title="中文發音（瀏覽器）" type="button">🔊中</button>`
    + `<button class="speak-btn" data-speak="${t}" data-src="ai" title="中文 AI 語音（會記住）" type="button">🤖</button>`;
}

// 依序朗讀多段（瀏覽器語音會自動排隊）
function makeUtterance(text, lang) {
  const u = new SpeechSynthesisUtterance(text);
  u.lang = lang;
  // 閱讀頁：一律用目前語速設定（每次新建 utterance 都重新讀取）
  u.rate = ($('#view-reader') && $('#view-reader').classList.contains('active')) ? getReaderSpeed() : 0.95;
  const voices = window.speechSynthesis.getVoices();
  const pre = lang.slice(0, 2).toLowerCase();
  const same = voices.filter(x => x.lang && x.lang.toLowerCase().startsWith(pre));
  const best = same.find(x => x.lang.toLowerCase() === lang.toLowerCase() && /google|microsoft|natural/i.test(x.name))
    || same.find(x => x.lang.toLowerCase() === lang.toLowerCase())
    || same[0];
  if (best) u.voice = best;
  return u;
}
function speakSequence(items) {
  if (!window.speechSynthesis) return;
  try {
    window.speechSynthesis.cancel();
    items.filter(it => it && it.text && String(it.text).trim())
      .forEach(it => window.speechSynthesis.speak(makeUtterance(String(it.text), it.lang || L().speech.def)));
  } catch (e) { console.error(e); }
}
function stopStudySpeech() {
  try { if (window.speechSynthesis) window.speechSynthesis.cancel(); } catch {}
}
const ZH_LANG = 'zh-TW';
function zhExplanationOf(d) {
  return (d.definitions || []).map(x => (x.meaning_zh || '').trim()).filter(Boolean).join('，');
}
function exampleSentencesOf(d) {
  const arr = [];
  (d.definitions || []).forEach(x => { if (x.example_en) arr.push(x.example_en); });
  (d.examples || []).forEach(x => { if (x.en) arr.push(x.en); });
  return arr;
}
const TARGET_LANG = () => L().speech.def;
// 切到新卡：只念「題面」可見內容，不要先把答案唸出來
function autoSpeakFront(d, mode) {
  if (mode === 'spelling') {
    // 克漏字：聽整句拼單字（句子本身含答案字，屬題目設計）
    const sent = clozeSentence(d);
    speakSequence([{ text: sent ? sent.en : d.word, lang: TARGET_LANG() }]);
    return;
  }
  if (mode === 'zh2en') {
    const zh = zhExplanationOf(d);
    if (zh) speakSequence([{ text: zh, lang: ZH_LANG }]);
    return;
  }
  // en2zh 及其他「看外文回想…」：只先念單字
  if (d.word) speakSequence([{ text: d.word, lang: TARGET_LANG() }]);
}
// 顯示答案：英中交錯×3，再每句例句念兩次
function autoSpeakBack(d) {
  const en = String(d.word || '').trim();
  const zh = zhExplanationOf(d);
  const items = [];
  for (let i = 0; i < 3; i++) {
    if (en) items.push({ text: en, lang: TARGET_LANG() });
    if (zh) items.push({ text: zh, lang: ZH_LANG });
  }
  exampleSentencesOf(d).forEach(s => {
    const t = String(s || '').trim();
    if (!t) return;
    items.push({ text: t, lang: TARGET_LANG() });
    items.push({ text: t, lang: TARGET_LANG() });
  });
  speakSequence(items);
}

let toastTimer;
function toast(msg, isErr = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast show' + (isErr ? ' err' : '');
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = 'toast'; }, 2600);
}

// 閱讀／聽力：隱藏中文翻譯（設定會記住）
let hideZh = localStorage.getItem('hide_zh') === '1';
function applyHideZh() {
  document.documentElement.classList.toggle('hide-zh', hideZh);
  document.querySelectorAll('#rdToggleZh, #listenToggleZh').forEach(btn => {
    btn.textContent = hideZh ? '顯示中文' : '隱藏中文';
    btn.title = hideZh ? '顯示中文翻譯' : '隱藏中文翻譯';
  });
}
function toggleHideZh() {
  hideZh = !hideZh;
  localStorage.setItem('hide_zh', hideZh ? '1' : '0');
  applyHideZh();
}

/* =========================================================================
   初始化
   ========================================================================= */
function bindAutoHideScrollbars() {
  // 滾動／觸控時短暫顯示捲軸（懸停已由 CSS :hover 處理）
  const show = (el) => {
    if (!(el instanceof Element)) return;
    el.classList.add('is-scrolling');
    clearTimeout(el._scrollBarT);
    el._scrollBarT = setTimeout(() => el.classList.remove('is-scrolling'), 1000);
  };
  document.addEventListener('scroll', e => show(e.target === document ? document.documentElement : e.target), true);
  document.addEventListener('wheel', e => show(e.target.closest('*')), { passive: true, capture: true });
  document.addEventListener('touchmove', e => show(e.target.closest('*')), { passive: true, capture: true });
}

function init() {
  loadCustomLangs();
  if (!allLangs()[currentLang]) currentLang = 'en';
  cards = loadJSON(nsKey(LS_CARDS), []);
  settings = { ...DEFAULT_SETTINGS, ...loadJSON(LS_SETTINGS, {}) };
  folders = loadJSON(nsKey(LS_FOLDERS), []);
  daily = loadJSON(nsKey(LS_DAILY), { date: todayStr(), count: 0, streak: 0, lastMetDate: '', countedIds: [] });
  if (!Array.isArray(daily.countedIds)) daily.countedIds = [];
  migrateSettings();
  migrateCards();
  rolloverDaily();
  applyLangToModes();
  loadEnvKeys();
  bindAutoHideScrollbars();

  applyTheme(localStorage.getItem(LS_THEME) || 'light');
  // 全域喇叭朗讀（事件委派）
  document.addEventListener('click', e => {
    const b = e.target.closest('.speak-btn');
    if (!b) return;
    e.stopPropagation();
    const t = b.dataset.speak;
    switch (b.dataset.src) {
      case 'us': speakWordAccent(t, 'us'); break;
      case 'uk': speakWordAccent(t, 'uk'); break;
      case 'ai': speakGeminiTTS(t, b); break;
      case 'dict': speakWord(t); break;
      case 'zh': speak(t, ZH_LANG); break;
      default: speak(t);
    }
  });
  // 預先載入語音清單（部分瀏覽器需要）
  if (window.speechSynthesis) window.speechSynthesis.getVoices();

  bindNav();
  bindTheme();
  bindLang();
  bindAdd();
  bindBatch();
  bindDeck();
  bindCardModal();
  bindStudySetup();
  bindStudyControls();
  bindSettings();
  bindReader();
  bindListen();
  bindSelAiPop();
  applyHideZh();

  // 回填設定畫面
  $('#apiKeysInput').value = (settings.apiKeys || []).join('\n');
  $('#modelSelect').value = settings.model;
  $('#accentSelect').value = settings.accent || 'us';
  $('#dailyGoalInput').value = settings.dailyGoal || 20;
  $('#listenBackendInput').value = settings.listenBackend || 'https://whisper-api-1016448029865.asia-east1.run.app/api';

  bindDeckControls();
  updateLangUI();
  renderFolderSelects();
  renderDailyPanel();
  renderDeck();
  renderModeGrid();

  // 需要登入才能使用；等 Auth 模組載入後由登入狀態驅動資料載入
  if (window.Auth) bindAuth();
  else window.addEventListener('cloud-ready', () => bindAuth(), { once: true });
}

/* ---------------------- Google 登入（必須登入） ---------------------- */
const MIGRATE_OWNER_EMAIL = 'lcy101120@gmail.com'; // 舊資料歸屬的帳號
const LS_MIGRATED = 'vocab_migrated_lcy_v1';
let authBound = false;

function showGate(show, status) {
  const gate = $('#loginGate');
  if (gate) gate.hidden = !show;
  if (status !== undefined) { const s = $('#gateStatus'); if (s) s.textContent = status; }
}

function bindAuth() {
  const topBtn = $('#loginBtn');
  const gateBtn = $('#gateLoginBtn');
  // 無 Auth（例如未部署 Firebase）：不強制登入，維持本機資料
  if (!window.Auth || !window.Auth.enabled) {
    showGate(false);
    if (topBtn) topBtn.style.display = 'none';
    if (window.Cloud && window.Cloud.enabled) startCloud();
    return;
  }
  if (authBound) return;
  authBound = true;

  gateBtn?.addEventListener('click', () => { showGate(true, '登入中…'); window.Auth.signInGoogle(); });
  topBtn?.addEventListener('click', () => {
    if (window.Auth.user) { if (confirm('確定要登出嗎？')) window.Auth.signOut(); }
    else window.Auth.signInGoogle();
  });

  window.Auth.onChange(u => { onAuthChanged(u); });
}

async function onAuthChanged(u) {
  const topBtn = $('#loginBtn');
  if (!u) {
    // 未登入：清空畫面、顯示登入牆
    currentUid = null;
    if (window.Cloud?.setUser) window.Cloud.setUser(null);
    if (cloudUnsub) { try { cloudUnsub(); } catch { } cloudUnsub = null; }
    cards = [];
    if (topBtn) { topBtn.textContent = '登入'; topBtn.title = '以 Google 登入'; topBtn.classList.remove('signed-in'); }
    setCloudBadge('');
    renderDeck();
    showGate(true, '');
    return;
  }
  // 已登入
  currentUid = u.uid;
  if (window.Cloud?.setUser) window.Cloud.setUser(u.uid);
  const name = u.displayName || u.email || '已登入';
  if (topBtn) { topBtn.textContent = '登出'; topBtn.title = `${name}（點擊登出）`; topBtn.classList.add('signed-in'); }
  showGate(true, '載入中…');

  // 舊資料一次性歸戶到指定帳號
  if ((u.email || '').toLowerCase() === MIGRATE_OWNER_EMAIL && !localStorage.getItem(LS_MIGRATED)) {
    try { await migrateLegacyToUser(u.uid); localStorage.setItem(LS_MIGRATED, '1'); }
    catch (e) { console.error('舊資料歸戶失敗', e); }
  }

  // 載入該使用者的本機快取（雲端載入後會覆蓋為單一真實來源）
  loadUserLocalData();
  applyLangToModes();
  updateLangUI();
  renderFolderSelects();
  renderDailyPanel();
  renderDeck();
  renderModeGrid();
  if (window.Cloud && window.Cloud.enabled) startCloud();
  syncHistory();
  showGate(false);
}

// 重新載入目前使用者 + 目前語言的本機資料
function loadUserLocalData() {
  cards = loadJSON(nsKey(LS_CARDS), []);
  folders = loadJSON(nsKey(LS_FOLDERS), []);
  daily = loadJSON(nsKey(LS_DAILY), { date: todayStr(), count: 0, streak: 0, lastMetDate: '', countedIds: [] });
  if (!Array.isArray(daily.countedIds)) daily.countedIds = [];
  rolloverDaily();
  migrateCards();
  readerBooks = loadJSON(nsKey(LS_READER), []);
  readerSyncedLang = null;
  listenItems = loadJSON(nsKey(LS_LISTEN), []);
  listenSyncedLang = null;
}

// 把舊的共用資料（Firestore 頂層集合 + 本機舊 key）搬到 users/{uid} 底下
async function migrateLegacyToUser(uid) {
  const langs = allLangs();
  for (const l of Object.values(langs)) {
    const col = l.collection;
    // 1) Firestore 頂層集合 → users/{uid}/col
    if (window.Cloud?.migrateLegacy) {
      try { await window.Cloud.migrateLegacy(uid, col); } catch (e) { console.error(e); }
    }
    // 2) 本機舊快取（未帶 uid 的 key）→ 補上雲端，避免只存在離線的卡片遺失
    const base = l.code === 'en' ? LS_CARDS : `${LS_CARDS}_${l.code}`;
    const legacyCards = loadJSON(base, []);
    if (Array.isArray(legacyCards) && legacyCards.length && window.Cloud?.setCollection && window.Cloud?.bulk) {
      window.Cloud.setCollection(col);
      try { await window.Cloud.bulk(legacyCards); } catch (e) { console.error(e); }
    }
    // 3) 資料夾／每日進度／複習歷史：把舊 key 複製到帶 uid 的新 key（若尚未存在）
    const bases = [
      l.code === 'en' ? LS_FOLDERS : `${LS_FOLDERS}_${l.code}`,
      l.code === 'en' ? LS_DAILY : `${LS_DAILY}_${l.code}`,
      l.code === 'en' ? LS_DAILY_HIST : `${LS_DAILY_HIST}_${l.code}`,
    ];
    bases.forEach(b => {
      const nk = `${b}__u_${uid}`;
      if (localStorage.getItem(b) && !localStorage.getItem(nk)) localStorage.setItem(nk, localStorage.getItem(b));
    });
  }
  // 還原目前語言集合
  if (window.Cloud?.setCollection) window.Cloud.setCollection(L().collection);
}

/* ---------------------- 複習歷史（熱力圖）跨裝置同步 ---------------------- */
let histSaveTimer = null;
function histMetaName() { return `hist_${currentLang}`; }
function saveHistoryToCloud() {
  if (!currentUid || !(window.Cloud && window.Cloud.enabled && window.Cloud.saveMeta)) return;
  clearTimeout(histSaveTimer);
  histSaveTimer = setTimeout(() => {
    const hist = loadJSON(nsKey(LS_DAILY_HIST), {});
    window.Cloud.saveMeta(histMetaName(), { history: hist });
  }, 1500);
}
// 登入時：回收登入前的本機歷史 + 與雲端合併（取每日較大值），修正「隔天消失」
async function syncHistory() {
  if (!currentUid) { renderDailyPanel(); return; }
  const curKey = nsKey(LS_DAILY_HIST);
  let cur = loadJSON(curKey, {});
  // (1) 回收登入前存在「非 uid」key 的歷史（每個 uid／語言只做一次）
  const legacyBase = currentLang === 'en' ? LS_DAILY_HIST : `${LS_DAILY_HIST}_${currentLang}`;
  const recoverFlag = `vocab_hist_recovered_${currentLang}_${currentUid}`;
  if (!localStorage.getItem(recoverFlag)) {
    const legacy = loadJSON(legacyBase, {});
    if (legacy && typeof legacy === 'object') {
      Object.keys(legacy).forEach(k => { cur[k] = Math.max(cur[k] || 0, legacy[k] || 0); });
    }
    localStorage.setItem(recoverFlag, '1');
  }
  // (2) 與雲端合併
  if (window.Cloud && window.Cloud.enabled && window.Cloud.loadMeta) {
    try {
      const meta = await window.Cloud.loadMeta(histMetaName());
      const cloudHist = (meta && meta.history) || {};
      Object.keys(cloudHist).forEach(k => { cur[k] = Math.max(cur[k] || 0, cloudHist[k] || 0); });
    } catch (e) { console.error(e); }
  }
  localStorage.setItem(curKey, JSON.stringify(cur));
  saveHistoryToCloud(); // 把合併後結果寫回雲端，跨裝置一致
  renderDailyPanel();
}

/* ---------------------- 雲端同步 ---------------------- */
let cloudReady = false;
let firstSnapshot = true;
let cloudUnsub = null;

function startCloud() {
  if (!(window.Cloud && window.Cloud.enabled)) return;
  cloudReady = true;
  firstSnapshot = true;
  if (cloudUnsub) { try { cloudUnsub(); } catch { } cloudUnsub = null; }
  if (window.Cloud.setCollection) window.Cloud.setCollection(L().collection);
  setCloudBadge('連線中…');
  cloudUnsub = window.Cloud.start(onCloudCards);
}

function onCloudCards(cloudCards) {
  if (firstSnapshot) {
    firstSnapshot = false;
    // 首次：把本機才有、雲端沒有的卡片上傳，其餘以雲端為準做聯集
    const cloudIds = new Set(cloudCards.map(c => c.id));
    const localOnly = cards.filter(c => c && c.id && !cloudIds.has(c.id));
    if (localOnly.length) window.Cloud.bulk(localOnly);
    const map = new Map();
    cloudCards.forEach(c => map.set(c.id, c));
    localOnly.forEach(c => map.set(c.id, c));
    cards = Array.from(map.values());
  } else {
    // 之後：雲端為單一真實來源
    cards = cloudCards.slice();
  }
  cards.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  migrateCards();
  localStorage.setItem(nsKey(LS_CARDS), JSON.stringify(cards));
  setCloudBadge('已同步');
  refreshCurrentView();
}

function refreshCurrentView() {
  const active = document.querySelector('.view.active');
  if (!active) return;
  if (active.id === 'view-deck') renderDeck();
  if (active.id === 'view-study' && !$('#studySetup').hidden) renderModeGrid();
}

function setCloudBadge(text) {
  const el = $('#cloudStatus');
  if (el) el.textContent = text ? '☁️ ' + text : '';
}

// 雲端寫入輔助（未啟用時自動略過）
function cloudUpsert(card) { if (cloudReady && card) window.Cloud.upsert(card); }
function cloudRemove(id) { if (cloudReady) window.Cloud.remove(id); }
function cloudBulk(arr) { if (cloudReady) window.Cloud.bulk(arr); }
function cloudClear() { if (cloudReady) window.Cloud.clearAll(); }

let cloudSaveTimer;
function debouncedCloudSave(card) {
  clearTimeout(cloudSaveTimer);
  cloudSaveTimer = setTimeout(() => cloudUpsert(card), 800);
}

// 相容舊版單一 apiKey 設定，並清理金鑰陣列
function migrateSettings() {
  if (!Array.isArray(settings.apiKeys)) settings.apiKeys = [];
  if (settings.apiKey) { // 舊版欄位
    if (!settings.apiKeys.includes(settings.apiKey)) settings.apiKeys.unshift(settings.apiKey);
    delete settings.apiKey;
  }
  settings.apiKeys = settings.apiKeys.map(k => k.trim()).filter(Boolean);
  delete settings.provider; // 一律 Vertex，不再需要
}

// 確保每張卡都有 srs 結構
function migrateCards() {
  cards.forEach(c => {
    c.srs = c.srs || {};
    STUDY_MODES.forEach(m => {
      if (!c.srs[m.id]) c.srs[m.id] = newSrsState();
    });
  });
}
function newSrsState() {
  return { due: 0, interval: 0, ease: 2.5, reps: 0, lapses: 0 };
}

/* =========================================================================
   導覽 / 主題
   ========================================================================= */
function showView(name) {
  $$('.view').forEach(v => v.classList.remove('active'));
  $('#view-' + name).classList.add('active');
  $$('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.view === name));
  // 閱讀／聽力頁需要更寬的版面（左右對照），其餘頁維持置中窄版
  document.querySelector('.container')?.classList.toggle('wide', name === 'reader' || name === 'listen');
  if (name === 'add') currentEntry = null; // 進入新增頁預設不綁定任何已存卡片
  if (name === 'deck') { renderFolderSelects(); renderDailyPanel(); renderDeck(); }
  if (name === 'batch') renderBatch();
  if (name === 'study') { renderModeGrid(); renderFolderSelects(); resetStudyToSetup(); }
  if (name === 'reader') openReader();
  if (name === 'listen') openListen();
}

function bindNav() {
  document.body.addEventListener('click', e => {
    const el = e.target.closest('[data-view]');
    if (el) { showView(el.dataset.view); }
  });
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem(LS_THEME, theme);
  $('.theme-icon').textContent = theme === 'dark' ? '☀️' : '🌙';
}
function bindTheme() {
  $('#themeToggle').addEventListener('click', () => {
    const cur = document.documentElement.getAttribute('data-theme');
    applyTheme(cur === 'dark' ? 'light' : 'dark');
  });
}

/* ---------------------- 語言切換（英文 / 德文） ---------------------- */
function bindLang() {
  $('#langSwitch')?.addEventListener('click', e => {
    if (e.target.closest('[data-add-lang]')) { addCustomLang(); return; }
    const del = e.target.closest('[data-del-lang]');
    if (del) { e.stopPropagation(); removeCustomLang(del.dataset.delLang); return; }
    const b = e.target.closest('[data-lang]');
    if (b) switchLang(b.dataset.lang);
  });
}
function renderLangSwitch() {
  const box = $('#langSwitch');
  if (!box) return;
  const langs = allLangs();
  box.innerHTML = Object.values(langs).map(l => {
    const active = l.code === currentLang ? ' active' : '';
    const del = l.custom ? `<span class="lang-del" data-del-lang="${l.code}" title="刪除此語言">×</span>` : '';
    return `<button class="lang-btn${active}" data-lang="${l.code}" title="${l.name}">${l.label}${del}</button>`;
  }).join('') + `<button class="lang-btn lang-add" data-add-lang title="新增自訂語言">＋</button>`;
}
function updateLangUI() {
  renderLangSwitch();
  const brand = $('.brand h1');
  if (brand) brand.textContent = currentLang === 'en' ? '快速背單字' : `快速背${L().label}文`;
  // 美式/英式口音只對英文有意義，其他語言隱藏
  const af = $('#accentField');
  if (af) af.style.display = currentLang === 'en' ? '' : 'none';
}
function addCustomLang() {
  const name = (prompt('語言名稱（例如：義大利文）')||'').trim();
  if (!name) return;
  let label = (prompt('顯示按鈕文字（建議一個字，例如：義）', name.slice(0,1))||'').trim();
  if (!label) label = name.slice(0,1);
  const speech = (prompt('語音代碼 BCP-47（例如義大利文為 it-IT，可留空用瀏覽器預設）','')||'').trim();
  // 產生唯一代碼
  let code = 'c_' + Date.now().toString(36);
  const l = makeLang(code, label, name, speech, speech ? speech.split('-')[0] : '');
  l.custom = true;
  customLangs[code] = l;
  saveCustomLangs();
  switchLang(code);
}
function removeCustomLang(code) {
  const l = customLangs[code];
  if (!l) return;
  if (!confirm(`確定刪除自訂語言「${l.name}」？（該語言的本機資料索引會保留，但按鈕會移除）`)) return;
  const wasCurrent = currentLang === code;
  delete customLangs[code];
  saveCustomLangs();
  if (wasCurrent) switchLang('en'); // currentLang 仍為 code，switchLang('en') 會正常重載
  else renderLangSwitch();
}
function switchLang(lang) {
  if (!allLangs()[lang]) return;
  if (lang === currentLang) { renderLangSwitch(); return; }
  currentLang = lang;
  localStorage.setItem(LS_LANG, lang);
  // 重新載入該語言的資料（各語言互不干擾）
  cards = loadJSON(nsKey(LS_CARDS), []);
  folders = loadJSON(nsKey(LS_FOLDERS), []);
  daily = loadJSON(nsKey(LS_DAILY), { date: todayStr(), count: 0, streak: 0, lastMetDate: '', countedIds: [] });
  if (!Array.isArray(daily.countedIds)) daily.countedIds = [];
  rolloverDaily();
  migrateCards();
  applyLangToModes();
  // 重置詞庫檢視狀態
  deckFolder = ''; starOnly = false; if (selectMode) setSelectMode(false);
  const sf = $('#starFilterBtn'); if (sf) sf.classList.remove('active');
  updateLangUI();
  renderFolderSelects();
  renderDailyPanel();
  renderDeck();
  renderModeGrid();
  // 重新訂閱該語言的雲端集合
  startCloud();
  syncHistory();
  // 閱讀書架也換語言
  readerBooks = loadJSON(nsKey(LS_READER), []);
  readerSyncedLang = null;
  readerCurrentBookId = null; readerCurrentTocId = null;
  if (document.querySelector('#view-reader')?.classList.contains('active')) openReader();
  // 聽力清單也換語言
  listenStopPlayer();
  listenItems = loadJSON(nsKey(LS_LISTEN), []);
  listenSyncedLang = null;
  listenCurrentId = null;
  if (document.querySelector('#view-listen')?.classList.contains('active')) openListen();
  toast(`已切換到${L().label}`);
}

/* =========================================================================
   Gemini API
   ========================================================================= */
const _list = (props, itemRequired) => {
  const items = { type: 'object', properties: props };
  if (itemRequired?.length) items.required = itemRequired;
  return { type: 'array', items };
};

// 每段共用的原始內容說明
function rawBlock(raw) {
  return raw
    ? `以下是從詞典／使用者提供的補充內容（可能雜亂、有重複或無關文字，請判讀後取用；優先採用標示來源的釋義、例句、詞源）：\n"""\n${raw}\n"""`
    : '（沒有詞典補充內容，請依你自己的知識整理。）';
}

/** 從 Free Dictionary API（瀏覽器可直連）抓英文釋義當後備 */
async function fetchFreeDictionaryRaw(word) {
  try {
    const res = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`);
    if (!res.ok) return '';
    const data = await res.json();
    const lines = ['【Free Dictionary】'];
    for (const en of data || []) {
      if (en.phonetic) lines.push(`音標 ${en.phonetic}`);
      for (const m of en.meanings || []) {
        lines.push(`詞性 ${m.partOfSpeech || ''}`);
        for (const d of (m.definitions || []).slice(0, 4)) {
          lines.push(`- ${d.definition || ''}`);
          if (d.example) lines.push(`  例：${d.example}`);
        }
        for (const s of (m.synonyms || []).slice(0, 6)) lines.push(`同義 ${s}`);
      }
    }
    const text = lines.join('\n').trim();
    return text.length > 80 ? text.slice(0, 4000) : '';
  } catch {
    return '';
  }
}

/**
 * 未貼歐路內容時，自動從劍橋／柯林斯／朗文／歐路／Etymonline 抓補充。
 * 優先聽力後端（curl_cffi + 代理可過 Cloudflare），其次 Vercel，最後 Free Dictionary。
 */
async function fetchOnlineDictRaw(word, onStatus) {
  const w = String(word || '').trim();
  if (!w || currentLang !== 'en') return '';
  const report = (msg) => { if (typeof onStatus === 'function') onStatus(msg); };

  const tryJson = async (url) => {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = await res.json();
    if (j && j.text) return j;
    throw new Error('empty');
  };

  report('正在從線上詞典抓取補充（劍橋／柯林斯等，含 Cloudflare 繞過）…');
  // 1) 聽力 Cloud Run 後端（curl_cffi TLS 模擬 + 必要時代理）
  try {
    const j = await tryJson(`${listenBackend()}/beidanzi/dict_fetch?word=${encodeURIComponent(w)}`);
    const okN = (j.sources || []).filter(s => s.ok).length;
    report(`已抓到 ${okN} 個詞典來源，開始 AI 整理…`);
    return j.text;
  } catch (e) {
    console.warn('dict-fetch (backend) failed', e);
  }
  // 2) Vercel serverless（無 curl_cffi，作後備）
  try {
    const j = await tryJson(`/api/dict-fetch?word=${encodeURIComponent(w)}`);
    const okN = (j.sources || []).filter(s => s.ok).length;
    report(`已抓到 ${okN} 個詞典來源，開始 AI 整理…`);
    return j.text;
  } catch (e) {
    console.warn('dict-fetch (vercel) failed', e);
  }
  // 3) 瀏覽器直連 Free Dictionary
  report('線上詞典代理失敗，改用 Free Dictionary…');
  const free = await fetchFreeDictionaryRaw(w);
  if (free) return free;
  report('無法抓取線上詞典，改由 AI 依自身知識整理…');
  return '';
}

/** 若使用者未貼補充，自動抓線上詞典；有貼則原樣使用 */
async function resolveCardRaw(word, raw, onStatus) {
  const pasted = String(raw || '').trim();
  if (pasted) return pasted;
  return (await fetchOnlineDictRaw(word, onStatus)) || '';
}


/** 清洗音標：只保留短 IPA，擋掉模型把說明文字塞進音標欄 */
function cleanPhonetic(s) {
  const t = String(s || '').trim();
  if (!t) return '';
  const slash = t.match(/\/[^/\n]{1,48}\//);
  if (slash) return slash[0];
  const bracket = t.match(/\[[^\]\n]{1,48}\]/);
  if (bracket) return bracket[0];
  if (t.length <= 48 && !/\s{2,}|\b(phonetic|IPA|JSON|Note|Let's|provide|American|British|international|alphabet|reference|structure)\b/i.test(t)) {
    return t;
  }
  return '';
}

/** 正規化「音標」段 */
function normalizePhoneticsPart(part) {
  return {
    phonetic_uk: cleanPhonetic(part?.phonetic_uk),
    phonetic_us: cleanPhonetic(part?.phonetic_us),
  };
}

/** 正規化「釋義」段：確保 definitions 是乾淨陣列 */
function normalizeDefinitionsPart(part) {
  let defs = part?.definitions;
  if (typeof defs === 'string' && defs.trim()) {
    defs = [{ pos: '', meaning_zh: defs.trim(), meaning_en: '', example_en: '', example_zh: '' }];
  }
  if (!Array.isArray(defs)) defs = [];
  defs = defs.map(d => ({
    pos: String(d?.pos || '').trim(),
    meaning_zh: String(d?.meaning_zh || '').trim(),
    meaning_en: String(d?.meaning_en || '').trim(),
    example_en: String(d?.example_en || '').trim(),
    example_zh: String(d?.example_zh || '').trim(),
  })).filter(d => d.meaning_zh || d.meaning_en);
  return { definitions: defs };
}

/** 顯示用：髒音標不直接秀出 */
function displayPhonetics(d) {
  const uk = cleanPhonetic(d?.phonetic_uk);
  const us = cleanPhonetic(d?.phonetic_us);
  return [uk && `英 ${esc(uk)}`, us && `美 ${esc(us)}`].filter(Boolean).join('　');
}

// 分段任務：各段輸出小、聚焦，品質較好
const SEGMENTS = [
  {
    key: 'phonetics',
    schema: {
      type: 'object',
      properties: {
        phonetic_uk: {
          type: 'string',
          description: 'British IPA only, e.g. /ˈfreɪm.wɜːk/. Empty string if unknown.',
          maxLength: '40',
        },
        phonetic_us: {
          type: 'string',
          description: 'American IPA only, e.g. /ˈfreɪm.wɝːk/. Empty string if unknown.',
          maxLength: '40',
        },
      },
      required: ['phonetic_uk', 'phonetic_us'],
      propertyOrdering: ['phonetic_uk', 'phonetic_us'],
    },
    temperature: 0.2,
    prompt: (word, raw) => `你是${L().name}發音專家。請只輸出單字「${word}」的音標 JSON。
${rawBlock(raw)}

嚴格規則：
- phonetic_uk：英式 IPA，格式如 /ˈwɜːd/；不知道就填空字串 ""。
- phonetic_us：美式 IPA，格式如 /ˈwɝːd/；不知道就填空字串 ""。
- 每個欄位只能是短音標字串，禁止任何說明、註解、英文散文、JSON 欄位名、思考過程。
只輸出這兩個欄位。`,
  },
  {
    key: 'base',
    schema: {
      type: 'object',
      properties: {
        definitions: _list({
          pos: { type: 'string', description: 'Part of speech, e.g. n. / v. / adj.' },
          meaning_zh: { type: 'string', description: 'Traditional Chinese meaning' },
          meaning_en: { type: 'string', description: 'Optional English gloss; empty string ok' },
          example_en: { type: 'string', description: `${L().name} example sentence` },
          example_zh: { type: 'string', description: 'Traditional Chinese translation of the example' },
        }, ['pos', 'meaning_zh', 'example_en', 'example_zh']),
      },
      required: ['definitions'],
      propertyOrdering: ['definitions'],
    },
    temperature: 0.35,
    prompt: (word, raw) => `你是${L().name}單字整理老師。請只整理單字「${word}」的「釋義」，輸出繁體中文為主的 JSON。
${rawBlock(raw)}

嚴格規則：
- 只輸出 definitions 陣列，不要音標、不要其他欄位。
- 列出最常用的 2～5 個義項。
- 每個義項必須有：pos（詞性，如 n./v./adj.）、meaning_zh（繁中意思）、example_en（${L().name}例句）、example_zh（例句中譯）；meaning_en 可留空字串。
- 禁止把說明文字、思考過程、音標寫進任何欄位。
只做釋義這部分。`,
  },
  {
    key: 'memory',
    schema: {
      type: 'object',
      properties: {
        mnemonics: _list({ type: { type: 'string' }, content: { type: 'string' } }),
        roots: _list({ part: { type: 'string' }, meaning: { type: 'string' } }),
        etymology: { type: 'string' },
      },
    },
    prompt: (word, raw) => `你是記憶法專家。請只針對${L().name}單字「${word}」設計「助記法與詞根詞源」，輸出繁體中文 JSON。
${rawBlock(raw)}

要求：
- mnemonics：重點！用諧音、拆解、聯想、圖像、詞根等方式設計 1～3 個生動好記的中文記憶法。範例風格：melancholy（憂鬱）→「沒人 call 你」。type 填方法類型（如「諧音」「拆解」「詞根聯想」），content 填記憶內容。
- roots：拆解字首、字根、字尾並說明含義。
- etymology：簡短說明字的由來演變。
只做這部分。`,
  },
  {
    key: 'collocation',
    schema: {
      type: 'object',
      properties: {
        collocations: _list({ phrase: { type: 'string' }, meaning: { type: 'string' } }),
        phrases: _list({ phrase: { type: 'string' }, meaning: { type: 'string' } }),
      },
    },
    prompt: (word, raw) => `你是${L().name}單字整理老師。請只整理${L().name}單字「${word}」的「搭配詞與片語」，輸出繁體中文 JSON。
${rawBlock(raw)}

要求：
- collocations：常見搭配用法（動詞+介系詞、形容詞+名詞等），附中文意思。
- phrases：相關片語、慣用語，附中文意思。
只做這部分。`,
  },
  {
    key: 'relation',
    schema: {
      type: 'object',
      properties: {
        synonyms: _list({ word: { type: 'string' }, meaning: { type: 'string' } }),
        antonyms: _list({ word: { type: 'string' }, meaning: { type: 'string' } }),
        context_words: _list({ word: { type: 'string' }, meaning: { type: 'string' }, note: { type: 'string' } }),
        confusing_words: _list({ word: { type: 'string' }, meaning: { type: 'string' }, difference: { type: 'string' } }),
      },
    },
    prompt: (word, raw) => `你是${L().name}單字整理老師。請只整理${L().name}單字「${word}」的「同義詞、反義詞、情境詞、易混淆詞」，輸出繁體中文 JSON。
${rawBlock(raw)}

要求：
- synonyms / antonyms：常見近義、反義字，各附中文意思。
- context_words：這個字常在什麼情境出現？列出常一起出現、前後文常見的相關單詞，note 說明關聯。
- confusing_words：拼字相近或容易搞混的字，difference 說明差異。
只做這部分。`,
  },
  {
    key: 'forms',
    schema: {
      type: 'object',
      properties: {
        word_forms: _list({ label: { type: 'string' }, form: { type: 'string' } }),
        derivatives: _list({ word: { type: 'string' }, pos: { type: 'string' }, meaning: { type: 'string' } }),
      },
    },
    prompt: (word, raw) => `你是${L().name}單字整理老師。請只整理${L().name}單字「${word}」的「詞形變化與詞性變換」，輸出繁體中文 JSON。
${rawBlock(raw)}

要求：
- word_forms：依詞性列出所有變化形。label 用中文標籤、form 填該形式。${currentLang === 'de'
      ? `德文請特別列出：
  - 名詞：「詞性（der/die/das）」「複數」「屬格」
  - 動詞：「現在式(er/sie/es)」「過去式(Präteritum)」「完成式(Partizip II)」「助動詞(haben/sein)」，可附主要不規則變位
  - 形容詞／副詞：「比較級」「最高級」`
      : `例如：
  - 名詞：「複數」
  - 動詞：「第三人稱單數」「現在分詞」「過去式」「過去分詞」
  - 形容詞／副詞：「比較級」「最高級」`}
  不適用的變化就不要列。
- derivatives：詞性變換／派生詞，列出同詞根但不同詞性的相關字，word 填單字、pos 填詞性、meaning 填中文意思。
只做這部分。`,
  },
  {
    key: 'examples',
    schema: {
      type: 'object',
      properties: {
        examples: _list({ en: { type: 'string' }, zh: { type: 'string' } }),
      },
    },
    prompt: (word, raw) => `你是${L().name}單字整理老師。請只整理${L().name}單字「${word}」的「例句庫」，輸出繁體中文 JSON。
${rawBlock(raw)}

要求：
- examples：3～6 句實用例句，涵蓋不同用法，每句 en 填${L().name}例句 + zh 中文翻譯。優先取用原始內容中的好例句。
只做這部分。`,
  },
];

// 一律使用 Vertex AI 通道（aiplatform.googleapis.com）。
// 嚴禁使用 Gemini 通道（generativelanguage.googleapis.com），因無法使用 GCP 抵免額。
function endpointFor(key, model) {
  return `https://aiplatform.googleapis.com/v1/publishers/google/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`;
}

// 單次請求（指定金鑰）
async function requestGemini(key, body, model) {
  const url = endpointFor(key, model || settings.model);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let detail = '';
    try { const j = await res.json(); detail = j.error?.message || ''; } catch {}
    const err = new Error(`回應錯誤 (${res.status})${detail ? '：' + detail : ''}`);
    err.status = res.status;
    // 額度/限流/伺服器錯誤 → 可換下一把金鑰重試
    err.retryable = [429, 500, 502, 503, 504].includes(res.status);
    throw err;
  }
  return res.json();
}

// ---- 全域併發限制器（避免同時打太多請求）----
let inFlight = 0;
const waitQueue = [];
function globalLimit() { return Math.max(1, activeKeys().length || 1); }
function acquireSlot() {
  return new Promise(resolve => {
    if (inFlight < globalLimit()) { inFlight++; resolve(); }
    else waitQueue.push(resolve);
  });
}
function releaseSlot() {
  inFlight--;
  if (waitQueue.length && inFlight < globalLimit()) { inFlight++; waitQueue.shift()(); }
}

// 產生單一段落的 JSON（含金鑰輪詢、重試、併發限制）
async function generateJSON(promptText, schema, opts = {}) {
  const keys = activeKeys();
  if (keys.length === 0) throw new Error('尚未設定 API 金鑰，請到「設定」填入。');
  const body = {
    contents: [{ role: 'user', parts: [{ text: promptText }] }],
    generationConfig: {
      temperature: opts.temperature ?? 0.7,
      maxOutputTokens: opts.maxOutputTokens ?? 8192,
      responseMimeType: 'application/json',
      responseSchema: schema,
    },
  };

  await acquireSlot();
  try {
    let lastErr;
    for (let attempt = 0; attempt < keys.length; attempt++) {
      const idx = keyIndex % keys.length;
      const key = keys[idx];
      keyIndex = (keyIndex + 1) % keys.length;
      try {
        const data = await requestGemini(key, body);
        const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || '';
        if (!text) throw new Error('沒有回傳內容（可能被安全機制擋下或模型名稱錯誤）。');
        try { return JSON.parse(text); }
        catch { throw new Error('無法解析回傳的 JSON。'); }
      } catch (err) {
        lastErr = err;
        if (err.retryable === false || (err.status && ![429, 500, 502, 503, 504].includes(err.status))) {
          throw new Error(`第 ${idx + 1} 把金鑰${err.message}`);
        }
      }
    }
    throw new Error(`所有金鑰都失敗了：${lastErr ? lastErr.message : '未知錯誤'}`);
  } finally {
    releaseSlot();
  }
}

/** 跑單一段並做欄位清洗；釋義空則自動重試一次 */
async function generateSegmentJSON(seg, word, raw) {
  const opts = { temperature: seg.temperature };
  let part = await generateJSON(seg.prompt(word, raw), seg.schema, opts);
  if (seg.key === 'phonetics') return normalizePhoneticsPart(part);
  if (seg.key === 'base') {
    let norm = normalizeDefinitionsPart(part);
    if (!norm.definitions.length) {
      part = await generateJSON(
        seg.prompt(word, raw) + '\n\n上一輪 definitions 為空，請務必輸出至少 2 個完整義項。',
        seg.schema,
        { temperature: 0.15 },
      );
      norm = normalizeDefinitionsPart(part);
    }
    if (!norm.definitions.length) throw new Error('釋義產生失敗（definitions 為空）');
    return norm;
  }
  return part;
}

// 分段整理：把一個字拆成多個焦點小任務，各自輸出小、品質好，最後合併
async function callGemini(word, raw, onProgress) {
  const segs = SEGMENTS;
  let doneCount = 0;
  const report = () => { if (onProgress) onProgress(doneCount, segs.length); };
  report();

  const results = await Promise.all(segs.map(async seg => {
    try {
      const part = await generateSegmentJSON(seg, word, raw);
      doneCount++; report();
      return { ok: true, key: seg.key, part };
    } catch (err) {
      doneCount++; report();
      return { ok: false, key: seg.key, err };
    }
  }));

  // 合併
  const merged = { word };
  results.forEach(r => { if (r.ok && r.part) Object.assign(merged, r.part); });
  merged.word = merged.word || word;
  // 舊卡／髒資料防呆
  Object.assign(merged, normalizePhoneticsPart(merged));
  if (Array.isArray(merged.definitions)) {
    Object.assign(merged, normalizeDefinitionsPart(merged));
  }

  // 至少要有釋義段成功，否則視為失敗（音標失敗可接受）
  const base = results.find(r => r.key === 'base');
  const anyOk = results.some(r => r.ok);
  if (!base?.ok || !anyOk) {
    const firstErr = base?.err || results.find(r => !r.ok)?.err;
    throw new Error(firstErr ? firstErr.message : '整理失敗');
  }
  return merged;
}

/* =========================================================================
   新增單字
   ========================================================================= */
function bindAdd() {
  $('#generateBtn').addEventListener('click', onGenerate);
  $('#clearAddBtn').addEventListener('click', () => {
    $('#wordInput').value = '';
    $('#rawInput').value = '';
    $('#previewArea').innerHTML = '<div class="empty-state small"><p class="empty-sub">整理結果會顯示在這裡</p></div>';
    $('#saveCardBtn').hidden = true;
    $('#genStatus').hidden = true;
    pendingCard = null;
    pendingTtsHolder = { ttsUrls: {} };
    currentEntry = null;
    $('#addHint').textContent = '整理後會顯示預覽，確認無誤再存入詞庫。';
  });
  $('#saveCardBtn').addEventListener('click', onSaveCard);
  $('#previewArea').addEventListener('click', e => {
    const regen = e.target.closest('.seg-regen');
    if (regen) { regenerateSegment(regen.dataset.seg, regen); return; }
    const edit = e.target.closest('[data-edit-card]');
    if (edit) openCardEditor();
  });
  // 檢視已存卡片時，編輯原文會自動存回該卡
  $('#rawInput').addEventListener('input', () => {
    if (currentEntry && currentEntry.card) {
      currentEntry.card.raw = $('#rawInput').value;
      currentEntry.raw = currentEntry.card.raw;
      saveCards();
      debouncedCloudSave(currentEntry.card);
    }
  });
}

// 只重新生成指定段落
async function regenerateSegment(segKey, btn) {
  if (!currentEntry) return;
  const seg = SEGMENTS.find(s => s.key === segKey);
  if (!seg) return;
  const { data, container, word } = currentEntry;
  btn.disabled = true;
  const oldHtml = btn.innerHTML;
  // 用最新的原文（新增頁讀 #rawInput；背誦/彈窗編輯則沿用該卡原文）
  const onAddPage = container && container.id === 'previewArea';
  let raw = onAddPage ? $('#rawInput').value.trim() : (currentEntry.raw || '');
  if (!raw) {
    try {
      raw = await resolveCardRaw(word, '', msg => { btn.innerHTML = `<span class="spinner"></span> ${esc(msg)}`; });
      if (raw && onAddPage) $('#rawInput').value = raw;
    } catch { /* 略過 */ }
  }
  currentEntry.raw = raw;
  if (currentEntry.card) { currentEntry.card.raw = raw; saveCards(); }

  btn.innerHTML = '<span class="spinner"></span> 生成中';
  try {
    const part = await generateSegmentJSON(seg, word, raw);
    // 清掉此段舊欄位再覆蓋
    Object.keys(seg.schema.properties).forEach(k => { delete data[k]; });
    Object.assign(data, part);
    if (seg.key === 'base' || seg.key === 'phonetics') {
      Object.assign(data, normalizePhoneticsPart(data));
    }
    if (currentEntry.onChange) currentEntry.onChange();
    if (currentEntry.card) cloudUpsert(currentEntry.card);
    // 重新渲染（依當前檢視型態：欄位編輯器或預覽）
    if (currentEntry.rerender) currentEntry.rerender();
    else renderPreview(data, container, { editable: true, word, raw, onChange: currentEntry.onChange, card: currentEntry.card });
    toast('已重新生成此段');
  } catch (err) {
    btn.disabled = false;
    btn.innerHTML = oldHtml;
    toast('重新生成失敗：' + err.message, true);
  }
}

async function onGenerate() {
  const word = $('#wordInput').value.trim();
  let raw = $('#rawInput').value.trim();
  if (!word) { toast('請先輸入單字', true); $('#wordInput').focus(); return; }

  if (findExistingCard(word) && !confirm(`「${word}」已經在詞庫中了，仍要重新整理一張新的嗎？`)) return;

  const status = $('#genStatus');
  const btn = $('#generateBtn');
  status.hidden = false;
  status.className = 'gen-status';
  status.innerHTML = '<span class="spinner"></span> 分段整理中…';
  btn.disabled = true;
  $('#saveCardBtn').hidden = true;

  try {
    if (!raw) {
      raw = await resolveCardRaw(word, '', msg => {
        status.innerHTML = `<span class="spinner"></span> ${esc(msg)}`;
      });
      if (raw) {
        $('#rawInput').value = raw;
        toast('已自動抓取線上詞典補充');
      }
    }
    const result = await callGemini(word, raw, (done, total) => {
      status.innerHTML = `<span class="spinner"></span> 分段整理中… (${done}/${total} 段完成)`;
    });
    pendingCard = result;
    renderPreview(result, $('#previewArea'), { editable: true, word, raw, onChange: () => {} });
    $('#saveCardBtn').hidden = false;
    status.hidden = true;
    toast('整理完成，確認後即可存入詞庫');
  } catch (err) {
    status.className = 'gen-status error';
    status.textContent = '⚠️ ' + err.message;
  } finally {
    btn.disabled = false;
  }
}

function addCardFromData(data, raw) {
  const card = { id: uid(), data, raw: raw || '', createdAt: now(), srs: {} };
  STUDY_MODES.forEach(m => card.srs[m.id] = newSrsState());
  cards.unshift(card);
  return card;
}

function onSaveCard() {
  if (!pendingCard) return;
  const card = addCardFromData(pendingCard, $('#rawInput').value.trim());
  if (pendingTtsHolder?.ttsUrls && Object.keys(pendingTtsHolder.ttsUrls).length) {
    card.ttsUrls = { ...pendingTtsHolder.ttsUrls };
  }
  pendingTtsHolder = { ttsUrls: {} };
  saveCards();
  cloudUpsert(card);
  pendingCard = null;
  $('#clearAddBtn').click();
  toast(`已加入「${card.data.word}」`);
  showView('deck');
}

/* =========================================================================
   批次新增（背景多線程整理）
   ========================================================================= */
let batchItems = [];   // { id, word, raw, status, error, data }
let batchActive = 0;   // 目前同時進行中的數量

function bindBatch() {
  $('#batchAddBtn').addEventListener('click', addBatchItem);
  $('#batchWord').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#batchRaw').focus(); }
  });
  $('#batchRaw').addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); addBatchItem(); }
  });
  $('#batchClearDone').addEventListener('click', () => {
    batchItems = batchItems.filter(it => it.status !== 'done');
    renderBatch();
  });
  $('#batchList').addEventListener('click', e => {
    const btn = e.target.closest('.bi-retry');
    if (btn) {
      const it = batchItems.find(x => x.id === btn.closest('.batch-item').dataset.id);
      if (it) { it.status = 'pending'; it.error = ''; renderBatch(); pumpBatch(); }
    }
  });
}

function batchConcurrency() {
  return Math.max(1, activeKeys().length || 1);
}

function addBatchItem() {
  const word = $('#batchWord').value.trim();
  const raw = $('#batchRaw').value.trim();
  if (!word) { toast('請先輸入單字', true); $('#batchWord').focus(); return; }

  const wl = word.toLowerCase();
  const inDeck = !!findExistingCard(word);
  const inQueue = batchItems.some(it => it.word.trim().toLowerCase() === wl);
  if (inDeck || inQueue) {
    const where = inDeck ? '詞庫' : '這批佇列';
    if (!confirm(`「${word}」已經在${where}中了，仍要加入處理嗎？`)) {
      $('#batchWord').focus();
      return;
    }
  }

  const bf = $('#batchFolder');
  let folder = bf ? bf.value : '';
  if (folder === '__new__') {
    folder = createFolder();
    if (bf) bf.value = folder || '';
  }

  batchItems.push({ id: uid(), word, raw, folder: folder || '', status: 'pending', error: '', data: null });
  $('#batchWord').value = '';
  $('#batchRaw').value = '';
  $('#batchWord').focus();
  renderBatch();
  pumpBatch();
}

// 排程器：只要還有空位與待處理項目，就同時往下跑
function pumpBatch() {
  const limit = batchConcurrency();
  while (batchActive < limit) {
    const next = batchItems.find(it => it.status === 'pending');
    if (!next) break;
    runBatchItem(next);
  }
}

async function runBatchItem(it) {
  it.status = 'running';
  it.prog = '';
  batchActive++;
  renderBatch();
  try {
    if (!(it.raw || '').trim()) {
      it.prog = '詞典';
      renderBatch();
      it.raw = await resolveCardRaw(it.word, '', () => {});
    }
    const data = await callGemini(it.word, it.raw, (done, total) => {
      it.prog = `${done}/${total}`;
      renderBatch();
    });
    // 檢查是否為空結果（模型偶爾會回空）
    const empty = !(data.definitions || []).length && !(data.mnemonics || []).length
      && !(data.collocations || []).length && !(data.examples || []).length;
    if (empty) throw new Error('回傳內容為空，請重試');
    it.data = data;
    const newCard = addCardFromData(data, it.raw);
    if (it.folder) newCard.folder = it.folder;
    saveCards();
    cloudUpsert(newCard);
    renderFolderSelects();
    it.status = 'done';
  } catch (err) {
    it.status = 'error';
    it.error = err.message;
  } finally {
    batchActive--;
    renderBatch();
    pumpBatch();
  }
}

function renderBatch() {
  const list = $('#batchList');
  $('#batchCount').textContent = batchItems.length;
  const done = batchItems.filter(i => i.status === 'done').length;
  const running = batchItems.filter(i => i.status === 'running').length;
  const pending = batchItems.filter(i => i.status === 'pending').length;
  const err = batchItems.filter(i => i.status === 'error').length;
  $('#batchProgress').textContent = batchItems.length
    ? `完成 ${done}｜進行中 ${running}｜等待 ${pending}${err ? `｜失敗 ${err}` : ''}` : '';

  if (batchItems.length === 0) {
    list.innerHTML = '<div class="empty-state small"><p class="empty-sub">加入的單字會顯示在這裡，並即時顯示整理狀態</p></div>';
    return;
  }
  const statusText = it => ({
    pending: '⏳ 等待中',
    running: `<span class="spinner"></span> 整理中${it.prog ? ' ' + it.prog + ' 段' : ''}`,
    done: '✅ 已存入',
    error: '❌ 失敗',
  }[it.status]);
  list.innerHTML = batchItems.map(it => `
    <div class="batch-item ${it.status}" data-id="${it.id}">
      <span class="bi-word">${esc(it.word)}</span>
      <span class="bi-status">${statusText(it)}</span>
      ${it.status === 'error' ? `<button class="bi-retry" title="${esc(it.error)}">重試</button>` : ''}
    </div>`).join('');
}

/* =========================================================================
   詞條呈現（預覽 & 詳情共用）
   ========================================================================= */
// 目前正在檢視／編輯的詞條（供分段重新生成使用）
let currentEntry = null; // { data, container, word, raw, onChange }

function renderPreview(d, container, ctx) {
  const editable = !!(ctx && ctx.editable);
  container.oninput = null; container.onclick = null; container._onDone = null; // 清掉編輯器殘留的處理器
  if (editable) {
    currentEntry = { data: d, container, word: ctx.word || d.word, raw: ctx.raw || '', onChange: ctx.onChange, card: ctx.card || null };
    currentEntry.rerender = () => { container.innerHTML = buildEntryHtml(d, true); };
  }
  container.innerHTML = buildEntryHtml(d, editable);
}

// 產生整張卡片的 HTML（editable=true 會顯示編輯/重新生成鈕）
function buildEntryHtml(d, editable) {
  // sec：editable 時即使空白也會顯示區塊與「重新生成」按鈕
  const sec = (title, icon, inner, seg) => {
    if (!inner && !editable) return '';
    const btn = editable && seg ? `<button class="seg-regen" data-seg="${seg}" title="只重新生成這個段落">↻ 重新生成</button>` : '';
    const body = inner || '<div class="seg-empty">（此段目前沒有內容，可按「重新生成」）</div>';
    return `<div class="entry-section"><div class="es-title">${icon} ${title}${btn}</div>${body}</div>`;
  };

  const defs = (d.definitions || []).map(x => `
    <div class="def-item">
      ${x.pos ? `<span class="def-pos">${esc(x.pos)}</span>` : ''}
      <span class="def-zh">${esc(x.meaning_zh)}</span>${x.meaning_zh ? spkZh(x.meaning_zh) : ''}
      ${x.meaning_en ? `<span class="def-en"> — ${esc(x.meaning_en)}</span>` : ''}
      ${x.example_en ? `<div class="example">${esc(x.example_en)}${spk(x.example_en)}<div class="ex-zh">${esc(x.example_zh || '')}${x.example_zh ? spkZh(x.example_zh) : ''}</div></div>` : ''}
    </div>`).join('');

  const formsPills = (d.word_forms || []).length
    ? `<div class="pill-list">${d.word_forms.map(x => `<span class="pill"><b>${esc(x.label)}</b> ${esc(x.form)}${spkw(x.form)}</span>`).join('')}</div>` : '';
  const derivPills = (d.derivatives || []).length
    ? `<div class="pill-list">${d.derivatives.map(x => `<span class="pill"><b>${esc(x.word)}</b>${spkw(x.word)}<span class="pill-zh">${esc(x.pos || '')} ${esc(x.meaning || '')}</span></span>`).join('')}</div>` : '';

  const mnem = (d.mnemonics || []).map(x =>
    `<div class="mnemonic"><span class="mn-type">${esc(x.type || '助記')}</span>${esc(x.content)}</div>`).join('');

  const roots = (d.roots || []).length
    ? `<div class="pill-list">${d.roots.map(r => `<span class="pill"><b>${esc(r.part)}</b><span class="pill-zh">${esc(r.meaning)}</span></span>`).join('')}</div>`
    + (d.etymology ? `<div class="example" style="margin-top:8px">${esc(d.etymology)}</div>` : '')
    : (d.etymology ? `<div class="example">${esc(d.etymology)}</div>` : '');

  const pairPills = (arr, k1, k2) => arr && arr.length
    ? `<div class="pill-list">${arr.map(x => `<span class="pill"><b>${esc(x[k1])}</b>${spk(x[k1])}<span class="pill-zh">${esc(x[k2] || '')}</span></span>`).join('')}</div>` : '';

  const ctxPills = (d.context_words || []).length
    ? `<div class="pill-list">${d.context_words.map(x => `<span class="pill"><b>${esc(x.word)}</b>${spk(x.word)}<span class="pill-zh">${esc(x.meaning || '')}${x.note ? '｜' + esc(x.note) : ''}</span></span>`).join('')}</div>` : '';

  const confus = (d.confusing_words || []).length
    ? `<div class="pill-list">${d.confusing_words.map(x => `<span class="pill"><b>${esc(x.word)}</b>${spk(x.word)}<span class="pill-zh">${esc(x.meaning || '')}${x.difference ? '｜' + esc(x.difference) : ''}</span></span>`).join('')}</div>` : '';

  const examples = (d.examples || []).length
    ? d.examples.map(x => `<div class="example">${esc(x.en)}${spk(x.en)}<div class="ex-zh">${esc(x.zh || '')}</div></div>`).join('') : '';

  const phon = displayPhonetics(d);

  const notesHtml = (d.notes && d.notes.trim())
    ? `<div class="entry-section"><div class="es-title">📝 我的筆記</div><div class="example" style="white-space:pre-wrap">${esc(d.notes)}</div></div>`
    : (editable ? `<div class="entry-section"><div class="es-title">📝 我的筆記</div><div class="seg-empty">（尚無筆記，可按上方「手動編輯」新增）</div></div>` : '');

  const toolbar = editable
    ? `<div class="editor-toolbar"><button class="btn small" data-edit-card>✏️ 手動編輯整張卡</button></div>`
    : '';

  return `
    ${toolbar}
    <div class="entry-word">${esc(d.word)}${spkWord3(d.word)}</div>
    ${phon ? `<div class="entry-phon">${phon}</div>` : ''}
    ${sec('釋義', '📖', defs, 'base')}
    ${notesHtml}
    ${sec('詞形變化', '🔤', formsPills, 'forms')}
    ${sec('詞性變換／派生詞', '🔀', derivPills, 'forms')}
    ${sec('助記法', '💡', mnem, 'memory')}
    ${sec('詞根詞源', '🌱', roots, 'memory')}
    ${sec('搭配詞', '🔗', pairPills(d.collocations, 'phrase', 'meaning'), 'collocation')}
    ${sec('片語', '🧩', pairPills(d.phrases, 'phrase', 'meaning'), 'collocation')}
    ${sec('同義詞', '🟰', pairPills(d.synonyms, 'word', 'meaning'), 'relation')}
    ${sec('反義詞', '↔️', pairPills(d.antonyms, 'word', 'meaning'), 'relation')}
    ${sec('情境詞（常一起出現）', '🎯', ctxPills, 'relation')}
    ${sec('形近／易混淆', '⚠️', confus, 'relation')}
    ${sec('例句庫', '✏️', examples, 'examples')}
  `;
}

// 從檢視切到完整編輯器
function openCardEditor() {
  if (!currentEntry) return;
  const { data, container } = currentEntry;
  const onChangeCb = () => {
    if (currentEntry.onChange) currentEntry.onChange();     // 存 localStorage（已存卡會 saveCards）
    if (currentEntry.card) debouncedCloudSave(currentEntry.card);
  };
  container._onDone = () => renderPreview(data, container, {
    editable: true, word: data.word, raw: currentEntry.raw,
    onChange: currentEntry.onChange, card: currentEntry.card,
  });
  currentEntry.rerender = () => renderEditor(data, container, onChangeCb);
  renderEditor(data, container, onChangeCb);
}

// 直接在容器內開啟「欄位編輯器」（用於詞庫彈窗直接編輯：一鍵可編輯＋可重新生成）
function openCardFieldEditor(container, card, onDone) {
  const onChangeCb = () => { saveCards(); debouncedCloudSave(card); };
  currentEntry = { data: card.data, container, word: card.data.word, raw: card.raw || '', onChange: () => saveCards(), card };
  currentEntry.rerender = () => renderEditor(card.data, container, onChangeCb);
  container._onDone = onDone || null;
  renderEditor(card.data, container, onChangeCb);
}

/* =========================================================================
   卡片完整編輯器（每個欄位都可手動編輯）
   ========================================================================= */
// 陣列型欄位：欄位名 → [ [key, 標籤], ... ]
const ARRAY_FIELDS = {
  definitions: { title: '📖 釋義', cols: [['pos', '詞性'], ['meaning_zh', '中文'], ['meaning_en', '英文'], ['example_en', '例句'], ['example_zh', '例句中譯']] },
  mnemonics: { title: '💡 助記法', cols: [['type', '類型'], ['content', '內容']] },
  roots: { title: '🌱 詞根', cols: [['part', '詞根/詞綴'], ['meaning', '含義']] },
  collocations: { title: '🔗 搭配詞', cols: [['phrase', '搭配'], ['meaning', '中文']] },
  phrases: { title: '🧩 片語', cols: [['phrase', '片語'], ['meaning', '中文']] },
  synonyms: { title: '🟰 同義詞', cols: [['word', '單字'], ['meaning', '中文']] },
  antonyms: { title: '↔️ 反義詞', cols: [['word', '單字'], ['meaning', '中文']] },
  context_words: { title: '🎯 情境詞', cols: [['word', '單字'], ['meaning', '中文'], ['note', '關聯']] },
  confusing_words: { title: '⚠️ 形近／易混淆', cols: [['word', '單字'], ['meaning', '中文'], ['difference', '差異']] },
  word_forms: { title: '🔤 詞形變化', cols: [['label', '變化'], ['form', '形式']] },
  derivatives: { title: '🔀 詞性變換', cols: [['word', '單字'], ['pos', '詞性'], ['meaning', '中文']] },
  examples: { title: '✏️ 例句庫', cols: [['en', '英文'], ['zh', '中文']] },
};

function attr(v) { return esc(v ?? ''); }

// 欄位群組 → 對應可重新生成的段落（seg）
const FIELD_SEG = {
  definitions: 'base', mnemonics: 'memory', collocations: 'collocation',
  synonyms: 'relation', word_forms: 'forms', examples: 'examples',
};

function renderEditor(data, container, onChange) {
  const arrGroup = (field) => {
    const cfg = ARRAY_FIELDS[field];
    const seg = FIELD_SEG[field];
    const regenBtn = seg ? `<button class="seg-regen" data-seg="${seg}" title="用 AI 重新生成此段">↻ 重新生成</button>` : '';
    const rows = (data[field] || []).map((item, i) => {
      const cells = cfg.cols.map(([k, label]) =>
        `<label class="ed-cell"><span>${label}</span><input class="ed-input" data-arr="${field}" data-idx="${i}" data-key="${k}" value="${attr(item[k])}" /></label>`
      ).join('');
      return `<div class="ed-row" style="grid-template-columns:repeat(${cfg.cols.length},1fr) auto">
        ${cells}
        <button class="ed-del-row" data-del="${field}" data-idx="${i}" title="刪除這列">✕</button>
      </div>`;
    }).join('');
    return `<div class="ed-group">
      <div class="ed-title"><span>${cfg.title}</span>${regenBtn}</div>
      ${rows}
      <button class="ed-add" data-add="${field}">＋ 新增一列</button>
    </div>`;
  };

  container.innerHTML = `
    <div class="editor-toolbar">
      <button class="btn primary small" data-editor-done>✓ 完成編輯（回檢視）</button>
      <span class="ed-saved" data-saved hidden>已自動儲存</span>
    </div>
    <div class="ed-group">
      <div class="ed-title"><span>基本</span><button class="seg-regen" data-seg="phonetics" title="用 AI 重新生成音標">↻ 重新生成音標</button></div>
      <label class="ed-field"><span>單字</span><input class="ed-input" data-field="word" value="${attr(data.word)}" /></label>
      <div class="ed-basic-grid">
        <label class="ed-field"><span>英式音標</span><input class="ed-input" data-field="phonetic_uk" value="${attr(cleanPhonetic(data.phonetic_uk) || data.phonetic_uk)}" /></label>
        <label class="ed-field"><span>美式音標</span><input class="ed-input" data-field="phonetic_us" value="${attr(cleanPhonetic(data.phonetic_us) || data.phonetic_us)}" /></label>
      </div>
    </div>
    ${arrGroup('definitions')}
    ${arrGroup('mnemonics')}
    ${arrGroup('roots')}
    <div class="ed-group">
      <div class="ed-title">🌱 詞源</div>
      <textarea class="ed-area" data-field="etymology" rows="2">${esc(data.etymology || '')}</textarea>
    </div>
    ${arrGroup('collocations')}
    ${arrGroup('phrases')}
    ${arrGroup('synonyms')}
    ${arrGroup('antonyms')}
    ${arrGroup('word_forms')}
    ${arrGroup('derivatives')}
    ${arrGroup('context_words')}
    ${arrGroup('confusing_words')}
    ${arrGroup('examples')}
    <div class="ed-group">
      <div class="ed-title">📝 我的筆記</div>
      <textarea class="ed-area" data-field="notes" rows="4" placeholder="寫下自己的記憶方式、例句、易錯點…">${esc(data.notes || '')}</textarea>
    </div>
  `;

  const flashSaved = () => {
    const s = container.querySelector('[data-saved]');
    if (!s) return;
    s.hidden = false;
    clearTimeout(s._t);
    s._t = setTimeout(() => { s.hidden = true; }, 1200);
  };
  const commit = () => { if (onChange) onChange(); flashSaved(); };

  container.oninput = e => {
    const t = e.target;
    if (t.dataset.field) { data[t.dataset.field] = t.value; commit(); }
    else if (t.dataset.arr) {
      const f = t.dataset.arr, i = +t.dataset.idx;
      if (!Array.isArray(data[f])) data[f] = [];
      data[f][i] = data[f][i] || {};
      data[f][i][t.dataset.key] = t.value;
      commit();
    }
  };
  container.onclick = e => {
    const add = e.target.closest('[data-add]');
    const del = e.target.closest('[data-del]');
    const done = e.target.closest('[data-editor-done]');
    if (add) {
      const f = add.dataset.add;
      if (!Array.isArray(data[f])) data[f] = [];
      data[f].push({});
      commit();
      renderEditor(data, container, onChange);
      const inputs = container.querySelectorAll(`[data-arr="${f}"]`);
      if (inputs.length) inputs[inputs.length - ARRAY_FIELDS[f].cols.length].focus();
    } else if (del) {
      data[del.dataset.del].splice(+del.dataset.idx, 1);
      commit();
      renderEditor(data, container, onChange);
    } else if (done && container._onDone) {
      container._onDone();
    }
  };
}

/* =========================================================================
   詞庫
   ========================================================================= */
function bindDeck() {
  $('#deckSearch').addEventListener('input', renderDeck);
  $('#deckList').addEventListener('click', e => {
    if (e.target.closest('.speak-btn')) return; // 喇叭交給全域處理，不開詳情
    const star = e.target.closest('.wc-star');
    if (star) {
      e.stopPropagation();
      const c = cards.find(x => x.id === star.closest('.word-card').dataset.id);
      if (c) {
        c.starred = !c.starred;
        saveCards();
        cloudUpsert(c);
        renderDeck();
        toast(c.starred ? '已加星號' : '已移除星號');
      }
      return;
    }
    if (selectMode) {
      if (e.target.closest('.wc-mnem')) return; // 選取模式下讓助記下拉正常展開
      const card = e.target.closest('.word-card');
      if (card) toggleSelect(card.dataset.id);
      return;
    }
    if (e.target.closest('.wc-mnem')) return; // 點助記下拉不要開詳情
    const del = e.target.closest('.wc-del');
    if (del) {
      e.stopPropagation();
      const id = del.closest('.word-card').dataset.id;
      const c = cards.find(x => x.id === id);
      if (c && confirm(`確定刪除「${c.data.word}」？`)) {
        cards = cards.filter(x => x.id !== id);
        saveCards();
        cloudRemove(id);
        renderDeck();
        toast('已刪除');
      }
      return;
    }
    if (e.target.closest('.wc-folder')) return; // 點資料夾下拉不要開詳情
    const card = e.target.closest('.word-card');
    if (card) openCardDetail(card.dataset.id);
  });
}

function isDue(state) { return (state.due || 0) <= now(); }
function isNew(state) { return (state.reps || 0) === 0 && (state.due || 0) === 0; }

function cardDueCount(card) {
  return STUDY_MODES.filter(m => m.has(card.data) && modeUnlocked(card, m.id) && isDue(card.srs[m.id])).length;
}

/* ---------------------- 資料夾 ---------------------- */
// 所有資料夾名稱（自訂 + 卡片上出現過的）
function allFolders() {
  const set = new Set(folders);
  cards.forEach(c => { if (c.folder) set.add(c.folder); });
  return Array.from(set).sort((a, b) => a.localeCompare(b, 'zh-Hant'));
}
function folderCount(name) {
  if (name === NO_FOLDER) return cards.filter(c => !c.folder).length;
  return cards.filter(c => c.folder === name).length;
}

function renderFolderSelects() {
  const list = allFolders();
  // 詞庫篩選
  const df = $('#deckFolder');
  if (df) {
    df.innerHTML = `<option value="">全部（${cards.length}）</option>`
      + `<option value="${NO_FOLDER}">未分類（${folderCount(NO_FOLDER)}）</option>`
      + list.map(f => `<option value="${esc(f)}">${esc(f)}（${folderCount(f)}）</option>`).join('');
    df.value = deckFolder;
  }
  // 背誦範圍
  const sf = $('#studyFolder');
  if (sf) {
    const prev = sf.value;
    sf.innerHTML = `<option value="">全部</option><option value="${NO_FOLDER}">未分類</option>`
      + list.map(f => `<option value="${esc(f)}">${esc(f)}</option>`).join('');
    sf.value = prev || '';
  }
  // 批次移動目的地
  const mf = $('#moveFolder');
  if (mf) {
    mf.innerHTML = `<option value="">移動到…</option>`
      + `<option value="${NO_FOLDER}">未分類</option>`
      + list.map(f => `<option value="${esc(f)}">${esc(f)}</option>`).join('')
      + `<option value="__new__">＋ 新資料夾…</option>`;
    mf.value = '';
  }
  // 批次新增：目標資料夾
  const bf = $('#batchFolder');
  if (bf) {
    const prev = bf.value;
    bf.innerHTML = `<option value="">未分類</option>`
      + list.map(f => `<option value="${esc(f)}">${esc(f)}</option>`).join('')
      + `<option value="__new__">＋ 新資料夾…</option>`;
    bf.value = list.includes(prev) ? prev : '';
  }
}

// 產生卡片上的資料夾下拉
function folderSelectHtml(card) {
  const list = allFolders();
  const opts = `<option value="">未分類</option>`
    + list.map(f => `<option value="${esc(f)}" ${card.folder === f ? 'selected' : ''}>${esc(f)}</option>`).join('')
    + `<option value="__new__">＋ 新資料夾…</option>`;
  return `<select class="wc-folder" data-id="${card.id}">${opts}</select>`;
}

function createFolder() {
  const name = (prompt('新資料夾名稱：') || '').trim();
  if (!name) return '';
  if (name === NO_FOLDER || name === '__new__') { toast('名稱不可使用', true); return ''; }
  if (!folders.includes(name)) { folders.push(name); saveFolders(); }
  renderFolderSelects();
  return name;
}

// 重新命名目前在詞庫選取的資料夾
function renameCurrentFolder() {
  const old = deckFolder;
  if (!old || old === NO_FOLDER) { toast('請先在上方選一個要改名的資料夾', true); return; }
  const name = (prompt(`把「${old}」改名為：`, old) || '').trim();
  if (!name || name === old) return;
  if (name === NO_FOLDER || name === '__new__') { toast('名稱不可使用', true); return; }
  // 更新資料夾清單（合併到既有同名）
  folders = folders.filter(f => f !== old);
  if (!folders.includes(name)) folders.push(name);
  saveFolders();
  // 更新所有卡片
  cards.forEach(c => {
    if (c.folder === old) { c.folder = name; cloudUpsert(c); }
  });
  saveCards();
  deckFolder = name;
  renderFolderSelects();
  renderDeck();
  toast(`已改名為「${name}」`);
}

function bindDeckControls() {
  $('#deckFolder').addEventListener('change', e => { deckFolder = e.target.value; renderDeck(); });
  $('#deckSort').addEventListener('change', e => { deckSort = e.target.value; renderDeck(); });
  $('#newFolderBtn').addEventListener('click', () => {
    const name = createFolder();
    if (name) { deckFolder = name; renderFolderSelects(); renderDeck(); }
  });
  $('#renameFolderBtn').addEventListener('click', renameCurrentFolder);
  // 只看星號
  $('#starFilterBtn').addEventListener('click', () => {
    starOnly = !starOnly;
    $('#starFilterBtn').classList.toggle('active', starOnly);
    renderDeck();
  });
  // 批次選取
  $('#selectModeBtn').addEventListener('click', () => setSelectMode(!selectMode));
  $('#selectCancelBtn').addEventListener('click', () => setSelectMode(false));
  $('#selectAll').addEventListener('change', e => {
    if (e.target.checked) lastFilteredIds.forEach(id => selectedIds.add(id));
    else selectedIds.clear();
    renderDeck();
    updateSelectBar();
  });
  $('#moveFolder').addEventListener('change', e => {
    const sel = e.target;
    let val = sel.value;
    if (!val && val !== '') return;
    if (!selectedIds.size) { toast('尚未勾選任何卡片', true); sel.value = ''; return; }
    if (val === '__new__') {
      val = createFolder();
      if (!val) { sel.value = ''; return; }
    }
    moveSelectedTo(val === NO_FOLDER ? '' : val);
    sel.value = '';
  });
  // 卡片上的資料夾下拉（事件委派）
  $('#deckList').addEventListener('change', e => {
    const sel = e.target.closest('.wc-folder');
    if (!sel) return;
    const card = cards.find(c => c.id === sel.dataset.id);
    if (!card) return;
    let val = sel.value;
    if (val === '__new__') {
      val = createFolder();
      if (!val) { renderDeck(); return; }
    }
    card.folder = val;
    saveCards();
    cloudUpsert(card);
    renderFolderSelects();
    renderDeck();
    toast(val ? `已移到「${val}」` : '已設為未分類');
  });
}

/* ---------------------- 批次選取 / 移動 ---------------------- */
function setSelectMode(on) {
  selectMode = on;
  selectedIds.clear();
  const bar = $('#selectBar');
  if (bar) bar.hidden = !on;
  const ctrls = $('#selectControls');
  if (ctrls) ctrls.hidden = !on;
  const btn = $('#selectModeBtn');
  if (btn) btn.classList.toggle('active', on);
  renderDeck();
  updateSelectBar();
}
function toggleSelect(id) {
  if (selectedIds.has(id)) selectedIds.delete(id); else selectedIds.add(id);
  const el = document.querySelector(`.word-card[data-id="${id}"]`);
  if (el) {
    el.classList.toggle('checked', selectedIds.has(id));
    const cb = el.querySelector('.wc-check');
    if (cb) cb.checked = selectedIds.has(id);
  }
  updateSelectBar();
}
function updateSelectBar() {
  const cnt = $('#selectCount');
  if (cnt) cnt.textContent = `已選 ${selectedIds.size}`;
  const all = $('#selectAll');
  if (all) {
    const total = lastFilteredIds.length;
    const sel = lastFilteredIds.filter(id => selectedIds.has(id)).length;
    all.checked = total > 0 && sel === total;
    all.indeterminate = sel > 0 && sel < total;
  }
}
function moveSelectedTo(folder) {
  const ids = Array.from(selectedIds);
  let moved = 0;
  ids.forEach(id => {
    const card = cards.find(c => c.id === id);
    if (!card) return;
    card.folder = folder;
    cloudUpsert(card);
    moved++;
  });
  saveCards();
  setSelectMode(false);
  renderFolderSelects();
  renderDeck();
  toast(`已把 ${moved} 張移到「${folder || '未分類'}」`);
}

/* ---------------------- 每日目標 / 簽到 ---------------------- */
function rolloverDaily() {
  if (daily.date !== todayStr()) { daily.date = todayStr(); daily.count = 0; daily.countedIds = []; saveDaily(); }
}
// 今日複習目標：每個單字翻過一次就算一個，重複（不同模式/再翻）不重複計
function updateDailyOnReview(cardId) {
  rolloverDaily();
  if (!Array.isArray(daily.countedIds)) daily.countedIds = [];
  if (daily.countedIds.includes(cardId)) return; // 這個字今天已經算過
  daily.countedIds.push(cardId);
  daily.count = daily.countedIds.length;
  const goal = settings.dailyGoal || 0;
  if (goal > 0 && daily.count >= goal && daily.lastMetDate !== todayStr()) {
    daily.streak = (daily.lastMetDate === yesterdayStr()) ? (daily.streak + 1) : 1;
    daily.lastMetDate = todayStr();
    toast(`🎉 今日達標！連續簽到 ${daily.streak} 天`);
  }
  saveDaily();
  renderDailyPanel();
}
// GitHub 風格熱力圖：越深代表當天翻閱越多張卡
function heatLevel(n) {
  if (n <= 0) return 0;
  if (n < 3) return 1;
  if (n < 6) return 2;
  if (n < 11) return 3;
  return 4;
}
function renderHeatmap() {
  const hist = loadJSON(nsKey(LS_DAILY_HIST), {});
  const weeks = 53; // 約一年（GitHub 風格）
  const WD = ['週日', '週一', '週二', '週三', '週四', '週五', '週六'];
  const today = new Date(); today.setHours(0, 0, 0, 0);
  // 對齊到本週週日；讓今天落在最後一欄
  const start = new Date(today);
  start.setDate(today.getDate() - today.getDay() - (weeks - 1) * 7);

  let total = 0;
  let cols = '';
  let months = '';
  let prevMonth = -1;
  for (let w = 0; w < weeks; w++) {
    // 這一欄（週）第一天，決定是否標月份
    const firstDay = new Date(start); firstDay.setDate(start.getDate() + w * 7);
    const mo = firstDay.getMonth();
    months += `<span class="heat-mo">${mo !== prevMonth ? (mo + 1) + '月' : ''}</span>`;
    prevMonth = mo;

    let cells = '';
    for (let d = 0; d < 7; d++) {
      const cur = new Date(start);
      cur.setDate(start.getDate() + w * 7 + d);
      const key = dateStr(cur);
      const future = cur > today;
      const n = hist[key] || 0;
      if (!future) total += n;
      const lvl = future ? 'f' : heatLevel(n);
      const tip = `${key}（${WD[cur.getDay()]}）｜${future ? '—' : n + ' 張'}`;
      cells += `<span class="heat-cell l${lvl}" title="${tip}"></span>`;
    }
    cols += `<div class="heat-col">${cells}</div>`;
  }

  // 左側星期標籤（僅一、三、五，對齊 GitHub）
  const wdLabels = [0, 1, 2, 3, 4, 5, 6]
    .map(i => `<span class="heat-wd">${[1, 3, 5].includes(i) ? WD[i].slice(1) : ''}</span>`).join('');

  return `<div class="dp-heat">
      <div class="heat-title">最近一年複習（越深＝當天翻越多張，共 ${total} 張）</div>
      <div class="heat-cal">
        <div class="heat-weekdays"><span class="heat-wd-spacer"></span>${wdLabels}</div>
        <div class="heat-gridwrap">
          <div class="heat-months">${months}</div>
          <div class="heat-grid">${cols}</div>
        </div>
      </div>
    </div>`;
}

function renderDailyPanel() {
  const el = $('#dailyPanel');
  if (!el) return;
  rolloverDaily();
  const goal = settings.dailyGoal || 0;
  const count = daily.count || 0;
  const pct = goal > 0 ? Math.min(100, Math.round(count / goal * 100)) : 0;
  const met = goal > 0 && count >= goal;
  el.innerHTML = `
    ${renderHeatmap()}
    <div class="dp-main">
      <div class="dp-title">📅 今日複習目標 ${met ? '<span class="dp-check">✅ 已簽到</span>' : ''}</div>
      <div class="daily-bar ${met ? 'done' : ''}"><i style="width:${pct}%"></i></div>
      <div class="dp-num">${count} / ${goal || '—'} 個單字（每字只算一次）${met ? '' : goal ? `　還差 ${goal - count} 個` : ''}</div>
    </div>
    <div class="daily-streak">
      <div class="ds-num">${daily.streak || 0}</div>
      <div class="ds-label">連續天數</div>
    </div>`;
}

function renderDeck() {
  const q = $('#deckSearch').value.trim().toLowerCase();
  const list = $('#deckList');
  const empty = $('#deckEmpty');

  // 統計（以「單字」為單位）
  let dueTotal = 0, newTotal = 0;
  cards.forEach(c => {
    if (cardNeverStudied(c)) newTotal++;        // 還沒遇到的字
    else if (cardHasDueToday(c)) dueTotal++;     // 有到期複習的字
  });
  $('#statTotal').textContent = cards.length;
  $('#statDue').textContent = dueTotal;
  $('#statNew').textContent = newTotal;

  let filtered = cards.filter(c => {
    // 只看星號
    if (starOnly && !c.starred) return false;
    // 資料夾篩選
    if (deckFolder === NO_FOLDER) { if (c.folder) return false; }
    else if (deckFolder) { if (c.folder !== deckFolder) return false; }
    // 搜尋
    if (!q) return true;
    const d = c.data;
    const hay = [d.word, ...(d.definitions || []).map(x => x.meaning_zh)].join(' ').toLowerCase();
    return hay.includes(q);
  });

  // 排序
  filtered.sort((a, b) => {
    if (deckSort === 'created_asc') return (a.createdAt || 0) - (b.createdAt || 0);
    if (deckSort === 'alpha') return (a.data.word || '').localeCompare(b.data.word || '', 'en');
    return (b.createdAt || 0) - (a.createdAt || 0); // created_desc
  });

  lastFilteredIds = filtered.map(c => c.id);
  // 清掉已不在畫面上的勾選
  Array.from(selectedIds).forEach(id => { if (!lastFilteredIds.includes(id)) selectedIds.delete(id); });

  if (cards.length === 0) { list.innerHTML = ''; empty.style.display = 'block'; return; }
  empty.style.display = 'none';

  list.innerHTML = filtered.map(c => {
    const d = c.data;
    const mean = (d.definitions || []).map(x => (x.pos ? x.pos + ' ' : '') + x.meaning_zh).join('；');
    const phon = cleanPhonetic(d.phonetic_us) || cleanPhonetic(d.phonetic_uk) || '';
    const due = cardDueCount(c);
    const created = c.createdAt ? dateStr(new Date(c.createdAt)) : '';
    const mnems = d.mnemonics || [];
    const tags = [];
    if (due > 0) tags.push(`<span class="wc-tag due">待複習 ${due}</span>`);
    if (created) tags.push(`<span class="wc-tag">🗓 ${created}</span>`);
    const mnemDrop = mnems.length ? `
      <details class="wc-mnem">
        <summary>💡 助記法（${mnems.length}）</summary>
        <div class="wc-mnem-body">${mnems.map(m => `<div class="wc-mnem-item"><span class="mn-type">${esc(m.type || '助記')}</span>${esc(m.content)}</div>`).join('')}</div>
      </details>` : '';
    const checked = selectedIds.has(c.id);
    return `
      <div class="word-card${selectMode ? ' selecting' : ''}${checked ? ' checked' : ''}" data-id="${c.id}">
        ${selectMode
        ? `<input type="checkbox" class="wc-check" ${checked ? 'checked' : ''} tabindex="-1" />`
        : `<button class="wc-del" title="刪除">✕</button>`}
        <div class="wc-word"><button class="wc-star${c.starred ? ' on' : ''}" title="${c.starred ? '移除星號' : '加星號'}">${c.starred ? '★' : '☆'}</button>${esc(d.word)}${spkWord3(d.word)}</div>
        ${phon ? `<div class="wc-phon">${esc(phon)}</div>` : ''}
        <div class="wc-mean">${esc(mean || '（無釋義）')}</div>
        ${tags.length ? `<div class="wc-tags">${tags.join('')}</div>` : ''}
        ${mnemDrop}
        ${selectMode ? '' : folderSelectHtml(c)}
      </div>`;
  }).join('');
  updateSelectBar();
}

// 點詞庫單字：彈出視窗看整張卡片重點（唯讀）
let modalCardId = null;
function setModalReadonly(c) {
  $('#modalBody').innerHTML = buildEntryHtml(c.data, false);
  const btn = $('#modalEditBtn');
  btn.textContent = '✏️ 編輯';
  btn.dataset.editing = '';
}
function openCardDetail(id) {
  const c = cards.find(x => x.id === id);
  if (!c) return;
  modalCardId = id;
  // 讓彈窗內按 AI 語音能對應到這張卡並寫入 ttsUrls
  currentEntry = {
    data: c.data, container: $('#modalBody'), word: c.data.word,
    raw: c.raw || '', card: c,
  };
  setModalReadonly(c);
  const modal = $('#cardModal');
  modal.hidden = false;
  document.body.classList.add('modal-open');
  $('#modalBody').scrollTop = 0;
}
function closeCardModal() {
  $('#cardModal').hidden = true;
  document.body.classList.remove('modal-open');
  modalCardId = null;
  currentEntry = null;
  renderDeck(); // 反映剛剛在彈窗內的編輯
}
function bindCardModal() {
  $('#modalCloseBtn').addEventListener('click', closeCardModal);
  $('#cardModal').querySelectorAll('[data-close-modal]').forEach(el =>
    el.addEventListener('click', closeCardModal));
  // 直接在彈窗內編輯（不跳到新增頁）
  $('#modalEditBtn').addEventListener('click', () => {
    const c = cards.find(x => x.id === modalCardId);
    if (!c) return;
    const btn = $('#modalEditBtn');
    if (btn.dataset.editing === '1') {
      setModalReadonly(c);
      renderDeck();
    } else {
      // 直接進入「欄位編輯器」：每個欄位都能改，且各段可重新生成
      openCardFieldEditor($('#modalBody'), c, () => { setModalReadonly(c); renderDeck(); });
      btn.textContent = '✓ 完成'; btn.dataset.editing = '1';
      $('#modalBody').scrollTop = 0;
    }
  });
  // 彈窗內：各段重新生成（欄位編輯器與預覽皆適用）／手動編輯整張卡
  $('#modalBody').addEventListener('click', e => {
    const regen = e.target.closest('.seg-regen');
    if (regen) { regenerateSegment(regen.dataset.seg, regen); return; }
    if (e.target.closest('[data-edit-card]')) openCardEditor();
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !$('#cardModal').hidden) closeCardModal();
  });
}

// 完整編輯：借用新增頁的預覽區，可逐段重新生成
function editCardFull(id) {
  const c = cards.find(x => x.id === id);
  if (!c) return;
  showView('add');
  $('#wordInput').value = c.data.word;
  $('#rawInput').value = c.raw || '';
  renderPreview(c.data, $('#previewArea'), {
    editable: true,
    word: c.data.word,
    raw: c.raw || '',
    onChange: () => saveCards(),
    card: c,
  });
  $('#saveCardBtn').hidden = true;
  $('#genStatus').hidden = true;
  $('#addHint').textContent = c.raw
    ? '（編輯模式）左側為已保存的歐路原文，可修改（自動存檔）；各段可單獨「重新生成」。'
    : '（編輯模式）這張卡沒有保存原文。可在左側貼上歐路內容（自動存檔）後再重新生成各段。';
  pendingCard = null;
  $('#previewArea').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

/* =========================================================================
   背誦：設定畫面
   ========================================================================= */
function getSelectedModes() {
  return $$('.mode-item input:checked').map(i => i.value);
}

function renderModeGrid() {
  const grid = $('#modeGrid');
  const prevSelected = grid.dataset.init ? getSelectedModes() : ['en2zh', 'spelling'];
  grid.innerHTML = STUDY_MODES.map(m => {
    const avail = cards.filter(c => m.has(c.data) && modeUnlocked(c, m.id));
    const dueCount = avail.filter(c => isDue(c.srs[m.id])).length;
    const lockedCount = BASIC_MODES.includes(m.id) ? 0
      : cards.filter(c => m.has(c.data) && !modeUnlocked(c, m.id)).length;
    const checked = prevSelected.includes(m.id) ? 'checked' : '';
    const countHtml = `待複習 ${dueCount}`
      + (lockedCount > 0 ? ` <span class="mi-lock">🔒 ${lockedCount} 待解鎖</span>` : '');
    return `
      <label class="mode-item ${checked ? 'on' : ''}">
        <input type="checkbox" value="${m.id}" ${checked} />
        <div>
          <div class="mi-name">${m.name}${BASIC_MODES.includes(m.id) ? '' : ' <span class="mi-badge">進階</span>'}</div>
          <div class="mi-desc">${m.desc}</div>
          <div class="mi-count">${countHtml}</div>
        </div>
      </label>`;
  }).join('');
  grid.dataset.init = '1';
  $$('.mode-item input').forEach(inp => {
    inp.addEventListener('change', () => {
      inp.closest('.mode-item').classList.toggle('on', inp.checked);
    });
  });
}

function bindStudySetup() {
  $('#startStudyBtn').addEventListener('click', startStudy);
  $('#backToSetupBtn').addEventListener('click', resetStudyToSetup);
}

function resetStudyToSetup() {
  $('#studySetup').hidden = false;
  $('#studyCard').hidden = true;
  $('#studyDone').hidden = true;
  renderModeGrid();
}

/* =========================================================================
   背誦：排程與流程
   ========================================================================= */
let session = null; // { queue: [{cardId, mode}], idx, reviewed }

function startStudy() {
  const modes = getSelectedModes();
  if (modes.length === 0) { toast('請至少選一種背誦模式', true); return; }
  const scope = document.querySelector('input[name="scope"]:checked').value;
  const limit = parseInt($('#studyLimit').value, 10) || 0;
  const folder = $('#studyFolder').value;

  let queue = [];
  cards.forEach(c => {
    // 資料夾篩選
    if (folder === NO_FOLDER) { if (c.folder) return; }
    else if (folder) { if (c.folder !== folder) return; }
    modes.forEach(mid => {
      const m = STUDY_MODES.find(x => x.id === mid);
      if (!m.has(c.data)) return;
      if (!modeUnlocked(c, mid)) return; // 進階模式要先熟悉英→中或中→英
      if (scope === 'due' && !isDue(c.srs[mid])) return;
      queue.push({ cardId: c.id, mode: mid });
    });
  });

  if (queue.length === 0) {
    const onlyAdvanced = modes.every(mid => !BASIC_MODES.includes(mid));
    if (onlyAdvanced) {
      $('#studySetupHint').textContent = '這些是進階模式，需要先用「英→中」或「中→英」把單字背熟後才會解鎖喔！';
    } else {
      $('#studySetupHint').textContent = scope === 'due'
        ? '目前沒有到期的卡片，選「全部卡片」或換個資料夾吧！'
        : '沒有可背誦的卡片，先去新增單字吧！';
    }
    return;
  }
  $('#studySetupHint').textContent = '';

  // 洗牌
  for (let i = queue.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [queue[i], queue[j]] = [queue[j], queue[i]];
  }

  // 限制本次數量
  if (limit > 0 && queue.length > limit) queue = queue.slice(0, limit);

  session = { queue, idx: 0, reviewed: 0, total: queue.length, results: [], modes, scope };
  $('#studySetup').hidden = true;
  $('#studyDone').hidden = true;
  $('#studyCard').hidden = false;
  showCurrentCard();
}

function currentItem() { return session.queue[session.idx]; }

// 某張卡在基礎模式熟悉後，把本輪已勾選、剛解鎖的進階模式補進佇列
function enqueueUnlockedModes(card) {
  if (!session || !session.modes) return;
  if (!cardBasicLearned(card)) return;
  session.modes.forEach(mid => {
    if (BASIC_MODES.includes(mid)) return;
    const m = STUDY_MODES.find(x => x.id === mid);
    if (!m || !m.has(card.data)) return;
    if (!modeUnlocked(card, mid)) return;
    // 已在佇列或本輪已做過就略過
    if (session.queue.some(q => q.cardId === card.id && q.mode === mid)) return;
    if (session.results.some(r => r.cardId === card.id && r.mode === mid)) return;
    session.queue.push({ cardId: card.id, mode: mid });
    session.total++;
  });
}

function showCurrentCard() {
  // 換卡時立刻中斷上一張的朗讀
  stopStudySpeech();
  // 換卡時關閉編輯面板
  if (studyEditing) {
    studyEditing = false;
    $('#studyEditor').hidden = true;
    $('#studyEditor').innerHTML = '';
    $('#editCardBtn').textContent = '✏️ 編輯';
  }
  const item = currentItem();
  const card = cards.find(c => c.id === item.cardId);
  const mode = STUDY_MODES.find(m => m.id === item.mode);

  $('#studyCounter').textContent = `${session.reviewed + 1} / ${session.total}`;
  $('#studyModeBadge').textContent = mode.name;

  const { front, back } = renderFaces(card.data, item.mode);
  $('#cardFront').innerHTML = front;
  const backEl = $('#cardBack');
  backEl.innerHTML = back;
  backEl.hidden = true;

  $('#showAnswerBtn').hidden = false;
  $('#rateBtns').hidden = true;

  updateRateLabels(card.srs[item.mode]);

  if (item.mode === 'spelling') {
    const inp = $('#spellInput');
    if (inp) {
      setTimeout(() => inp.focus(), 50);
      inp.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); if (!$('#showAnswerBtn').hidden) revealAnswer(); }
      });
    }
  }
  // 切到新卡：只朗讀題面（不洩漏答案）
  autoSpeakFront(card.data, item.mode);
}

function escapeReg(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// 找一句包含此單字的例句，用於克漏字
function clozeSentence(d) {
  const cands = [];
  (d.definitions || []).forEach(x => { if (x.example_en) cands.push({ en: x.example_en, zh: x.example_zh }); });
  (d.examples || []).forEach(x => { if (x.en) cands.push({ en: x.en, zh: x.zh }); });
  if (!cands.length) return null;
  const re = new RegExp('\\b' + escapeReg((d.word || '').trim()) + '\\b', 'i');
  return cands.find(c => re.test(c.en)) || cands[0];
}

function renderFaces(d, mode) {
  const phon = cleanPhonetic(d.phonetic_us) || cleanPhonetic(d.phonetic_uk) || '';
  const wordBlock = `<div class="fc-word">${esc(d.word)}${spkWord3(d.word)}</div>${phon ? `<div class="fc-phon">${esc(phon)}</div>` : ''}`;
  const defsFull = (d.definitions || []).map(x => `
    <div class="def-item">
      ${x.pos ? `<span class="def-pos">${esc(x.pos)}</span>` : ''}
      <span class="def-zh">${esc(x.meaning_zh)}</span>
      ${x.meaning_en ? `<span class="def-en"> — ${esc(x.meaning_en)}</span>` : ''}
      ${x.example_en ? `<div class="example">${esc(x.example_en)}${spk(x.example_en)}<div class="ex-zh">${esc(x.example_zh || '')}</div></div>` : ''}
    </div>`).join('');

  const pairPills = (arr, k1, k2) =>
    `<div class="pill-list">${(arr || []).map(x => `<span class="pill"><b>${esc(x[k1])}</b><span class="pill-zh">${esc(x[k2] || '')}</span></span>`).join('')}</div>`;

  let front = '', back = '';

  if (mode === 'en2zh') {
    front = wordBlock + `<div class="fc-prompt">${L().askMeaning}</div>`;
    back = `<div class="entry-section"><div class="es-title">📖 釋義</div>${defsFull}</div>`
      + mnemBlock(d);
  } else if (mode === 'zh2en') {
    const zh = (d.definitions || []).map(x => (x.pos ? x.pos + ' ' : '') + x.meaning_zh).join('；');
    front = `<div class="fc-zh-main">${esc(zh)}</div><div class="fc-prompt">${L().askWord}</div>`;
    back = wordBlock + mnemBlock(d)
      + `<div class="entry-section" style="margin-top:14px"><div class="es-title">📖 釋義</div>${defsFull}</div>`;
  } else if (mode === 'collocation') {
    front = wordBlock + `<div class="fc-prompt">常見的「搭配詞」有哪些？</div>`;
    back = `<div class="entry-section"><div class="es-title">🔗 搭配詞</div>${pairPills(d.collocations, 'phrase', 'meaning')}</div>`;
  } else if (mode === 'context') {
    front = wordBlock + `<div class="fc-prompt">常一起出現的「情境詞」有哪些？</div>`;
    const ctx = `<div class="pill-list">${(d.context_words || []).map(x => `<span class="pill"><b>${esc(x.word)}</b><span class="pill-zh">${esc(x.meaning || '')}${x.note ? '｜' + esc(x.note) : ''}</span></span>`).join('')}</div>`;
    back = `<div class="entry-section"><div class="es-title">🎯 情境詞</div>${ctx}</div>`;
  } else if (mode === 'synonym') {
    front = wordBlock + `<div class="fc-prompt">「同義／近義詞」有哪些？</div>`;
    back = `<div class="entry-section"><div class="es-title">🟰 同義詞</div>${pairPills(d.synonyms, 'word', 'meaning')}</div>`
      + ((d.antonyms || []).length ? `<div class="entry-section"><div class="es-title">↔️ 反義詞</div>${pairPills(d.antonyms, 'word', 'meaning')}</div>` : '');
  } else if (mode === 'phrase') {
    front = wordBlock + `<div class="fc-prompt">相關的「片語」有哪些？</div>`;
    back = `<div class="entry-section"><div class="es-title">🧩 片語</div>${pairPills(d.phrases, 'phrase', 'meaning')}</div>`;
  } else if (mode === 'spelling') {
    const sent = clozeSentence(d);
    const zhHint = (d.definitions || []).map(x => x.meaning_zh).filter(Boolean).join('；');
    let clozeHtml = '';
    if (sent) {
      const re = new RegExp('\\b' + escapeReg((d.word || '').trim()) + '\\b', 'gi');
      clozeHtml = `<div class="spell-cloze">${esc(sent.en).replace(re, '<span class="blank">＿＿＿＿</span>')}</div>`
        + (sent.zh ? `<div class="spell-hint-zh">${esc(sent.zh)}</div>` : '');
    }
    front = `<div class="spell-top">🔊 聽整句，拼出單字 <button class="speak-btn" data-speak="${esc(sent ? sent.en : d.word)}" data-src="browser" type="button" title="再聽一次整句">🔁 播放</button></div>`
      + clozeHtml
      + `<input id="spellInput" class="spell-input" placeholder="在此輸入單字…" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" />`
      + (zhHint ? `<div class="fc-prompt">提示：${esc(zhHint)}</div>` : '')
      + `<div class="fc-prompt">按 Enter 或「顯示答案」對答案</div>`;
    back = wordBlock;
    if (sent) back += `<div class="entry-section" style="margin-top:12px"><div class="example">${esc(sent.en)}${spk(sent.en)}<div class="ex-zh">${esc(sent.zh || '')}</div></div></div>`;
    back += mnemBlock(d);
  } else if (mode === 'forms') {
    front = wordBlock + `<div class="fc-prompt">它的「詞形變化 / 詞性變換」有哪些？</div>`;
    const forms = (d.word_forms || []).length
      ? `<div class="pill-list">${d.word_forms.map(x => `<span class="pill"><b>${esc(x.label)}</b> ${esc(x.form)}${spkw(x.form)}</span>`).join('')}</div>` : '';
    const derivs = (d.derivatives || []).length
      ? `<div class="pill-list">${d.derivatives.map(x => `<span class="pill"><b>${esc(x.word)}</b>${spkw(x.word)}<span class="pill-zh">${esc(x.pos || '')} ${esc(x.meaning || '')}</span></span>`).join('')}</div>` : '';
    back = (forms ? `<div class="entry-section"><div class="es-title">🔤 詞形變化</div>${forms}</div>` : '')
      + (derivs ? `<div class="entry-section"><div class="es-title">🔀 詞性變換／派生詞</div>${derivs}</div>` : '');
  }
  // 答案面：先放「該模式專屬答案區」，再放完整字卡
  back = modeAnswerBlock(d, mode) + buildEntryHtml(d, false);
  return { front, back };
}

// 克漏字遮罩：保留目標單字，其餘字用底線提示（長度近似）
function clozeMask(phrase, keepWord) {
  const kw = (keepWord || '').trim().toLowerCase();
  return String(phrase || '').split(/\s+/).map(w => {
    const bare = w.replace(/[^\p{L}\p{N}]/gu, '');
    if (kw && bare.toLowerCase() === kw) return esc(w);
    return `<span class="cloze-blank">${'＿'.repeat(Math.max(2, bare.length))}</span>`;
  }).join(' ');
}

// 各背誦模式的「專屬答案區」（顯示在完整字卡最上方）
function modeAnswerBlock(d, mode) {
  const wrap = (title, inner) => inner
    ? `<div class="mode-answer"><div class="ma-title">${title}</div>${inner}</div>` : '';
  const clozeLines = (arr, key) => (arr || []).map(x =>
    `<div class="ma-line">${clozeMask(x[key], d.word)}　<span class="ma-zh">${esc(x.meaning || '')}</span>${spk(x[key])}<span class="ma-ans">（答案：${esc(x[key])}）</span></div>`).join('');

  if (mode === 'collocation') return wrap('🔗 搭配詞（克漏字，附中文提示）', clozeLines(d.collocations, 'phrase'));
  if (mode === 'phrase') return wrap('🧩 片語（克漏字，附中文提示）', clozeLines(d.phrases, 'phrase'));

  if (mode === 'context') {
    const pills = (d.context_words || []).length
      ? `<div class="pill-list">${d.context_words.map(x => `<span class="pill"><b>${esc(x.word)}</b>${spk(x.word)}<span class="pill-zh">${esc(x.meaning || '')}${x.note ? '｜' + esc(x.note) : ''}</span></span>`).join('')}</div>` : '';
    const exs = exampleSentencesOf(d);
    const exHtml = exs.length
      ? `<div class="ma-sub">例句提示：</div>` + exs.map(s => `<div class="ma-line">${esc(s)}${spk(s)}</div>`).join('') : '';
    return wrap('🎯 情境詞（例句作提示）', pills + exHtml);
  }

  if (mode === 'synonym') {
    const syn = (d.synonyms || []).length
      ? `<div class="pill-list">${d.synonyms.map(x => `<span class="pill"><b>${esc(x.word)}</b>${spk(x.word)}<span class="pill-zh">${esc(x.meaning || '')}</span></span>`).join('')}</div>` : '';
    const ant = (d.antonyms || []).length
      ? `<div class="ma-sub">反義詞：</div><div class="pill-list">${d.antonyms.map(x => `<span class="pill"><b>${esc(x.word)}</b>${spk(x.word)}<span class="pill-zh">${esc(x.meaning || '')}</span></span>`).join('')}</div>` : '';
    return wrap('🟰 同義詞／反義詞', syn + ant);
  }

  if (mode === 'forms') {
    const forms = (d.word_forms || []).map(x =>
      `<div class="ma-line"><span class="ma-label">${esc(x.label)}</span><span class="cloze-blank">${'＿'.repeat(Math.max(2, (x.form || '').replace(/\s/g, '').length))}</span>${spkw(x.form)}<span class="ma-ans">（答案：${esc(x.form)}）</span></div>`).join('');
    const derivs = (d.derivatives || []).map(x =>
      `<div class="ma-line"><span class="ma-label">${esc(x.pos || '派生')}</span><span class="cloze-blank">${'＿'.repeat(Math.max(2, (x.word || '').replace(/\s/g, '').length))}</span>${spkw(x.word)}<span class="ma-ans">（答案：${esc(x.word)}｜${esc(x.meaning || '')}）</span></div>`).join('');
    return wrap('🔤 詞形變化 / 詞性變換（先想想再看答案）', forms + derivs);
  }
  return '';
}

function mnemBlock(d) {
  if (!(d.mnemonics || []).length) return '';
  return `<div class="entry-section" style="margin-top:14px"><div class="es-title">💡 助記法</div>`
    + d.mnemonics.map(x => `<div class="mnemonic"><span class="mn-type">${esc(x.type || '助記')}</span>${esc(x.content)}</div>`).join('')
    + `</div>`;
}

function notesBlock(d) {
  if (!(d.notes && d.notes.trim())) return '';
  return `<div class="entry-section" style="margin-top:14px"><div class="es-title">📝 我的筆記</div>`
    + `<div class="example" style="white-space:pre-wrap">${esc(d.notes)}</div></div>`;
}

let studyEditing = false;

function toggleStudyEditor() {
  const panel = $('#studyEditor');
  studyEditing = !studyEditing;
  if (!studyEditing) {
    panel.hidden = true;
    panel.innerHTML = '';
    $('#editCardBtn').textContent = '✏️ 編輯';
    showCurrentCard(); // 用最新內容重繪卡面
    renderDeck();
    return;
  }
  const item = currentItem();
  if (!item) return;
  const card = cards.find(c => c.id === item.cardId);
  if (!card) return;
  $('#editCardBtn').textContent = '✓ 編輯完成';
  panel.hidden = false;
  // 用可編輯的預覽（含各段「↻ 重新生成」與「手動編輯整張卡」）
  renderPreview(card.data, panel, {
    editable: true,
    word: card.data.word,
    raw: card.raw || '',
    onChange: () => saveCards(),
    card,
  });
  panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function bindStudyControls() {
  $('#showAnswerBtn').addEventListener('click', revealAnswer);
  $('#endStudyBtn').addEventListener('click', endStudy);
  $('#editCardBtn').addEventListener('click', toggleStudyEditor);
  // 背誦編輯面板：各段重新生成／手動編輯整張卡
  $('#studyEditor').addEventListener('click', e => {
    const regen = e.target.closest('.seg-regen');
    if (regen) { regenerateSegment(regen.dataset.seg, regen); return; }
    if (e.target.closest('[data-edit-card]')) openCardEditor();
  });
  $('#rateBtns').addEventListener('click', e => {
    const b = e.target.closest('[data-rate]');
    if (b) rateCard(parseInt(b.dataset.rate, 10));
  });
  document.addEventListener('keydown', e => {
    if ($('#view-study').classList.contains('active') === false) return;
    if ($('#studyCard').hidden) return;
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if (e.code === 'Space') {
      e.preventDefault();
      if (!$('#showAnswerBtn').hidden) revealAnswer();
    } else if (!$('#rateBtns').hidden && ['1', '2', '3', '4'].includes(e.key)) {
      rateCard(parseInt(e.key, 10) - 1);
    }
  });
}

function revealAnswer() {
  const item = currentItem();
  if (item && item.mode === 'spelling') {
    const inp = $('#spellInput');
    const card = cards.find(c => c.id === item.cardId);
    const ans = (inp ? inp.value : '').trim();
    const correct = ans.toLowerCase() === (card.data.word || '').trim().toLowerCase();
    const result = ans
      ? `<div class="spell-result ${correct ? 'ok' : 'no'}">${correct ? '✓ 拼對了！' : '✗ 你的答案：' + esc(ans)}</div>`
      : `<div class="spell-result no">（未作答）</div>`;
    $('#cardBack').innerHTML = result + $('#cardBack').innerHTML;
  }
  $('#cardBack').hidden = false;
  $('#showAnswerBtn').hidden = true;
  $('#rateBtns').hidden = false;
  // 顯示答案：英中交錯×3 → 每句例句×2
  const card = item ? cards.find(c => c.id === item.cardId) : null;
  if (card) autoSpeakBack(card.data);
}

/* ---- SRS 排程（簡化 SM-2） ---- */
function predictInterval(state, rate) {
  let { interval, ease, reps } = state;
  if (rate === 0) return 0;                 // 重來：本輪再看
  if (rate === 1) return Math.max(1, Math.round((interval || 1) * 1.2));
  if (rate === 2) {
    if (reps === 0) return 1;
    if (reps === 1) return 3;
    return Math.max(1, Math.round(interval * ease));
  }
  // easy
  if (reps === 0) return 4;
  return Math.max(1, Math.round(interval * ease * 1.3));
}

function fmtInterval(days) {
  if (days === 0) return '<1分';
  if (days < 1) return '<1天';
  if (days < 30) return days + '天';
  if (days < 365) return Math.round(days / 30) + '月';
  return (days / 365).toFixed(1) + '年';
}

function updateRateLabels(state) {
  [0, 1, 2, 3].forEach(r => {
    $('#rt' + r).textContent = fmtInterval(predictInterval(state, r));
  });
}

function rateCard(rate) {
  if ($('#rateBtns').hidden) return;
  const item = currentItem();
  const card = cards.find(c => c.id === item.cardId);
  const s = card.srs[item.mode];

  const days = predictInterval(s, rate);
  if (rate === 0) {
    s.ease = Math.max(1.3, s.ease - 0.2);
    s.reps = 0;
    s.lapses = (s.lapses || 0) + 1;
    s.interval = 0;
    s.due = now() + 60 * 1000; // 1 分鐘後（同輪重看）
    // 把這張卡再排到本輪後段
    session.queue.push({ cardId: item.cardId, mode: item.mode });
    session.total++;
  } else {
    if (rate === 1) s.ease = Math.max(1.3, s.ease - 0.15);
    if (rate === 3) s.ease = s.ease + 0.15;
    s.reps += 1;
    s.interval = days;
    s.due = now() + days * DAY;
    // 基礎模式一旦熟悉，立刻把這張卡「本輪已勾選」的進階模式補進佇列
    if (BASIC_MODES.includes(item.mode)) enqueueUnlockedModes(card);
  }
  saveCards();
  cloudUpsert(card);

  // 記錄本輪結果（重來/困難視為不熟）
  session.results.push({ cardId: item.cardId, mode: item.mode, rate, word: card.data.word });
  bumpHistory(); // 熱力圖：每翻一張卡 +1
  updateDailyOnReview(item.cardId); // 今日目標：同一單字只算一次

  session.reviewed++;
  session.idx++;
  if (session.idx >= session.queue.length) {
    finishStudy();
  } else {
    showCurrentCard();
  }
}

function finishStudy() {
  stopStudySpeech();
  $('#studyCard').hidden = true;
  $('#studyDone').hidden = false;
  renderSummary();
  session = null;
  renderDailyPanel();
  renderDeck();
}

function renderSummary() {
  const results = session.results || [];
  const total = results.length;
  const missed = results.filter(r => r.rate <= 1); // 重來/困難
  const ok = total - missed.length;
  $('#doneSummary').textContent = `這輪複習了 ${total} 張卡片`;
  $('#doneStats').innerHTML = `
    <div class="d-item"><div class="d-num ok">${ok}</div><div class="d-label">熟悉（良好/簡單）</div></div>
    <div class="d-item"><div class="d-num no">${missed.length}</div><div class="d-label">不熟（重來/困難）</div></div>`;

  const missedEl = $('#doneMissed');
  if (!missed.length) {
    missedEl.innerHTML = '<p class="hint" style="text-align:center">太棒了，這輪沒有不熟的卡片！</p>';
    return;
  }
  const rateName = { 0: 'again', 1: 'hard' };
  const rateLabel = { 0: '重來', 1: '困難' };
  missedEl.innerHTML = `<div class="dm-title">需要加強（點擊展開看細節）：</div>`
    + missed.map((r, i) => {
      const mode = STUDY_MODES.find(m => m.id === r.mode);
      return `<div class="missed-item">
        <div class="missed-head" data-mi="${i}">
          <span class="mh-word">${esc(r.word)}</span>
          <span class="mh-mode">${mode ? mode.name : r.mode}</span>
          <span class="mh-rate ${rateName[r.rate]}">${rateLabel[r.rate]}</span>
          <span class="mh-toggle">▾</span>
        </div>
        <div class="missed-detail" data-mid="${i}" hidden></div>
      </div>`;
    }).join('');

  // 展開/收合看細節
  missedEl.onclick = e => {
    const head = e.target.closest('.missed-head');
    if (!head) return;
    const i = head.dataset.mi;
    const detail = missedEl.querySelector(`[data-mid="${i}"]`);
    if (!detail) return;
    if (detail.hidden) {
      const card = cards.find(c => c.id === missed[i].cardId);
      if (card && !detail.dataset.loaded) {
        renderPreview(card.data, detail, null); // 唯讀呈現
        detail.dataset.loaded = '1';
      }
      detail.hidden = false;
    } else {
      detail.hidden = true;
    }
  };
}

function endStudy() {
  if (session && session.reviewed > 0) {
    finishStudy();
  } else {
    resetStudyToSetup();
  }
  session = null;
}

/* =========================================================================
   設定
   ========================================================================= */
function bindSettings() {
  $('#saveSettingsBtn').addEventListener('click', () => {
    settings.apiKeys = $('#apiKeysInput').value.split('\n').map(k => k.trim()).filter(Boolean);
    settings.model = $('#modelSelect').value;
    settings.accent = $('#accentSelect').value;
    settings.dailyGoal = Math.max(1, parseInt($('#dailyGoalInput').value, 10) || 20);
    settings.listenBackend = ($('#listenBackendInput').value || '').trim().replace(/\/$/, '') || 'https://whisper-api-1016448029865.asia-east1.run.app/api';
    keyIndex = 0;
    saveSettings();
    renderDailyPanel();
    $('#settingsStatus').textContent = settings.apiKeys.length
      ? `✅ 已儲存（${settings.apiKeys.length} 組金鑰）`
      : (envKeys.length ? `✅ 已儲存（使用 Vercel 環境變數 ${envKeys.length} 組）` : '✅ 已儲存（尚無金鑰）');
    toast('設定已儲存');
    setTimeout(() => $('#settingsStatus').textContent = '', 2500);
  });

  $('#testKeyBtn').addEventListener('click', async () => {
    const keys = $('#apiKeysInput').value.split('\n').map(k => k.trim()).filter(Boolean);
    if (keys.length === 0) { toast('請先填入金鑰', true); return; }
    // 測試時先套用目前選擇的模型
    settings.model = $('#modelSelect').value;
    const status = $('#settingsStatus');
    status.textContent = '逐一測試金鑰中…';
    const results = [];
    for (let i = 0; i < keys.length; i++) {
      try {
        const url = endpointFor(keys[i], settings.model);
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: '回覆 ok' }] }] }),
        });
        results.push(`#${i + 1} ${res.ok ? '✅' : '❌' + res.status}`);
      } catch (e) {
        results.push(`#${i + 1} ❌`);
      }
    }
    status.textContent = results.join('　');
    toast('測試完成');
  });

  $('#exportBtn').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify({ cards, exportedAt: new Date().toISOString() }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `背單字備份_${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  });

  $('#importFile').addEventListener('change', e => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        const imported = Array.isArray(data) ? data : data.cards;
        if (!Array.isArray(imported)) throw new Error('格式錯誤');
        const existIds = new Set(cards.map(c => c.id));
        const addedCards = [];
        imported.forEach(c => {
          if (!c.id) c.id = uid();
          if (!existIds.has(c.id)) { cards.push(c); addedCards.push(c); }
        });
        migrateCards();
        saveCards();
        cloudBulk(addedCards);
        renderDeck();
        toast(`匯入完成，新增 ${addedCards.length} 張卡片`);
      } catch (err) {
        toast('匯入失敗：' + err.message, true);
      }
      e.target.value = '';
    };
    reader.readAsText(file);
  });

  $('#resetBtn').addEventListener('click', () => {
    if (confirm('確定要清空「所有單字資料」嗎？此動作會同時清空雲端，無法復原（設定與金鑰保留）。')) {
      cards = [];
      saveCards();
      cloudClear();
      renderDeck();
      toast('已清空所有單字');
    }
  });
}

/* =========================================================================
   閱讀（PDF / 文章精讀）
   資料模型：
   book = { id, title, createdAt, updatedAt, kind:'pdf'|'text',
            pages:[string], toc:[{id,title,page,section,done}], articles:{ [tocId]: article } }
   article = { tocId, title, body, paragraphs:[{en,zh}], summary, mindmap,
               vocab:[{word,meaning_zh,example_en,example_zh,example_pi}],
               phrases:[{phrase,meaning_zh,example_en,example_pi}],
               patterns:[{pattern,explain_zh,example_en,example_pi}],
               processedAt }
   pages 只存本機（供之後處理未整理文章）；雲端只存已處理內容（避免超過文件大小上限）。
   ========================================================================= */
let readerBooks = [];
let readerCurrentBookId = null;
let readerCurrentTocId = null;
let readerSyncedLang = null;

function readerLangKey() { return `reader_${currentLang}`; }
function saveReaderLocal() { localStorage.setItem(nsKey(LS_READER), JSON.stringify(readerBooks)); }
let readerCloudTimer = null;
function saveReaderCloud() {
  if (!currentUid || !(window.Cloud && window.Cloud.enabled && window.Cloud.saveMeta)) return;
  clearTimeout(readerCloudTimer);
  readerCloudTimer = setTimeout(() => {
    // 雲端不存 pages、也不存本機 blob URL（audioLocalUrl）
    const slim = readerBooks.map(b => {
      const { pages, ...rest } = b;
      const articles = {};
      Object.entries(rest.articles || {}).forEach(([id, a]) => {
        const { audioLocalUrl, ...ar } = a || {};
        articles[id] = ar;
      });
      return { ...rest, articles };
    });
    window.Cloud.saveMeta(readerLangKey(), { books: slim });
  }, 1500);
}
function saveReader() { saveReaderLocal(); saveReaderCloud(); }

async function syncReaderFromCloud() {
  if (readerSyncedLang === currentLang) return;
  readerSyncedLang = currentLang;
  if (!currentUid || !(window.Cloud && window.Cloud.enabled && window.Cloud.loadMeta)) return;
  try {
    const meta = await window.Cloud.loadMeta(readerLangKey());
    if (meta && Array.isArray(meta.books)) {
      const map = new Map();
      readerBooks.forEach(b => map.set(b.id, b));
      meta.books.forEach(cb => {
        const ex = map.get(cb.id);
        if (!ex) { map.set(cb.id, cb); return; }
        // 合併：保留本機 pages，其餘取較新
        const merged = ((cb.updatedAt || 0) >= (ex.updatedAt || 0)) ? { ...ex, ...cb } : { ...cb, ...ex };
        merged.pages = ex.pages || cb.pages;
        map.set(cb.id, merged);
      });
      readerBooks = Array.from(map.values()).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      saveReaderLocal();
      renderReader();
    }
  } catch (e) { console.error('讀取閱讀雲端資料失敗', e); }
}

function openReader() {
  readerBooks = loadJSON(nsKey(LS_READER), []);
  renderReader();
  syncReaderFromCloud();
}

function renderReader() {
  const book = readerBooks.find(b => b.id === readerCurrentBookId);
  const lib = $('#readerLibrary');
  const bk = $('#readerBook');
  if (!lib || !bk) return;
  if (book) {
    lib.hidden = true; bk.hidden = false;
    renderBook(book);
  } else {
    lib.hidden = false; bk.hidden = true;
    renderBookList();
  }
}

function renderBookList() {
  const el = $('#readerBookList');
  if (!el) return;
  if (!readerBooks.length) {
    el.innerHTML = '<div class="empty-state small"><p class="empty-sub">還沒有任何書。上傳一份 PDF 或貼上文章開始。</p></div>';
    return;
  }
  el.innerHTML = readerBooks.map(b => {
    const total = (b.toc || []).length;
    const done = (b.toc || []).filter(t => b.articles && b.articles[t.id]).length;
    const d = new Date(b.createdAt || Date.now());
    const ds = `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
    return `<button class="reader-book-card" data-book="${b.id}">
      <span class="rbc-icon">${b.kind === 'text' ? '📝' : '📕'}</span>
      <span class="rbc-info">
        <span class="rbc-title">${esc(b.title)}</span>
        <span class="rbc-sub">${total} 篇文章 · 已整理 ${done} · ${ds}</span>
      </span>
    </button>`;
  }).join('');
}

function renderBook(book) {
  $('#readerBookTitle').textContent = book.title;
  const toc = $('#readerToc');
  const head = `<div class="rd-toc-head">
      <span>目錄（${(book.toc || []).length}）</span>
      <button class="btn ghost small" id="readerAddTocBtn" type="button" title="貼上文字新增一篇文章到這本書">＋ 新增</button>
    </div>`;
  if ((book.toc || []).length === 0) {
    toc.innerHTML = head + '<p class="hint" style="padding:10px">尚無目錄。可按上方「＋ 新增」貼上文章，或重新上傳 PDF 讓 AI 整理。</p>';
  } else {
    toc.innerHTML = head + book.toc.map(t => {
      const processed = book.articles && book.articles[t.id];
      const active = t.id === readerCurrentTocId ? ' active' : '';
      const flag = processed ? '✅' : (t.customBody ? '✍️' : (t.page ? 'p.' + t.page : ''));
      return `<button class="rd-toc-item${active}" data-toc="${t.id}">
        <span class="rd-toc-title">${esc(t.title)}</span>
        ${t.title_zh ? `<span class="rd-toc-zh">${esc(t.title_zh)}</span>` : '<span class="rd-toc-zh muted">翻譯中…</span>'}
        ${t.section ? `<span class="rd-toc-sec">${esc(t.section)}</span>` : ''}
        <span class="rd-toc-flag">${flag}</span>
      </button>`;
    }).join('');
    translateReaderTocTitles(book);
  }
  // 文章區
  const art = $('#readerArticle');
  if (readerCurrentTocId && book.articles && book.articles[readerCurrentTocId]) {
    renderArticle(book, book.articles[readerCurrentTocId]);
  } else if (!readerCurrentTocId) {
    art.innerHTML = '<div class="empty-state small"><p class="empty-sub">從左側目錄點一篇文章開始精讀。</p></div>';
  }
}

let readerTocTranslateBusy = false;
async function translateReaderTocTitles(book) {
  if (!book || readerTocTranslateBusy) return;
  const need = (book.toc || []).filter(t => t.title && !t.title_zh);
  if (!need.length) return;
  readerTocTranslateBusy = true;
  try {
    const translator = await createBrowserTranslator();
    for (const t of need) {
      try {
        t.title_zh = translator
          ? await browserTranslateOneNative(t.title, translator)
          : await browserTranslateOneGtx(t.title);
      } catch {
        try { t.title_zh = await browserTranslateOneGtx(t.title); } catch { t.title_zh = ''; }
      }
      // 逐項更新 DOM，不必整本重繪
      const btn = document.querySelector(`#readerToc [data-toc="${CSS.escape(t.id)}"] .rd-toc-zh`);
      if (btn) {
        btn.textContent = t.title_zh || '';
        btn.classList.toggle('muted', !t.title_zh);
      }
    }
    book.updatedAt = now();
    saveReader();
  } finally {
    readerTocTranslateBusy = false;
  }
}

/* ---------- 上傳 / 建立書本 ---------- */
async function readerAddPdf(file) {
  if (!file) return;
  if (!window.pdfjsLib) { toast('PDF 引擎尚未載入，請稍候再試', true); return; }
  const hint = $('#readerLibHint');
  const setHint = (t) => { if (hint) hint.textContent = t; };
  try {
    setHint('讀取 PDF 中…');
    const pages = await readerParsePdf(file, (p, n) => setHint(`解析 PDF 第 ${p}/${n} 頁…`));
    setHint('AI 整理目錄中…');
    const title = file.name.replace(/\.pdf$/i, '');
    const book = { id: uid(), title, createdAt: now(), updatedAt: now(), kind: 'pdf', pages, toc: [], articles: {} };
    readerBooks.unshift(book);
    book.toc = await readerBuildToc(pages);
    saveReader();
    readerCurrentBookId = book.id; readerCurrentTocId = null;
    renderReader();
    const byPage = book.toc.some(t => t.byPage);
    setHint(byPage ? '目錄自動辨識較不完整，已改用「分頁」方式；點任一頁即可精讀。' : '完成！點左側目錄任一篇開始精讀。');
    toast(`已加入《${title}》，共 ${book.toc.length} 篇`);
  } catch (e) {
    console.error(e);
    setHint('');
    toast('處理 PDF 失敗：' + e.message, true);
  }
}

async function readerParsePdf(file, onProgress) {
  const buf = await file.arrayBuffer();
  const pdf = await window.pdfjsLib.getDocument({ data: buf }).promise;
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    if (onProgress) onProgress(i, pdf.numPages);
    const page = await pdf.getPage(i);
    const tc = await page.getTextContent();
    const text = tc.items.map(it => it.str).join(' ').replace(/\s+/g, ' ').trim();
    pages.push(text);
  }
  return pages;
}

// 目錄整理失敗時的後備：把每一頁（有足夠文字的）當作一個可精讀的項目
function fallbackToc(pages) {
  const entries = [];
  pages.forEach((t, i) => {
    const txt = (t || '').trim();
    if (txt.length < 120) return; // 略過幾乎空白的頁
    const preview = txt.split(/\s+/).slice(0, 10).join(' ');
    entries.push({ id: uid(), title: `第 ${i + 1} 頁 — ${preview}…`, section: '（自動分頁）', page: i + 1, byPage: true, done: false });
  });
  return entries;
}

async function readerBuildToc(pages) {
  // 目錄（Contents）幾乎都在最前面幾頁：聚焦前段頁面給 AI，涵蓋 Contents 頁即可完整抓到。
  const FRONT_PAGES = 18, LIMIT = 45000;
  let sample = '';
  for (let i = 0; i < Math.min(pages.length, FRONT_PAGES) && sample.length < LIMIT; i++) {
    sample += `\n[P${i + 1}] ${pages[i]}`;
  }
  sample = sample.slice(0, LIMIT);
  const schema = {
    type: 'object', properties: {
      entries: {
        type: 'array', items: {
          type: 'object', properties: {
            title: { type: 'string' }, section: { type: 'string' }, page: { type: 'integer' },
          }, required: ['title'],
        },
      },
    }, required: ['entries'],
  };
  const prompt = `以下是一本雜誌／刊物「最前面幾頁」的文字（[P#] 為 PDF 頁碼）。這類刊物通常在前幾頁有一頁「目錄／Contents」，上面列出所有文章標題與頁碼。\n請依這頁目錄，完整萃取這本刊物的「文章目錄」：\n- 逐篇列出文章標題(title)、所屬版塊或專欄名稱(section)、頁碼(page，取最接近的 [P#] 數字）。\n- 以刊物自己的 Contents 頁為主要依據；若某頁明顯是目錄頁，請把上面每一項都列出來，不要遺漏。\n- 略過廣告、版權頁、訂閱資訊等非文章內容。\n- 標題請用原文（英文）。\n只輸出 JSON。\n\n文字：\n${sample}`;
  try {
    const out = await readerJSON(prompt, schema, 0.3, 16384);
    const entries = (out.entries || []).filter(e => e.title && e.title.trim());
    if (!entries.length) throw new Error('AI 未回傳任何目錄項目');
    return entries.map(e => ({ id: uid(), title: e.title.trim(), section: (e.section || '').trim(), page: e.page || 0, done: false }));
  } catch (e) {
    console.error('目錄整理失敗，改用自動分頁', e);
    return fallbackToc(pages);
  }
}

let readerPasteMode = 'book'; // 'book' = 新建一本書；'toc' = 加到目前這本書的目錄
function openReaderPaste(mode = 'book') {
  readerPasteMode = mode === 'toc' ? 'toc' : 'book';
  $('#rpasteTitle').value = '';
  $('#rpasteBody').value = '';
  const titleEl = $('#rpasteModalTitle');
  const hint = $('#rpasteHint');
  const confirmBtn = $('#rpasteConfirm');
  if (readerPasteMode === 'toc') {
    const book = readerBooks.find(b => b.id === readerCurrentBookId);
    if (titleEl) titleEl.textContent = '新增文章到目錄';
    if (hint) {
      hint.hidden = false;
      hint.textContent = book ? `將加進《${book.title}》的目錄，貼上後即可開始精讀。` : '';
    }
    if (confirmBtn) confirmBtn.textContent = '加入並精讀';
  } else {
    if (titleEl) titleEl.textContent = '貼上文章';
    if (hint) { hint.hidden = true; hint.textContent = ''; }
    if (confirmBtn) confirmBtn.textContent = '開始精讀';
  }
  $('#readerPasteModal').hidden = false;
  document.body.classList.add('modal-open');
  $('#rpasteTitle').focus();
}
function closeReaderPaste() {
  $('#readerPasteModal').hidden = true;
  document.body.classList.remove('modal-open');
  readerPasteMode = 'book';
}

// 正規化貼上的文章：保留段落（空行）分段，但把段內硬斷行接回、清掉多餘空白
function normalizePastedText(text) {
  let t = String(text || '').replace(/\r\n?/g, '\n');
  t = t.replace(/[ \t]+\n/g, '\n');            // 行尾空白
  t = t.replace(/\n{3,}/g, '\n\n');            // 多個空行縮成一個
  t = t.replace(/[ \t]{2,}/g, ' ');            // 行內多空白
  return t.trim();
}

function readerAddText(title, text) {
  const clean = normalizePastedText(text);
  const book = {
    id: uid(), title: title || '未命名文章', createdAt: now(), updatedAt: now(), kind: 'text',
    pages: [clean], toc: [{ id: uid(), title: title || '未命名文章', section: '', page: 1, done: false, customBody: clean }], articles: {},
  };
  readerBooks.unshift(book);
  saveReader();
  readerCurrentBookId = book.id;
  readerCurrentTocId = book.toc[0].id;
  renderReader();
  openArticle(book, book.toc[0]);
}

// 把一篇貼上的文章加進目前這本書的目錄
function readerAddArticleToBook(book, title, text) {
  if (!book) return;
  const clean = normalizePastedText(text);
  if (!clean) { toast('沒有內容', true); return; }
  book.toc = book.toc || [];
  book.articles = book.articles || {};
  const entry = {
    id: uid(),
    title: title || '未命名文章',
    section: '自行新增',
    page: 0,
    customBody: clean,
    done: false,
  };
  book.toc.push(entry);
  book.updatedAt = now();
  saveReader();
  renderBook(book);
  openArticle(book, entry);
  toast(`已加入「${entry.title}」`);
}

/* ---------- 文章精讀處理 ---------- */
function readerFullText(book) {
  if (!book.pages || !book.pages.length) return '';
  return book.pages.map((t, i) => `[P${i + 1}] ${t}`).join('\n');
}
function escapeRegExp(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/** 依目錄頁碼，取出該篇大致涵蓋的 PDF 原文視窗（給 Gemini 排版用） */
function readerArticleWindow(book, toc) {
  // 使用者自行貼上的文章：直接用原文（保留段落）
  if (toc && toc.customBody) return toc.customBody;
  const full = readerFullText(book);
  if (!full) return '';
  if (book.kind === 'text') return full.replace(/\[P\d+\]\s*/g, '');

  const pages = book.pages || [];
  const pageNum = Number(toc && toc.page) || 0;

  // 有頁碼：取本篇起始頁到下一篇起始頁（再多留 1 頁緩衝）
  if (pageNum > 0 && pages.length) {
    const start = Math.max(0, pageNum - 1);
    let end = pages.length;
    const siblings = (book.toc || [])
      .map(t => Number(t.page) || 0)
      .filter(p => p > pageNum)
      .sort((a, b) => a - b);
    if (siblings.length) end = Math.min(pages.length, siblings[0]); // 下一篇頁碼前（不含）
    else end = Math.min(pages.length, start + 6); // 無下一篇時最多取 6 頁
    // byPage 或單頁項目：至少含本頁＋下一頁
    if (toc.byPage) end = Math.min(pages.length, Math.max(end, start + 2));
    const slice = pages.slice(start, Math.max(start + 1, end));
    return slice.map((t, i) => `[P${start + i + 1}] ${t}`).join('\n\n');
  }

  const words = (toc.title || '').toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8).map(escapeRegExp);
  let idx = -1;
  if (words.length) {
    try { const re = new RegExp(words.join('\\W+'), 'i'); const m = re.exec(full); if (m) idx = m.index; } catch {}
  }
  if (idx < 0) return full.slice(0, 18000);
  return full.slice(Math.max(0, idx - 200), idx + 14000);
}

function chunkByWords(text, maxWords) {
  const paras = text.split(/\n{1,}|(?<=[.!?])\s{2,}/).map(s => s.trim()).filter(Boolean);
  const chunks = []; let cur = '', curW = 0;
  for (const p of paras) {
    const w = p.split(/\s+/).length;
    if (curW + w > maxWords && cur) { chunks.push(cur); cur = ''; curW = 0; }
    cur += (cur ? '\n\n' : '') + p; curW += w;
  }
  if (cur) chunks.push(cur);
  return chunks.length ? chunks : [text];
}

/** PDF 原文必須先經 Gemini 排版；失敗則拋錯，絕不直接沿用 PDF 生文字 */
async function formatPdfArticleBody(raw, title) {
  const schema = {
    type: 'object',
    properties: {
      title: { type: 'string' },
      article: { type: 'string' },
    },
    required: ['article'],
  };
  const prompt = `你是雜誌／刊物的文字排版編輯。以下文字擷取自 PDF，常有硬斷行、斷字、雙欄錯亂、頁碼標記 [P#]、頁眉頁腳、圖說、廣告或其他文章殘片。

請找出標題約為「${title}」的「那一篇」完整正文，並重新排版成可閱讀的純文字：
- 修復被 PDF 硬斷的單字與句子（含行末連字號斷字，例如 inter-\\nnational → international）。
- 依語意還原自然段落；段落之間用空行（\\n\\n）分隔。
- 若有小標／小節標題，請單獨成行保留。
- 移除頁碼標記、頁眉頁腳、圖說、廣告、目錄殘片、以及其他不屬於本篇的內容。
- 保留原文用字與語序：不要翻譯、不要改寫、不要摘要、不要加入任何說明或註解。
- article 欄位只放排版後的正文（可含文章標題作為首行）。

只輸出 JSON。

原始文字：
${String(raw || '').slice(0, 28000)}`;

  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const out = await readerJSON(prompt, schema, 0.2, 16384);
      const article = String(out.article || '').trim();
      if (article.length >= 80) return article;
      lastErr = new Error('排版結果過短');
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('PDF 正文排版失敗');
}

async function processArticle(book, toc) {
  const art = $('#readerArticle');
  const status = (t) => { art.innerHTML = `<div class="rd-processing"><span class="spinner"></span> ${esc(t)}</div>`; };
  status('擷取文章原文中…');
  const win = readerArticleWindow(book, toc);
  if (!win) {
    art.innerHTML = '<div class="empty-state small"><p class="empty-sub">這本書的原始內容不在此裝置（雲端不保存 PDF 原文）。請重新上傳同一份 PDF 即可處理未整理的文章。</p></div>';
    return;
  }

  // 1) PDF：必須先經 Gemini 排版（不可直接用 PDF 生文字）；貼上／自行新增則沿用原文
  let body = win;
  if (book.kind === 'pdf' && !(toc && toc.customBody)) {
    status('Gemini 重新排版正文中…');
    try {
      body = await formatPdfArticleBody(win, toc.title || '');
    } catch (e) {
      console.error('PDF 正文排版失敗', e);
      art.innerHTML = `<div class="empty-state small"><p class="empty-sub">無法排版此篇 PDF 正文：${esc(e.message || '未知錯誤')}。請稍後按「重新整理」再試，或改用貼上文字。</p></div>`;
      toast('PDF 排版失敗，未使用原始擷取文字', true);
      return;
    }
  }

  // 2) 逐段中英對照＋單字（含詞性）＋片語/句型（另一次 AI）＋大意
  status('AI 翻譯與精讀分析中…（重要單字、片語、句型、逐段對照、大意）');
  const chunks = chunkByWords(body, 850);
  const transSchema = {
    type: 'object', properties: {
      paragraphs: { type: 'array', items: { type: 'object', properties: { en: { type: 'string' }, zh: { type: 'string' } }, required: ['en', 'zh'] } },
    }, required: ['paragraphs'],
  };
  const transTasks = chunks.map(ch => readerJSON(
    `以下是已排版好的英文文章片段。請依現有段落（空行分隔）輸出每一段的原文(en)與對應的繁體中文翻譯(zh)。保持順序與段落結構、勿省略、勿合併無關段落、勿加入說明。\n\n${ch}`,
    transSchema, 0.3,
  ).then(r => r.paragraphs || []).catch(() => [{ en: ch, zh: '（此段翻譯失敗）' }]));

  const vocabSchema = {
    type: 'object', properties: {
      vocab: { type: 'array', items: { type: 'object', properties: { word: { type: 'string' }, pos: { type: 'string' }, meaning_zh: { type: 'string' }, example_en: { type: 'string' }, example_zh: { type: 'string' } }, required: ['word'] } },
    },
    required: ['vocab'],
  };
  const vocabTask = readerJSON(
    `你是英語精讀老師。從以下文章挑出 10–15 個重要單字，用繁體中文說明。每個含：word、pos（詞性，如 n./v./adj.）、meaning_zh、example_en（優先取自文章）、example_zh。只輸出 JSON（不要生成片語或句型）。\n\n文章：\n${body.slice(0, 16000)}`,
    vocabSchema, 0.5,
  ).catch(() => ({ vocab: [] }));

  const phrasesSchema = {
    type: 'object', properties: {
      phrases: { type: 'array', items: { type: 'object', properties: { phrase: { type: 'string' }, meaning_zh: { type: 'string' }, example_en: { type: 'string' } }, required: ['phrase'] } },
      patterns: { type: 'array', items: { type: 'object', properties: { pattern: { type: 'string' }, explain_zh: { type: 'string' }, example_en: { type: 'string' } }, required: ['pattern'] } },
    },
    required: ['phrases', 'patterns'],
  };
  const phrasesTask = readerJSON(
    `你是英語精讀老師。從以下文章挑出（不要重複生成單字列表）：\n- phrases：5–10 個重要片語／搭配，附 meaning_zh 與 example_en（優先取自文章）。\n- patterns：3–6 個重要句型／文法結構，附 explain_zh 與 example_en。\n只輸出 JSON。\n\n文章：\n${body.slice(0, 16000)}`,
    phrasesSchema, 0.5,
  ).catch(() => ({ phrases: [], patterns: [] }));

  const summarySchema = { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] };
  const summaryTask = readerJSON(
    `用繁體中文寫出這篇文章的整體大意（重點摘要，3–5 句）。只輸出 JSON。\n\n文章：\n${body.slice(0, 16000)}`,
    summarySchema, 0.4,
  ).then(r => r.summary || '').catch(() => '');

  const [transArr, vocabOut, phrasesOut, summary] = await Promise.all([
    Promise.all(transTasks), vocabTask, phrasesTask, summaryTask,
  ]);
  const paragraphs = transArr.flat();

  status('整理心智圖大綱…');
  let mindmap = null;
  try { mindmap = await generateReaderMindmap(paragraphs); } catch (e) { console.error('心智圖失敗', e); }

  const article = {
    tocId: toc.id, title: toc.title, body,
    paragraphs, summary, mindmap,
    vocab: vocabOut.vocab || [], phrases: phrasesOut.phrases || [], patterns: phrasesOut.patterns || [],
    processedAt: now(),
  };
  attachReaderExamplePis(article);
  attachReaderMindmapPis(article);
  book.articles = book.articles || {};
  book.articles[toc.id] = article;
  toc.done = true;
  book.updatedAt = now();
  saveReader();
  renderBook(book);
  renderArticle(book, article);
  toast('精讀整理完成');
}

/* ---------- 朗讀整篇：瀏覽器 / AI（AI 音檔存雲端 Storage，網址存 Firestore） ---------- */
let readerAudioEl = null;
let readerSpeakIdx = -1;
let readerSpeakGen = 0; // 用來讓「停止」真正取消整篇佇列（cancel 會觸發 onerror，否則會唸下一段）
let readerSpeed = parseFloat(localStorage.getItem('reader_speed') || '1') || 1;
function getReaderSpeed() {
  // 優先讀畫面上的語速選單，避免變數與 UI 不同步
  const sel = document.getElementById('rdSpeed');
  if (sel && sel.value) {
    const v = parseFloat(sel.value);
    if (!Number.isNaN(v) && v > 0) {
      readerSpeed = Math.max(0.5, Math.min(2, v));
      return readerSpeed;
    }
  }
  return readerSpeed;
}
function setReaderSpeed(v) {
  readerSpeed = Math.max(0.5, Math.min(2, parseFloat(v) || 1));
  localStorage.setItem('reader_speed', String(readerSpeed));
  const sel = document.getElementById('rdSpeed');
  if (sel && String(sel.value) !== String(readerSpeed)) sel.value = String(readerSpeed);
  if (readerAudioEl) {
    try { readerAudioEl.playbackRate = readerSpeed; } catch {}
  }
}
function readerAudioSrc(a) { return (a && (a.audioUrl || a.audioLocalUrl)) || ''; }
function clearReadingHighlight() {
  readerSpeakIdx = -1;
  document.querySelectorAll('.rd-para.reading').forEach(el => el.classList.remove('reading'));
}
function highlightReadingPara(i) {
  if (i === readerSpeakIdx) return;
  readerSpeakIdx = i;
  document.querySelectorAll('.rd-para.reading').forEach(el => el.classList.remove('reading'));
  const el = document.querySelector(`.rd-para[data-pi="${i}"]`);
  if (el) {
    el.classList.add('reading');
    const main = document.querySelector('#readerArticle .rd-main');
    if ($('#rdFollow')?.checked && main) scrollWithin(main, el);
  }
}
function readerStopAudio() {
  readerSpeakGen++; // 作廢進行中的逐段朗讀佇列
  if (readerAudioEl) {
    try { readerAudioEl.pause(); readerAudioEl.onended = null; readerAudioEl.ontimeupdate = null; } catch {}
    readerAudioEl = null;
  }
  if (window.speechSynthesis) window.speechSynthesis.cancel();
  clearReadingHighlight();
}
function readerPlayUrl(url, cues, opts = {}) {
  readerStopAudio();
  const startAt = opts.startAt || 0;
  const endAt = opts.endAt;
  const gen = readerSpeakGen;
  readerAudioEl = new Audio(url);
  const applyRate = () => {
    if (!readerAudioEl) return;
    try { readerAudioEl.playbackRate = getReaderSpeed(); } catch {}
  };
  const applyStart = () => {
    if (startAt > 0 && readerAudioEl) {
      try { readerAudioEl.currentTime = startAt; } catch {}
    }
  };
  applyRate();
  readerAudioEl.addEventListener('loadedmetadata', () => { applyRate(); applyStart(); });
  readerAudioEl.addEventListener('ratechange', () => {
    // 某些瀏覽器在 load/seek 後會把 rate 重設成 1，強制拉回來
    if (readerAudioEl && Math.abs(readerAudioEl.playbackRate - getReaderSpeed()) > 0.01) applyRate();
  });
  readerAudioEl.addEventListener('timeupdate', () => {
    if (!readerAudioEl || gen !== readerSpeakGen) return;
    // 播放中也持續確保語速正確
    if (Math.abs(readerAudioEl.playbackRate - getReaderSpeed()) > 0.01) applyRate();
    const t = readerAudioEl.currentTime;
    if (endAt != null && t >= endAt - 0.05) {
      readerAudioEl.pause();
      clearReadingHighlight();
      return;
    }
    if (cues && cues.length) {
      let hit = cues[0];
      for (const c of cues) { if (t >= c.start) hit = c; else break; }
      if (hit) highlightReadingPara(hit.i);
    }
  });
  readerAudioEl.addEventListener('ended', () => {
    if (gen === readerSpeakGen) clearReadingHighlight();
  });
  const play = () => {
    if (gen !== readerSpeakGen || !readerAudioEl) return;
    applyRate();
    readerAudioEl.play().catch(e => toast('播放失敗：' + e.message, true));
  };
  if (startAt > 0) {
    readerAudioEl.addEventListener('canplay', () => { applyStart(); applyRate(); play(); }, { once: true });
    readerAudioEl.load();
  } else {
    play();
  }
}

// 播放某一段的 AI 語音（需已生成整篇並有時間軸）
function readerPlayParaAI(a, paraIdx) {
  const src = readerAudioSrc(a);
  const cues = (a.audioCues || []).filter(c => c.i === paraIdx);
  if (!src || !cues.length) { toast('此段尚無 AI 語音，請先按「AI 朗讀整篇」生成', true); return; }
  const start = cues[0].start;
  const end = cues[cues.length - 1].end;
  readerPlayUrl(src, a.audioCues, { startAt: start, endAt: end });
}

// 瀏覽器逐段朗讀，並用藍色底標示當前段
function speakArticleWithHighlight(a) {
  if (!window.speechSynthesis) { toast('這個瀏覽器不支援朗讀', true); return; }
  readerStopAudio();
  const gen = readerSpeakGen;
  const jobs = (a.paragraphs || []).map((p, i) => ({ i, text: (p.en || '').trim() })).filter(j => j.text);
  if (!jobs.length) { toast('沒有內容可朗讀', true); return; }
  let n = 0;
  const next = () => {
    if (gen !== readerSpeakGen) return;
    if (n >= jobs.length) { clearReadingHighlight(); return; }
    const job = jobs[n++];
    highlightReadingPara(job.i);
    const u = makeUtterance(job.text, TARGET_LANG());
    u.rate = getReaderSpeed(); // 每一段都重新套用語速
    u.onend = () => { if (gen === readerSpeakGen) next(); };
    u.onerror = () => { if (gen === readerSpeakGen) next(); };
    window.speechSynthesis.speak(u);
  };
  next();
}

// 依段落產生 TTS 工作（過長段落再切句，方便並行）
function ttsJobsFromArticle(a) {
  const jobs = [];
  (a.paragraphs || []).forEach((p, i) => {
    const text = (p.en || '').trim();
    if (!text) return;
    if (text.length <= 1400) { jobs.push({ i, text }); return; }
    const parts = text.match(/[^.!?]+[.!?]+(?:\s+|$)|[^.!?]+$/g) || [text];
    let cur = '';
    for (const s of parts) {
      if (cur && (cur.length + s.length) > 1200) { jobs.push({ i, text: cur.trim() }); cur = ''; }
      cur += s;
    }
    if (cur.trim()) jobs.push({ i, text: cur.trim() });
  });
  return jobs;
}

function readerStopAudioOnly() {
  // 只停掉目前 Audio，不遞增 gen（串流朗讀換段時用）
  if (readerAudioEl) {
    try { readerAudioEl.pause(); readerAudioEl.onended = null; readerAudioEl.ontimeupdate = null; } catch {}
    readerAudioEl = null;
  }
}

/** 播放單一 WAV blob URL，結束後 resolve；若已被停止則立刻 resolve(false) */
function readerPlayBlobUrl(url, { paraIdx, gen } = {}) {
  return new Promise((resolve) => {
    if (gen != null && gen !== readerSpeakGen) { resolve(false); return; }
    readerStopAudioOnly();
    if (paraIdx != null) highlightReadingPara(paraIdx);
    const audio = new Audio(url);
    readerAudioEl = audio;
    const applyRate = () => {
      try { audio.playbackRate = getReaderSpeed(); } catch {}
    };
    const finish = (ok) => {
      if (readerAudioEl === audio) readerAudioEl = null;
      resolve(ok);
    };
    audio.addEventListener('ended', () => finish(true));
    audio.addEventListener('error', () => finish(false));
    audio.addEventListener('ratechange', () => {
      if (Math.abs(audio.playbackRate - getReaderSpeed()) > 0.01) applyRate();
    });
    applyRate();
    audio.play().then(() => applyRate()).catch(() => finish(false));
  });
}

let readerTtsBusy = false;
async function readerPlayAI(book, a) {
  const src = readerAudioSrc(a);
  if (src) { readerPlayUrl(src, a.audioCues); return; }
  if (readerTtsBusy) { toast('AI 語音生成中，請稍候…'); return; }
  if (!activeKeys().length) { toast('尚未設定 API 金鑰', true); return; }
  const jobs = ttsJobsFromArticle(a);
  if (!jobs.length) { toast('沒有內容可朗讀', true); return; }

  readerTtsBusy = true;
  readerStopAudio(); // 取消舊朗讀並取得新 gen
  const streamGen = readerSpeakGen;
  const btn = $('#rdReadAi');
  const setLabel = t => { if (btn) btn.textContent = t; };
  const keys = activeKeys();
  const concurrency = Math.max(1, keys.length);
  const results = new Array(jobs.length).fill(null);
  const resolvers = [];
  const ready = jobs.map((_, i) => new Promise(r => { resolvers[i] = r; }));
  let done = 0;

  setLabel(`🤖 邊生成邊朗讀 0/${jobs.length}…`);
  toast('第一段就緒即開始朗讀…');

  // 並行生成；每完成一段立刻通知播放佇列
  const genPromise = mapPool(jobs, concurrency, async (job, jobIdx) => {
    if (streamGen !== readerSpeakGen) return null;
    const key = keys[jobIdx % keys.length];
    const r = await geminiTTSChunk(job.text, key);
    results[jobIdx] = r;
    done++;
    if (streamGen === readerSpeakGen) setLabel(`🤖 邊生成邊朗讀 ${done}/${jobs.length}…`);
    resolvers[jobIdx](r);
    return r;
  });

  const pcms = [];
  const cues = [];
  let t = 0;
  let rate = 24000;
  let played = 0;
  let anyFail = false;

  try {
    for (let i = 0; i < jobs.length; i++) {
      if (streamGen !== readerSpeakGen) break;
      setLabel(`🤖 等待第 ${i + 1}/${jobs.length} 段…`);
      const r = await ready[i];
      if (streamGen !== readerSpeakGen) break;
      if (!r) { anyFail = true; continue; }
      rate = r.rate || rate;
      const bytes = b64ToBytes(r.b64);
      const dur = pcmDurationSec(bytes, rate);
      cues.push({ i: jobs[i].i, start: t, end: t + dur });
      t += dur;
      pcms.push(bytes);
      const url = pcmB64ToWavUrl(r.b64, rate);
      setLabel(`▶️ 朗讀 ${i + 1}/${jobs.length}（邊生成邊播）`);
      const ok = await readerPlayBlobUrl(url, { paraIdx: jobs[i].i, gen: streamGen });
      try { URL.revokeObjectURL(url); } catch {}
      if (!ok && streamGen !== readerSpeakGen) break;
      played++;
    }

    await genPromise;
    if (streamGen !== readerSpeakGen) {
      setLabel(readerAudioSrc(a) ? '▶️ 播放 AI 語音' : '🤖 AI 朗讀整篇');
      return;
    }
    if (!pcms.length) {
      toast('AI 語音生成失敗（可改用瀏覽器朗讀）', true);
      setLabel('🤖 AI 朗讀整篇');
      return;
    }

    // 串成整檔以便下次直接播、並可存雲端
    const blob = pcmChunksToWavBlob(pcms, rate);
    a.audioCues = cues;
    if (a.audioLocalUrl) { try { URL.revokeObjectURL(a.audioLocalUrl); } catch {} }
    a.audioLocalUrl = URL.createObjectURL(blob);
    book.updatedAt = now();
    saveReaderLocal();
    setLabel('☁️ 保存中…');
    try {
      const fd = new FormData();
      fd.append('file', new File([blob], 'article.wav', { type: 'audio/wav' }));
      const res = await fetch(listenBackend() + '/beidanzi/store_audio', { method: 'POST', body: fd });
      if (!res.ok) throw new Error('狀態 ' + res.status);
      const j = await res.json();
      a.audioUrl = j.url;
      book.updatedAt = now(); saveReader();
      setLabel('▶️ 播放 AI 語音');
      renderArticle(book, a);
      toast(anyFail
        ? `已朗讀 ${played}/${jobs.length} 段（部分失敗），音檔已保存`
        : `AI 語音完成（邊生成邊播），已保存雲端`);
    } catch (e) {
      book.updatedAt = now(); saveReaderLocal();
      renderArticle(book, a);
      setLabel('▶️ 播放 AI 語音');
      toast('雲端保存失敗，本機已可重播：' + e.message, true);
    }
  } finally {
    readerTtsBusy = false;
    if (streamGen === readerSpeakGen) clearReadingHighlight();
    if (btn) setLabel(readerAudioSrc(a) ? '▶️ 播放 AI 語音' : '🤖 AI 朗讀整篇');
  }
}

function openArticle(book, toc) {
  readerCurrentTocId = toc.id;
  renderBook(book); // 更新目錄 active 狀態
  const existing = book.articles && book.articles[toc.id];
  if (existing) { renderArticle(book, existing); return; }
  processArticle(book, toc);
}

/* ---------- 文章渲染（含螢光筆、朗讀、加入詞庫） ---------- */
function buildKnownWordRegex() {
  const words = Array.from(new Set(cards.map(c => (c.data.word || '').toLowerCase().trim())
    .filter(w => w && /^[a-z][a-z'-]{1,}$/.test(w))));
  if (!words.length) return null;
  words.sort((a, b) => b.length - a.length);
  try { return new RegExp(`\\b(${words.map(escapeRegExp).join('|')})(s|es|ed|ing|d)?\\b`, 'gi'); }
  catch { return null; }
}

/** 文中標示：重要片語綠底線、重要文法／句型綠虛線、重要單字綠底、詞庫單字黃底（可點擊跳右側） */
function highlightArticleEn(raw, { vocab = [], phrases = [], grammar = [], patterns = [], knownRe = null } = {}) {
  const text = String(raw || '');
  if (!text) return '';
  const marks = [];
  const pushMatches = (re, type, key) => {
    let m;
    while ((m = re.exec(text))) {
      marks.push({
        start: m.index, end: m.index + m[0].length, type, len: m[0].length,
        key: String(key || '').toLowerCase(),
      });
      if (m[0].length === 0) re.lastIndex++;
    }
  };
  const addMarks = (list, type, getTerm) => {
    for (const item of list || []) {
      const term = String(getTerm(item) || '').trim();
      if (term.length < 2) continue;
      let re;
      try {
        if (type === 'phrase') {
          re = new RegExp(escapeRegExp(term).replace(/\s+/g, '\\s+'), 'gi');
        } else {
          if (!/^[A-Za-z][A-Za-z'-]*$/.test(term)) continue;
          re = new RegExp(`\\b${escapeRegExp(term)}(?:s|es|ed|ing|d)?\\b`, 'gi');
        }
      } catch { continue; }
      pushMatches(re, type, term);
    }
  };
  /** 文法／句型：優先標英文結構本身，找不到再用原文例句 */
  const addGrammarMarks = (list, getKey, getEx) => {
    for (const item of list || []) {
      const key = String(getKey(item) || '').trim();
      if (!key) continue;
      const seen = new Set();
      const tryTerm = (term) => {
        const t = String(term || '').trim();
        if (t.length < 2 || t.length > 180) return;
        const sig = t.toLowerCase();
        if (seen.has(sig)) return;
        seen.add(sig);
        let pat = escapeRegExp(t).replace(/\s+/g, '\\s+');
        // not only...but also 這類省略號允許中間有空隙
        pat = pat.replace(/(?:\\\.){2,}/g, '[\\s\\S]{0,80}?');
        try {
          pushMatches(new RegExp(pat, 'gi'), 'grammar', key);
        } catch { /* ignore bad pattern */ }
      };
      // 含足夠英文字母才當結構本身去比對（略過純中文標題）
      if (/[A-Za-z]/.test(key) && (key.match(/[A-Za-z]/g) || []).length >= 2) tryTerm(key);
      const ex = String(getEx(item) || '').trim();
      if (ex) tryTerm(ex);
    }
  };
  addMarks(phrases, 'phrase', x => x.phrase);
  addGrammarMarks(grammar, x => x.point, x => x.example_en);
  addGrammarMarks(patterns, x => x.pattern, x => x.example_en);
  addMarks(vocab, 'vocab', x => x.word);
  marks.sort((a, b) => a.start - b.start || b.len - a.len);
  const picked = [];
  for (const mk of marks) {
    if (picked.some(p => !(mk.end <= p.start || mk.start >= p.end))) continue;
    picked.push(mk);
  }
  picked.sort((a, b) => a.start - b.start);
  let html = '', cursor = 0;
  const wrapKnown = (slice) => {
    const safe = esc(slice);
    if (!knownRe) return safe;
    knownRe.lastIndex = 0;
    return safe.replace(knownRe, m => `<mark class="rd-known">${m}</mark>`);
  };
  for (const mk of picked) {
    if (mk.start > cursor) html += wrapKnown(text.slice(cursor, mk.start));
    const chunk = esc(text.slice(mk.start, mk.end));
    const keyAttr = attr(mk.key);
    if (mk.type === 'phrase') {
      html += `<mark class="rd-imp-phrase" data-imp-phrase="${keyAttr}" title="點擊跳到右側重要片語">${chunk}</mark>`;
    } else if (mk.type === 'grammar') {
      html += `<mark class="rd-imp-grammar" data-imp-grammar="${keyAttr}" title="點擊跳到右側重要文法／句型">${chunk}</mark>`;
    } else {
      html += `<mark class="rd-imp-word" data-imp-word="${keyAttr}" title="點擊跳到右側重要單字">${chunk}</mark>`;
    }
    cursor = mk.end;
  }
  if (cursor < text.length) html += wrapKnown(text.slice(cursor));
  return html;
}
function highlightKnown(text, re) {
  return highlightArticleEn(text, { knownRe: re });
}

/** 從節點取出純文字（去掉按鈕等） */
function plainEnText(node) {
  if (!node) return '';
  const clone = node.cloneNode(true);
  clone.querySelectorAll('button, .speak-btn').forEach(b => b.remove());
  return (clone.textContent || '').replace(/\s+/g, ' ').trim();
}

function wordFromDblClick(e) {
  if (e.target.closest('button, a, input, select, textarea, .speak-btn, .rd-add-vocab, .ls-regen, .rd-regen, .side-edit-toggle, .ed-del-row, .ed-add')) return '';
  const sel = window.getSelection();
  let w = (sel && String(sel.toString()) || '').trim();
  w = w.replace(/^[\s"'“”‘’(\[{«]+|[\s"'“”‘’.,!?;:…)\]}»]+$/g, '').trim();
  if (!w || w.length > 60) return '';
  return w;
}

const SIDE_LIST_FIELDS = {
  vocab: {
    cols: [['word', '單字'], ['pos', '詞性'], ['meaning_zh', '中文'], ['example_en', '例句'], ['example_zh', '例句中譯']],
    blank: () => ({ word: '', pos: '', meaning_zh: '', example_en: '', example_zh: '' }),
  },
  phrases: {
    cols: [['phrase', '片語'], ['meaning_zh', '中文'], ['example_en', '例句']],
    blank: () => ({ phrase: '', meaning_zh: '', example_en: '' }),
  },
  patterns: {
    cols: [['pattern', '句型'], ['explain_zh', '說明'], ['example_en', '例句']],
    blank: () => ({ pattern: '', explain_zh: '', example_en: '' }),
  },
  grammar: {
    cols: [['point', '重點'], ['explain_zh', '說明'], ['example_en', '例句']],
    blank: () => ({ point: '', explain_zh: '', example_en: '' }),
  },
};

let readerEditingSide = null; // 'vocab'|'phrases'|'patterns'|null
let listenEditingSide = null; // 'vocab'|'phrases'|'grammar'|null

function sideListEditorHtml(field, list) {
  const cfg = SIDE_LIST_FIELDS[field];
  if (!cfg) return '<p class="hint">—</p>';
  const rows = (list || []).map((item, i) => {
    const cells = cfg.cols.map(([k, label]) =>
      `<label class="ed-cell"><span>${label}</span><input class="ed-input side-ed-input" data-side-field="${field}" data-idx="${i}" data-key="${k}" value="${attr(item[k])}" /></label>`
    ).join('');
    return `<div class="ed-row side-ed-row" style="grid-template-columns:repeat(${Math.min(cfg.cols.length, 3)},minmax(0,1fr)) auto">
      ${cells}
      <button class="ed-del-row" data-side-del="${field}" data-idx="${i}" title="刪除這列" type="button">✕</button>
    </div>`;
  }).join('');
  return `<div class="side-editor" data-side-editor="${esc(field)}">
    ${rows || '<p class="hint">尚無項目</p>'}
    <button class="ed-add" data-side-add="${esc(field)}" type="button">＋ 新增一列</button>
  </div>`;
}

function sideVocabHtml(vocab, { jumpable = false, editing = false } = {}) {
  if (editing) return sideListEditorHtml('vocab', vocab);
  const list = vocab || [];
  if (!list.length) return '<p class="hint">—</p>';
  const mode = jumpable === true ? 'time' : jumpable;
  const exLine = (ex, jumpVal) => {
    if (!ex) return '';
    if (!mode) {
      return `<div class="example">${esc(ex)} <button class="speak-btn" data-speak="${esc(ex)}" data-src="browser" type="button">🔊</button></div>`;
    }
    const canJump = jumpVal != null && jumpVal !== '';
    if (mode === 'para') {
      const cls = canJump ? 'example rd-jump' : 'example';
      const attrs = canJump ? ` data-pi="${jumpVal}" title="點擊跳到文章第 ${Number(jumpVal) + 1} 段"` : '';
      return `<div class="${cls}"${attrs}>${esc(ex)} <button class="speak-btn" data-speak="${esc(ex)}" data-src="browser" type="button">🔊</button></div>`;
    }
    const cls = canJump ? 'example ls-jump' : 'example';
    const attrs = canJump ? ` data-start="${jumpVal}" title="點擊跳到影片／音檔對應處"` : '';
    return `<div class="${cls}"${attrs}>${esc(ex)} <button class="speak-btn" data-speak="${esc(ex)}" data-src="browser" type="button">🔊</button></div>`;
  };
  return list.map(v => {
    const jumpVal = mode === 'para' ? v.example_pi : v.example_start;
    const canJump = !!(mode && jumpVal != null && jumpVal !== '');
    const jumpCls = canJump ? (mode === 'para' ? ' rd-jump' : ' ls-jump') : '';
    const jumpAttr = canJump
      ? (mode === 'para'
        ? ` data-pi="${jumpVal}" title="點擊跳到文章第 ${Number(jumpVal) + 1} 段"`
        : ` data-start="${jumpVal}" title="點擊跳到影片／音檔 ${typeof fmtTime === 'function' ? fmtTime(jumpVal) : ''} 處"`)
      : '';
    const jumpBadge = canJump ? '<span class="rd-jump-hint" aria-hidden="true">↗ 跳轉</span>' : '';
    return `<div class="def-item rd-vitem${jumpCls}" data-word="${esc((v.word || '').toLowerCase())}"${jumpAttr}>
      <div class="rd-vhead">
        <b class="rd-vword">${esc(v.word)}</b>${spkw(v.word)}${jumpBadge}
        <button class="btn ghost small rd-add-vocab" data-word="${esc(v.word)}" data-ex="${esc(v.example_en || '')}">＋ 加入詞庫</button>
      </div>
      ${(v.pos || v.meaning_zh) ? `<div class="rd-vmean">${v.pos ? `<span class="def-pos">${esc(v.pos)}</span>` : ''}${v.meaning_zh ? `<span class="def-zh">${esc(v.meaning_zh)}</span>${spkZh(v.meaning_zh)}` : ''}</div>` : ''}
      ${exLine(v.example_en, jumpVal)}
      ${v.example_zh ? `<div class="ex-zh">${esc(v.example_zh)}</div>` : ''}
    </div>`;
  }).join('');
}

function sidePhrasesHtml(phrases, { jumpable = false, editing = false, field = 'phrases' } = {}) {
  if (editing) return sideListEditorHtml(field, phrases);
  const list = phrases || [];
  if (!list.length) return '<p class="hint">—</p>';
  return list.map(p => {
    const key = field === 'grammar' ? (p.point || '') : (field === 'patterns' ? (p.pattern || '') : (p.phrase || ''));
    const mean = field === 'patterns' || field === 'grammar' ? (p.explain_zh || '') : (p.meaning_zh || '');
    const jumpVal = jumpable === 'para' ? p.example_pi : p.example_start;
    const canJump = jumpable && jumpVal != null && jumpVal !== '';
    const jumpCls = canJump ? (jumpable === 'para' ? ' rd-jump' : ' ls-jump') : '';
    const jumpAttr = canJump
      ? (jumpable === 'para'
        ? ` data-pi="${jumpVal}" title="點擊跳到對應段落"`
        : ` data-start="${jumpVal}" title="點擊跳到影片／音檔對應處"`)
      : '';
    const jumpBadge = canJump ? '<span class="rd-jump-hint" aria-hidden="true">↗ 跳轉</span>' : '';
    return `<div class="def-item rd-pitem${jumpCls}" data-phrase="${esc(key.toLowerCase())}"${jumpAttr}>
      <div class="rd-vhead"><b>${esc(key)}</b>${jumpBadge} <button class="speak-btn" data-speak="${esc(key)}" data-src="browser" type="button">🔊</button></div>
      ${mean ? `<div class="rd-vmean">${esc(mean)}</div>` : ''}
      ${p.example_en ? `<div class="example${jumpCls}"${jumpAttr}>${esc(p.example_en)} <button class="speak-btn" data-speak="${esc(p.example_en)}" data-src="browser" type="button">🔊</button></div>` : ''}
    </div>`;
  }).join('');
}

async function enrichSideVocabMeaning(store, word, onDone) {
  const entry = (store.vocab || []).find(v => (v.word || '').toLowerCase() === word.toLowerCase());
  if (!entry) return;
  try {
    const schema = {
      type: 'object',
      properties: { pos: { type: 'string' }, meaning_zh: { type: 'string' }, example_zh: { type: 'string' } },
      required: ['meaning_zh'],
    };
    const out = await readerJSON(
      `解釋英文「${word}」在此句中的意思。回傳：pos（詞性，如 n. / v. / adj.）、meaning_zh（簡短繁體中文）、可選 example_zh（整句中譯）。\n句子：${entry.example_en || '（無）'}\n只輸出 JSON。`,
      schema, 0.3, 512,
    );
    if (out.pos) entry.pos = out.pos;
    if (out.meaning_zh) entry.meaning_zh = out.meaning_zh;
    if (out.example_zh) entry.example_zh = out.example_zh;
  } catch (e) {
    if (entry.meaning_zh === '查詢中…') entry.meaning_zh = '';
    console.error('單字意思查詢失敗', e);
  }
  if (typeof onDone === 'function') onDone();
}

/** 閱讀頁：雙擊單字 → 右側重要單字 */
function addReaderSideVocab(word, exampleEn, examplePi) {
  const book = readerBooks.find(b => b.id === readerCurrentBookId);
  const a = book && book.articles && book.articles[readerCurrentTocId];
  if (!a) { toast('請先開啟一篇文章', true); return; }
  a.vocab = a.vocab || [];
  const key = word.toLowerCase();
  const exists = a.vocab.some(v => (v.word || '').toLowerCase() === key);
  if (!exists) {
    const entry = { word, meaning_zh: '查詢中…', example_en: exampleEn || '', example_zh: '' };
    if (examplePi != null && examplePi !== '') entry.example_pi = examplePi;
    a.vocab.unshift(entry);
    book.updatedAt = now();
    saveReader();
    const box = $('#rdVocabList');
    if (box) box.innerHTML = sideVocabHtml(a.vocab, { jumpable: 'para' });
    toast(`已加入「${word}」`);
    enrichSideVocabMeaning(a, word, () => {
      saveReader();
      const b = $('#rdVocabList');
      if (b) b.innerHTML = sideVocabHtml(a.vocab, { jumpable: 'para' });
      scrollReaderVocabIntoView(word);
    });
  } else {
    toast(`「${word}」已在重要單字`);
  }
  scrollReaderVocabIntoView(word);
}

/** 右側欄滾到指定項目並暫時高亮 */
function scrollSidePanelItemIntoView({ sideSel, listSel, attr, value, collapseKey, setCollapse }) {
  const key = String(value || '').toLowerCase();
  if (!key) return;
  if (collapseKey) {
    const col = document.querySelector(`${sideSel} .rd-collapse[data-collapse="${collapseKey}"]`);
    if (col) {
      col.classList.remove('collapsed');
      if (typeof setCollapse === 'function') setCollapse(collapseKey, false);
    }
  }
  const side = document.querySelector(sideSel);
  let el = null;
  try {
    el = document.querySelector(`${listSel} [${attr}="${CSS.escape(key)}"]`);
  } catch {
    el = null;
  }
  if (!el) return;
  try {
    const sRect = side?.getBoundingClientRect();
    const eRect = el.getBoundingClientRect();
    if (side && sRect) {
      const delta = (eRect.top - sRect.top) - 12;
      side.scrollTo({ top: side.scrollTop + delta, behavior: 'smooth' });
    } else {
      el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  } catch {
    el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
  el.classList.remove('rd-vitem-flash');
  void el.offsetWidth;
  el.classList.add('rd-vitem-flash');
  setTimeout(() => el.classList.remove('rd-vitem-flash'), 1600);
}

/** 右側欄滾到指定重要單字，並暫時高亮 */
function scrollReaderVocabIntoView(word) {
  scrollSidePanelItemIntoView({
    sideSel: '#readerArticle .rd-aside',
    listSel: '#rdVocabList',
    attr: 'data-word',
    value: word,
    collapseKey: 'vocab',
    setCollapse: setReaderCollapse,
  });
}
function scrollReaderPhraseIntoView(phrase) {
  scrollSidePanelItemIntoView({
    sideSel: '#readerArticle .rd-aside',
    listSel: '#rdPhraseList',
    attr: 'data-phrase',
    value: phrase,
    collapseKey: 'phrases',
    setCollapse: setReaderCollapse,
  });
}
function scrollListenVocabIntoView(word) {
  scrollSidePanelItemIntoView({
    sideSel: '#listenSide',
    listSel: '#lsVocabList',
    attr: 'data-word',
    value: word,
    collapseKey: 'vocab',
    setCollapse: setListenCollapse,
  });
}
function scrollListenPhraseIntoView(phrase) {
  scrollSidePanelItemIntoView({
    sideSel: '#listenSide',
    listSel: '#lsPhraseList',
    attr: 'data-phrase',
    value: phrase,
    collapseKey: 'phrases',
    setCollapse: setListenCollapse,
  });
}
function scrollReaderPatternIntoView(pattern) {
  scrollSidePanelItemIntoView({
    sideSel: '#readerArticle .rd-aside',
    listSel: '#rdPatternList',
    attr: 'data-phrase',
    value: pattern,
    collapseKey: 'patterns',
    setCollapse: setReaderCollapse,
  });
}
function scrollListenGrammarIntoView(point) {
  scrollSidePanelItemIntoView({
    sideSel: '#listenSide',
    listSel: '#lsGrammarList',
    attr: 'data-phrase',
    value: point,
    collapseKey: 'grammar',
    setCollapse: setListenCollapse,
  });
}

function readerCollapseState() {
  try { return JSON.parse(localStorage.getItem('reader_collapse_v1') || '{}') || {}; }
  catch { return {}; }
}
function setReaderCollapse(key, collapsed) {
  const st = readerCollapseState();
  st[key] = !!collapsed;
  localStorage.setItem('reader_collapse_v1', JSON.stringify(st));
}
function readerCollapseHtml(key, titleInner, bodyInner) {
  const collapsed = !!readerCollapseState()[key];
  return `<div class="rd-collapse${collapsed ? ' collapsed' : ''}" data-collapse="${esc(key)}">
    <div class="rd-collapse-head" role="button" tabindex="0" title="點擊收合／展開">
      <span class="rd-collapse-chevron" aria-hidden="true">▾</span>
      <div class="rd-sec-title">${titleInner}</div>
    </div>
    <div class="rd-collapse-body">${bodyInner}</div>
  </div>`;
}

function findReaderParaIndex(paragraphs, example) {
  const paras = paragraphs || [];
  const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9'\s]/g, ' ').replace(/\s+/g, ' ').trim();
  const needle = norm(example);
  if (!needle || needle.length < 3) return undefined;
  let best = null, bestScore = 0;
  for (let i = 0; i < paras.length; i++) {
    const hay = norm(paras[i].en);
    if (!hay) continue;
    if (hay.includes(needle) || needle.includes(hay)) return i;
    const words = needle.split(' ').filter(w => w.length > 2).slice(0, 6);
    if (!words.length) continue;
    const hit = words.filter(w => hay.includes(w)).length;
    const score = hit / words.length;
    if (score > bestScore && score >= 0.5) { bestScore = score; best = i; }
  }
  return best == null ? undefined : best;
}

function attachReaderExamplePis(article) {
  const paras = article.paragraphs || [];
  if (!paras.length) return;
  (article.vocab || []).forEach(v => {
    if (v.example_pi != null) return;
    const pi = findReaderParaIndex(paras, v.example_en);
    if (pi != null) v.example_pi = pi;
  });
  (article.phrases || []).forEach(p => {
    if (p.example_pi != null) return;
    const pi = findReaderParaIndex(paras, p.example_en || p.phrase);
    if (pi != null) p.example_pi = pi;
  });
  (article.patterns || []).forEach(p => {
    if (p.example_pi != null) return;
    const pi = findReaderParaIndex(paras, p.example_en || p.pattern);
    if (pi != null) p.example_pi = pi;
  });
}

async function generateReaderMindmap(paragraphs) {
  const paras = paragraphs || [];
  const numbered = paras.map((p, i) => `[P${i}] ${(p.en || '').trim()}`).filter(l => l.length > 4).join('\n').slice(0, 16000);
  if (!numbered.trim()) return null;
  const schema = {
    type: 'object',
    properties: {
      title: { type: 'string' },
      title_pi: { type: 'number' },
      branches: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            pi: { type: 'number' },
            bullets: {
              type: 'array',
              items: {
                type: 'object',
                properties: { text: { type: 'string' }, pi: { type: 'number' } },
                required: ['text'],
              },
            },
          },
          required: ['title'],
        },
      },
    },
    required: ['title', 'branches'],
  };
  const out = await readerJSON(
    `你是英語精讀老師。以下文章每段標了 [P數字]（段落編號）。用繁體中文產出「心智圖大綱」方便複習與跳轉：\n- title：中心主題（短句）\n- title_pi：主題對應段落編號（整數）\n- branches：4–8 個主分支；每個含 title、pi、bullets（2–5 個；每項含 text 與 pi）\npi 請對齊最相關那段的 [P數字]；要點精煉。只輸出 JSON。\n\n文章：\n${numbered}`,
    schema, 0.4, 4096,
  );
  const branches = (Array.isArray(out.branches) ? out.branches : []).map(b => ({
    title: b.title || '',
    pi: Number.isFinite(b.pi) ? b.pi : undefined,
    bullets: (b.bullets || []).map(x => {
      if (typeof x === 'string') return { text: x };
      return { text: x.text || '', pi: Number.isFinite(x.pi) ? x.pi : undefined };
    }),
  }));
  return {
    title: out.title || '',
    title_pi: Number.isFinite(out.title_pi) ? out.title_pi : undefined,
    branches,
  };
}

function attachReaderMindmapPis(article) {
  const paras = article.paragraphs || [];
  const mm = article.mindmap;
  if (!mm || !paras.length) return;
  const clamp = (n) => {
    if (!Number.isFinite(n)) return undefined;
    const i = Math.round(n);
    if (i < 0 || i >= paras.length) return undefined;
    return i;
  };
  const byHint = (hint, fallback) => {
    const c = clamp(fallback);
    if (c != null) return c;
    return findReaderParaIndex(paras, hint);
  };
  const tp = byHint(mm.title, mm.title_pi);
  if (tp != null) mm.title_pi = tp;
  (mm.branches || []).forEach(b => {
    const bp = byHint(b.title, b.pi);
    if (bp != null) b.pi = bp;
    (b.bullets || []).forEach(bu => {
      const up = byHint(bu.text, bu.pi);
      if (up != null) bu.pi = up;
    });
  });
}

function renderReaderMindmap(mm) {
  if (!mm || (!mm.title && !(mm.branches || []).length)) return '<p class="hint">—</p>';
  const jumpAttrs = (pi, label) => {
    if (pi == null || pi === '') return { cls: '', attrs: '', badge: '' };
    return {
      cls: ' rd-jump',
      attrs: ` data-pi="${pi}" title="點擊跳到第 ${Number(pi) + 1} 段：${esc(label || '')}"`,
      badge: `<span class="mm-time">§${Number(pi) + 1}</span>`,
    };
  };
  const centerJ = jumpAttrs(mm.title_pi, mm.title);
  const branches = (mm.branches || []).map(b => {
    const bj = jumpAttrs(b.pi, b.title);
    const bullets = (b.bullets || []).map(x => {
      const text = typeof x === 'string' ? x : (x.text || '');
      const pi = typeof x === 'string' ? undefined : x.pi;
      const uj = jumpAttrs(pi, text);
      return `<li class="mm-bullet${uj.cls}"${uj.attrs}>${uj.badge}<span class="mm-bullet-text">${esc(text)}</span></li>`;
    }).join('');
    return `<li class="mm-branch">
      <div class="mm-branch-title${bj.cls}"${bj.attrs}>${bj.badge}<span>${esc(b.title || '')}</span></div>
      ${bullets ? `<ul class="mm-bullets">${bullets}</ul>` : ''}
    </li>`;
  }).join('');
  return `<div class="mm-map">
    <div class="mm-center${centerJ.cls}"${centerJ.attrs}>${centerJ.badge}<span>${esc(mm.title || '大綱')}</span></div>
    ${branches ? `<ul class="mm-branches">${branches}</ul>` : ''}
  </div>`;
}

function readerSeekToPara(pi) {
  const i = parseInt(pi, 10);
  if (!Number.isFinite(i)) return;
  const main = document.querySelector('#readerArticle .rd-main');
  const el = document.querySelector(`#readerArticle .rd-para[data-pi="${i}"]`);
  if (!el) return;
  if (main) scrollWithin(main, el);
  else try { el.scrollIntoView({ block: 'start', behavior: 'smooth' }); } catch {}
  el.classList.add('rd-para-flash');
  setTimeout(() => el.classList.remove('rd-para-flash'), 1200);
}

function renderArticle(book, a) {
  const el = $('#readerArticle');
  const re = buildKnownWordRegex();
  const hasAiAudio = !!(readerAudioSrc(a) && (a.audioCues || []).length);
  const speed = getReaderSpeed();
  const speedOpts = [0.75, 1, 1.25, 1.5, 1.75, 2].map(s =>
    `<option value="${s}"${s === speed ? ' selected' : ''}>${s}x</option>`).join('');
  // 舊資料補段落跳轉索引
  if ((a.vocab || []).some(v => v.example_en && v.example_pi == null)
    || (a.phrases || []).some(p => (p.example_en || p.phrase) && p.example_pi == null)
    || (a.patterns || []).some(p => (p.example_en || p.pattern) && p.example_pi == null)) {
    attachReaderExamplePis(a);
  }
  if (a.mindmap) attachReaderMindmapPis(a);

  const paras = (a.paragraphs || []).map((p, i) => {
    const en = highlightArticleEn(p.en || '', {
      vocab: a.vocab, phrases: a.phrases, patterns: a.patterns, knownRe: re,
    });
    const paraHasAi = hasAiAudio && (a.audioCues || []).some(c => c.i === i);
    return `<div class="rd-para" data-pi="${i}">
      <p class="rd-en">${en}
        <button class="speak-btn rd-para-spk" data-speak="${esc(p.en || '')}" data-src="browser" title="瀏覽器朗讀此段" type="button">🔊</button>
        ${paraHasAi ? `<button class="rd-para-ai" data-pi="${i}" title="AI 語音此段" type="button">🤖</button>` : ''}
      </p>
      <p class="rd-zh">${esc(p.zh || '')}</p>
    </div>`;
  }).join('') || '<p class="hint">（沒有逐段內容）</p>';

  const regen = part => `<button class="btn ghost small rd-regen" data-rdpart="${part}" title="重新生成這部分">↻</button>`;
  const editBtn = (field) => {
    const on = readerEditingSide === field;
    return `<button class="btn ghost small side-edit-toggle" data-side-edit="${field}" type="button" title="${on ? '完成編輯' : '編輯此區'}">${on ? '✓ 完成' : '✏️ 編輯'}</button>`;
  };
  const vocabHtml = sideVocabHtml(a.vocab, { jumpable: 'para', editing: readerEditingSide === 'vocab' });
  const phraseHtml = sidePhrasesHtml(a.phrases, { jumpable: 'para', editing: readerEditingSide === 'phrases', field: 'phrases' });
  const patternHtml = sidePhrasesHtml(a.patterns, { jumpable: 'para', editing: readerEditingSide === 'patterns', field: 'patterns' });

  const followOn = localStorage.getItem('reader_follow') !== '0';
  const summaryBody = `<p>${a.summary ? esc(a.summary) : '<span class="hint">—</span>'}</p>`;
  const mindBody = renderReaderMindmap(a.mindmap);

  el.innerHTML = `
    <div class="rd-article-head">
      <h2 class="rd-atitle">${esc(a.title)}</h2>
      <div class="rd-tools">
        <label class="rd-speed" title="瀏覽器與 AI 朗讀語速">語速
          <select id="rdSpeed">${speedOpts}</select>
        </label>
        <button class="btn ghost small" id="rdToggleZh" type="button" title="隱藏／顯示中文翻譯">${hideZh ? '顯示中文' : '隱藏中文'}</button>
        <button class="btn ghost small" id="rdReadAll">🔊 瀏覽器朗讀</button>
        <button class="btn ghost small" id="rdReadAi">${hasAiAudio ? '▶️ 播放 AI 語音' : '🤖 AI 朗讀整篇'}</button>
        <button class="btn ghost small" id="rdStop">⏹ 停止</button>
        <button class="btn ghost small" id="rdReprocess" title="重新用 AI 整理這篇">↻ 重新整理</button>
      </div>
    </div>
    <div class="rd-body-split">
      <div class="rd-main">
        <div class="rd-section">
          <div class="rd-sec-title">📖 逐段中英對照
            <span class="hint" style="font-weight:400">（雙擊單字加入右側・綠底＝重要單字・綠底線＝重要片語）</span>
            <label class="listen-follow"><input type="checkbox" id="rdFollow"${followOn ? ' checked' : ''} /> 朗讀跟讀</label>
          </div>
          ${paras}
        </div>
      </div>
      <div class="rd-resizer" title="拖曳調整左右寬度"></div>
      <aside class="rd-aside">
        <div class="rd-summary">
          <div class="rd-sec-title">📌 大意 ${a.summary ? spkZh(a.summary) : ''} ${regen('summary')}</div>
          ${summaryBody}
        </div>
        ${readerCollapseHtml('mindmap', `🧠 心智圖大綱 ${regen('mindmap')}`, mindBody)}
        ${readerCollapseHtml('vocab', `🔑 重要單字 ${regen('vocab')} ${editBtn('vocab')}`, `<div id="rdVocabList">${vocabHtml}</div>`)}
        ${readerCollapseHtml('phrases', `🧩 重要片語 ${regen('phrases')} ${editBtn('phrases')}`, `<div id="rdPhraseList">${phraseHtml}</div>`)}
        ${readerCollapseHtml('patterns', `🏗 重要句型 ${regen('patterns')} ${editBtn('patterns')}`, `<div id="rdPatternList">${patternHtml}</div>`)}
      </aside>
    </div>`;
  applyHideZh();
}

/** 閱讀頁：重新生成某一部分重點 */
async function rereadAnalyze(article, part) {
  const book = readerBooks.find(b => b.id === readerCurrentBookId);
  if (!book || !article) return;
  const text = (article.paragraphs || []).map(p => p.en).join('\n').slice(0, 16000)
    || String(article.body || '').slice(0, 16000);
  if (!text.trim()) { toast('沒有文章內容', true); return; }
  let schema, prompt, apply;
  if (part === 'summary') {
    schema = { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] };
    prompt = `用繁體中文寫出這篇文章的整體大意（3–5 句）。只輸出 JSON。\n\n文章：\n${text}`;
    apply = o => { article.summary = o.summary || ''; };
  } else if (part === 'vocab') {
    schema = { type: 'object', properties: { vocab: { type: 'array', items: { type: 'object', properties: { word: { type: 'string' }, pos: { type: 'string' }, meaning_zh: { type: 'string' }, example_en: { type: 'string' }, example_zh: { type: 'string' } }, required: ['word'] } } }, required: ['vocab'] };
    prompt = `你是英語精讀老師。從以下文章挑出 10–15 個重要單字，每個含 word、pos（詞性）、meaning_zh、example_en、example_zh。只輸出 JSON。\n\n文章：\n${text}`;
    apply = o => { article.vocab = o.vocab || []; };
  } else if (part === 'phrases') {
    schema = { type: 'object', properties: { phrases: { type: 'array', items: { type: 'object', properties: { phrase: { type: 'string' }, meaning_zh: { type: 'string' }, example_en: { type: 'string' } }, required: ['phrase'] } } }, required: ['phrases'] };
    prompt = `從以下文章挑出 5–10 個重要片語／搭配，附 meaning_zh 與 example_en（優先取自文章）。只輸出 JSON。\n\n文章：\n${text}`;
    apply = o => { article.phrases = o.phrases || []; };
  } else if (part === 'patterns') {
    schema = { type: 'object', properties: { patterns: { type: 'array', items: { type: 'object', properties: { pattern: { type: 'string' }, explain_zh: { type: 'string' }, example_en: { type: 'string' } }, required: ['pattern'] } } }, required: ['patterns'] };
    prompt = `從以下文章挑出 3–6 個重要句型／文法結構，附 explain_zh 與 example_en。只輸出 JSON。\n\n文章：\n${text}`;
    apply = o => { article.patterns = o.patterns || []; };
  } else if (part === 'mindmap') {
    toast('重新整理心智圖大綱中…');
    try {
      article.mindmap = await generateReaderMindmap(article.paragraphs || []);
      attachReaderMindmapPis(article);
      book.updatedAt = now(); saveReader();
      renderArticle(book, article);
      toast('心智圖大綱已重新整理');
    } catch (e) { toast('重新整理心智圖失敗：' + e.message, true); }
    return;
  } else return;
  const label = { summary: '大意', vocab: '重要單字', phrases: '重要片語', patterns: '重要句型' }[part];
  toast(`重新整理${label}中…`);
  try {
    const out = await readerJSON(prompt, schema, 0.5);
    apply(out);
    attachReaderExamplePis(article);
    book.updatedAt = now(); saveReader();
    renderArticle(book, article);
    toast(`${label}已重新整理`);
  } catch (e) { toast(`重新整理${label}失敗：` + e.message, true); }
}
function addListenSideVocab(word, exampleEn, exampleStart) {
  const item = listenItems.find(i => i.id === listenCurrentId);
  if (!item) { toast('請先開啟一則聽力', true); return; }
  item.vocab = item.vocab || [];
  const key = word.toLowerCase();
  const exists = item.vocab.some(v => (v.word || '').toLowerCase() === key);
  if (!exists) {
    const entry = { word, meaning_zh: '查詢中…', example_en: exampleEn || '' };
    if (exampleStart != null && exampleStart !== '') entry.example_start = exampleStart;
    item.vocab.unshift(entry);
    item.updatedAt = now();
    saveListen();
    const box = $('#lsVocabList');
    if (box) {
      box.innerHTML = sideVocabHtml(item.vocab, { jumpable: true });
    } else if (listenCurrentId === item.id) {
      renderListenItem(item);
    }
    toast(`已加入「${word}」`);
    enrichSideVocabMeaning(item, word, () => {
      saveListen();
      const b = $('#lsVocabList');
      if (b) b.innerHTML = sideVocabHtml(item.vocab, { jumpable: true });
      scrollListenVocabIntoView(word);
    });
  } else {
    toast(`「${word}」已在重要單字`);
  }
  scrollListenVocabIntoView(word);
}

/* ---------- 加入詞庫彈窗 ---------- */
function openReaderAdd(word, example) {
  $('#raddWord').value = word || '';
  $('#raddRaw').value = '';
  const ex = $('#raddExample');
  ex.textContent = example ? `文章例句：${example}` : '';
  $('#raddStatus').hidden = true;
  const dup = findExistingCard(word);
  if (dup) toast(`「${word}」已在詞庫，仍可重新整理一張`, false);
  $('#readerAddModal').hidden = false;
  document.body.classList.add('modal-open');
  $('#raddWord').focus();
}
function closeReaderAdd() {
  $('#readerAddModal').hidden = true;
  document.body.classList.remove('modal-open');
}
async function readerDoAdd() {
  const word = $('#raddWord').value.trim();
  let raw = $('#raddRaw').value.trim();
  if (!word) { toast('請輸入單字', true); return; }
  const status = $('#raddStatus');
  const btn = $('#raddGenBtn');
  status.hidden = false; status.className = 'gen-status';
  status.innerHTML = '<span class="spinner"></span> 整理中…';
  btn.disabled = true;
  try {
    if (!raw) {
      raw = await resolveCardRaw(word, '', msg => {
        status.innerHTML = `<span class="spinner"></span> ${esc(msg)}`;
      });
      if (raw) $('#raddRaw').value = raw;
    }
    const data = await callGemini(word, raw);
    const card = addCardFromData(data, raw);
    saveCards();
    cloudUpsert(card);
    toast(`已加入「${card.data.word}」到詞庫`);
    closeReaderAdd();
    // 重新渲染文章以更新螢光筆標示
    const book = readerBooks.find(b => b.id === readerCurrentBookId);
    if (book && readerCurrentTocId && book.articles?.[readerCurrentTocId]) renderArticle(book, book.articles[readerCurrentTocId]);
    // 聽力頁若開啟中，也刷新逐字稿螢光筆
    const litem = listenItems.find(i => i.id === listenCurrentId);
    if (litem && !$('#view-listen')?.hidden && document.querySelector('#view-listen')?.classList.contains('active')) renderListenItem(litem);
  } catch (e) {
    status.className = 'gen-status error';
    status.textContent = '⚠️ ' + e.message;
  } finally { btn.disabled = false; }
}

/* ---------- 綁定 ---------- */
function fileToBase64(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(',')[1]);
    r.onerror = rej;
    r.readAsDataURL(file);
  });
}
// 泛用 Gemini 請求（支援圖片；含金鑰輪詢與併發限制）
async function geminiGenerate(parts, cfg = {}) {
  const keys = activeKeys();
  if (!keys.length) throw new Error('尚未設定 API 金鑰，請到「設定」填入。');
  const body = {
    contents: [{ role: 'user', parts }],
    generationConfig: {
      temperature: cfg.temperature ?? 0.6,
      maxOutputTokens: cfg.maxOutputTokens ?? 8192,
      ...(cfg.schema ? { responseMimeType: 'application/json', responseSchema: cfg.schema } : {}),
    },
  };
  await acquireSlot();
  try {
    let lastErr;
    for (let attempt = 0; attempt < keys.length; attempt++) {
      const idx = keyIndex % keys.length; const key = keys[idx];
      keyIndex = (keyIndex + 1) % keys.length;
      try {
        const data = await requestGemini(key, body, cfg.model);
        const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || '';
        if (!text) throw new Error('沒有回傳內容。');
        return text;
      } catch (err) {
        lastErr = err;
        if (err.status && ![429, 500, 502, 503, 504].includes(err.status)) throw new Error(`第 ${idx + 1} 把金鑰${err.message}`);
      }
    }
    throw new Error(`所有金鑰都失敗了：${lastErr ? lastErr.message : '未知錯誤'}`);
  } finally { releaseSlot(); }
}
// 盡量從模型回傳的字串救出 JSON：去除 ```json 圍欄、擷取最外層物件/陣列、修補被截斷的結尾
function parseLooseJSON(text) {
  let t = String(text || '').trim();
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  try { return JSON.parse(t); } catch {}
  // 擷取第一個 { 或 [ 到對應收尾之間的內容
  const start = t.search(/[{[]/);
  if (start >= 0) {
    const sub = t.slice(start);
    try { return JSON.parse(sub); } catch {}
    // 嘗試修補被截斷的 JSON：補上缺少的引號/括號
    for (let end = sub.length; end > 0; end--) {
      const cand = sub.slice(0, end);
      try { return JSON.parse(cand); } catch {}
    }
  }
  return null;
}

// 閱讀／聽力的翻譯與重點分析走較快的模型（可在設定的模型清單挑選；預設 gemini-2.5-flash）
const READER_FAST_MODEL = 'gemini-2.5-flash';
async function readerJSON(prompt, schema, temperature, maxTokens) {
  const max = maxTokens || 8192;
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const text = await geminiGenerate([{ text: prompt }], { schema, temperature, maxOutputTokens: max, model: READER_FAST_MODEL });
      const obj = parseLooseJSON(text);
      if (obj && typeof obj === 'object') return obj;
      lastErr = new Error('無法解析回傳的 JSON。');
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('無法解析回傳的 JSON。');
}
async function visionTranscribe(file) {
  const b64 = await fileToBase64(file);
  return geminiGenerate(
    [{ text: '把這張圖片中的英文文章文字完整轉錄為純文字，保留段落換行；不要翻譯、不要加入任何說明。' },
      { inlineData: { mimeType: file.type || 'image/png', data: b64 } }],
    { temperature: 0.1 },
  );
}

// 閱讀頁：正文／右側重點可拖曳調整寬度（記憶在 localStorage）
function bindReaderResizer() {
  const saved = localStorage.getItem('reader_side_w');
  if (saved) document.documentElement.style.setProperty('--reader-side-w', saved);
  let dragging = false;
  let activeRez = null;
  const move = e => {
    if (!dragging) return;
    const split = document.querySelector('#readerArticle .rd-body-split');
    if (!split) return;
    const rect = split.getBoundingClientRect();
    const min = 240, max = Math.max(min, rect.width * 0.55);
    const w = Math.max(min, Math.min(max, rect.right - e.clientX));
    document.documentElement.style.setProperty('--reader-side-w', w + 'px');
  };
  const up = () => {
    if (!dragging) return;
    dragging = false;
    if (activeRez) activeRez.classList.remove('dragging');
    activeRez = null;
    document.body.style.userSelect = '';
    const v = getComputedStyle(document.documentElement).getPropertyValue('--reader-side-w').trim();
    if (v) localStorage.setItem('reader_side_w', v);
  };
  // 委派：renderArticle 會重建 DOM，不能只綁一次節點
  document.addEventListener('pointerdown', e => {
    const rez = e.target.closest('.rd-resizer');
    if (!rez || !rez.closest('#readerArticle')) return;
    dragging = true;
    activeRez = rez;
    rez.classList.add('dragging');
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

function bindReader() {
  bindReaderResizer();
  $('#readerPdfFile')?.addEventListener('change', e => {
    const f = e.target.files && e.target.files[0];
    if (f) readerAddPdf(f);
    e.target.value = '';
  });
  $('#readerPasteBtn')?.addEventListener('click', () => openReaderPaste('book'));
  $('#readerPasteModal')?.addEventListener('click', e => { if (e.target.closest('[data-close-rpaste]')) closeReaderPaste(); });
  $('#rpasteConfirm')?.addEventListener('click', () => {
    const title = ($('#rpasteTitle').value || '').trim();
    const text = ($('#rpasteBody').value || '');
    if (!text.trim()) { toast('沒有內容', true); return; }
    const mode = readerPasteMode;
    closeReaderPaste();
    if (mode === 'toc') {
      const book = readerBooks.find(b => b.id === readerCurrentBookId);
      if (!book) { toast('找不到目前書本', true); return; }
      readerAddArticleToBook(book, title || '未命名文章', text);
    } else {
      readerAddText(title || '未命名文章', text);
    }
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && $('#readerPasteModal') && !$('#readerPasteModal').hidden) closeReaderPaste();
  });
  $('#readerImgFile')?.addEventListener('change', async e => {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!f) return;
    const hint = $('#readerLibHint');
    const setHint = t => { if (hint) hint.textContent = t; };
    try {
      setHint('AI 辨識圖片文字中…');
      const text = (await visionTranscribe(f)).trim();
      setHint('');
      if (!text) { toast('圖片中沒有辨識到文字', true); return; }
      const title = (prompt('文章標題（可自訂）', f.name.replace(/\.[^.]+$/, '')) || '').trim();
      readerAddText(title || '截圖文章', text);
    } catch (err) { setHint(''); toast('圖片辨識失敗：' + err.message, true); }
  });

  $('#readerBackToLib')?.addEventListener('click', () => {
    readerCurrentBookId = null; readerCurrentTocId = null; renderReader();
  });
  $('#readerRenameBook')?.addEventListener('click', () => {
    const book = readerBooks.find(b => b.id === readerCurrentBookId);
    if (!book) return;
    const t = (prompt('新書名', book.title) || '').trim();
    if (!t) return;
    book.title = t; book.updatedAt = now(); saveReader(); renderReader();
  });
  $('#readerDeleteBook')?.addEventListener('click', () => {
    const book = readerBooks.find(b => b.id === readerCurrentBookId);
    if (!book) return;
    if (!confirm(`確定刪除《${book.title}》？此動作無法復原。`)) return;
    readerBooks = readerBooks.filter(b => b.id !== book.id);
    readerCurrentBookId = null; readerCurrentTocId = null;
    saveReader(); renderReader();
  });

  $('#readerBookList')?.addEventListener('click', e => {
    const b = e.target.closest('[data-book]');
    if (b) { readerCurrentBookId = b.dataset.book; readerCurrentTocId = null; renderReader(); }
  });
  $('#readerToc')?.addEventListener('click', e => {
    if (e.target.closest('#readerAddTocBtn')) {
      if (!readerCurrentBookId) { toast('請先開啟一本書', true); return; }
      openReaderPaste('toc');
      return;
    }
    const item = e.target.closest('[data-toc]');
    if (!item) return;
    const book = readerBooks.find(b => b.id === readerCurrentBookId);
    if (!book) return;
    const toc = (book.toc || []).find(t => t.id === item.dataset.toc);
    if (toc) openArticle(book, toc);
  });
  $('#readerArticle')?.addEventListener('click', e => {
    const impPhrase = e.target.closest('.rd-imp-phrase');
    if (impPhrase && e.target.closest('.rd-en, .rd-para')) {
      scrollReaderPhraseIntoView(impPhrase.dataset.impPhrase || plainEnText(impPhrase));
      return;
    }
    const impGrammar = e.target.closest('.rd-imp-grammar');
    if (impGrammar && e.target.closest('.rd-en, .rd-para')) {
      scrollReaderPatternIntoView(impGrammar.dataset.impGrammar || plainEnText(impGrammar));
      return;
    }
    const impWord = e.target.closest('.rd-imp-word');
    if (impWord && e.target.closest('.rd-en, .rd-para')) {
      scrollReaderVocabIntoView(impWord.dataset.impWord || plainEnText(impWord));
      return;
    }
    const paraAi = e.target.closest('.rd-para-ai');
    if (paraAi) {
      const book = readerBooks.find(b => b.id === readerCurrentBookId);
      const a = book && book.articles && book.articles[readerCurrentTocId];
      if (a) readerPlayParaAI(a, parseInt(paraAi.dataset.pi, 10));
      return;
    }
    if (e.target.closest('.speak-btn')) return; // 交給全域喇叭
    const head = e.target.closest('.rd-collapse-head');
    if (head && !e.target.closest('button')) {
      const box = head.closest('.rd-collapse');
      if (box) {
        box.classList.toggle('collapsed');
        setReaderCollapse(box.dataset.collapse, box.classList.contains('collapsed'));
      }
      return;
    }
    const regen = e.target.closest('.rd-regen');
    if (regen) {
      const book = readerBooks.find(b => b.id === readerCurrentBookId);
      const a = book && book.articles && book.articles[readerCurrentTocId];
      if (a) rereadAnalyze(a, regen.dataset.rdpart);
      return;
    }
    const editToggle = e.target.closest('.side-edit-toggle');
    if (editToggle) {
      const field = editToggle.dataset.sideEdit;
      readerEditingSide = readerEditingSide === field ? null : field;
      const book = readerBooks.find(b => b.id === readerCurrentBookId);
      const a = book && book.articles && book.articles[readerCurrentTocId];
      if (book && a) renderArticle(book, a);
      return;
    }
    const sideAdd = e.target.closest('[data-side-add]');
    if (sideAdd) {
      const field = sideAdd.dataset.sideAdd;
      const book = readerBooks.find(b => b.id === readerCurrentBookId);
      const a = book && book.articles && book.articles[readerCurrentTocId];
      if (!a || !SIDE_LIST_FIELDS[field]) return;
      a[field] = a[field] || [];
      a[field].push(SIDE_LIST_FIELDS[field].blank());
      book.updatedAt = now(); saveReader();
      renderArticle(book, a);
      return;
    }
    const sideDel = e.target.closest('[data-side-del]');
    if (sideDel) {
      const field = sideDel.dataset.sideDel;
      const idx = +sideDel.dataset.idx;
      const book = readerBooks.find(b => b.id === readerCurrentBookId);
      const a = book && book.articles && book.articles[readerCurrentTocId];
      if (!a || !Array.isArray(a[field])) return;
      a[field].splice(idx, 1);
      book.updatedAt = now(); saveReader();
      renderArticle(book, a);
      return;
    }
    const add = e.target.closest('.rd-add-vocab');
    if (add) { openReaderAdd(add.dataset.word, add.dataset.ex); return; }
    const jump = e.target.closest('.rd-jump');
    if (jump && jump.dataset.pi != null) {
      readerSeekToPara(jump.dataset.pi);
      return;
    }
    if (e.target.closest('#rdToggleZh')) { toggleHideZh(); return; }
    if (e.target.closest('#rdReadAll')) {
      const book = readerBooks.find(b => b.id === readerCurrentBookId);
      const a = book && book.articles && book.articles[readerCurrentTocId];
      if (a) speakArticleWithHighlight(a);
      return;
    }
    if (e.target.closest('#rdReadAi')) {
      const book = readerBooks.find(b => b.id === readerCurrentBookId);
      const a = book && book.articles && book.articles[readerCurrentTocId];
      if (a) readerPlayAI(book, a);
      return;
    }
    if (e.target.closest('#rdStop')) { readerStopAudio(); return; }
    if (e.target.closest('#rdReprocess')) {
      const book = readerBooks.find(b => b.id === readerCurrentBookId);
      const toc = book && (book.toc || []).find(t => t.id === readerCurrentTocId);
      if (book && toc && confirm('重新用 AI 整理這篇文章？')) processArticle(book, toc);
      return;
    }
  });
  $('#readerArticle')?.addEventListener('input', e => {
    const t = e.target.closest('.side-ed-input');
    if (!t) return;
    const book = readerBooks.find(b => b.id === readerCurrentBookId);
    const a = book && book.articles && book.articles[readerCurrentTocId];
    if (!a) return;
    const field = t.dataset.sideField;
    const idx = +t.dataset.idx;
    if (!Array.isArray(a[field])) a[field] = [];
    a[field][idx] = a[field][idx] || {};
    a[field][idx][t.dataset.key] = t.value;
    book.updatedAt = now();
    saveReader();
  });
  $('#readerArticle')?.addEventListener('change', e => {
    if (e.target && e.target.id === 'rdSpeed') {
      setReaderSpeed(e.target.value);
      toast(`語速已設為 ${getReaderSpeed()}x`);
    }
    if (e.target && e.target.id === 'rdFollow') {
      localStorage.setItem('reader_follow', e.target.checked ? '1' : '0');
    }
  });
  $('#readerArticle')?.addEventListener('dblclick', e => {
    if (!e.target.closest('.rd-en, .rd-para')) return;
    const word = wordFromDblClick(e);
    if (!word) return;
    const para = e.target.closest('.rd-para');
    const example = plainEnText(para?.querySelector('.rd-en'));
    const pi = para ? parseInt(para.dataset.pi, 10) : undefined;
    addReaderSideVocab(word, example, Number.isFinite(pi) ? pi : undefined);
  });

  // 加入詞庫彈窗
  $('#raddGenBtn')?.addEventListener('click', readerDoAdd);
  $('#readerAddModal')?.querySelectorAll('[data-close-radd]').forEach(el => el.addEventListener('click', closeReaderAdd));
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !$('#readerAddModal').hidden) closeReaderAdd();
  });
}

/* =========================================================================
   聽力（音檔 / 影片 / YouTube 逐字稿精聽）
   item = { id, title, kind:'file'|'youtube', createdAt, updatedAt, status:'processing'|'done'|'error',
            mediaUrl (file kind，Firebase Storage 公開下載網址), mediaType:'video'|'audio', videoId (youtube),
            language, captionSource,
            segments:[{start,end,en,zh}],
            vocab:[{word,meaning_zh,example_en,example_start}], phrases:[{phrase,meaning_zh,example_en,example_start}],
            grammar:[{point,explain_zh,example_en,example_start}],
            mindmap:{title,title_start,branches:[{title,start,bullets:[{text,start}]}]}, summary }
   媒體檔由雲端後端存進 Firebase Storage（stt-tool 專案）；逐字稿/翻譯/分析存本機+雲端 meta。
   ========================================================================= */
let listenItems = [];
let listenCurrentId = null;
let listenSyncedLang = null;
let ytPlayer = null;
let listenMediaEl = null;
let listenPollTimer = null;
let listenActiveIdx = -1;
let listenPlayerId = null; // 目前播放器對應的 item id，避免重複重建

function listenBackend() { return (settings.listenBackend || 'https://whisper-api-1016448029865.asia-east1.run.app/api').replace(/\/$/, ''); }
function listenLangCode() {
  const d = (L().dictLang || '').slice(0, 2);
  if (d) return d;
  return currentLang.length === 2 ? currentLang : '';
}
// Whisper 語言名稱（Replicate incredibly-fast-whisper 用全名；未知則交給自動偵測）
const WHISPER_LANG_NAME = { en: 'english', de: 'german', ja: 'japanese', fr: 'french', ko: 'korean', es: 'spanish', nl: 'dutch', ru: 'russian', vi: 'vietnamese' };
function listenWhisperLang() { return WHISPER_LANG_NAME[listenLangCode()] || 'None'; }
function saveListenLocal() { localStorage.setItem(nsKey(LS_LISTEN), JSON.stringify(listenItems)); }
let listenCloudTimer = null;
function saveListenCloud() {
  if (!currentUid || !(window.Cloud && window.Cloud.enabled && window.Cloud.saveMeta)) return;
  clearTimeout(listenCloudTimer);
  listenCloudTimer = setTimeout(() => window.Cloud.saveMeta(`listen_${currentLang}`, { items: listenItems }), 1500);
}
function saveListen() { saveListenLocal(); saveListenCloud(); }

async function syncListenFromCloud() {
  if (listenSyncedLang === currentLang) return;
  listenSyncedLang = currentLang;
  if (!currentUid || !(window.Cloud && window.Cloud.enabled && window.Cloud.loadMeta)) return;
  try {
    const meta = await window.Cloud.loadMeta(`listen_${currentLang}`);
    if (meta && Array.isArray(meta.items)) {
      const map = new Map();
      listenItems.forEach(it => map.set(it.id, it));
      meta.items.forEach(ci => { const ex = map.get(ci.id); if (!ex || (ci.updatedAt || 0) >= (ex.updatedAt || 0)) map.set(ci.id, ci); });
      listenItems = Array.from(map.values()).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      saveListenLocal();
      if (!listenCurrentId) renderListen();
    }
  } catch (e) { console.error('讀取聽力雲端資料失敗', e); }
}

function openListen() {
  listenItems = loadJSON(nsKey(LS_LISTEN), []);
  renderListen();
  syncListenFromCloud();
  checkListenBackend();
}

async function checkListenBackend() {
  const el = $('#listenBackendState');
  if (!el) return;
  el.textContent = '偵測雲端後端…';
  try {
    const res = await fetch(listenBackend() + '/health', { cache: 'no-store' });
    if (res.ok) { el.textContent = '🟢 雲端轉錄後端已連線'; el.style.color = 'var(--good)'; }
    else throw new Error();
  } catch { el.textContent = '🔴 連不上雲端轉錄後端（請確認 Cloud Run 已部署且網址正確）'; el.style.color = 'var(--again)'; }
}

function renderListen() {
  const item = listenItems.find(i => i.id === listenCurrentId);
  const lib = $('#listenLibrary'), box = $('#listenItem');
  if (!lib || !box) return;
  if (item) { lib.hidden = true; box.hidden = false; renderListenItem(item); }
  else { listenStopPlayer(); lib.hidden = false; box.hidden = true; renderListenList(); }
}

function renderListenList() {
  const el = $('#listenList');
  if (!el) return;
  if (!listenItems.length) {
    el.innerHTML = '<div class="empty-state small"><p class="empty-sub">還沒有任何聽力內容。上傳音檔／影片或貼上 YouTube 網址。</p></div>';
    return;
  }
  el.innerHTML = listenItems.map(it => {
    const n = (it.segments || []).length;
    const d = new Date(it.createdAt || Date.now());
    const ds = `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
    const cap = it.captionSource === 'manual' ? '人工字幕'
      : it.captionSource === 'auto' ? '自動字幕'
      : it.captionSource === 'whisper' ? 'Whisper'
      : '';
    const st = it.status === 'processing' ? '（處理中…）' : it.status === 'error' ? '（處理失敗）' : `${n} 段${cap ? ' · ' + cap : ''}`;
    return `<button class="reader-book-card" data-listen="${it.id}">
      <span class="rbc-icon">${it.kind === 'youtube' ? '▶️' : (it.mediaType === 'video' ? '🎬' : '🎧')}</span>
      <span class="rbc-info"><span class="rbc-title">${esc(it.title)}</span><span class="rbc-sub">${st} · ${ds}</span></span>
    </button>`;
  }).join('');
}

/* ---------- 建立聽力：上傳檔案 / YouTube（雲端 Cloud Run + Replicate） ---------- */
/** 清除 YouTube CC 滾動字幕重複（同一句寫兩三次） */
function longestSuffixPrefixOverlap(a, b) {
  const maxN = Math.min(a.length, b.length);
  for (let n = maxN; n > 0; n--) {
    if (a.slice(-n) !== b.slice(0, n)) continue;
    if (n === a.length || n === b.length || a.slice(-n).startsWith(' ')
      || (a.length > n && a[a.length - n - 1] === ' ')
      || (n < b.length && b[n] === ' ')) return a.slice(-n);
  }
  for (let n = maxN; n > 7; n--) {
    if (a.slice(-n) === b.slice(0, n)) return a.slice(-n);
  }
  return '';
}
function dedupeRollupCaptions(segs) {
  const out = [];
  for (const seg of segs || []) {
    let text = String(seg.text || seg.en || '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const start = Number(seg.start) || 0;
    const end = seg.end != null ? Number(seg.end) : start;
    if (!out.length) {
      out.push({ start: +start.toFixed(2), end: +end.toFixed(2), text });
      continue;
    }
    const prev = out[out.length - 1];
    const a = prev.text;
    let b = text;
    if (b === a) { prev.end = Math.max(prev.end, +end.toFixed(2)); continue; }
    if (b.startsWith(a) && (start - prev.start <= 12)) {
      prev.text = b; prev.end = Math.max(prev.end, +end.toFixed(2)); continue;
    }
    if (a.startsWith(b) || a.includes(b)) {
      prev.end = Math.max(prev.end, +end.toFixed(2)); continue;
    }
    if (b.includes(a) && a.length >= 8) {
      const idx = b.indexOf(a);
      if (idx === 0) {
        prev.text = b; prev.end = Math.max(prev.end, +end.toFixed(2)); continue;
      }
      if (out.length >= 2) {
        const prev2 = out[out.length - 2];
        const prefix = b.slice(0, idx).trim();
        if (prefix && (prev2.text === prefix || prefix.startsWith(prev2.text) || prefix.includes(prev2.text))) {
          prev2.text = b;
          prev2.end = Math.max(prev2.end, +end.toFixed(2));
          out.pop();
          continue;
        }
      }
      prev.text = b;
      prev.start = Math.min(prev.start, +start.toFixed(2));
      prev.end = Math.max(prev.end, +end.toFixed(2));
      continue;
    }
    const ov = longestSuffixPrefixOverlap(a, b);
    const minOv = Math.min(10, Math.max(6, Math.floor(Math.min(a.length, b.length) / 4)));
    if (ov.length >= minOv) {
      const delta = b.slice(ov.length).trim();
      if (!delta) { prev.end = Math.max(prev.end, +end.toFixed(2)); continue; }
      b = delta;
    }
    out.push({ start: +start.toFixed(2), end: +end.toFixed(2), text: b });
  }
  return out;
}

function captionEndsSentence(text) {
  let t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return false;
  if (!/[.!?。！？]["'”’)\]]*$/.test(t)) return false;
  if (/\.$/.test(t) && /(?:^|[\s(\[])(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|vs|etc|approx|fig|vol|nos?|u\.s|u\.k|e\.g|i\.e)\.$/i.test(t)) return false;
  if (/\b[A-Z]\.$/.test(t)) return false;
  if (/\d\.$/.test(t)) return false;
  return true;
}
function splitCaptionSentences(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return [];
  const parts = t.split(/(?<=[.!?。！？])\s+(?=[A-Z"“‘「])/);
  const out = parts.map(p => p.trim()).filter(Boolean);
  return out.length ? out : [t];
}
/** 把斷在句中的 CC 片段併成完整句子 */
function mergeCaptionSentences(segs, { maxChars = 420, maxGap = 3.5 } = {}) {
  const merged = [];
  let buf = null;
  const flush = () => {
    if (!buf) return;
    const pieces = splitCaptionSentences(buf.text);
    if (pieces.length <= 1) {
      merged.push(buf);
    } else {
      const total = Math.max(1, pieces.reduce((n, p) => n + p.length, 0));
      const t0 = buf.start;
      const t1 = Math.max(buf.end, t0 + 0.4);
      const span = Math.max(0.4, t1 - t0);
      let cur = t0;
      pieces.forEach((p, i) => {
        const share = p.length / total;
        const nxt = i === pieces.length - 1 ? t1 : +(cur + span * share).toFixed(2);
        merged.push({ start: +cur.toFixed(2), end: +Math.max(nxt, cur + 0.2).toFixed(2), text: p });
        cur = nxt;
      });
    }
    buf = null;
  };
  for (const seg of segs || []) {
    const text = String(seg.text || seg.en || '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const start = Number(seg.start) || 0;
    const end = seg.end != null ? Number(seg.end) : start;
    if (!buf) {
      buf = { start: +start.toFixed(2), end: +end.toFixed(2), text };
    } else {
      const gap = start - buf.end;
      if (gap > maxGap * 2) {
        flush();
        buf = { start: +start.toFixed(2), end: +end.toFixed(2), text };
      } else {
        const joiner = /[-—/]$/.test(buf.text) ? '' : ' ';
        buf.text = (buf.text + joiner + text).replace(/  +/g, ' ').trim();
        buf.end = +Math.max(buf.end, end).toFixed(2);
      }
    }
    if (buf && captionEndsSentence(buf.text)) flush();
    else if (buf && buf.text.length >= maxChars) flush();
  }
  flush();
  return merged;
}

function mapListenCaptionSegments(rawSegs, { dedupe = true, sentences = true } = {}) {
  const base = (rawSegs || []).map(s => ({
    start: s.start, end: s.end, text: (s.text || s.en || '').trim(), zh: s.zh || '',
  }));
  let cleaned = dedupe ? dedupeRollupCaptions(base) : base;
  if (sentences && dedupe) cleaned = mergeCaptionSentences(cleaned);
  const zhMap = new Map();
  base.forEach(s => { if (s.text && s.zh) zhMap.set(s.text, s.zh); });
  return cleaned.map(s => ({
    start: s.start, end: s.end, en: s.text, zh: zhMap.get(s.text) || '',
  }));
}
/** 開啟舊項目時清一次 CC 滾動重複＋併成完整句（已標記則略過） */
function ensureListenCaptionsClean(item) {
  if (!item || item.captionsSentenceMerged) return false;
  item.captionsSentenceMerged = true;
  item.captionsDeduped = true;
  if (item.captionSource === 'whisper') { saveListenLocal(); return false; }
  const segs = item.segments || [];
  if (segs.length < 2) { saveListenLocal(); return false; }
  const cleaned = mapListenCaptionSegments(segs.map(s => ({ start: s.start, end: s.end, text: s.en, zh: s.zh })));
  if (cleaned.length >= segs.length * 0.95 && cleaned.length === segs.length) {
    const broken = segs.filter(s => {
      const t = (s.en || '').trim();
      return t && !captionEndsSentence(t);
    }).length;
    if (broken < Math.max(2, segs.length * 0.25)) { saveListenLocal(); return false; }
  }
  item.segments = cleaned;
  item.updatedAt = now();
  saveListen();
  toast(`已整理 CC 為完整句子（${segs.length} → ${cleaned.length} 段）；若中文對不齊請再按「瀏覽器翻譯」`);
  return true;
}

let listenJobQueue = [];
let listenJobsActive = 0;
let listenJobsDone = 0;
let listenJobsFail = 0;
const LISTEN_JOB_CONCURRENCY = 1;

function updateListenQueueHint() {
  const el = $('#listenQueueHint');
  if (!el) return;
  const pending = listenJobQueue.length;
  const active = listenJobsActive;
  if (!pending && !active) {
    if (listenJobsDone || listenJobsFail) {
      el.hidden = false;
      el.textContent = `批次完成：成功 ${listenJobsDone}、失敗 ${listenJobsFail}`;
      listenJobsDone = 0; listenJobsFail = 0;
    } else {
      el.hidden = true; el.textContent = '';
    }
    return;
  }
  el.hidden = false;
  el.textContent = `批次處理中：進行 ${active}、佇列 ${pending}`
    + (listenJobsDone || listenJobsFail ? `（已完成 ${listenJobsDone}${listenJobsFail ? '／失敗 ' + listenJobsFail : ''}）` : '')
    + ' — 可離開此頁以外的分頁，但請勿關閉網站';
}

function pumpListenJobQueue() {
  updateListenQueueHint();
  while (listenJobsActive < LISTEN_JOB_CONCURRENCY && listenJobQueue.length) {
    const job = listenJobQueue.shift();
    listenJobsActive++;
    updateListenQueueHint();
    (async () => {
      try {
        if (job.type === 'file') await listenUploadFile(job.file, { open: false, quiet: true });
        else await listenAddYoutube(job.url, { ...job.opts, open: false, quiet: true });
        listenJobsDone++;
      } catch {
        listenJobsFail++;
      } finally {
        listenJobsActive--;
        pumpListenJobQueue();
      }
    })();
  }
  if (!listenJobsActive && !listenJobQueue.length) updateListenQueueHint();
}

function enqueueListenFiles(fileList) {
  const files = [...(fileList || [])].filter(Boolean);
  if (!files.length) return;
  if (files.length === 1) {
    listenUploadFile(files[0], { open: true, quiet: false });
    return;
  }
  files.forEach(f => listenJobQueue.push({ type: 'file', file: f }));
  toast(`已加入 ${files.length} 個檔案到批次佇列`);
  pumpListenJobQueue();
}
function enqueueListenYoutubeUrls(urls, opts = {}) {
  const list = [...new Set((urls || []).map(u => String(u || '').trim()).filter(Boolean))];
  if (!list.length) return;
  if (list.length === 1) {
    listenAddYoutube(list[0], { ...opts, open: true, quiet: false });
    return;
  }
  list.forEach(url => listenJobQueue.push({ type: 'youtube', url, opts: { ...opts } }));
  toast(`已加入 ${list.length} 個 YouTube 到批次佇列`);
  pumpListenJobQueue();
}

// 轉錄完成後統一做翻譯 + 重點分析
async function listenAfterTranscribe(item, opts = {}) {
  const quiet = !!opts.quiet;
  const showStage = (txt) => setListenProgress(txt);
  item.status = 'translating';
  saveListen();
  if (listenCurrentId === item.id) renderListenItem(item); // 先顯示英文與播放器＋右側欄位骨架
  else renderListenList();
  try {
    if (item.translatePrefer === 'gemini') await translateListenGemini(item, showStage);
    else await translateListenBrowser(item, showStage);
    await analyzeListen(item, showStage);
    item.status = 'done'; item.updatedAt = now();
    saveListen();
    if (listenCurrentId === item.id) renderListenItem(item);
    renderListenList();
    if (!quiet) toast('聽力精聽整理完成');
  } finally {
    clearListenProgress();
  }
}

/** 左側進度條：不覆蓋右側大意／心智圖／單字 */
function setListenProgress(txt) {
  const el = $('#listenProgress');
  if (!el) return;
  if (!txt) {
    el.hidden = true;
    el.innerHTML = '';
    return;
  }
  el.hidden = false;
  el.innerHTML = `<span class="spinner"></span> <span>${esc(txt)}</span>`;
}
function clearListenProgress() { setListenProgress(''); }

/** 單句：Chrome/Edge Translator API（若可用） */
async function browserTranslateOneNative(text, translator) {
  if (!translator || !text) return '';
  try { return await translator.translate(text); } catch { return ''; }
}

/** 單句：Google 網頁翻譯（gtx，免金鑰、速度快） */
async function browserTranslateOneGtx(text, sl = 'en', tl = 'zh-TW') {
  if (!text || !String(text).trim()) return '';
  const url = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl='
    + encodeURIComponent(sl) + '&tl=' + encodeURIComponent(tl) + '&dt=t&q=' + encodeURIComponent(text);
  const res = await fetch(url);
  if (!res.ok) throw new Error('瀏覽器翻譯 HTTP ' + res.status);
  const data = await res.json();
  return ((data && data[0]) || []).map(x => x && x[0]).filter(Boolean).join('') || '';
}

async function createBrowserTranslator() {
  // Chrome 內建 Translator（實驗性）；不可用則回 null，改走 gtx
  try {
    if (typeof Translator === 'undefined') return null;
    const src = 'en', tgt = 'zh-Hant';
    if (Translator.availability) {
      const a = await Translator.availability({ sourceLanguage: src, targetLanguage: tgt });
      if (a === 'unavailable') return null;
    }
    return await Translator.create({ sourceLanguage: src, targetLanguage: tgt });
  } catch { return null; }
}

/** 即時把某一句的中文寫進逐字稿 DOM（不整頁重繪） */
function patchListenSegZh(idx, zh) {
  const el = document.querySelector(`#listenTranscript .ls-seg[data-i="${idx}"]`);
  if (!el) return;
  let zhEl = el.querySelector('.ls-zh');
  if (!zh) {
    if (zhEl) zhEl.remove();
    return;
  }
  if (!zhEl) {
    zhEl = document.createElement('div');
    zhEl.className = 'ls-zh';
    el.appendChild(zhEl);
  }
  zhEl.textContent = zh;
  if (typeof hideZh !== 'undefined' && hideZh) zhEl.style.display = 'none';
  else zhEl.style.display = '';
}

/** 預設：快速瀏覽器翻譯整篇逐字稿（譯完一句就顯示一句） */
async function translateListenBrowser(item, showStage) {
  const segs = item.segments || [];
  if (!segs.length) return;
  const translator = await createBrowserTranslator();
  const engine = translator ? 'native' : 'gtx';
  item.translateEngine = engine;
  // 先確保逐字稿已在畫面上
  if (listenCurrentId === item.id) renderListenItem(item);
  const CONC = translator ? 3 : 6;
  let done = 0;
  for (let i = 0; i < segs.length; i += CONC) {
    const batch = segs.slice(i, i + CONC);
    if (showStage) showStage(`瀏覽器翻譯中… ${Math.min(i + CONC, segs.length)}/${segs.length}`);
    await Promise.all(batch.map(async (s, j) => {
      const idx = i + j;
      try {
        const zh = translator
          ? await browserTranslateOneNative(s.en, translator)
          : await browserTranslateOneGtx(s.en);
        s.zh = zh || s.zh || '';
      } catch (e) {
        console.error('瀏覽器翻譯失敗', e);
        if (!s.zh) s.zh = '（翻譯失敗）';
      }
      done += 1;
      if (listenCurrentId === item.id) patchListenSegZh(idx, s.zh);
    }));
    saveListenLocal();
  }
  saveListenLocal();
}

/** Gemini 翻譯整篇（品質較好、較慢／耗額度） */
async function translateListenGemini(item, showStage) {
  const segs = item.segments || [];
  const CH = 40;
  const schema = { type: 'object', properties: { translations: { type: 'array', items: { type: 'string' } } }, required: ['translations'] };
  item.translateEngine = 'gemini';
  for (let i = 0; i < segs.length; i += CH) {
    if (showStage) showStage(`Gemini 翻譯中… ${Math.min(i + CH, segs.length)}/${segs.length}`);
    const part = segs.slice(i, i + CH);
    const prompt = `把下面每一行英文翻成繁體中文。回傳 translations 陣列，長度與行數完全相同、順序一致（第 n 行對應第 n 個）。只輸出 JSON。\n\n${part.map((s, idx) => `${idx + 1}. ${s.en}`).join('\n')}`;
    try {
      const out = await readerJSON(prompt, schema, 0.3);
      (out.translations || []).forEach((z, idx) => { if (part[idx] && z) part[idx].zh = z; });
    } catch (e) { console.error('Gemini 翻譯失敗', e); }
    saveListenLocal();
  }
}

/** 使用者按「Gemini 翻譯」：整篇重翻 */
async function relistenTranslateGemini(item) {
  const segs = item.segments || [];
  if (!segs.length) { toast('沒有逐字稿', true); return; }
  const btn = $('#listenGeminiTranslate'); const orig = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = '翻譯中…'; }
  setListenToolBusy(true);
  const showStage = (t) => { if (btn) btn.textContent = t; };
  try {
    item.translatePrefer = 'gemini';
    await translateListenGemini(item, showStage);
    item.updatedAt = now(); saveListen();
    if (listenCurrentId === item.id) renderListenItem(item);
    toast('Gemini 翻譯完成');
  } catch (e) {
    toast('Gemini 翻譯失敗：' + e.message, true);
  } finally {
    setListenToolBusy(false);
    if (btn) { btn.disabled = false; btn.textContent = orig || '✨ Gemini 翻譯'; }
  }
}

/** 使用者按「瀏覽器翻譯」：整篇重翻 */
async function relistenTranslateBrowser(item) {
  const segs = item.segments || [];
  if (!segs.length) { toast('沒有逐字稿', true); return; }
  const btn = $('#listenBrowserTranslate'); const orig = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = '翻譯中…'; }
  setListenToolBusy(true);
  const showStage = (t) => { if (btn) btn.textContent = t; };
  try {
    item.translatePrefer = 'browser';
    await translateListenBrowser(item, showStage);
    item.updatedAt = now(); saveListen();
    if (listenCurrentId === item.id) renderListenItem(item);
    toast('瀏覽器翻譯完成');
  } catch (e) {
    toast('瀏覽器翻譯失敗：' + e.message, true);
  } finally {
    setListenToolBusy(false);
    if (btn) { btn.disabled = false; btn.textContent = orig || '🌐 瀏覽器翻譯'; }
  }
}

function setListenToolBusy(on) {
  ['listenCcRescan', 'listenWhisperRescan', 'listenBrowserTranslate', 'listenGeminiTranslate'].forEach(id => {
    const el = document.getElementById(id);
    if (el && !on) el.disabled = false;
    else if (el && on && document.activeElement !== el) el.disabled = true;
  });
}

function updateListenSourceButtons(item) {
  const cc = $('#listenCcRescan');
  const wh = $('#listenWhisperRescan');
  const br = $('#listenBrowserTranslate');
  const gm = $('#listenGeminiTranslate');
  const yt = item && item.kind === 'youtube' && !!item.videoId;
  if (cc) {
    cc.hidden = !yt;
    cc.classList.toggle('active', yt && item.captionSource !== 'whisper');
  }
  if (wh) {
    wh.hidden = !yt;
    wh.classList.toggle('active', yt && item.captionSource === 'whisper');
  }
  if (br) br.classList.toggle('active', item && item.translatePrefer !== 'gemini' && item.translateEngine !== 'gemini');
  if (gm) gm.classList.toggle('active', item && (item.translatePrefer === 'gemini' || item.translateEngine === 'gemini'));
}

/** 改回 YouTube CC／自動字幕（不強制 Whisper） */
async function listenForceCc(item) {
  if (!item || item.kind !== 'youtube' || !item.videoId) {
    toast('目前僅支援 YouTube 切換 CC 字幕', true);
    return;
  }
  if (item.captionSource === 'manual' || item.captionSource === 'auto') {
    if (!confirm('目前已是 CC 字幕，要重新抓一次嗎？')) return;
  } else if (!confirm('改回使用 YouTube CC／自動字幕（會覆寫目前逐字稿）。確定？')) {
    return;
  }
  const btn = $('#listenCcRescan'); const orig = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = '抓取中…'; }
  setListenToolBusy(true);
  const showStage = (txt) => {
    if (btn) btn.textContent = txt.slice(0, 18);
    setListenProgress(txt);
  };
  const prevStatus = item.status;
  item.status = 'processing';
  saveListen();
  if (listenCurrentId === item.id) renderListenItem(item);
  try {
    showStage('抓取 YouTube CC 字幕中…');
    const fd = new FormData();
    fd.append('url', 'https://www.youtube.com/watch?v=' + item.videoId);
    fd.append('language', listenWhisperLang());
    // 不帶 force_whisper → 後端優先 CC
    // 雲端 IP 常被 YouTube 擋，後端可能要換路徑／代理，通常數十秒；若前面還有 Whisper／批次佇列會更久
    showStage('抓 CC 中（雲端直連常被擋，可能需數十秒）…');
    const res = await fetch(listenBackend() + '/beidanzi/youtube', { method: 'POST', body: fd });
    if (!res.ok) throw new Error('後端回應錯誤 ' + res.status);
    const j = await res.json();
    if (j.captionSource === 'whisper' || j.usedWhisper) {
      throw new Error('此影片抓不到 CC 字幕（後端改走了 Whisper）。可改按 Whisper。');
    }
    item.captionSource = j.captionSource || 'auto';
    if (j.title) item.title = j.title;
    item.segments = mapListenCaptionSegments(j.segments || []);
    item.captionsDeduped = true;
    item.captionsSentenceMerged = true;
    item.summary = ''; item.vocab = []; item.phrases = []; item.grammar = []; item.mindmap = null;
    item.updatedAt = now();
    saveListen();
    if (listenCurrentId === item.id) {
      const tEl = $('#listenTitle'); if (tEl && item.title) tEl.textContent = item.title;
      renderListenItem(item);
    }
    toast(`已改用 ${item.captionSource === 'manual' ? '人工' : '自動'}字幕，開始翻譯與整理…`);
    await listenAfterTranscribe(item);
  } catch (e) {
    item.status = prevStatus === 'done' ? 'done' : 'error';
    saveListen();
    if (listenCurrentId === item.id) renderListenItem(item);
    toast('CC 字幕失敗：' + e.message, true);
  } finally {
    setListenToolBusy(false);
    clearListenProgress();
    if (btn) { btn.disabled = false; btn.textContent = orig || '📄 CC 字幕'; }
  }
}

/** CC 對不齊時：強制 YouTube 下載音訊 + Whisper 重掃 */
async function listenForceWhisper(item) {
  if (!item || item.kind !== 'youtube' || !item.videoId) {
    toast('目前僅支援 YouTube 改用 Whisper 掃描', true);
    return;
  }
  if (item.captionSource === 'whisper') {
    if (!confirm('已經是 Whisper 逐字稿，要再掃描一次嗎？')) return;
  } else if (!confirm('將下載音訊並用 Whisper 重新掃描時間軸（較久，會覆寫目前逐字稿）。確定？')) {
    return;
  }
  const btn = $('#listenWhisperRescan'); const orig = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = '掃描中…'; }
  setListenToolBusy(true);
  const showStage = (txt) => {
    if (btn) btn.textContent = txt.slice(0, 18);
    setListenProgress(txt);
  };
  const prevStatus = item.status;
  item.status = 'processing';
  saveListen();
  if (listenCurrentId === item.id) renderListenItem(item);
  try {
    showStage('下載音訊並 Whisper 掃描中…');
    const fd = new FormData();
    fd.append('url', 'https://www.youtube.com/watch?v=' + item.videoId);
    fd.append('language', listenWhisperLang());
    fd.append('force_whisper', '1');
    const res = await fetch(listenBackend() + '/beidanzi/youtube', { method: 'POST', body: fd });
    if (!res.ok) throw new Error('後端回應錯誤 ' + res.status);
    const j = await res.json();
    item.captionSource = j.captionSource || 'whisper';
    if (j.title) item.title = j.title;
    item.segments = mapListenCaptionSegments(j.segments || [], { dedupe: false });
    item.captionsDeduped = true;
    item.summary = ''; item.vocab = []; item.phrases = []; item.grammar = []; item.mindmap = null;
    item.updatedAt = now();
    saveListen();
    if (listenCurrentId === item.id) {
      const tEl = $('#listenTitle'); if (tEl && item.title) tEl.textContent = item.title;
      renderListenItem(item);
    }
    toast('Whisper 掃描完成，開始翻譯與整理…');
    await listenAfterTranscribe(item);
  } catch (e) {
    item.status = prevStatus === 'done' ? 'done' : 'error';
    saveListen();
    if (listenCurrentId === item.id) renderListenItem(item);
    toast('Whisper 掃描失敗：' + e.message, true);
  } finally {
    setListenToolBusy(false);
    clearListenProgress();
    if (btn) { btn.disabled = false; btn.textContent = orig || '🎙 Whisper'; }
  }
}

async function translateListen(item, showStage) {
  // 相容舊呼叫：改走瀏覽器翻譯
  return translateListenBrowser(item, showStage);
}

async function listenUploadFile(file, opts = {}) {
  if (!file) return;
  const open = opts.open !== false;
  const quiet = !!opts.quiet;
  const hint = $('#listenLibHint');
  const setHint = t => { if (hint && !quiet) hint.textContent = t; };
  // 先建立處理中的項目讓使用者看到進度
  const item = {
    id: uid(), title: file.name.replace(/\.[^.]+$/, ''), kind: 'file',
    mediaUrl: '', mediaType: /\.(mp4|mkv|avi|mov|webm|m4v)$/i.test(file.name) ? 'video' : 'audio',
    createdAt: now(), updatedAt: now(), status: 'processing', language: listenLangCode(),
    segments: [], vocab: [], phrases: [], grammar: [], summary: '',
  };
  listenItems.unshift(item);
  saveListen();
  if (open) { listenCurrentId = item.id; renderListen(); }
  else renderListenList();
  try {
    setHint('上傳並雲端轉錄中…（長音檔可能需要數分鐘，請勿關閉此頁）');
    const fd = new FormData();
    fd.append('file', file);
    fd.append('language', listenWhisperLang());
    const res = await fetch(listenBackend() + '/beidanzi/upload', { method: 'POST', body: fd });
    if (!res.ok) throw new Error('後端回應錯誤 ' + res.status);
    const j = await res.json();
    item.mediaUrl = j.mediaUrl || '';
    item.mediaType = j.mediaType || item.mediaType;
    item.segments = mapListenCaptionSegments(j.segments || [], { dedupe: false });
    item.captionsDeduped = true;
    saveListen();
    setHint('');
    await listenAfterTranscribe(item, { quiet });
  } catch (e) {
    item.status = 'error'; saveListen();
    if (listenCurrentId === item.id) renderListenItem(item);
    renderListenList();
    setHint('');
    if (!quiet) toast('上傳失敗：' + e.message, true);
    checkListenBackend();
    throw e;
  }
}

async function listenAddYoutube(url, opts = {}) {
  const forceWhisper = !!opts.forceWhisper;
  const translatePrefer = opts.translatePrefer === 'gemini' ? 'gemini' : 'browser';
  const open = opts.open !== false;
  const quiet = !!opts.quiet;
  const hint = $('#listenLibHint');
  const setHint = t => { if (hint && !quiet) hint.textContent = t; };
  const vid = (url.match(/(?:v=|youtu\.be\/|\/embed\/|\/shorts\/)([A-Za-z0-9_-]{11})/) || [])[1] || '';
  const item = {
    id: uid(), title: vid ? `讀取中…` : 'YouTube', kind: 'youtube', videoId: vid,
    createdAt: now(), updatedAt: now(), status: 'processing', language: listenLangCode(),
    segments: [], vocab: [], phrases: [], grammar: [], summary: '',
    translatePrefer, forceWhisper,
  };
  listenItems.unshift(item);
  saveListen();
  if (open) { listenCurrentId = item.id; renderListen(); }
  else renderListenList();
  try {
    setHint(forceWhisper
      ? '強制 Whisper：下載音訊並掃描中…（較久）'
      : '讀取 YouTube（優先 CC 字幕，沒有才雲端轉錄）…');
    const fd = new FormData();
    fd.append('url', url);
    fd.append('language', listenWhisperLang());
    if (forceWhisper) fd.append('force_whisper', '1');
    const res = await fetch(listenBackend() + '/beidanzi/youtube', { method: 'POST', body: fd });
    if (!res.ok) throw new Error('後端回應錯誤 ' + res.status);
    const j = await res.json();
    item.videoId = j.videoId || vid;
    const ytTitle = (j.title || '').trim();
    if (ytTitle) {
      item.title = ytTitle;
      if (listenCurrentId === item.id) {
        const tEl = $('#listenTitle');
        if (tEl) tEl.textContent = ytTitle;
      }
    } else if (!item.title || item.title === '讀取中…') {
      item.title = 'YouTube ' + (item.videoId || '');
    }
    item.captionSource = j.captionSource;
    const isCc = item.captionSource === 'manual' || item.captionSource === 'auto';
    item.segments = mapListenCaptionSegments(j.segments || [], { dedupe: isCc || !forceWhisper });
    item.captionsDeduped = true;
    item.captionsSentenceMerged = true;
    saveListen();
    renderListenList();
    setHint('');
    const src = j.captionSource;
    if (!quiet) {
      if (src === 'manual') toast('已使用 YouTube 人工字幕（未下載轉錄）');
      else if (src === 'auto') toast('已使用 YouTube 自動字幕 CC（未下載轉錄）');
      else if (src === 'whisper' || j.usedWhisper) toast(forceWhisper ? '已用 Whisper 掃描音軌' : '無可用字幕，已下載音訊並用 Whisper 轉錄');
    }
    await listenAfterTranscribe(item, { quiet });
  } catch (e) {
    item.status = 'error'; saveListen();
    if (listenCurrentId === item.id) renderListenItem(item);
    renderListenList();
    setHint('');
    if (!quiet) toast('處理失敗：' + e.message, true);
    checkListenBackend();
    throw e;
  }
}

function openListenYoutubeModal() {
  const modal = $('#listenYoutubeModal');
  if (!modal) return;
  const urlEl = $('#lytUrl');
  if (urlEl) urlEl.value = '';
  const cc = document.querySelector('input[name="lytCaption"][value="cc"]');
  const br = document.querySelector('input[name="lytTranslate"][value="browser"]');
  if (cc) cc.checked = true;
  if (br) br.checked = true;
  modal.hidden = false;
  document.body.classList.add('modal-open');
  urlEl?.focus();
}
function closeListenYoutubeModal() {
  const modal = $('#listenYoutubeModal');
  if (modal) modal.hidden = true;
  document.body.classList.remove('modal-open');
}
function parseListenYoutubeUrls(raw) {
  const text = String(raw || '');
  const found = [];
  const re = /https?:\/\/(?:www\.)?(?:youtube\.com\/(?:watch\?[^\s]*v=|embed\/|shorts\/)|youtu\.be\/)[A-Za-z0-9_-]{11}[^\s]*/gi;
  let m;
  while ((m = re.exec(text))) found.push(m[0].replace(/[),.;]+$/, ''));
  // 也接受純 video id 行
  text.split(/[\n,;]+/).map(l => l.trim()).forEach(l => {
    if (/^[A-Za-z0-9_-]{11}$/.test(l)) found.push('https://www.youtube.com/watch?v=' + l);
  });
  // 去重（以 videoId）
  const seen = new Set();
  const out = [];
  for (const u of found) {
    const vid = (u.match(/(?:v=|youtu\.be\/|\/embed\/|\/shorts\/)([A-Za-z0-9_-]{11})/) || [])[1];
    const key = vid || u;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(u);
  }
  return out;
}
function confirmListenYoutubeModal() {
  const raw = ($('#lytUrl')?.value || '').trim();
  const urls = parseListenYoutubeUrls(raw);
  if (!urls.length) { toast('請貼上至少一個 YouTube 網址', true); return; }
  const caption = (document.querySelector('input[name="lytCaption"]:checked') || {}).value || 'cc';
  const translate = (document.querySelector('input[name="lytTranslate"]:checked') || {}).value || 'browser';
  closeListenYoutubeModal();
  enqueueListenYoutubeUrls(urls, {
    forceWhisper: caption === 'whisper',
    translatePrefer: translate === 'gemini' ? 'gemini' : 'browser',
  });
}

async function analyzeListen(item, showStage) {
  const text = (item.segments || []).map(s => s.en).join(' ').slice(0, 16000);
  if (!text.trim()) return;

  // 1) 大意 + 重要單字（單獨一輪，避免 JSON 過大導致整包失敗）
  if (showStage) showStage('整理大意與重要單字…');
  const vocabSchema = {
    type: 'object', properties: {
      summary: { type: 'string' },
      vocab: { type: 'array', items: { type: 'object', properties: { word: { type: 'string' }, pos: { type: 'string' }, meaning_zh: { type: 'string' }, example_en: { type: 'string' } }, required: ['word'] } },
    },
    required: ['vocab'],
  };
  try {
    const out = await readerJSON(
      `你是英語聽力精聽老師。以下是一段音檔／影片的逐字稿。用繁體中文整理：\n- summary：整體大意（3–5 句）。\n- vocab：10–15 個重要單字，附 pos（詞性，如 n./v./adj.）、中文意思(meaning_zh)與一個原文例句(example_en，必須儘量直接取自逐字稿原句)。\n只輸出 JSON（不要生成片語或文法）。\n\n逐字稿：\n${text}`,
      vocabSchema, 0.5,
    );
    item.summary = out.summary || item.summary || '';
    item.vocab = out.vocab || [];
    attachListenExampleStarts(item);
    saveListenLocal();
    if (listenCurrentId === item.id) renderListenItem(item);
  } catch (e) { console.error('聽力單字／大意分析失敗', e); }

  // 2) 重要片語 + 重要文法（再調用一次，與單字分開）
  if (showStage) showStage('整理重要片語／文法…');
  const pgSchema = {
    type: 'object', properties: {
      phrases: { type: 'array', items: { type: 'object', properties: { phrase: { type: 'string' }, meaning_zh: { type: 'string' }, example_en: { type: 'string' } }, required: ['phrase'] } },
      grammar: { type: 'array', items: { type: 'object', properties: { point: { type: 'string' }, explain_zh: { type: 'string' }, example_en: { type: 'string' } }, required: ['point'] } },
    },
    required: ['phrases', 'grammar'],
  };
  try {
    const out = await readerJSON(
      `你是英語聽力精聽老師。以下是一段音檔／影片的逐字稿。用繁體中文整理（不要重複生成單字列表）：\n- phrases：5–10 個重要片語／口語搭配，附中文(meaning_zh)與一個原文例句(example_en，必須儘量直接取自逐字稿原句)。\n- grammar：3–6 個重要文法／句型重點，說明用法(explain_zh)並附原文例句(example_en，必須儘量直接取自逐字稿原句)。\n只輸出 JSON。\n\n逐字稿：\n${text}`,
      pgSchema, 0.5,
    );
    item.phrases = out.phrases || [];
    item.grammar = out.grammar || [];
    attachListenExampleStarts(item);
  } catch (e) { console.error('聽力片語／文法分析失敗', e); }

  // 3) 心智圖大綱（獨立一輪，附時間戳）
  if (showStage) showStage('整理心智圖大綱…');
  try {
    item.mindmap = await generateListenMindmap(item.segments || []);
    attachListenMindmapStarts(item);
    if (listenCurrentId === item.id) renderListenItem(item);
  } catch (e) { console.error('聽力心智圖失敗', e); }

  saveListenLocal();
}

async function generateListenMindmap(segments) {
  const segs = segments || [];
  const timed = segs.map(s => `[${fmtTime(s.start)}] ${s.en}`).join('\n').slice(0, 16000);
  const schema = {
    type: 'object',
    properties: {
      title: { type: 'string' },
      title_start: { type: 'number' },
      branches: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            start: { type: 'number' },
            bullets: {
              type: 'array',
              items: {
                type: 'object',
                properties: { text: { type: 'string' }, start: { type: 'number' } },
                required: ['text'],
              },
            },
          },
          required: ['title'],
        },
      },
    },
    required: ['title', 'branches'],
  };
  const out = await readerJSON(
    `你是英語聽力精聽老師。以下逐字稿每行前面有時間碼 [m:ss]。用繁體中文產出「心智圖大綱」方便複習與跳播：\n- title：中心主題（短句）\n- title_start：主題對應的大概開始秒數（數字）\n- branches：4–8 個主分支；每個含 title、start（秒）、bullets（2–5 個；每項含 text 與 start 秒數）\nstart 請對齊最相關那一行的時間碼；要點精煉，不要逐句抄稿。只輸出 JSON。\n\n逐字稿：\n${timed}`,
    schema, 0.4, 4096,
  );
  // 相容：若 AI 仍回傳字串 bullets，轉成物件
  const branches = (Array.isArray(out.branches) ? out.branches : []).map(b => ({
    title: b.title || '',
    start: typeof b.start === 'number' ? b.start : undefined,
    bullets: (b.bullets || []).map(x => {
      if (typeof x === 'string') return { text: x };
      return { text: x.text || '', start: typeof x.start === 'number' ? x.start : undefined };
    }),
  }));
  return {
    title: out.title || '',
    title_start: typeof out.title_start === 'number' ? out.title_start : undefined,
    branches,
  };
}

/** 幫心智圖補上／校正時間戳（對逐字稿） */
function attachListenMindmapStarts(item) {
  const segs = item.segments || [];
  const mm = item.mindmap;
  if (!mm || !segs.length) return;
  const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff'\s]/g, ' ').replace(/\s+/g, ' ').trim();
  const findStart = (hint, fallbackSec) => {
    if (typeof fallbackSec === 'number' && Number.isFinite(fallbackSec)) {
      // 吸附到最近段落起點
      let best = segs[0].start, bestD = Infinity;
      for (const s of segs) {
        const d = Math.abs((s.start || 0) - fallbackSec);
        if (d < bestD) { bestD = d; best = s.start; }
      }
      return best;
    }
    const needle = norm(hint);
    if (!needle || needle.length < 2) return undefined;
    let best = null, bestScore = 0;
    for (const s of segs) {
      const hay = norm(s.en);
      if (!hay) continue;
      if (hay.includes(needle) || needle.includes(hay)) return s.start;
      const words = needle.split(' ').filter(w => w.length > 1).slice(0, 5);
      if (!words.length) continue;
      const hit = words.filter(w => hay.includes(w)).length;
      const score = hit / words.length;
      if (score > bestScore && score >= 0.4) { bestScore = score; best = s.start; }
    }
    return best == null ? undefined : best;
  };
  const ts = findStart(mm.title, mm.title_start);
  if (ts != null) mm.title_start = ts;
  (mm.branches || []).forEach(b => {
    const bs = findStart(b.title, b.start);
    if (bs != null) b.start = bs;
    (b.bullets || []).forEach(bu => {
      const us = findStart(bu.text, bu.start);
      if (us != null) bu.start = us;
    });
  });
}

function listenCollapseState() {
  try { return JSON.parse(localStorage.getItem('listen_collapse_v1') || '{}') || {}; }
  catch { return {}; }
}
function setListenCollapse(key, collapsed) {
  const st = listenCollapseState();
  st[key] = !!collapsed;
  localStorage.setItem('listen_collapse_v1', JSON.stringify(st));
}
function listenCollapseHtml(key, titleInner, bodyInner) {
  const collapsed = !!listenCollapseState()[key];
  return `<div class="rd-collapse${collapsed ? ' collapsed' : ''}" data-collapse="${esc(key)}">
    <div class="rd-collapse-head" role="button" tabindex="0" title="點擊收合／展開">
      <span class="rd-collapse-chevron" aria-hidden="true">▾</span>
      <div class="rd-sec-title">${titleInner}</div>
    </div>
    <div class="rd-collapse-body">${bodyInner}</div>
  </div>`;
}
function renderListenMindmap(mm) {
  if (!mm || (!mm.title && !(mm.branches || []).length)) return '<p class="hint">—</p>';
  const jumpAttrs = (start, label) => {
    if (start == null || start === '') return { cls: '', attrs: '' };
    return {
      cls: ' ls-jump',
      attrs: ` data-start="${start}" title="點擊跳到 ${fmtTime(start)}：${esc(label || '')}"`,
    };
  };
  const centerJ = jumpAttrs(mm.title_start, mm.title);
  const branches = (mm.branches || []).map(b => {
    const bj = jumpAttrs(b.start, b.title);
    const bullets = (b.bullets || []).map(x => {
      const text = typeof x === 'string' ? x : (x.text || '');
      const start = typeof x === 'string' ? undefined : x.start;
      const uj = jumpAttrs(start, text);
      const time = start != null && start !== '' ? `<span class="mm-time">${fmtTime(start)}</span>` : '';
      return `<li class="mm-bullet${uj.cls}"${uj.attrs}>${time}<span class="mm-bullet-text">${esc(text)}</span></li>`;
    }).join('');
    const bTime = b.start != null && b.start !== '' ? `<span class="mm-time">${fmtTime(b.start)}</span>` : '';
    return `<li class="mm-branch">
      <div class="mm-branch-title${bj.cls}"${bj.attrs}>${bTime}<span>${esc(b.title || '')}</span></div>
      ${bullets ? `<ul class="mm-bullets">${bullets}</ul>` : ''}
    </li>`;
  }).join('');
  const cTime = mm.title_start != null && mm.title_start !== '' ? `<span class="mm-time">${fmtTime(mm.title_start)}</span>` : '';
  return `<div class="mm-map">
    <div class="mm-center${centerJ.cls}"${centerJ.attrs}>${cTime}<span>${esc(mm.title || '大綱')}</span></div>
    ${branches ? `<ul class="mm-branches">${branches}</ul>` : ''}
  </div>`;
}

// 依逐字稿幫例句對上時間戳，方便點擊跳轉
function attachListenExampleStarts(item) {
  const segs = item.segments || [];
  if (!segs.length) return;
  const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9'\s]/g, ' ').replace(/\s+/g, ' ').trim();
  const findStart = (ex) => {
    const needle = norm(ex);
    if (!needle || needle.length < 4) return undefined;
    let best = null, bestScore = 0;
    for (const s of segs) {
      const hay = norm(s.en);
      if (!hay) continue;
      if (hay.includes(needle) || needle.includes(hay)) return s.start;
      // 取前幾個詞比對
      const words = needle.split(' ').filter(w => w.length > 2).slice(0, 6);
      if (!words.length) continue;
      const hit = words.filter(w => hay.includes(w)).length;
      const score = hit / words.length;
      if (score > bestScore && score >= 0.5) { bestScore = score; best = s.start; }
    }
    return best == null ? undefined : best;
  };
  (item.vocab || []).forEach(v => { const t = findStart(v.example_en); if (t != null) v.example_start = t; });
  (item.phrases || []).forEach(p => { const t = findStart(p.example_en); if (t != null) p.example_start = t; });
  (item.grammar || []).forEach(g => { const t = findStart(g.example_en); if (t != null) g.example_start = t; });
}


// 重新生成某一部分重點（summary / vocab / phrases / grammar / mindmap）
async function relistenAnalyze(item, part) {
  const text = (item.segments || []).map(s => s.en).join(' ').slice(0, 16000);
  if (!text.trim()) { toast('沒有逐字稿內容', true); return; }
  let schema, prompt, apply;
  if (part === 'summary') {
    schema = { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] };
    prompt = `用繁體中文寫出以下逐字稿的整體大意（3–5 句）。只輸出 JSON。\n\n逐字稿：\n${text}`;
    apply = o => { item.summary = o.summary || ''; };
  } else if (part === 'vocab') {
    schema = { type: 'object', properties: { vocab: { type: 'array', items: { type: 'object', properties: { word: { type: 'string' }, pos: { type: 'string' }, meaning_zh: { type: 'string' }, example_en: { type: 'string' } }, required: ['word'] } } }, required: ['vocab'] };
    prompt = `你是英語聽力老師。從以下逐字稿挑出 10–15 個重要單字，附 pos（詞性）、繁體中文意思(meaning_zh)與一個例句(example_en，優先取自逐字稿)。只輸出 JSON。\n\n逐字稿：\n${text}`;
    apply = o => { item.vocab = o.vocab || []; };
  } else if (part === 'phrases') {
    schema = { type: 'object', properties: { phrases: { type: 'array', items: { type: 'object', properties: { phrase: { type: 'string' }, meaning_zh: { type: 'string' }, example_en: { type: 'string' } }, required: ['phrase'] } } }, required: ['phrases'] };
    prompt = `從以下逐字稿挑出 5–10 個重要片語／口語搭配，附繁體中文意思(meaning_zh)與一個原文例句(example_en，必須儘量直接取自逐字稿原句)。只輸出 JSON。\n\n逐字稿：\n${text}`;
    apply = o => { item.phrases = o.phrases || []; };
  } else if (part === 'grammar') {
    schema = { type: 'object', properties: { grammar: { type: 'array', items: { type: 'object', properties: { point: { type: 'string' }, explain_zh: { type: 'string' }, example_en: { type: 'string' } }, required: ['point'] } } }, required: ['grammar'] };
    prompt = `從以下逐字稿挑出 3–6 個重要文法／句型重點，用繁體中文說明用法(explain_zh)並附原文例句(example_en，必須儘量直接取自逐字稿原句)。只輸出 JSON。\n\n逐字稿：\n${text}`;
    apply = o => { item.grammar = o.grammar || []; };
  } else if (part === 'mindmap') {
    toast('重新整理心智圖大綱中…');
    try {
      item.mindmap = await generateListenMindmap(item.segments || []);
      attachListenMindmapStarts(item);
      item.updatedAt = now(); saveListen();
      if (listenCurrentId === item.id) renderListenItem(item);
      toast('心智圖大綱已重新整理');
    } catch (e) { toast('重新整理心智圖失敗：' + e.message, true); }
    return;
  } else return;
  const label = { summary: '大意', vocab: '重要單字', phrases: '重要片語', grammar: '重要文法' }[part];
  toast(`重新整理${label}中…`);
  try {
    const out = await readerJSON(prompt, schema, 0.5);
    apply(out);
    attachListenExampleStarts(item);
    item.updatedAt = now(); saveListen();
    if (listenCurrentId === item.id) renderListenItem(item);
    toast(`${label}已重新整理`);
  } catch (e) { toast(`重新整理${label}失敗：` + e.message, true); }
}

/* ---------- 渲染單一聽力：播放器 + 逐字稿 + 右側重點 ---------- */
function fmtTime(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const m = Math.floor(sec / 60), s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function renderListenItem(item) {
  ensureListenCaptionsClean(item);
  $('#listenTitle').textContent = item.title;
  updateListenSourceButtons(item);
  // 只有換了 item（或播放器不存在）才重建播放器，避免整理過程中重置播放進度
  const hasPlayer = ytPlayer || listenMediaEl;
  if (listenPlayerId !== item.id || !hasPlayer) renderListenPlayer(item);

  const tr = $('#listenTranscript');
  const side = $('#listenSide');

  if (item.status === 'processing' || item.status === 'translating') {
    if (!(item.segments || []).length) tr.innerHTML = '<div class="ls-processing"><span class="spinner"></span> 產生逐字稿中…</div>';
  }

  const re = buildKnownWordRegex();
  if ((item.segments || []).length) {
    tr.innerHTML = item.segments.map((s, i) =>
      `<div class="ls-seg" data-i="${i}" data-start="${s.start}">
        <span class="ls-time">${fmtTime(s.start)}</span><span class="ls-en">${highlightArticleEn(s.en, { vocab: item.vocab, phrases: item.phrases, grammar: item.grammar, knownRe: re })}</span>
        ${s.zh ? `<div class="ls-zh">${esc(s.zh)}</div>` : ''}
      </div>`).join('');
  }

  // 右側重點：翻譯／整理中也保留欄位骨架，不整塊蓋成「整理中」
  const hasSegs = !!(item.segments || []).length;
  const hasSideData = !!(item.summary || (item.vocab || []).length || (item.phrases || []).length
    || (item.grammar || []).length || item.mindmap);
  const showSidePanels = item.status === 'done' || hasSideData || hasSegs
    || item.status === 'translating' || item.status === 'processing';

  if (item.status === 'error' && !hasSegs && !hasSideData) {
    side.innerHTML = '<p class="hint">處理失敗，可刪除後重試。</p>';
  } else if (showSidePanels) {
    // 舊資料可能還沒有 example_start：渲染前補一次
    if ((item.phrases || []).some(p => p.example_en && p.example_start == null)
      || (item.vocab || []).some(v => v.example_en && v.example_start == null)
      || (item.grammar || []).some(g => g.example_en && g.example_start == null)) {
      attachListenExampleStarts(item);
    }
    const regen = part => `<button class="btn ghost small ls-regen" data-lspart="${part}" title="重新生成這部分">↻</button>`;
    const editBtn = (field) => {
      const on = listenEditingSide === field;
      return `<button class="btn ghost small side-edit-toggle" data-side-edit="${field}" type="button">${on ? '✓ 完成' : '✏️ 編輯'}</button>`;
    };
    const pendingHint = (label) => {
      if (item.status === 'translating' || item.status === 'processing') {
        return `<p class="hint">${esc(label)}（左側可看進度）</p>`;
      }
      return '<p class="hint">—</p>';
    };
    const vocabHtml = `<div id="lsVocabList">${(item.vocab || []).length || listenEditingSide === 'vocab'
      ? sideVocabHtml(item.vocab, { jumpable: true, editing: listenEditingSide === 'vocab' })
      : pendingHint('單字整理中')}</div>`;
    const phraseHtml = `<div id="lsPhraseList">${(item.phrases || []).length || listenEditingSide === 'phrases'
      ? sidePhrasesHtml(item.phrases, { jumpable: true, editing: listenEditingSide === 'phrases', field: 'phrases' })
      : pendingHint('片語整理中')}</div>`;
    const grammarHtml = `<div id="lsGrammarList">${(item.grammar || []).length || listenEditingSide === 'grammar'
      ? sidePhrasesHtml(item.grammar, { jumpable: true, editing: listenEditingSide === 'grammar', field: 'grammar' })
      : pendingHint('文法整理中')}</div>`;
    const summaryBody = item.summary
      ? `<p>${esc(item.summary)}</p>`
      : pendingHint('大意整理中');
    const mindBody = (item.mindmap && (item.mindmap.title || (item.mindmap.branches || []).length))
      ? renderListenMindmap(item.mindmap)
      : pendingHint('心智圖整理中');
    side.innerHTML = `
      <div class="rd-summary">
        <div class="rd-sec-title">📌 大意 ${item.summary ? spkZh(item.summary) : ''} ${regen('summary')}</div>
        ${summaryBody}
      </div>
      ${listenCollapseHtml('mindmap', `🧠 心智圖大綱 ${regen('mindmap')}`, mindBody)}
      ${listenCollapseHtml('vocab', `🔑 重要單字 ${regen('vocab')} ${editBtn('vocab')}`, vocabHtml)}
      ${listenCollapseHtml('phrases', `🧩 重要片語 ${regen('phrases')} ${editBtn('phrases')}`, phraseHtml)}
      ${listenCollapseHtml('grammar', `🏗 重要文法 ${regen('grammar')} ${editBtn('grammar')}`, grammarHtml)}`;
  } else {
    side.innerHTML = '<p class="hint">開啟或新增內容後，右側會顯示大意與重點。</p>';
  }

  listenActiveIdx = -1;
}

function getListenYtSpeed() {
  const v = parseFloat(localStorage.getItem('listen_yt_speed') || '1');
  return Number.isFinite(v) && v > 0 ? v : 1;
}
function applyListenYtSpeed(rate) {
  const r = Number(rate) || 1;
  localStorage.setItem('listen_yt_speed', String(r));
  try {
    if (ytPlayer && typeof ytPlayer.setPlaybackRate === 'function') ytPlayer.setPlaybackRate(r);
  } catch {}
  const sel = $('#ytChromeSpeed');
  if (sel && document.activeElement !== sel) sel.value = String(r);
}

function renderListenPlayer(item) {
  listenStopPlayer();
  listenPlayerId = item.id;
  const box = $('#listenPlayer');
  if (item.kind === 'youtube' && item.videoId) {
    box.classList.remove('audio-only');
    const speed = getListenYtSpeed();
    const speedOpts = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2]
      .map(s => `<option value="${s}"${Math.abs(s - speed) < 0.01 ? ' selected' : ''}>${s}x</option>`)
      .join('');
    // 隱藏 YouTube 原生上下控制列（消失很慢），改用我們自己的 hover 控制條（移開立刻消失）
    box.innerHTML = `
      <div id="ytFrame"></div>
      <div class="yt-chrome" id="ytChrome">
        <button type="button" class="yt-chrome-btn" id="ytChromePlay" title="播放／暫停">▶</button>
        <input type="range" class="yt-chrome-seek" id="ytChromeSeek" min="0" max="1" value="0" step="0.1" />
        <span class="yt-chrome-time" id="ytChromeTime">0:00 / 0:00</span>
        <label class="yt-chrome-speed" title="播放速度">
          <select id="ytChromeSpeed" aria-label="播放速度">${speedOpts}</select>
        </label>
        <button type="button" class="yt-chrome-btn" id="ytChromeFs" title="全螢幕">⛶</button>
      </div>`;
    ensureYT(() => {
      ytPlayer = new YT.Player('ytFrame', {
        videoId: item.videoId,
        playerVars: {
          rel: 0,
          modestbranding: 1,
          controls: 0,
          iv_load_policy: 3,
          fs: 0,
          playsinline: 1,
          disablekb: 0,
        },
        events: {
          onReady: () => {
            applyListenYtSpeed(getListenYtSpeed());
            listenStartPolling(() => (ytPlayer && ytPlayer.getCurrentTime) ? ytPlayer.getCurrentTime() : null);
            updateYtChrome();
          },
          onStateChange: () => updateYtChrome(),
          onPlaybackRateChange: () => {
            try {
              const r = ytPlayer.getPlaybackRate?.();
              if (r) {
                localStorage.setItem('listen_yt_speed', String(r));
                const sel = $('#ytChromeSpeed');
                if (sel && document.activeElement !== sel) sel.value = String(r);
              }
            } catch {}
          },
        },
      });
    });
  } else if (item.kind === 'file' && item.mediaUrl) {
    const src = item.mediaUrl;
    if (item.mediaType === 'video') {
      box.classList.remove('audio-only');
      box.innerHTML = `<video id="lsMedia" controls src="${src}"></video>`;
    } else {
      box.classList.add('audio-only');
      box.innerHTML = `<audio id="lsMedia" controls src="${src}"></audio>`;
    }
    listenMediaEl = $('#lsMedia');
    listenMediaEl.addEventListener('timeupdate', () => listenSetActiveByTime(listenMediaEl.currentTime));
  } else {
    box.classList.add('audio-only');
    box.innerHTML = '<p class="hint" style="color:#bbb">（媒體尚未就緒；轉錄完成後即可播放）</p>';
  }
}

function updateYtChrome() {
  if (!ytPlayer || typeof ytPlayer.getCurrentTime !== 'function') return;
  let cur = 0, dur = 0, playing = false;
  try {
    cur = ytPlayer.getCurrentTime() || 0;
    dur = ytPlayer.getDuration() || 0;
    if (window.YT && ytPlayer.getPlayerState) {
      playing = ytPlayer.getPlayerState() === YT.PlayerState.PLAYING;
    }
  } catch { return; }
  const timeEl = $('#ytChromeTime');
  const seek = $('#ytChromeSeek');
  const btn = $('#ytChromePlay');
  if (timeEl) timeEl.textContent = `${fmtTime(cur)} / ${fmtTime(dur)}`;
  if (seek && document.activeElement !== seek) {
    seek.max = String(Math.max(dur, 1));
    seek.value = String(cur);
  }
  if (btn) {
    btn.textContent = playing ? '❚❚' : '▶';
    btn.title = playing ? '暫停' : '播放';
  }
}

function ytTogglePlay() {
  if (!ytPlayer || !ytPlayer.getPlayerState) return;
  try {
    const st = ytPlayer.getPlayerState();
    if (st === YT.PlayerState.PLAYING) ytPlayer.pauseVideo();
    else ytPlayer.playVideo();
  } catch {}
}

function ytToggleFullscreen() {
  const box = $('#listenPlayer');
  if (!box) return;
  try {
    if (document.fullscreenElement === box) document.exitFullscreen?.();
    else box.requestFullscreen?.();
  } catch {}
}

function ensureYT(cb) {
  if (window.YT && window.YT.Player) { cb(); return; }
  const t = setInterval(() => { if (window.YT && window.YT.Player) { clearInterval(t); cb(); } }, 200);
  setTimeout(() => clearInterval(t), 10000);
}

function listenStartPolling(getTime) {
  listenStopPolling();
  listenPollTimer = setInterval(() => {
    const t = getTime();
    if (typeof t === 'number') listenSetActiveByTime(t);
    updateYtChrome();
  }, 400);
}
function listenStopPolling() { if (listenPollTimer) { clearInterval(listenPollTimer); listenPollTimer = null; } }

function listenStopPlayer() {
  listenStopPolling();
  if (ytPlayer && ytPlayer.destroy) { try { ytPlayer.destroy(); } catch {} }
  ytPlayer = null;
  listenMediaEl = null;
  listenPlayerId = null;
}

function listenSetActiveByTime(t) {
  const item = listenItems.find(i => i.id === listenCurrentId);
  if (!item || !(item.segments || []).length) return;
  const segs = item.segments;
  let idx = -1;
  for (let i = 0; i < segs.length; i++) {
    if (t >= segs[i].start - 0.15) idx = i; else break;
  }
  if (idx === listenActiveIdx) return;
  listenActiveIdx = idx;
  const cont = $('#listenTranscript');
  if (!cont) return;
  cont.querySelectorAll('.ls-seg.active').forEach(e => e.classList.remove('active'));
  if (idx < 0) return;
  const el = cont.querySelector(`.ls-seg[data-i="${idx}"]`);
  if (el) {
    el.classList.add('active');
    // 只在逐字稿容器內捲動，不要用 scrollIntoView（會把上方影片一起捲掉）
    if ($('#listenFollow')?.checked) scrollWithin(cont, el);
  }
}

// 在可捲動容器內把目前句子捲到框頂（不影響外層頁面／播放器）
function scrollWithin(container, el) {
  if (!container || !el) return;
  const cRect = container.getBoundingClientRect();
  const eRect = el.getBoundingClientRect();
  const pad = 4; // 稍微離頂一點，避免貼邊
  const next = container.scrollTop + (eRect.top - cRect.top) - pad;
  try {
    container.scrollTo({ top: Math.max(0, next), behavior: 'smooth' });
  } catch {
    container.scrollTop = Math.max(0, next);
  }
}

// 右側欄可拖曳調整寬度（記憶在 localStorage）
function bindListenResizer() {
  const rez = $('#listenResizer');
  const split = rez && rez.closest('.listen-split');
  if (!rez || !split) return;
  const saved = localStorage.getItem('listen_side_w');
  if (saved) document.documentElement.style.setProperty('--listen-side-w', saved);
  let dragging = false;
  const move = e => {
    if (!dragging) return;
    const rect = split.getBoundingClientRect();
    const x = e.clientX;
    const min = 280, max = Math.max(min, rect.width * 0.6);
    const w = Math.max(min, Math.min(max, rect.right - x));
    document.documentElement.style.setProperty('--listen-side-w', w + 'px');
  };
  const up = () => {
    if (!dragging) return;
    dragging = false; rez.classList.remove('dragging'); document.body.style.userSelect = '';
    const v = getComputedStyle(document.documentElement).getPropertyValue('--listen-side-w').trim();
    if (v) localStorage.setItem('listen_side_w', v);
  };
  rez.addEventListener('pointerdown', e => { dragging = true; rez.classList.add('dragging'); document.body.style.userSelect = 'none'; e.preventDefault(); });
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

// 影片／逐字稿高度比例可拖曳調整
function bindListenPlayerResizer() {
  const rez = $('#listenPlayerResizer');
  const player = $('#listenPlayer');
  if (!rez || !player) return;
  const saved = localStorage.getItem('listen_player_h');
  if (saved) document.documentElement.style.setProperty('--listen-player-h', saved);
  let dragging = false;
  const setIframePe = (on) => {
    const iframe = player.querySelector('iframe');
    if (iframe) iframe.style.pointerEvents = on ? '' : 'none';
  };
  const move = e => {
    if (!dragging) return;
    const top = player.getBoundingClientRect().top;
    const min = 120;
    const max = Math.max(min + 40, window.innerHeight * 0.72);
    const h = Math.max(min, Math.min(max, e.clientY - top));
    document.documentElement.style.setProperty('--listen-player-h', `${Math.round(h)}px`);
  };
  const up = () => {
    if (!dragging) return;
    dragging = false;
    rez.classList.remove('dragging');
    document.body.style.userSelect = '';
    setIframePe(true);
    const v = getComputedStyle(document.documentElement).getPropertyValue('--listen-player-h').trim();
    if (v) localStorage.setItem('listen_player_h', v);
  };
  rez.addEventListener('pointerdown', e => {
    dragging = true;
    rez.classList.add('dragging');
    document.body.style.userSelect = 'none';
    setIframePe(false);
    e.preventDefault();
    try { rez.setPointerCapture(e.pointerId); } catch {}
  });
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
}

function listenSeekTo(sec) {
  if (ytPlayer && ytPlayer.seekTo) { ytPlayer.seekTo(sec, true); ytPlayer.playVideo && ytPlayer.playVideo(); }
  else if (listenMediaEl) { listenMediaEl.currentTime = sec; listenMediaEl.play && listenMediaEl.play(); }
}

/* ---------- 綁定 ---------- */
function bindListen() {
  $('#listenFile')?.addEventListener('change', e => {
    const files = e.target.files;
    e.target.value = '';
    if (files && files.length) enqueueListenFiles(files);
  });
  $('#listenPlayer')?.addEventListener('click', e => {
    if (e.target.closest('#ytChromePlay')) { ytTogglePlay(); return; }
    if (e.target.closest('#ytChromeFs')) { ytToggleFullscreen(); return; }
  });
  $('#listenPlayer')?.addEventListener('change', e => {
    const speed = e.target.closest('#ytChromeSpeed');
    if (speed) applyListenYtSpeed(speed.value);
  });
  $('#listenPlayer')?.addEventListener('input', e => {
    const seek = e.target.closest('#ytChromeSeek');
    if (!seek || !ytPlayer || !ytPlayer.seekTo) return;
    const t = parseFloat(seek.value) || 0;
    ytPlayer.seekTo(t, true);
    listenSetActiveByTime(t);
  });
  $('#listenYoutubeBtn')?.addEventListener('click', openListenYoutubeModal);
  $('#lytConfirm')?.addEventListener('click', confirmListenYoutubeModal);
  $('#listenYoutubeModal')?.addEventListener('click', e => {
    if (e.target.closest('[data-close-lyt]')) closeListenYoutubeModal();
  });
  $('#lytUrl')?.addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); confirmListenYoutubeModal(); }
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && $('#listenYoutubeModal') && !$('#listenYoutubeModal').hidden) closeListenYoutubeModal();
  });
  $('#listenBackBtn')?.addEventListener('click', () => { listenStopPlayer(); listenCurrentId = null; renderListen(); });
  $('#listenRenameBtn')?.addEventListener('click', () => {
    const it = listenItems.find(i => i.id === listenCurrentId); if (!it) return;
    const t = (prompt('新標題', it.title) || '').trim(); if (!t) return;
    it.title = t; it.updatedAt = now(); saveListen(); $('#listenTitle').textContent = t;
  });
  $('#listenDeleteBtn')?.addEventListener('click', () => {
    const it = listenItems.find(i => i.id === listenCurrentId); if (!it) return;
    if (!confirm(`確定刪除「${it.title}」？`)) return;
    listenItems = listenItems.filter(i => i.id !== it.id);
    listenStopPlayer(); listenCurrentId = null; saveListen(); renderListen();
  });
  $('#listenList')?.addEventListener('click', e => {
    const b = e.target.closest('[data-listen]');
    if (b) { listenCurrentId = b.dataset.listen; renderListen(); }
  });
  $('#listenTranscript')?.addEventListener('click', e => {
    if (e.target.closest('.speak-btn')) return;
    const impPhrase = e.target.closest('.rd-imp-phrase');
    if (impPhrase) {
      scrollListenPhraseIntoView(impPhrase.dataset.impPhrase || plainEnText(impPhrase));
      return;
    }
    const impGrammar = e.target.closest('.rd-imp-grammar');
    if (impGrammar) {
      scrollListenGrammarIntoView(impGrammar.dataset.impGrammar || plainEnText(impGrammar));
      return;
    }
    const impWord = e.target.closest('.rd-imp-word');
    if (impWord) {
      scrollListenVocabIntoView(impWord.dataset.impWord || plainEnText(impWord));
      return;
    }
    const seg = e.target.closest('.ls-seg');
    if (seg) listenSeekTo(parseFloat(seg.dataset.start) || 0);
  });
  $('#listenTranscript')?.addEventListener('dblclick', e => {
    if (!e.target.closest('.ls-en, .ls-seg')) return;
    const word = wordFromDblClick(e);
    if (!word) return;
    const seg = e.target.closest('.ls-seg');
    const example = plainEnText(seg?.querySelector('.ls-en'));
    const start = seg ? parseFloat(seg.dataset.start) : undefined;
    addListenSideVocab(word, example, Number.isFinite(start) ? start : undefined);
  });
  $('#listenToggleZh')?.addEventListener('click', toggleHideZh);
  $('#listenCcRescan')?.addEventListener('click', () => {
    const it = listenItems.find(i => i.id === listenCurrentId);
    if (it) listenForceCc(it);
  });
  $('#listenWhisperRescan')?.addEventListener('click', () => {
    const it = listenItems.find(i => i.id === listenCurrentId);
    if (it) listenForceWhisper(it);
  });
  $('#listenBrowserTranslate')?.addEventListener('click', () => {
    const it = listenItems.find(i => i.id === listenCurrentId);
    if (it) relistenTranslateBrowser(it);
  });
  $('#listenGeminiTranslate')?.addEventListener('click', () => {
    const it = listenItems.find(i => i.id === listenCurrentId);
    if (it) relistenTranslateGemini(it);
  });
  bindListenResizer();
  bindListenPlayerResizer();
  $('#listenSide')?.addEventListener('click', e => {
    if (e.target.closest('.speak-btn')) return;
    const regen = e.target.closest('.ls-regen');
    if (regen) { const it = listenItems.find(i => i.id === listenCurrentId); if (it) relistenAnalyze(it, regen.dataset.lspart); return; }
    const editToggle = e.target.closest('.side-edit-toggle');
    if (editToggle) {
      const field = editToggle.dataset.sideEdit;
      listenEditingSide = listenEditingSide === field ? null : field;
      const it = listenItems.find(i => i.id === listenCurrentId);
      if (it) renderListenItem(it);
      return;
    }
    const sideAdd = e.target.closest('[data-side-add]');
    if (sideAdd) {
      const field = sideAdd.dataset.sideAdd;
      const it = listenItems.find(i => i.id === listenCurrentId);
      if (!it || !SIDE_LIST_FIELDS[field]) return;
      it[field] = it[field] || [];
      it[field].push(SIDE_LIST_FIELDS[field].blank());
      it.updatedAt = now(); saveListen();
      renderListenItem(it);
      return;
    }
    const sideDel = e.target.closest('[data-side-del]');
    if (sideDel) {
      const field = sideDel.dataset.sideDel;
      const idx = +sideDel.dataset.idx;
      const it = listenItems.find(i => i.id === listenCurrentId);
      if (!it || !Array.isArray(it[field])) return;
      it[field].splice(idx, 1);
      it.updatedAt = now(); saveListen();
      renderListenItem(it);
      return;
    }
    const add = e.target.closest('.rd-add-vocab');
    if (add) { openReaderAdd(add.dataset.word, add.dataset.ex); return; }
    const head = e.target.closest('.rd-collapse-head');
    if (head && !e.target.closest('button')) {
      const box = head.closest('.rd-collapse');
      if (box) {
        box.classList.toggle('collapsed');
        setListenCollapse(box.dataset.collapse, box.classList.contains('collapsed'));
      }
      return;
    }
    // 可跳轉項目：避免點到按鈕時誤跳
    if (e.target.closest('button')) return;
    const jump = e.target.closest('.ls-jump');
    if (jump && jump.dataset.start != null) {
      listenSeekTo(parseFloat(jump.dataset.start) || 0);
    }
  });
  $('#listenSide')?.addEventListener('input', e => {
    const t = e.target.closest('.side-ed-input');
    if (!t) return;
    const it = listenItems.find(i => i.id === listenCurrentId);
    if (!it) return;
    const field = t.dataset.sideField;
    const idx = +t.dataset.idx;
    if (!Array.isArray(it[field])) it[field] = [];
    it[field][idx] = it[field][idx] || {};
    it[field][idx][t.dataset.key] = t.value;
    it.updatedAt = now();
    saveListen();
  });
}

/* ---------------------- 框選文字 → AI 提問小框 ---------------------- */
const SEL_AI_PROMPTS = {
  比較: (t) => `請簡短比較「${t}」與易混淆的相近用法（如近義詞／相近句型），點出差異與何時用哪個。用繁體中文，2–5 句。`,
  解釋: (t) => `請簡短解釋「${t}」在此文中的意思與用法。用繁體中文，2–5 句。`,
  翻譯: (t) => `請把「${t}」翻譯成自然繁體中文；若有歧義，附一句簡短說明。`,
  舉例: (t) => `請用「${t}」舉 2–3 個簡短英文例句，每句附繁中譯。`,
  造句: (t) => `請用「${t}」造 2 個實用英文句子，每句附繁中譯。`,
};
let selAiState = { text: '', context: '' };
let selAiBusy = false;

function hideSelAiPop() {
  const pop = $('#selAiPop');
  if (pop) {
    pop.hidden = true;
    pop.classList.remove('dragging');
  }
}

function clampSelAiPos(left, top, pop) {
  const pad = 8;
  const el = pop || $('#selAiPop');
  const w = el?.offsetWidth || 300;
  const h = el?.offsetHeight || 160;
  left = Math.max(pad, Math.min(left, window.innerWidth - w - pad));
  top = Math.max(pad, Math.min(top, window.innerHeight - h - pad));
  return { left: Math.round(left), top: Math.round(top) };
}

function showSelAiPop(text, context, rect) {
  const pop = $('#selAiPop');
  if (!pop || !text) return;
  selAiState = { text, context: context || '' };
  const quote = $('#selAiQuote');
  const ans = $('#selAiAns');
  const input = $('#selAiInput');
  if (quote) quote.textContent = text.length > 80 ? text.slice(0, 80) + '…' : text;
  if (ans) { ans.hidden = true; ans.textContent = ''; }
  if (input) input.value = '';
  pop.hidden = false;
  const w = pop.offsetWidth || 300;
  let left = rect.left + rect.width / 2 - w / 2;
  let top = rect.bottom + 8;
  ({ left, top } = clampSelAiPos(left, top, pop));
  // 若下方空間不足，改放到選取區上方
  if (top < rect.bottom && rect.top - (pop.offsetHeight || 160) - 8 > 8) {
    ({ left, top } = clampSelAiPos(left, rect.top - (pop.offsetHeight || 160) - 8, pop));
  }
  pop.style.left = `${left}px`;
  pop.style.top = `${top}px`;
}

function selectionInRoots() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
  let text = String(sel.toString() || '').replace(/\s+/g, ' ').trim();
  if (!text || text.length > 400) return null;
  const range = sel.getRangeAt(0);
  const node = range.commonAncestorContainer;
  const el = node.nodeType === 1 ? node : node.parentElement;
  if (!el) return null;

  // 不要在按鈕、表單、導航、登入門、小框本身觸發
  if (el.closest('button, a, input, textarea, select, label, .sel-ai-pop, .nav, .topbar, .login-gate, .toast, .modal-header, .modal-actions, .rate-btns, .study-toolbar')) {
    return null;
  }
  // 設定頁（金鑰等）不彈
  if (el.closest('#view-settings')) return null;

  // 主要學習內容：背誦字卡、詞庫、詳情、新增預覽、閱讀、聽力…
  const root = el.closest([
    '#cardFront',
    '#cardBack',
    '#studyCard',
    '#studyEditor',
    '#modalBody',
    '#deckList',
    '#previewArea',
    '#readerArticle .rd-main',
    '#readerArticle .rd-aside',
    '#listenTranscript',
    '#listenSide',
    '.word-card',
  ].join(', '));
  if (!root) return null;

  const block = el.closest([
    '.rd-para', '.ls-seg', '.rd-en', '.ls-en',
    '.card-face', '.card-back', '.word-card',
    '.def-item', '.example', '.entry-section', '.entry-word',
    '.fc-word', '.fc-zh-main', '.spell-cloze', '.ma-line',
    'p', 'div',
  ].join(', ')) || el;
  const context = plainEnText(block).slice(0, 600);
  return { text, context, range };
}

async function askSelAi(question) {
  const pop = $('#selAiPop');
  const ans = $('#selAiAns');
  if (!pop || !ans || selAiBusy) return;
  const { text, context } = selAiState;
  if (!text) return;
  const q = String(question || '').trim();
  if (!q) { toast('請先輸入問題或點快捷', true); return; }
  selAiBusy = true;
  ans.hidden = false;
  ans.innerHTML = '<span class="spinner"></span> 思考中…';
  try {
    const prompt = `你是英語家教，回答要精簡實用。\n使用者圈選：「${text}」\n上下文：${context || '（無）'}\n任務：${q}\n用繁體中文回答；英文例句可保留英文。不要開場白、不要列一堆無關選項。`;
    const reply = await geminiGenerate([{ text: prompt }], {
      temperature: 0.4,
      maxOutputTokens: 640,
      model: READER_FAST_MODEL,
    });
    ans.textContent = String(reply || '').trim() || '（沒有回覆）';
  } catch (e) {
    ans.textContent = `失敗：${e.message || e}`;
  } finally {
    selAiBusy = false;
  }
}

function bindSelAiPop() {
  const pop = $('#selAiPop');
  if (!pop) return;

  // 在小框上 mousedown 避免清掉選取／立刻關閉
  pop.addEventListener('mousedown', e => {
    // 允許在輸入框正常點選／輸入
    if (e.target.closest('input, textarea, select, button')) return;
    e.preventDefault();
  });

  // 有新的框選才打開／更新小框；點外面、捲動、Esc 都不關，只靠 ✕
  const onSelEnd = (e) => {
    if (e.target && e.target.closest && e.target.closest('#selAiPop')) return;
    setTimeout(() => {
      const hit = selectionInRoots();
      if (!hit) return;
      const rect = hit.range.getBoundingClientRect();
      if (rect.width || rect.height) showSelAiPop(hit.text, hit.context, rect);
    }, 10);
  };
  document.addEventListener('mouseup', onSelEnd);
  document.addEventListener('touchend', onSelEnd, { passive: true });

  pop.addEventListener('click', e => {
    const chip = e.target.closest('[data-sel-chip]');
    if (chip) {
      const kind = chip.dataset.selChip;
      const mk = SEL_AI_PROMPTS[kind];
      askSelAi(mk ? mk(selAiState.text) : kind);
      return;
    }
    if (e.target.closest('#selAiAsk')) {
      askSelAi($('#selAiInput')?.value || '');
      return;
    }
    if (e.target.closest('#selAiClose')) {
      hideSelAiPop();
    }
  });
  $('#selAiInput')?.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      askSelAi($('#selAiInput')?.value || '');
    }
  });
}

/* ---------------------- 啟動 ---------------------- */
document.addEventListener('DOMContentLoaded', init);
