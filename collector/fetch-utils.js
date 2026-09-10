'use strict';
/**
 * 抓取与解析工具（无第三方依赖，仅 Node 内置能力 + 全局 fetch）。
 */
const { TextDecoder } = require('node:util');

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 抓取原始字节，带超时与重试。返回 { buffer, contentType, finalUrl }。 */
async function fetchRaw(url, opts = {}) {
  const { timeout = 15000, retries = 2, headers = {} } = opts;
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeout);
    try {
      const res = await fetch(url, {
        redirect: 'follow',
        signal: ac.signal,
        headers: { 'User-Agent': DEFAULT_UA, Accept: '*/*', ...headers },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buffer = Buffer.from(await res.arrayBuffer());
      return {
        buffer,
        contentType: res.headers.get('content-type') || '',
        finalUrl: res.url || url,
      };
    } catch (err) {
      lastErr = err;
      if (attempt < retries) await sleep(500 * (attempt + 1));
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`fetch failed: ${url} (${lastErr && lastErr.message})`);
}

/** 依据 content-type 或 HTML <meta> 判断字符集，统一映射到 TextDecoder 支持的名字。 */
function detectCharset(contentType, buffer) {
  let cs = '';
  const m = /charset=["']?([\w-]+)/i.exec(contentType || '');
  if (m) cs = m[1];
  if (!cs) {
    const head = buffer.slice(0, 4096).toString('latin1');
    const m2 =
      /<meta[^>]+charset=["']?([\w-]+)/i.exec(head) ||
      /<meta[^>]+content=["'][^"']*charset=([\w-]+)/i.exec(head);
    if (m2) cs = m2[1];
  }
  cs = (cs || 'utf-8').toLowerCase();
  if (cs === 'gb2312' || cs === 'gbk' || cs === 'gb18030') return 'gb18030';
  if (cs === 'utf8') return 'utf-8';
  return cs;
}

/** 解码字节为字符串（缺省按 charset 判断）。 */
function decodeBuffer(buffer, contentType, forced) {
  if (forced) return new TextDecoder(forced).decode(buffer);
  return new TextDecoder(detectCharset(contentType, buffer)).decode(buffer);
}

/** 抓取文本（自动处理 GBK 等编码）。 */
async function fetchText(url, opts = {}) {
  const { buffer, contentType, finalUrl } = await fetchRaw(url, opts);
  return { text: decodeBuffer(buffer, contentType, opts.encoding), contentType, finalUrl };
}

/** 去标签 + 实体解码 + 空白归一。 */
function stripTags(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, '');
}

function decodeEntities(s) {
  return String(s)
    .replace(/&nbsp;/gi, ' ')
    .replace(/&ldquo;/gi, '“')
    .replace(/&rdquo;/gi, '”')
    .replace(/&hellip;/gi, '…')
    .replace(/&mdash;/gi, '—')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&#(\d{2,5});/g, (_, d) => {
      try {
        return String.fromCodePoint(Number(d));
      } catch {
        return ' ';
      }
    });
}

function htmlToText(html) {
  return decodeEntities(stripTags(html)).replace(/[ \t\r\f\v]+/g, ' ').replace(/\n{2,}/g, '\n').trim();
}

function collapse(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

const DATE_TIME_RE = /(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/;

/**
 * 从文章详情页提取「发布时间 + 正文摘要文本」。
 * 顺序：meta 描述 → 常见正文容器 → 最长的段落。
 * 返回 { date: Date|null, text: string }
 */
function extractArticle(html) {
  const raw = String(html);

  // 1) 发布时间：优先取带 class="time" 的元素（gkzhan/ofweek 均如此），否则取首个日期时间
  let date = null;
  const timeEl = /class=["'][^"']*\btime\b[^"']*["'][^>]*>([\s\S]{0,60}?)</i.exec(raw);
  const timeStr = (timeEl && timeEl[1]) || '';
  const candidates = [timeStr, raw.slice(0, 6000), raw];
  for (const c of candidates) {
    const m = DATE_TIME_RE.exec(c);
    if (m) {
      const d = new Date(
        Number(m[1]), Number(m[2]) - 1, Number(m[3]),
        Number(m[4] || 0), Number(m[5] || 0), Number(m[6] || 0)
      );
      if (!isNaN(d.getTime())) { date = d; break; }
    }
  }

  // 2) 摘要文本：meta 描述 → 正文容器 → 最长段落
  let text = '';
  const meta =
    /<meta[^>]+(?:name|property)=["'](?:description|og:description)["'][^>]+content=["']([^"']{20,})/i.exec(raw) ||
    /<meta[^>]+content=["']([^"']{20,})["'][^>]+(?:name|property)=["'](?:description|og:description)["']/i.exec(raw);
  if (meta) text = htmlToText(meta[1]);

  if (text.length < 60) {
    const containers = [
      /<div[^>]+class=["'][^"']*(?:artical-content|article-content|detail-content|news_content|artical|content)[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
    ];
    for (const re of containers) {
      const m = re.exec(raw);
      if (m) {
        const t = htmlToText(m[1]);
        if (t.length > text.length) text = t;
      }
    }
  }

  if (text.length < 60) {
    const ps = [...raw.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)]
      .map((m) => htmlToText(m[1]))
      .filter((t) => t.length > 40)
      .sort((a, b) => b.length - a.length);
    if (ps[0]) text = ps[0];
  }

  return { date, text: collapse(text).slice(0, 600) };
}

module.exports = {
  DEFAULT_UA,
  sleep,
  fetchRaw,
  fetchText,
  detectCharset,
  decodeBuffer,
  stripTags,
  decodeEntities,
  htmlToText,
  collapse,
  extractArticle,
};
