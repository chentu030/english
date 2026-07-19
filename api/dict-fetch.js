// Vercel Serverless：代抓線上詞典頁面文字，供「未貼歐路內容」時當 AI 補充素材。
// GET /api/dict-fetch?word=framework

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

function slugWord(word) {
  return String(word || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9'\-]/gi, '');
}

function decodeEntities(s) {
  return String(s || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

function htmlToText(html) {
  let t = String(html || '');
  t = t.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  t = t.replace(/<style[\s\S]*?<\/style>/gi, ' ');
  t = t.replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ');
  t = t.replace(/<!--[\s\S]*?-->/g, ' ');
  t = t.replace(/<[^>]+>/g, ' ');
  t = decodeEntities(t);
  t = t.replace(/\s+/g, ' ').trim();
  return t;
}

function extractChunks(html, patterns) {
  const out = [];
  for (const re of patterns) {
    const flags = re.flags.includes('g') ? re.flags : re.flags + 'g';
    const r = new RegExp(re.source, flags);
    let m;
    while ((m = r.exec(html))) {
      const chunk = htmlToText(m[1] || m[0]);
      if (chunk.length > 40) out.push(chunk);
      if (out.length >= 12) break;
    }
    if (out.length >= 8) break;
  }
  return out.join('\n');
}

function cleanSourceText(name, text, maxLen) {
  let t = String(text || '').trim();
  if (!t) return '';
  // 去掉常見導覽／腳本噪音
  t = t
    .replace(/\{\{[^}]{0,80}\}\}/g, ' ')
    .replace(/\b(AMP\.setState|searchAutoComplete|changeToLayoutContainer)[^ ]{0,120}/gi, ' ')
    .replace(/\b(Log in|Sign up|Cookie|Subscribe|Advertisement|My profile|AI Assistant|Thesaurus \+Plus|Cambridge Dictionary \+Plus)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (t.length < 60) return '';
  if (t.length > maxLen) t = t.slice(0, maxLen) + '…';
  return `【${name}】\n${t}`;
}

function focusAfterWord(text, word) {
  const t = String(text || '');
  const w = String(word || '').toLowerCase();
  if (!w) return t;
  const i = t.toLowerCase().indexOf(w);
  return i >= 0 ? t.slice(i) : t;
}

function stripMdLinks(s) {
  return String(s || '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
}

function collinsLooksReal(text, slug) {
  const t = String(text || '').toLowerCase();
  const w = String(slug || '').toLowerCase();
  if (t.length < 80) return false;
  const junk = ['opt-out request', 'manage your privacy', 'do not share or sell', 'agree and close'];
  const junkHits = junk.filter((j) => t.includes(j)).length;
  const hasForms = t.includes('word forms');
  const hasCobuild = new RegExp(`\\ba ${w} is\\b|\\ban ${w} is\\b`, 'i').test(t);
  if (junkHits && !hasForms && !hasCobuild) return false;
  if (/\b1\.\s*(countable|uncountable|verb|noun|adjective|adverb|phrase)/i.test(t)) return true;
  const signals = [
    'word forms', 'countable noun', 'uncountable noun', 'transitive verb',
    'in british english', 'in american english', 'synonyms:',
    `a ${w} is`, `an ${w} is`, 'cobuild',
  ];
  return signals.filter((s) => t.includes(s)).length >= 1;
}

function extractCollinsBody(raw, slug) {
  const s = String(slug || '').toLowerCase();
  const html = String(raw || '');
  if (html.slice(0, 800).includes('<') || /dictentry|class=["']def["']/i.test(html)) {
    const chunks = [];
    const patterns = [
      /<div[^>]*class="[^"]*content\s+definitions[^"]*"[^>]*>([\s\S]*?)<\/div>/gi,
      /<div[^>]*class="[^"]*dictentry[^"]*"[^>]*>([\s\S]*?)(?=<div[^>]*class="[^"]*dictentry|$)/gi,
      /<span[^>]*class="[^"]*\bdef\b[^"]*"[^>]*>([\s\S]*?)<\/span>/gi,
    ];
    for (const re of patterns) {
      let m;
      const r = new RegExp(re.source, re.flags);
      while ((m = r.exec(html))) {
        const chunk = htmlToText(m[1]);
        if (chunk.length > 40) chunks.push(chunk);
      }
      if (chunks.length >= 3) break;
    }
    if (chunks.length) {
      const body = chunks.join('\n');
      if (collinsLooksReal(body, s)) return body;
    }
  }

  let t = stripMdLinks(html);
  t = t.replace(
    /Opt-Out Request Honored[\s\S]*?(?=Word forms|##\s*\w|\b1\.\s*(?:countable|uncountable)|in British English|in American English)/i,
    ' ',
  );
  const anchors = [
    /Word forms\s*:/i,
    new RegExp(`##\\s*${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i'),
    /in British English/i,
    /in American English/i,
    /\b1\.\s*(?:countable|uncountable|verb|adjective|adverb|noun|phrase)/i,
    new RegExp(`\\bA ${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} is\\b`, 'i'),
    new RegExp(`\\bAn ${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} is\\b`, 'i'),
  ];
  let best = t;
  for (const a of anchors) {
    const m = t.match(a);
    if (m && m.index != null) {
      best = t.slice(m.index);
      break;
    }
  }
  best = best.split(/\n(?:Browse alphabetically|Trends of |Source:\s*Collins|Get the latest|You may also like)/i)[0];
  best = best.replace(/\s+/g, ' ').trim();
  return collinsLooksReal(best, s) ? best : '';
}

function sourcesFor(word) {
  const s = slugWord(word);
  const q = encodeURIComponent(s);
  return [
    {
      id: 'cambridge',
      name: '劍橋 Cambridge',
      urls: [
        `https://dictionary.cambridge.org/dictionary/english-chinese-traditional/${q}`,
        `https://dictionary.cambridge.org/dictionary/english/${q}`,
      ],
      extract: (html) => {
        const blocks = extractChunks(html, [
          /<div[^>]*class="[^"]*def-block[^"]*"[^>]*>([\s\S]*?)<\/div>/gi,
          /<div[^>]*class="[^"]*pr entry-body__el[^"]*"[^>]*>([\s\S]*?)<\/div>/gi,
        ]);
        return focusAfterWord(blocks || htmlToText(html), s);
      },
    },
    {
      id: 'collins',
      name: '柯林斯 Collins',
      preferJina: true,
      jinaSelectors: ['.content.definitions', '.dictentry', 'main', 'article'],
      urls: [
        `https://www.collinsdictionary.com/dictionary/english/${q}`,
        `https://www.collinsdictionary.com/dictionary/english-chinese/${q}`,
      ],
      extract: (raw) => extractCollinsBody(raw, s),
      maxLen: 4500,
      validate: (body) => collinsLooksReal(body, s),
    },
    {
      id: 'ldoce',
      name: '朗文 LDOCE',
      urls: [`https://www.ldoceonline.com/dictionary/${q}`],
      extract: (html) =>
        focusAfterWord(
          extractChunks(html, [
            /<span[^>]*class="[^"]*ldoceEntry[^"]*"[^>]*>([\s\S]*?)<\/span>/gi,
            /<span[^>]*class="DEF"[^>]*>([\s\S]*?)<\/span>/gi,
            /<span[^>]*class="[^"]*EXAMPLE[^"]*"[^>]*>([\s\S]*?)<\/span>/gi,
          ]) || htmlToText(html),
          s,
        ),
    },
    {
      id: 'eudic',
      name: '歐路 Eudic',
      urls: [`https://dict.eudic.net/dicts/en/${q}`],
      extract: (html) =>
        focusAfterWord(
          extractChunks(html, [
            /<div[^>]*class="[^"]*explain_wrap[^"]*"[^>]*>([\s\S]*?)<\/div>/gi,
            /<div[^>]*id="ExpFC_[^"]*"[^>]*>([\s\S]*?)<\/div>/gi,
            /<div[^>]*class="[^"]*expDiv[^"]*"[^>]*>([\s\S]*?)<\/div>/gi,
          ]) || htmlToText(html),
          s,
        ),
    },
    {
      id: 'etymonline',
      name: 'Etymonline 詞源',
      urls: [
        `https://www.etymonline.com/word/${q}`,
        `https://www.etymonline.com/tw/word/${q}`,
      ],
      extract: (html) => {
        const og = html.match(/property="og:description"\s+content="([^"]+)"/i);
        if (og && og[1]) return decodeEntities(og[1]);
        return focusAfterWord(
          extractChunks(html, [
            /<section[^>]*class="[^"]*word__defination[^"]*"[^>]*>([\s\S]*?)<\/section>/gi,
            /<div[^>]*class="[^"]*word__defination[^"]*"[^>]*>([\s\S]*?)<\/div>/gi,
          ]) || htmlToText(html),
          s,
        );
      },
    },
  ];
}

function isCfChallenge(html, status = 200) {
  const t = String(html || '');
  const head = t.slice(0, 4000);
  if ([403, 503].includes(status) && /cloudflare|cf-|Just a moment/i.test(t)) return true;
  if (/Just a moment|cf-browser-verification|challenge-platform|Performing security verification|cdn-cgi\/challenge|Attention Required! \| Cloudflare/i.test(t)) {
    if (t.length < 25000 || /Just a moment/i.test(head)) return true;
  }
  return false;
}

async function fetchUrl(url, ms = 10000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': UA,
        Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.8',
        'Sec-Ch-Ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Upgrade-Insecure-Requests': '1',
      },
    });
    const html = await res.text();
    if (isCfChallenge(html, res.status)) throw new Error(`Cloudflare challenge (${res.status})`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return html;
  } finally {
    clearTimeout(t);
  }
}

