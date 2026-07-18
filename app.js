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
    u.rate = 0.95;
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
let ttsBusy = false;
async function speakGeminiTTS(text) {
  if (!text) return;
  const keys = activeKeys();
  if (!keys.length) { toast('尚未設定 API 金鑰', true); return; }
  if (ttsBusy) return;
  ttsBusy = true;
  toast('🤖 AI 生成語音中…');
  const body = {
    contents: [{ role: 'user', parts: [{ text }] }],
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } },
    },
  };
  try {
    for (const model of TTS_MODELS) {
      for (let attempt = 0; attempt < keys.length; attempt++) {
        const key = keys[keyIndex % keys.length];
        keyIndex = (keyIndex + 1) % keys.length;
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
          new Audio(pcmB64ToWavUrl(part.inlineData.data, rate)).play();
          ttsBusy = false;
          return;
        } catch (e) { /* 換下一把金鑰 */ }
      }
    }
    toast('AI 語音失敗，改用瀏覽器語音', true);
    speak(text);
  } finally { ttsBusy = false; }
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
  inner += btn('browser', '🔊瀏', '瀏覽器語音') + btn('ai', '🤖', 'AI 語音（臨時生成）');
  return `<span class="spk-group">${inner}</span>`;
}
// 一般單字（詞形變化、派生詞）：依設定口音的字典發音 + AI
function spkw(word) {
  if (!word) return '';
  const t = esc(word);
  return `<button class="speak-btn" data-speak="${t}" data-src="dict" title="真人錄音發音" type="button">🔊</button>`
    + `<button class="speak-btn" data-speak="${t}" data-src="ai" title="AI 語音" type="button">🤖</button>`;
}
// 句子：瀏覽器語音 + AI
function spk(text) {
  if (!text) return '';
  const t = esc(text);
  return `<button class="speak-btn" data-speak="${t}" data-src="browser" title="瀏覽器語音" type="button">🔊</button>`
    + `<button class="speak-btn" data-speak="${t}" data-src="ai" title="AI 語音" type="button">🤖</button>`;
}
// 中文：瀏覽器中文語音 + AI
function spkZh(text) {
  if (!text) return '';
  const t = esc(text);
  return `<button class="speak-btn" data-speak="${t}" data-src="zh" title="中文發音（瀏覽器）" type="button">🔊中</button>`
    + `<button class="speak-btn" data-speak="${t}" data-src="ai" title="中文 AI 語音" type="button">🤖</button>`;
}

