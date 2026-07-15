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

// 計入每日目標的模式（中英、克漏字為主）
const DAILY_MODES = ['en2zh', 'zh2en', 'spelling'];
const NO_FOLDER = '__none__';

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

// 金鑰不寫死在會被公開的程式碼裡。
// 本機開發時可放在 config.local.js（已被 .gitignore 忽略）：window.DEFAULT_KEYS = [...]
// 部署後（如 Vercel）請到「設定」頁輸入金鑰，會存在該裝置的瀏覽器。
const DEFAULT_KEYS = (typeof window !== 'undefined' && Array.isArray(window.DEFAULT_KEYS)) ? window.DEFAULT_KEYS : [];
const DEFAULT_SETTINGS = {
  apiKeys: DEFAULT_KEYS.slice(),
  model: 'gemini-3-flash-preview',
  accent: 'us', // us | uk
  dailyGoal: 20,
};

let keyIndex = 0;          // 金鑰輪詢游標

/* ---------------------- 狀態 ---------------------- */
let cards = [];        // 全部卡片
let settings = { ...DEFAULT_SETTINGS };
let pendingCard = null; // 尚未存檔的整理結果
let folders = [];      // 自訂資料夾名稱
let daily = null;      // { date, count, streak, lastMetDate }
let deckFolder = '';   // 詞庫篩選：'' 全部、NO_FOLDER 未分類、否則資料夾名
let deckSort = 'created_desc';

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
function saveCards() { localStorage.setItem(LS_CARDS, JSON.stringify(cards)); }
function saveSettings() { localStorage.setItem(LS_SETTINGS, JSON.stringify(settings)); }
function saveFolders() { localStorage.setItem(LS_FOLDERS, JSON.stringify(folders)); }
function saveDaily() { localStorage.setItem(LS_DAILY, JSON.stringify(daily)); }

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---- 朗讀 ----
// 句子：用瀏覽器 Web Speech API（即時生成）
function speak(text, lang) {
  lang = lang || (settings.accent === 'uk' ? 'en-GB' : 'en-US');
  if (!text || !window.speechSynthesis) { toast('這個瀏覽器不支援朗讀', true); return; }
  try {
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = lang;
    u.rate = 0.95;
    const voices = window.speechSynthesis.getVoices();
    // 優先挑高品質（Google / Microsoft）且語系相符的語音
    const same = voices.filter(x => x.lang && x.lang.toLowerCase().startsWith(lang.slice(0, 2).toLowerCase()));
    const best = same.find(x => x.lang.toLowerCase() === lang.toLowerCase() && /google|microsoft|natural/i.test(x.name))
      || same.find(x => x.lang.toLowerCase() === lang.toLowerCase())
      || same[0];
    if (best) u.voice = best;
    window.speechSynthesis.speak(u);
  } catch (e) { console.error(e); }
}