async function fetchViaJina(url, ms = 20000, targetSelector) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const headers = { Accept: 'text/plain', 'User-Agent': UA, 'X-Retain-Images': 'none' };
    if (targetSelector) headers['X-Target-Selector'] = targetSelector;
    const res = await fetch('https://r.jina.ai/' + url, {
      signal: ctrl.signal,
      headers,
    });
    if (!res.ok) throw new Error(`Jina ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

async function fetchOneSource(src) {
  let lastErr = '';

  const finalize = (raw, url, via) => {
    const body = src.extract ? src.extract(raw) : '';
    if (src.validate && !src.validate(body)) throw new Error('content failed validation');
    const text = cleanSourceText(src.name, body, src.maxLen || 3800);
    if (!text) throw new Error('empty after clean');
    return { id: src.id, name: src.name, url, text, via };
  };

  // 柯林斯：先走 Jina + CSS，避開 CF 與導覽噪音
  if (src.preferJina || (src.jinaSelectors && src.jinaSelectors.length)) {
    for (const url of src.urls) {
      for (const sel of src.jinaSelectors || [undefined]) {
        try {
          const md = await fetchViaJina(url, 20000, sel);
          return finalize(md, url, sel ? `jina:${sel}` : 'jina');
        } catch (e) {
          lastErr = e.message || String(e);
        }
      }
    }
  }

  for (const url of src.urls) {
    try {
      const html = await fetchUrl(url);
      return finalize(html, url, 'direct');
    } catch (e) {
      lastErr = e.message || String(e);
    }
  }
  // Cloudflare／封鎖時改走 Jina 可讀內容
  for (const url of src.urls) {
    try {
      const md = await fetchViaJina(url);
      return finalize(md, url, 'jina');
    } catch (e) {
      lastErr = e.message || String(e);
    }
  }
  return { id: src.id, name: src.name, error: lastErr || 'failed' };
}

async function fetchFreeDictSource(word) {
  try {
    const res = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`, {
      headers: { Accept: 'application/json', 'User-Agent': UA },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const lines = [];
    for (const en of data || []) {
      if (en.phonetic) lines.push(`音標 ${en.phonetic}`);
      for (const m of en.meanings || []) {
        lines.push(`詞性 ${m.partOfSpeech || ''}`);
        for (const d of (m.definitions || []).slice(0, 5)) {
          lines.push(`- ${d.definition || ''}`);
          if (d.example) lines.push(`  例：${d.example}`);
        }
      }
    }
    const text = cleanSourceText('Free Dictionary（英英後備）', lines.join('\n'), 3500);
    if (!text) return { id: 'freedict', name: 'Free Dictionary', error: 'empty' };
    return { id: 'freedict', name: 'Free Dictionary', text, via: 'api', url: 'https://api.dictionaryapi.dev' };
  } catch (e) {
    return { id: 'freedict', name: 'Free Dictionary', error: e.message || String(e) };
  }
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const word = String(req.query?.word || '').trim();
  const slug = slugWord(word);
  if (!slug || slug.length < 1) {
    return res.status(400).json({ error: '請提供 word 參數' });
  }

  try {
    const sources = sourcesFor(slug);
    const results = await Promise.all([...sources.map(fetchOneSource), fetchFreeDictSource(slug)]);
    const order = ['cambridge', 'collins', 'ldoce', 'eudic', 'etymonline', 'freedict'];
    const byId = Object.fromEntries(results.filter((r) => r.text).map((r) => [r.id, r]));
    const parts = [];
    for (const id of order) {
      if (byId[id]) parts.push(byId[id].text);
    }
    for (const r of results) {
      if (r.text && !order.includes(r.id)) parts.push(r.text);
    }
    const text = parts.join('\n\n').slice(0, 16000);
    res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=86400');
    return res.status(200).json({
      word: slug,
      text,
      sources: results.map((r) => ({
        id: r.id,
        name: r.name,
        ok: !!r.text,
        via: r.via || null,
        url: r.url || null,
        error: r.error || null,
        chars: r.text ? r.text.length : 0,
      })),
    });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'dict-fetch failed' });
  }
};