// 依序朗讀多段（瀏覽器語音會自動排隊）
function makeUtterance(text, lang) {
  const u = new SpeechSynthesisUtterance(text);
  u.lang = lang;
  u.rate = 0.95;
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
// 切到新卡：自動念單字＋中文解釋（克漏字則念整句）
function autoSpeakFront(d, mode) {
  if (mode === 'spelling') {
    const sent = clozeSentence(d);
    speakSequence([{ text: sent ? sent.en : d.word, lang: TARGET_LANG() },
      { text: sent ? sent.zh : '', lang: ZH_LANG }]);
    return;
  }
  speakSequence([{ text: d.word, lang: TARGET_LANG() }, { text: zhExplanationOf(d), lang: ZH_LANG }]);
}
// 顯示答案：念單字＋中文解釋＋所有例句
function autoSpeakBack(d) {
  const items = [{ text: d.word, lang: TARGET_LANG() }, { text: zhExplanationOf(d), lang: ZH_LANG }];
  exampleSentencesOf(d).forEach(s => items.push({ text: s, lang: TARGET_LANG() }));
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

/* =========================================================================
   初始化
   ========================================================================= */
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
      case 'ai': speakGeminiTTS(t); break;
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
const _list = (props) => ({ type: 'array', items: { type: 'object', properties: props } });

// 每段共用的原始內容說明
function rawBlock(raw) {
  return raw
    ? `以下是使用者從歐路詞典複製貼上的原始內容（可能雜亂、有重複或無關文字，請判讀後取用）：\n"""\n${raw}\n"""`
    : '（使用者沒有提供字典內容，請依你自己的知識整理。）';
}

// 分段任務：各段輸出小、聚焦，品質較好
const SEGMENTS = [
  {
    key: 'base',
    schema: {
      type: 'object',
      properties: {
        phonetic_uk: { type: 'string' },
        phonetic_us: { type: 'string' },
        definitions: _list({
          pos: { type: 'string' },
          meaning_zh: { type: 'string' },
          meaning_en: { type: 'string' },
          example_en: { type: 'string' },
          example_zh: { type: 'string' },
        }),
      },
    },
    prompt: (word, raw) => `你是${L().name}單字整理老師。請只整理${L().name}單字「${word}」的「音標與釋義」，輸出繁體中文為主的 JSON。
${rawBlock(raw)}

要求：
- phonetic_uk / phonetic_us：音標（英文填英式/美式；德文可填 IPA 或留空）。
- definitions：列出最常用的 2～5 個詞性與中文意思，meaning_en 填${L().name}原文釋義（可留空），每個附一個實用例句（example_en 填${L().name}例句 + example_zh 中文翻譯）。
只做這部分，不要輸出其他欄位。`,
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
async function requestGemini(key, body) {
  const url = endpointFor(key, settings.model);
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
async function generateJSON(promptText, schema) {
  const keys = activeKeys();
  if (keys.length === 0) throw new Error('尚未設定 API 金鑰，請到「設定」填入。');
  const body = {
    contents: [{ role: 'user', parts: [{ text: promptText }] }],
    generationConfig: {
      temperature: 0.7,
      maxOutputTokens: 8192,
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

// 分段整理：把一個字拆成多個焦點小任務，各自輸出小、品質好，最後合併
async function callGemini(word, raw, onProgress) {
  const segs = SEGMENTS;
  let doneCount = 0;
  const report = () => { if (onProgress) onProgress(doneCount, segs.length); };
  report();

  const results = await Promise.all(segs.map(async seg => {
    try {
      const part = await generateJSON(seg.prompt(word, raw), seg.schema);
      doneCount++; report();
      return { ok: true, part };
    } catch (err) {
      doneCount++; report();
      return { ok: false, key: seg.key, err };
    }
  }));

  // 合併
  const merged = { word };
  results.forEach(r => { if (r.ok && r.part) Object.assign(merged, r.part); });
  merged.word = merged.word || word;

  // 至少要有基本釋義段成功，否則視為失敗
  const baseFailed = results[0] && !results[0].ok;
  const anyOk = results.some(r => r.ok);
  if (baseFailed || !anyOk) {
    const firstErr = results.find(r => !r.ok);
    throw new Error(firstErr ? firstErr.err.message : '整理失敗');
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
  // 用最新的原文（新增頁讀 #rawInput；背誦/彈窗編輯則沿用該卡原文）
  const onAddPage = container && container.id === 'previewArea';
  const raw = onAddPage ? $('#rawInput').value.trim() : (currentEntry.raw || '');
  currentEntry.raw = raw;
  if (currentEntry.card) { currentEntry.card.raw = raw; saveCards(); }

  btn.disabled = true;
  const oldHtml = btn.innerHTML;
  btn.innerHTML = '<span class="spinner"></span> 生成中';
  try {
    const part = await generateJSON(seg.prompt(word, raw), seg.schema);
    // 清掉此段舊欄位再覆蓋
    Object.keys(seg.schema.properties).forEach(k => { delete data[k]; });
    Object.assign(data, part);
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
  const raw = $('#rawInput').value.trim();
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

  const phon = [d.phonetic_uk && `英 ${esc(d.phonetic_uk)}`, d.phonetic_us && `美 ${esc(d.phonetic_us)}`].filter(Boolean).join('　');

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
      <div class="ed-title">基本</div>
      <label class="ed-field"><span>單字</span><input class="ed-input" data-field="word" value="${attr(data.word)}" /></label>
      <div class="ed-basic-grid">
        <label class="ed-field"><span>英式音標</span><input class="ed-input" data-field="phonetic_uk" value="${attr(data.phonetic_uk)}" /></label>
        <label class="ed-field"><span>美式音標</span><input class="ed-input" data-field="phonetic_us" value="${attr(data.phonetic_us)}" /></label>
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
    const phon = d.phonetic_us || d.phonetic_uk || '';
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
  // 切到新卡自動朗讀：單字＋中文解釋（克漏字念整句），皆用瀏覽器語音
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
  const phon = d.phonetic_us || d.phonetic_uk || '';
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
  // 顯示答案自動朗讀：單字＋中文解釋＋所有例句
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
   article = { tocId, title, body, paragraphs:[{en,zh}], summary,
               vocab:[{word,meaning_zh,example_en,example_zh}],
               phrases:[{phrase,meaning_zh}], patterns:[{pattern,explain_zh,example_en}],
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
    // 雲端不存 pages（可能很大且含 undefined），只存目錄與已處理文章
    const slim = readerBooks.map(b => { const { pages, ...rest } = b; return rest; });
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
  if ((book.toc || []).length === 0) {
    toc.innerHTML = '<p class="hint" style="padding:10px">目錄整理中或無目錄…</p>';
  } else {
    toc.innerHTML = `<div class="rd-toc-head">目錄（${book.toc.length}）</div>` + book.toc.map(t => {
      const processed = book.articles && book.articles[t.id];
      const active = t.id === readerCurrentTocId ? ' active' : '';
      return `<button class="rd-toc-item${active}" data-toc="${t.id}">
        <span class="rd-toc-title">${esc(t.title)}</span>
        ${t.section ? `<span class="rd-toc-sec">${esc(t.section)}</span>` : ''}
        <span class="rd-toc-flag">${processed ? '✅' : (t.page ? 'p.' + t.page : '')}</span>
      </button>`;
    }).join('');
  }
  // 文章區
  const art = $('#readerArticle');
  if (readerCurrentTocId && book.articles && book.articles[readerCurrentTocId]) {
    renderArticle(book, book.articles[readerCurrentTocId]);
  } else if (!readerCurrentTocId) {
    art.innerHTML = '<div class="empty-state small"><p class="empty-sub">從左側目錄點一篇文章開始精讀。</p></div>';
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
    setHint('完成！點左側目錄任一篇開始精讀。');
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

async function readerBuildToc(pages) {
  // 取前段文字（含頁碼標記）給 AI 抓目錄
  let sample = ''; const LIMIT = 26000;
  for (let i = 0; i < pages.length && sample.length < LIMIT; i++) {
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
  const prompt = `以下是一本雜誌／刊物前段的文字（[P#] 為 PDF 頁碼）。請萃取這本刊物的「文章目錄」：\n- 列出每一篇實際文章的標題(title)、所屬版塊或專欄名稱(section)、以及起始頁碼(page，用最接近的 [P#] 數字)。\n- 略過廣告、版權頁、訂閱資訊等非文章內容。\n- 標題請用原文（英文）。\n只輸出 JSON。\n\n文字：\n${sample}`;
  try {
    const out = await readerJSON(prompt, schema, 0.3);
    const entries = (out.entries || []).filter(e => e.title && e.title.trim());
    return entries.map(e => ({ id: uid(), title: e.title.trim(), section: (e.section || '').trim(), page: e.page || 0, done: false }));
  } catch (e) {
    console.error('目錄整理失敗', e);
    return [];
  }
}

function readerAddText(title, text) {
  const book = {
    id: uid(), title: title || '未命名文章', createdAt: now(), updatedAt: now(), kind: 'text',
    pages: [text], toc: [{ id: uid(), title: title || '未命名文章', section: '', page: 1, done: false }], articles: {},
  };
  readerBooks.unshift(book);
  saveReader();
  readerCurrentBookId = book.id;
  readerCurrentTocId = book.toc[0].id;
  renderReader();
  openArticle(book, book.toc[0]);
}

/* ---------- 文章精讀處理 ---------- */
function readerFullText(book) {
  if (!book.pages || !book.pages.length) return '';
  return book.pages.map((t, i) => `[P${i + 1}] ${t}`).join('\n');
}
function escapeRegExp(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function readerArticleWindow(book, toc) {
  const full = readerFullText(book);
  if (!full) return '';
  if (book.kind === 'text') return full.replace(/\[P\d+\]\s*/g, '');
  const words = (toc.title || '').toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8).map(escapeRegExp);
  let idx = -1;
  if (words.length) {
    try { const re = new RegExp(words.join('\\W+'), 'i'); const m = re.exec(full); if (m) idx = m.index; } catch {}
  }
  if (idx < 0) return full.slice(0, 14000);
  return full.slice(Math.max(0, idx - 200), idx + 11000);
}

function chunkByWords(text, maxWords) {
  const paras = text.split(/\n{1,}|(?<=[.!?])\s{2,}/).map(s => s.trim()).filter(Boolean);
  const chunks = []; let cur = '', curW = 0;
  for (const p of paras) {
    const w = p.split(/\s+/).length;
    if (curW + w > maxWords && cur) { chunks.push(cur); cur = ''; curW = 0; }
    cur += (cur ? '\n' : '') + p; curW += w;
  }
  if (cur) chunks.push(cur);
  return chunks.length ? chunks : [text];
}

async function processArticle(book, toc) {
  const art = $('#readerArticle');
  const status = (t) => { art.innerHTML = `<div class="rd-processing"><span class="spinner"></span> ${esc(t)}</div>`; };
  status('擷取文章正文中…');
  const win = readerArticleWindow(book, toc);
  if (!win) {
    art.innerHTML = '<div class="empty-state small"><p class="empty-sub">這本書的原始內容不在此裝置（雲端不保存 PDF 原文）。請重新上傳同一份 PDF 即可處理未整理的文章。</p></div>';
    return;
  }

  // 1) 用 AI 清出乾淨正文
  let body = win;
  try {
    const cleanSchema = { type: 'object', properties: { article: { type: 'string' } }, required: ['article'] };
    const cleanPrompt = `以下文字擷取自 PDF，可能夾雜頁碼標記[P#]、頁首頁尾、廣告或其他文章。請找出標題約為「${toc.title}」的那篇文章，輸出它的完整正文：\n- 合併被硬斷的行、還原自然段落（段落之間用換行分隔）。\n- 移除頁碼標記、頁首頁尾、圖說、廣告與其他文章。\n- 不要翻譯、不要加入任何說明，只輸出正文文字。\n\n文字：\n${win}`;
    const cj = await readerJSON(cleanPrompt, cleanSchema, 0.2);
    if (cj.article && cj.article.trim().length > 40) body = cj.article.trim();
  } catch (e) { console.error('正文清理失敗，改用原始擷取', e); }

  // 2) 逐段中英對照（分塊翻譯）＋ 3) 重要單字/片語/句型 ＋ 4) 大意，平行處理
  status('AI 翻譯與精讀分析中…（重要單字、片語、句型、逐段對照、大意）');
  const chunks = chunkByWords(body, 850);
  const transSchema = {
    type: 'object', properties: {
      paragraphs: { type: 'array', items: { type: 'object', properties: { en: { type: 'string' }, zh: { type: 'string' } }, required: ['en', 'zh'] } },
    }, required: ['paragraphs'],
  };
  const transTasks = chunks.map(ch => readerJSON(
    `把以下英文文章片段分成自然段落，輸出每一段的原文(en)與對應的繁體中文翻譯(zh)。保持順序、勿省略、勿加入說明。\n\n${ch}`,
    transSchema, 0.3,
  ).then(r => r.paragraphs || []).catch(() => [{ en: ch, zh: '（此段翻譯失敗）' }]));

  const vocabSchema = {
    type: 'object', properties: {
      vocab: { type: 'array', items: { type: 'object', properties: { word: { type: 'string' }, meaning_zh: { type: 'string' }, example_en: { type: 'string' }, example_zh: { type: 'string' } }, required: ['word'] } },
      phrases: { type: 'array', items: { type: 'object', properties: { phrase: { type: 'string' }, meaning_zh: { type: 'string' } }, required: ['phrase'] } },
      patterns: { type: 'array', items: { type: 'object', properties: { pattern: { type: 'string' }, explain_zh: { type: 'string' }, example_en: { type: 'string' } }, required: ['pattern'] } },
    },
  };
  const vocabTask = readerJSON(
    `你是英語精讀老師。從以下文章挑出對進階學習者最有價值的內容，用繁體中文說明：\n- vocab：10–15 個重要單字，每個給中文意思(meaning_zh)、一個例句(example_en，優先取自文章)與例句中譯(example_zh)。\n- phrases：5–10 個重要片語／搭配，附中文(meaning_zh)。\n- patterns：3–6 個重要句型或文法結構，說明用法(explain_zh)並附一個例句(example_en)。\n只輸出 JSON。\n\n文章：\n${body.slice(0, 16000)}`,
    vocabSchema, 0.5,
  ).catch(() => ({ vocab: [], phrases: [], patterns: [] }));

  const summarySchema = { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] };
  const summaryTask = readerJSON(
    `用繁體中文寫出這篇文章的整體大意（重點摘要，3–5 句）。只輸出 JSON。\n\n文章：\n${body.slice(0, 16000)}`,
    summarySchema, 0.4,
  ).then(r => r.summary || '').catch(() => '');

  const [transArr, vocabOut, summary] = await Promise.all([Promise.all(transTasks), vocabTask, summaryTask]);
  const paragraphs = transArr.flat();

  const article = {
    tocId: toc.id, title: toc.title, body,
    paragraphs, summary,
    vocab: vocabOut.vocab || [], phrases: vocabOut.phrases || [], patterns: vocabOut.patterns || [],
    processedAt: now(),
  };
  book.articles = book.articles || {};
  book.articles[toc.id] = article;
  toc.done = true;
  book.updatedAt = now();
  saveReader();
  renderBook(book);
  renderArticle(book, article);
  toast('精讀整理完成');
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
function highlightKnown(text, re) {
  const safe = esc(text);
  if (!re) return safe;
  re.lastIndex = 0;
  return safe.replace(re, m => `<mark class="rd-known">${m}</mark>`);
}

function renderArticle(book, a) {
  const el = $('#readerArticle');
  const re = buildKnownWordRegex();
  const paras = (a.paragraphs || []).map(p => {
    const en = highlightKnown(p.en || '', re);
    return `<div class="rd-para">
      <p class="rd-en">${en} <button class="speak-btn rd-para-spk" data-speak="${esc(p.en || '')}" data-src="browser" title="朗讀此段" type="button">🔊</button></p>
      <p class="rd-zh">${esc(p.zh || '')}</p>
    </div>`;
  }).join('') || '<p class="hint">（沒有逐段內容）</p>';

  const vocabHtml = (a.vocab || []).map(v => `<div class="rd-vitem">
      <div class="rd-vhead">
        <b class="rd-vword">${esc(v.word)}</b>
        ${spkw(v.word)}
        <button class="btn ghost small rd-add-vocab" data-word="${esc(v.word)}" data-ex="${esc(v.example_en || '')}">＋ 加入詞庫</button>
      </div>
      ${v.meaning_zh ? `<div class="rd-vmean">${esc(v.meaning_zh)}</div>` : ''}
      ${v.example_en ? `<div class="rd-vex">${esc(v.example_en)} <button class="speak-btn" data-speak="${esc(v.example_en)}" data-src="browser" title="朗讀例句" type="button">🔊</button></div>` : ''}
      ${v.example_zh ? `<div class="rd-vexzh">${esc(v.example_zh)}</div>` : ''}
    </div>`).join('') || '<p class="hint">—</p>';

  const phraseHtml = (a.phrases || []).map(p => `<div class="rd-pitem"><b>${esc(p.phrase)}</b>${p.meaning_zh ? ` — ${esc(p.meaning_zh)}` : ''} <button class="speak-btn" data-speak="${esc(p.phrase)}" data-src="browser" type="button">🔊</button></div>`).join('') || '<p class="hint">—</p>';

  const patternHtml = (a.patterns || []).map(p => `<div class="rd-pitem"><b>${esc(p.pattern)}</b>${p.explain_zh ? `<div class="rd-vmean">${esc(p.explain_zh)}</div>` : ''}${p.example_en ? `<div class="rd-vex">${esc(p.example_en)} <button class="speak-btn" data-speak="${esc(p.example_en)}" data-src="browser" type="button">🔊</button></div>` : ''}</div>`).join('') || '<p class="hint">—</p>';

  el.innerHTML = `
    <div class="rd-article-head">
      <h2 class="rd-atitle">${esc(a.title)}</h2>
      <div class="rd-tools">
        <button class="btn ghost small" id="rdReadAll">🔊 朗讀整篇</button>
        <button class="btn ghost small" id="rdStop">⏹ 停止</button>
        <button class="btn ghost small" id="rdReprocess" title="重新用 AI 整理這篇">↻ 重新整理</button>
      </div>
    </div>
    ${a.summary ? `<div class="rd-summary"><div class="rd-sec-title">📌 段落大意 ${spkZh(a.summary)}</div><p>${esc(a.summary)}</p></div>` : ''}
    <div class="rd-section"><div class="rd-sec-title">📖 逐段中英對照</div>${paras}</div>
    <div class="rd-cols">
      <div class="rd-section"><div class="rd-sec-title">🔑 重要單字</div>${vocabHtml}</div>
      <div class="rd-section"><div class="rd-sec-title">🧩 重要片語</div>${phraseHtml}</div>
      <div class="rd-section"><div class="rd-sec-title">🏗 重要句型</div>${patternHtml}</div>
    </div>`;
  el.scrollTop = 0;
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
  const raw = $('#raddRaw').value.trim();
  if (!word) { toast('請輸入單字', true); return; }
  const status = $('#raddStatus');
  const btn = $('#raddGenBtn');
  status.hidden = false; status.className = 'gen-status';
  status.innerHTML = '<span class="spinner"></span> 整理中…';
  btn.disabled = true;
  try {
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
        const data = await requestGemini(key, body);
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
async function readerJSON(prompt, schema, temperature) {
  const text = await geminiGenerate([{ text: prompt }], { schema, temperature, maxOutputTokens: 8192 });
  try { return JSON.parse(text); } catch { throw new Error('無法解析回傳的 JSON。'); }
}
async function visionTranscribe(file) {
  const b64 = await fileToBase64(file);
  return geminiGenerate(
    [{ text: '把這張圖片中的英文文章文字完整轉錄為純文字，保留段落換行；不要翻譯、不要加入任何說明。' },
      { inlineData: { mimeType: file.type || 'image/png', data: b64 } }],
    { temperature: 0.1 },
  );
}

function bindReader() {
  $('#readerPdfFile')?.addEventListener('change', e => {
    const f = e.target.files && e.target.files[0];
    if (f) readerAddPdf(f);
    e.target.value = '';
  });
  $('#readerPasteBtn')?.addEventListener('click', async () => {
    const title = (prompt('文章標題（例如：文章來源或主題）') || '').trim();
    if (title === null) return;
    const text = (prompt('把文章英文內容貼在這裡：') || '').trim();
    if (!text) { toast('沒有內容', true); return; }
    readerAddText(title || '未命名文章', text);
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
    const item = e.target.closest('[data-toc]');
    if (!item) return;
    const book = readerBooks.find(b => b.id === readerCurrentBookId);
    if (!book) return;
    const toc = (book.toc || []).find(t => t.id === item.dataset.toc);
    if (toc) openArticle(book, toc);
  });
  $('#readerArticle')?.addEventListener('click', e => {
    if (e.target.closest('.speak-btn')) return; // 交給全域喇叭
    const add = e.target.closest('.rd-add-vocab');
    if (add) { openReaderAdd(add.dataset.word, add.dataset.ex); return; }
    if (e.target.closest('#rdReadAll')) {
      const book = readerBooks.find(b => b.id === readerCurrentBookId);
      const a = book && book.articles && book.articles[readerCurrentTocId];
      if (a) speakSequence((a.paragraphs || []).map(p => ({ text: p.en, lang: TARGET_LANG() })));
      return;
    }
    if (e.target.closest('#rdStop')) { if (window.speechSynthesis) window.speechSynthesis.cancel(); return; }
    if (e.target.closest('#rdReprocess')) {
      const book = readerBooks.find(b => b.id === readerCurrentBookId);
      const toc = book && (book.toc || []).find(t => t.id === readerCurrentTocId);
      if (book && toc && confirm('重新用 AI 整理這篇文章？')) processArticle(book, toc);
      return;
    }
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
            vocab:[{word,meaning_zh,example_en}], phrases:[{phrase,meaning_zh}],
            grammar:[{point,explain_zh,example_en}], summary }
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
    const st = it.status === 'processing' ? '（處理中…）' : it.status === 'error' ? '（處理失敗）' : `${n} 段`;
    return `<button class="reader-book-card" data-listen="${it.id}">
      <span class="rbc-icon">${it.kind === 'youtube' ? '▶️' : (it.mediaType === 'video' ? '🎬' : '🎧')}</span>
      <span class="rbc-info"><span class="rbc-title">${esc(it.title)}</span><span class="rbc-sub">${st} · ${ds}</span></span>
    </button>`;
  }).join('');
}

/* ---------- 建立聽力：上傳檔案 / YouTube（雲端 Cloud Run + Replicate） ---------- */
// 轉錄完成後統一做翻譯 + 重點分析
async function listenAfterTranscribe(item) {
  const side = $('#listenSide');
  const showStage = (txt) => { if (side && listenCurrentId === item.id) side.innerHTML = `<div class="ls-processing"><span class="spinner"></span> ${esc(txt)}</div>`; };
  item.status = 'translating';
  saveListen();
  if (listenCurrentId === item.id) renderListenItem(item); // 先顯示英文與播放器
  await translateListen(item, showStage);
  await analyzeListen(item, showStage);
  item.status = 'done'; item.updatedAt = now();
  saveListen();
  if (listenCurrentId === item.id) renderListenItem(item);
  renderListenList();
  toast('聽力精聽整理完成');
}

async function listenUploadFile(file) {
  if (!file) return;
  const hint = $('#listenLibHint');
  const setHint = t => { if (hint) hint.textContent = t; };
  // 先建立處理中的項目讓使用者看到進度
  const item = {
    id: uid(), title: file.name.replace(/\.[^.]+$/, ''), kind: 'file',
    mediaUrl: '', mediaType: /\.(mp4|mkv|avi|mov|webm|m4v)$/i.test(file.name) ? 'video' : 'audio',
    createdAt: now(), updatedAt: now(), status: 'processing', language: listenLangCode(),
    segments: [], vocab: [], phrases: [], grammar: [], summary: '',
  };
  listenItems.unshift(item);
  saveListen();
  listenCurrentId = item.id; renderListen();
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
    item.segments = (j.segments || []).map(s => ({ start: s.start, end: s.end, en: (s.text || '').trim(), zh: '' }));
    saveListen();
    setHint('');
    await listenAfterTranscribe(item);
  } catch (e) {
    item.status = 'error'; saveListen();
    if (listenCurrentId === item.id) renderListenItem(item);
    renderListenList();
    setHint('');
    toast('上傳失敗：' + e.message, true);
    checkListenBackend();
  }
}

async function listenAddYoutube(url) {
  const hint = $('#listenLibHint');
  const setHint = t => { if (hint) hint.textContent = t; };
  const vid = (url.match(/(?:v=|youtu\.be\/|\/embed\/|\/shorts\/)([A-Za-z0-9_-]{11})/) || [])[1] || '';
  const item = {
    id: uid(), title: 'YouTube ' + (vid || ''), kind: 'youtube', videoId: vid,
    createdAt: now(), updatedAt: now(), status: 'processing', language: listenLangCode(),
    segments: [], vocab: [], phrases: [], grammar: [], summary: '',
  };
  listenItems.unshift(item);
  saveListen();
  listenCurrentId = item.id; renderListen();
  try {
    setHint('讀取 YouTube（優先使用現有字幕，沒有才雲端轉錄）…');
    const fd = new FormData();
    fd.append('url', url);
    fd.append('language', listenWhisperLang());
    const res = await fetch(listenBackend() + '/beidanzi/youtube', { method: 'POST', body: fd });
    if (!res.ok) throw new Error('後端回應錯誤 ' + res.status);
    const j = await res.json();
    item.videoId = j.videoId || vid;
    item.captionSource = j.captionSource;
    item.segments = (j.segments || []).map(s => ({ start: s.start, end: s.end, en: (s.text || '').trim(), zh: '' }));
    saveListen();
    setHint('');
    await listenAfterTranscribe(item);
  } catch (e) {
    item.status = 'error'; saveListen();
    if (listenCurrentId === item.id) renderListenItem(item);
    renderListenList();
    setHint('');
    toast('處理失敗：' + e.message, true);
    checkListenBackend();
  }
}

async function translateListen(item, showStage) {
  const segs = item.segments || [];
  const CH = 40;
  const schema = { type: 'object', properties: { translations: { type: 'array', items: { type: 'string' } } }, required: ['translations'] };
  for (let i = 0; i < segs.length; i += CH) {
    if (showStage) showStage(`翻譯中… ${Math.min(i + CH, segs.length)}/${segs.length}`);
    const part = segs.slice(i, i + CH);
    const prompt = `把下面每一行英文翻成繁體中文。回傳 translations 陣列，長度與行數完全相同、順序一致（第 n 行對應第 n 個）。只輸出 JSON。\n\n${part.map((s, idx) => `${idx + 1}. ${s.en}`).join('\n')}`;
    try {
      const out = await readerJSON(prompt, schema, 0.3);
      (out.translations || []).forEach((z, idx) => { if (part[idx]) part[idx].zh = z; });
    } catch (e) { console.error('翻譯段落失敗', e); }
    saveListenLocal();
  }
}

async function analyzeListen(item, showStage) {
  if (showStage) showStage('整理重要單字／片語／文法…');
  const text = (item.segments || []).map(s => s.en).join(' ').slice(0, 16000);
  const schema = {
    type: 'object', properties: {
      summary: { type: 'string' },
      vocab: { type: 'array', items: { type: 'object', properties: { word: { type: 'string' }, meaning_zh: { type: 'string' }, example_en: { type: 'string' } }, required: ['word'] } },
      phrases: { type: 'array', items: { type: 'object', properties: { phrase: { type: 'string' }, meaning_zh: { type: 'string' } }, required: ['phrase'] } },
      grammar: { type: 'array', items: { type: 'object', properties: { point: { type: 'string' }, explain_zh: { type: 'string' }, example_en: { type: 'string' } }, required: ['point'] } },
    },
  };
  const prompt = `你是英語聽力精聽老師。以下是一段音檔／影片的逐字稿。用繁體中文整理：\n- summary：整體大意（3–5 句）。\n- vocab：10–15 個重要單字，附中文意思(meaning_zh)與一個例句(example_en，優先取自逐字稿)。\n- phrases：5–10 個重要片語／口語搭配，附中文(meaning_zh)。\n- grammar：3–6 個重要文法／句型重點，說明用法(explain_zh)並附例句(example_en)。\n只輸出 JSON。\n\n逐字稿：\n${text}`;
  try {
    const out = await readerJSON(prompt, schema, 0.5);
    item.summary = out.summary || '';
    item.vocab = out.vocab || [];
    item.phrases = out.phrases || [];
    item.grammar = out.grammar || [];
  } catch (e) { console.error('聽力分析失敗', e); }
  saveListenLocal();
}

/* ---------- 渲染單一聽力：播放器 + 逐字稿 + 右側重點 ---------- */
function fmtTime(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const m = Math.floor(sec / 60), s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function renderListenItem(item) {
  $('#listenTitle').textContent = item.title;
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
        <span class="ls-time">${fmtTime(s.start)}</span><span class="ls-en">${highlightKnown(s.en, re)}</span>
        ${s.zh ? `<div class="ls-zh">${esc(s.zh)}</div>` : ''}
      </div>`).join('');
  }

  // 右側重點
  if (item.status === 'done' || (item.vocab || []).length) {
    const vocabHtml = (item.vocab || []).map(v => `<div class="rd-vitem">
        <div class="rd-vhead"><b class="rd-vword">${esc(v.word)}</b>${spkw(v.word)}
          <button class="btn ghost small rd-add-vocab" data-word="${esc(v.word)}" data-ex="${esc(v.example_en || '')}">＋ 加入詞庫</button></div>
        ${v.meaning_zh ? `<div class="rd-vmean">${esc(v.meaning_zh)}</div>` : ''}
        ${v.example_en ? `<div class="rd-vex">${esc(v.example_en)} <button class="speak-btn" data-speak="${esc(v.example_en)}" data-src="browser" type="button">🔊</button></div>` : ''}
      </div>`).join('') || '<p class="hint">—</p>';
    const phraseHtml = (item.phrases || []).map(p => `<div class="rd-pitem"><b>${esc(p.phrase)}</b>${p.meaning_zh ? ` — ${esc(p.meaning_zh)}` : ''} <button class="speak-btn" data-speak="${esc(p.phrase)}" data-src="browser" type="button">🔊</button></div>`).join('') || '<p class="hint">—</p>';
    const grammarHtml = (item.grammar || []).map(g => `<div class="rd-pitem"><b>${esc(g.point)}</b>${g.explain_zh ? `<div class="rd-vmean">${esc(g.explain_zh)}</div>` : ''}${g.example_en ? `<div class="rd-vex">${esc(g.example_en)} <button class="speak-btn" data-speak="${esc(g.example_en)}" data-src="browser" type="button">🔊</button></div>` : ''}</div>`).join('') || '<p class="hint">—</p>';
    side.innerHTML = `
      ${item.summary ? `<div class="rd-summary"><div class="rd-sec-title">📌 大意 ${spkZh(item.summary)}</div><p>${esc(item.summary)}</p></div>` : ''}
      <div class="rd-section"><div class="rd-sec-title">🔑 重要單字</div>${vocabHtml}</div>
      <div class="rd-section"><div class="rd-sec-title">🧩 重要片語</div>${phraseHtml}</div>
      <div class="rd-section"><div class="rd-sec-title">🏗 重要文法</div>${grammarHtml}</div>`;
  } else if (item.status !== 'error') {
    side.innerHTML = '<div class="ls-processing"><span class="spinner"></span> 整理重點中…</div>';
  } else {
    side.innerHTML = '<p class="hint">處理失敗，可刪除後重試。</p>';
  }

  listenActiveIdx = -1;
}

function renderListenPlayer(item) {
  listenStopPlayer();
  listenPlayerId = item.id;
  const box = $('#listenPlayer');
  if (item.kind === 'youtube' && item.videoId) {
    box.classList.remove('audio-only');
    box.innerHTML = '<div id="ytFrame"></div>';
    ensureYT(() => {
      ytPlayer = new YT.Player('ytFrame', {
        videoId: item.videoId,
        playerVars: { rel: 0, modestbranding: 1 },
        events: { onReady: () => listenStartPolling(() => (ytPlayer && ytPlayer.getCurrentTime) ? ytPlayer.getCurrentTime() : null) },
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

function ensureYT(cb) {
  if (window.YT && window.YT.Player) { cb(); return; }
  const t = setInterval(() => { if (window.YT && window.YT.Player) { clearInterval(t); cb(); } }, 200);
  setTimeout(() => clearInterval(t), 10000);
}

function listenStartPolling(getTime) {
  listenStopPolling();
  listenPollTimer = setInterval(() => { const t = getTime(); if (typeof t === 'number') listenSetActiveByTime(t); }, 400);
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
    if ($('#listenFollow')?.checked) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
}

function listenSeekTo(sec) {
  if (ytPlayer && ytPlayer.seekTo) { ytPlayer.seekTo(sec, true); ytPlayer.playVideo && ytPlayer.playVideo(); }
  else if (listenMediaEl) { listenMediaEl.currentTime = sec; listenMediaEl.play && listenMediaEl.play(); }
}

/* ---------- 綁定 ---------- */
function bindListen() {
  $('#listenFile')?.addEventListener('change', e => {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (f) listenUploadFile(f);
  });
  $('#listenYoutubeBtn')?.addEventListener('click', () => {
    const url = (prompt('貼上 YouTube 網址：') || '').trim();
    if (!url) return;
    if (!/youtu\.?be/.test(url)) { toast('看起來不是 YouTube 網址', true); return; }
    listenAddYoutube(url);
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
    const seg = e.target.closest('.ls-seg');
    if (seg) listenSeekTo(parseFloat(seg.dataset.start) || 0);
  });
  $('#listenSide')?.addEventListener('click', e => {
    if (e.target.closest('.speak-btn')) return;
    const add = e.target.closest('.rd-add-vocab');
    if (add) openReaderAdd(add.dataset.word, add.dataset.ex);
  });
}

/* ---------------------- 啟動 ---------------------- */
document.addEventListener('DOMContentLoaded', init);