// 單詞：優先播放真人錄音字典發音，抓不到才退回瀏覽器語音
const wordAudioCache = new Map(); // word -> {us,uk,any} 或 null
async function speakWord(word) {
  const w = (word || '').trim();
  if (!w) return;
  const key = w.toLowerCase();
  let entry = wordAudioCache.get(key);
  if (entry === undefined) {
    entry = null;
    try {
      const res = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(key)}`);
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
    } catch (e) { /* 網路錯誤就退回語音 */ }
    wordAudioCache.set(key, entry);
  }
  if (entry) {
    const pref = settings.accent === 'uk' ? (entry.uk || entry.us || entry.any) : (entry.us || entry.uk || entry.any);
    try {
      const audio = new Audio(pref.startsWith('//') ? 'https:' + pref : pref);
      audio.play().catch(() => speak(w));
      return;
    } catch { /* 落到語音 */ }
  }
  speak(w);
}

// 喇叭按鈕：isWord=true 走字典發音
function spk(text, lang, isWord) {
  if (!text) return '';
  return `<button class="speak-btn" data-speak="${esc(text)}"${isWord ? ' data-word="1"' : ''}${lang ? ` data-lang="${lang}"` : ''} title="朗讀" type="button">🔊</button>`;
}
function spkw(word) { return spk(word, '', true); }

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
  cards = loadJSON(LS_CARDS, []);
  settings = { ...DEFAULT_SETTINGS, ...loadJSON(LS_SETTINGS, {}) };
  folders = loadJSON(LS_FOLDERS, []);
  daily = loadJSON(LS_DAILY, { date: todayStr(), count: 0, streak: 0, lastMetDate: '' });
  migrateSettings();
  migrateCards();
  rolloverDaily();

  applyTheme(localStorage.getItem(LS_THEME) || 'light');
  // 全域喇叭朗讀（事件委派）
  document.addEventListener('click', e => {
    const b = e.target.closest('.speak-btn');
    if (b) {
      e.stopPropagation();
      if (b.dataset.word) speakWord(b.dataset.speak);
      else speak(b.dataset.speak, b.dataset.lang || '');
    }
  });
  // 預先載入語音清單（部分瀏覽器需要）
  if (window.speechSynthesis) window.speechSynthesis.getVoices();

  bindNav();
  bindTheme();
  bindAdd();
  bindBatch();
  bindDeck();
  bindStudySetup();
  bindStudyControls();
  bindSettings();

  // 回填設定畫面
  $('#apiKeysInput').value = (settings.apiKeys || []).join('\n');
  $('#modelSelect').value = settings.model;
  $('#accentSelect').value = settings.accent || 'us';
  $('#dailyGoalInput').value = settings.dailyGoal || 20;

  bindDeckControls();
  renderFolderSelects();
  renderDailyPanel();
  renderDeck();
  renderModeGrid();

  // 啟動雲端同步（Firestore 模組載入後）
  if (window.Cloud && window.Cloud.enabled) startCloud();
  else window.addEventListener('cloud-ready', () => { if (window.Cloud && window.Cloud.enabled) startCloud(); }, { once: true });
}

/* ---------------------- 雲端同步 ---------------------- */
let cloudReady = false;
let firstSnapshot = true;

function startCloud() {
  cloudReady = true;
  setCloudBadge('連線中…');
  window.Cloud.start(onCloudCards);
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
  localStorage.setItem(LS_CARDS, JSON.stringify(cards));
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
    prompt: (word, raw) => `你是英文單字整理老師。請只整理單字「${word}」的「音標與釋義」，輸出繁體中文為主的 JSON。
${rawBlock(raw)}

要求：
- phonetic_uk / phonetic_us：英式、美式音標（若無可留空）。
- definitions：列出最常用的 2～5 個詞性與中英文意思，每個附一個實用例句（example_en 英文 + example_zh 中文翻譯）。
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
    prompt: (word, raw) => `你是記憶法專家。請只針對單字「${word}」設計「助記法與詞根詞源」，輸出繁體中文 JSON。
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
    prompt: (word, raw) => `你是英文單字整理老師。請只整理單字「${word}」的「搭配詞與片語」，輸出繁體中文 JSON。
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
    prompt: (word, raw) => `你是英文單字整理老師。請只整理單字「${word}」的「同義詞、反義詞、情境詞、易混淆詞」，輸出繁體中文 JSON。
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
    prompt: (word, raw) => `你是英文單字整理老師。請只整理單字「${word}」的「詞形變化與詞性變換」，輸出繁體中文 JSON。
${rawBlock(raw)}

要求：
- word_forms：依詞性列出所有變化形。label 用中文標籤、form 填該形式。例如：
  - 名詞：「複數」
  - 動詞：「第三人稱單數」「現在分詞」「過去式」「過去分詞」
  - 形容詞／副詞：「比較級」「最高級」
  不適用的變化就不要列。
- derivatives：詞性變換／派生詞，列出同詞根但不同詞性的相關字，word 填單字、pos 填詞性（如 n./adj./adv.）、meaning 填中文意思。
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
    prompt: (word, raw) => `你是英文單字整理老師。請只整理單字「${word}」的「例句庫」，輸出繁體中文 JSON。
${rawBlock(raw)}

要求：
- examples：3～6 句實用例句，涵蓋不同用法，每句 en 英文 + zh 中文翻譯。優先取用原始內容中的好例句。
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
function globalLimit() { return Math.max(1, (settings.apiKeys || []).filter(Boolean).length || 1); }
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
  const keys = (settings.apiKeys || []).filter(Boolean);
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
  // 用最新的原文（若使用者剛編輯過）
  const raw = $('#rawInput').value.trim();
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
    // 重新渲染（保留可編輯狀態）
    renderPreview(data, container, { editable: true, word, raw, onChange: currentEntry.onChange, card: currentEntry.card });
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
  return Math.max(1, (settings.apiKeys || []).filter(Boolean).length || 1);
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

  batchItems.push({ id: uid(), word, raw, status: 'pending', error: '', data: null });
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
    saveCards();
    cloudUpsert(newCard);
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
  if (editable) currentEntry = { data: d, container, word: ctx.word || d.word, raw: ctx.raw || '', onChange: ctx.onChange, card: ctx.card || null };

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
      <span class="def-zh">${esc(x.meaning_zh)}</span>
      ${x.meaning_en ? `<span class="def-en"> — ${esc(x.meaning_en)}</span>` : ''}
      ${x.example_en ? `<div class="example">${esc(x.example_en)}${spk(x.example_en)}<div class="ex-zh">${esc(x.example_zh || '')}</div></div>` : ''}
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
    ? `<div class="pill-list">${arr.map(x => `<span class="pill"><b>${esc(x[k1])}</b><span class="pill-zh">${esc(x[k2] || '')}</span></span>`).join('')}</div>` : '';

  const ctxPills = (d.context_words || []).length
    ? `<div class="pill-list">${d.context_words.map(x => `<span class="pill"><b>${esc(x.word)}</b><span class="pill-zh">${esc(x.meaning || '')}${x.note ? '｜' + esc(x.note) : ''}</span></span>`).join('')}</div>` : '';

  const confus = (d.confusing_words || []).length
    ? `<div class="pill-list">${d.confusing_words.map(x => `<span class="pill"><b>${esc(x.word)}</b><span class="pill-zh">${esc(x.meaning || '')}${x.difference ? '｜' + esc(x.difference) : ''}</span></span>`).join('')}</div>` : '';

  const examples = (d.examples || []).length
    ? d.examples.map(x => `<div class="example">${esc(x.en)}${spk(x.en)}<div class="ex-zh">${esc(x.zh || '')}</div></div>`).join('') : '';

  const phon = [d.phonetic_uk && `英 ${esc(d.phonetic_uk)}`, d.phonetic_us && `美 ${esc(d.phonetic_us)}`].filter(Boolean).join('　');

  const notesHtml = (d.notes && d.notes.trim())
    ? `<div class="entry-section"><div class="es-title">📝 我的筆記</div><div class="example" style="white-space:pre-wrap">${esc(d.notes)}</div></div>`
    : (editable ? `<div class="entry-section"><div class="es-title">📝 我的筆記</div><div class="seg-empty">（尚無筆記，可按上方「手動編輯」新增）</div></div>` : '');

  const toolbar = editable
    ? `<div class="editor-toolbar"><button class="btn small" data-edit-card>✏️ 手動編輯整張卡</button></div>`
    : '';

  container.innerHTML = `
    ${toolbar}
    <div class="entry-word">${esc(d.word)}${spkw(d.word)}</div>
    ${phon ? `<div class="entry-phon">${phon}</div>` : ''}
    ${sec('釋義', '📖', defs, 'base')}
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
    ${notesHtml}
  `;
}

// 從檢視切到完整編輯器
function openCardEditor() {
  if (!currentEntry) return;
  const { data, container } = currentEntry;
  container._onDone = () => renderPreview(data, container, {
    editable: true, word: data.word, raw: currentEntry.raw,
    onChange: currentEntry.onChange, card: currentEntry.card,
  });
  renderEditor(data, container, () => {
    if (currentEntry.onChange) currentEntry.onChange();     // 存 localStorage（已存卡會 saveCards）
    if (currentEntry.card) debouncedCloudSave(currentEntry.card);
  });
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

function renderEditor(data, container, onChange) {
  const arrGroup = (field) => {
    const cfg = ARRAY_FIELDS[field];
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
      <div class="ed-title">${cfg.title}</div>
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
  return STUDY_MODES.filter(m => m.has(card.data) && isDue(card.srs[m.id])).length;
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

function bindDeckControls() {
  $('#deckFolder').addEventListener('change', e => { deckFolder = e.target.value; renderDeck(); });
  $('#deckSort').addEventListener('change', e => { deckSort = e.target.value; renderDeck(); });
  $('#newFolderBtn').addEventListener('click', () => {
    const name = createFolder();
    if (name) { deckFolder = name; renderFolderSelects(); renderDeck(); }
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

/* ---------------------- 每日目標 / 簽到 ---------------------- */
function rolloverDaily() {
  if (daily.date !== todayStr()) { daily.date = todayStr(); daily.count = 0; saveDaily(); }
}
function updateDailyOnReview(mode) {
  if (!DAILY_MODES.includes(mode)) return;
  rolloverDaily();
  daily.count++;
  const goal = settings.dailyGoal || 0;
  if (goal > 0 && daily.count >= goal && daily.lastMetDate !== todayStr()) {
    daily.streak = (daily.lastMetDate === yesterdayStr()) ? (daily.streak + 1) : 1;
    daily.lastMetDate = todayStr();
    toast(`🎉 今日達標！連續簽到 ${daily.streak} 天`);
  }
  saveDaily();
  renderDailyPanel();
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
    <div class="dp-main">
      <div class="dp-title">📅 今日複習目標 ${met ? '<span class="dp-check">✅ 已簽到</span>' : ''}</div>
      <div class="daily-bar ${met ? 'done' : ''}"><i style="width:${pct}%"></i></div>
      <div class="dp-num">${count} / ${goal || '—'} 張（中英・克漏字）${met ? '' : goal ? `　還差 ${goal - count} 張` : ''}</div>
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

  // 統計
  let dueTotal = 0, newTotal = 0;
  cards.forEach(c => {
    STUDY_MODES.forEach(m => {
      if (!m.has(c.data)) return;
      const s = c.srs[m.id];
      if (isNew(s)) newTotal++;
      else if (isDue(s)) dueTotal++;
    });
  });
  $('#statTotal').textContent = cards.length;
  $('#statDue').textContent = dueTotal + newTotal;
  $('#statNew').textContent = newTotal;

  let filtered = cards.filter(c => {
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

  if (cards.length === 0) { list.innerHTML = ''; empty.style.display = 'block'; return; }
  empty.style.display = 'none';

  list.innerHTML = filtered.map(c => {
    const d = c.data;
    const mean = (d.definitions || []).map(x => (x.pos ? x.pos + ' ' : '') + x.meaning_zh).join('；');
    const phon = d.phonetic_us || d.phonetic_uk || '';
    const due = cardDueCount(c);
    const created = c.createdAt ? dateStr(new Date(c.createdAt)) : '';
    const tags = [];
    if (due > 0) tags.push(`<span class="wc-tag due">待複習 ${due}</span>`);
    if ((d.mnemonics || []).length) tags.push('<span class="wc-tag">💡助記</span>');
    if (created) tags.push(`<span class="wc-tag">🗓 ${created}</span>`);
    return `
      <div class="word-card" data-id="${c.id}">
        <button class="wc-del" title="刪除">✕</button>
        <div class="wc-word">${esc(d.word)}</div>
        ${phon ? `<div class="wc-phon">${esc(phon)}</div>` : ''}
        <div class="wc-mean">${esc(mean || '（無釋義）')}</div>
        ${tags.length ? `<div class="wc-tags">${tags.join('')}</div>` : ''}
        ${folderSelectHtml(c)}
      </div>`;
  }).join('');
}

function openCardDetail(id) {
  const c = cards.find(x => x.id === id);
  if (!c) return;
  // 借用新增頁的預覽區呈現詳情
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
    ? '（檢視模式）左側為已保存的歐路原文，可修改（自動存檔）；各段可單獨「重新生成」。'
    : '（檢視模式）這張卡沒有保存原文。可在左側貼上歐路內容（自動存檔）後再重新生成各段。';
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
  const prevSelected = grid.dataset.init ? getSelectedModes() : ['en2zh', 'zh2en'];
  grid.innerHTML = STUDY_MODES.map(m => {
    const dueCount = cards.filter(c => m.has(c.data) && (isDue(c.srs[m.id]))).length;
    const checked = prevSelected.includes(m.id) ? 'checked' : '';
    return `
      <label class="mode-item ${checked ? 'on' : ''}">
        <input type="checkbox" value="${m.id}" ${checked} />
        <div>
          <div class="mi-name">${m.name}</div>
          <div class="mi-desc">${m.desc}</div>
          <div class="mi-count">待複習 ${dueCount}</div>
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
      if (scope === 'due' && !isDue(c.srs[mid])) return;
      queue.push({ cardId: c.id, mode: mid });
    });
  });

  if (queue.length === 0) {
    $('#studySetupHint').textContent = scope === 'due'
      ? '目前沒有到期的卡片，選「全部卡片」或換個資料夾吧！'
      : '沒有可背誦的卡片，先去新增單字吧！';
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

  session = { queue, idx: 0, reviewed: 0, total: queue.length, results: [] };
  $('#studySetup').hidden = true;
  $('#studyDone').hidden = true;
  $('#studyCard').hidden = false;
  showCurrentCard();
}

function currentItem() { return session.queue[session.idx]; }

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
    speakWord(card.data.word); // 自動播放一次發音（若被瀏覽器擋下，可按「播放」）
  }
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
  const wordBlock = `<div class="fc-word">${esc(d.word)}${spkw(d.word)}</div>${phon ? `<div class="fc-phon">${esc(phon)}</div>` : ''}`;
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
    front = wordBlock + `<div class="fc-prompt">這個字的意思是？</div>`;
    back = `<div class="entry-section"><div class="es-title">📖 釋義</div>${defsFull}</div>`
      + mnemBlock(d);
  } else if (mode === 'zh2en') {
    const zh = (d.definitions || []).map(x => (x.pos ? x.pos + ' ' : '') + x.meaning_zh).join('；');
    front = `<div class="fc-zh-main">${esc(zh)}</div><div class="fc-prompt">對應的英文單字是？</div>`;
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
    front = `<div class="spell-top">🔊 聽發音，拼出單字 <button class="speak-btn" data-speak="${esc(d.word)}" data-word="1" type="button" title="再聽一次">🔁 播放</button></div>`
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
  back += notesBlock(d);
  return { front, back };
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
  panel._onDone = () => toggleStudyEditor();
  renderEditor(card.data, panel, () => {
    saveCards();
    debouncedCloudSave(card);
  });
  panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function bindStudyControls() {
  $('#showAnswerBtn').addEventListener('click', revealAnswer);
  $('#endStudyBtn').addEventListener('click', endStudy);
  $('#editCardBtn').addEventListener('click', toggleStudyEditor);
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
  }
  saveCards();
  cloudUpsert(card);

  // 記錄本輪結果（重來/困難視為不熟）
  session.results.push({ cardId: item.cardId, mode: item.mode, rate, word: card.data.word });
  updateDailyOnReview(item.mode);

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
    keyIndex = 0;
    saveSettings();
    renderDailyPanel();
    $('#settingsStatus').textContent = `✅ 已儲存（${settings.apiKeys.length} 組金鑰）`;
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

/* ---------------------- 啟動 ---------------------- */
document.addEventListener('DOMContentLoaded', init);
