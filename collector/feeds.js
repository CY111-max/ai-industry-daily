'use strict';
/**
 * 资讯源清单与解析适配器。
 *
 * 源类型：
 *   - rss       官方 RSS/Atom feed（稳定，优先）
 *   - html-list 服务端渲染的列表页（垂直站点爬虫，正文/日期可能需再进详情页）
 *
 * 说明：机器之心 / 虎嗅 / 36氪 均为 JS 壳且公共 RSSHub 实例不可达，本期不做。
 * 若日后自建 RSSHub，可在 SOURCES 里加 rss 源，路由分别为 /jiqizhixin、/huxiu/article、/36kr。
 */

/** 每个源最多取多少条（防止个别源刷屏）。 */
const MAX_PER_SOURCE = 40;

/** 仅保留标题命中其一才收录（相关性过滤，避免娱乐/消费新闻灌水）。 */
const INCLUDE_TERMS = [
  '人工智能', 'AI', '大模型', '智能体', 'AIGC', '机器学习', '深度学习', '神经网络',
  '具身智能', '具身', '人形机器人', '机器人', '机器视觉', '视觉系统', '工业机器人',
  '数字孪生', '工业互联网', '智能制造', '智能工厂', '无人工厂', '工业软件', '工业大模型',
  '算力', '芯片', '半导体', 'GPU', '数据中心', '边缘计算', '云计算', '物联网', '传感器',
  '自动驾驶', '智能驾驶', '制造业', '工业', '产线', '生产线', '工厂', '机床', '数控',
  '数字化', '数智化', '算法', '模型', '融资', '政策', '补贴', '标准', '安全',
];

/** 命中其一即剔除（消费/娱乐噪音，避免"智能"这类宽词误收）。 */
const EXCLUDE_TERMS = [
  '手机', '手表', '手环', '耳机', '音箱', '电视', '笔记本', '平板', '家电', '空调', '冰箱',
  '游戏', '电影', '电视剧', '综艺', '明星', '演唱会', '球员', '赛事', '彩票', '生肖',
  '美食', '旅游攻略', '护肤', '减肥', '房价', '菜价',
];

const SOURCES = [
  { id: 'qbitai', name: '量子位', type: 'rss', url: 'https://www.qbitai.com/feed', encoding: 'utf-8' },
  { id: 'leiphone', name: '雷峰网', type: 'rss', url: 'https://www.leiphone.com/feed', encoding: 'utf-8' },
  { id: 'geekpark', name: '极客公园', type: 'rss', url: 'https://www.geekpark.net/rss', encoding: 'utf-8' },
  { id: 'ifanr', name: '爱范儿', type: 'rss', url: 'https://www.ifanr.com/feed', encoding: 'utf-8' },
  { id: 'ithome', name: 'IT之家', type: 'rss', url: 'https://www.ithome.com/rss/', encoding: 'utf-8' },
  // 列表项形如：<li><b>1</b><a href=".../news/detail/195389.html" title="标题">标题</a><span>09-08</span></li>
  // 列表只有标题+日期（MM-DD），正文与精确时间需进详情页 → needDetail + 较高的补抓上限
  { id: 'gkzhan', name: '智能制造网', type: 'html-list', url: 'https://www.gkzhan.com/news/', encoding: 'utf-8', needDetail: true, maxDetail: 30 },
  // 分类页的条目块: <h3><a href=".../ART-....html">标题</a></h3><p><span>导语</span></p><span class="date">… 2026-09-10 14:52</span>
  // 标题/导语/时间在列表页齐全，无需进详情页（人形机器人 + 工业机器人两个分类）
  {
    id: 'ofweek',
    name: 'OFweek机器人',
    type: 'html-list',
    parser: 'ofweek-cat',
    urls: [
      'https://robot.ofweek.com/CAT-898890-humanoidRobot.html',
      'https://robot.ofweek.com/CAT-8321202-GYJQR.html',
    ],
    encoding: 'gbk',
    needDetail: false,
  },
];

/** 判断标题是否与「AI × 智能制造」相关。 */
function isRelevant(title) {
  const t = String(title || '');
  if (!t) return false;
  if (EXCLUDE_TERMS.some((w) => t.includes(w))) return false;
  const lower = t.toLowerCase();
  return INCLUDE_TERMS.some((w) => lower.includes(w.toLowerCase()));
}

/** 取出 <tag>…</tag> 内容（支持 CDATA）。 */
function pickTag(block, tag) {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i');
  const m = re.exec(block);
  if (!m) return '';
  return m[1].replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, '$1').trim();
}

function decodeLite(s) {
  return String(s)
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 解析 RSS 2.0 / Atom feed → 标准化条目。 */
function parseFeed(xml, source) {
  const isAtom = /<entry[\s>]/i.test(xml);
  const blocks = isAtom
    ? [...xml.matchAll(/<entry(?:\s[^>]*)?>([\s\S]*?)<\/entry>/gi)].map((m) => m[1])
    : [...xml.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi)].map((m) => m[1]);

  const items = [];
  for (const b of blocks) {
    const title = pickTag(b, 'title');
    let link = pickTag(b, 'link');
    if (!link) {
      const lm = /<link[^>]+href="([^"]+)"/i.exec(b); // Atom
      if (lm) link = lm[1];
    }
    const dateRaw =
      pickTag(b, 'pubDate') || pickTag(b, 'published') || pickTag(b, 'updated') || pickTag(b, 'dc:date');
    const rawText =
      pickTag(b, 'content:encoded') || pickTag(b, 'description') || pickTag(b, 'summary') || pickTag(b, 'content');
    if (!title || !link) continue;

    const d = dateRaw ? new Date(dateRaw) : null;
    items.push({
      title: decodeLite(title),
      url: link.trim(),
      time: d && !isNaN(d.getTime()) ? d.toISOString() : null,
      rawText,
      source: source.name,
      sourceId: source.id,
    });
    if (items.length >= MAX_PER_SOURCE) break;
  }
  return items;
}

/**
 * 解析服务端渲染的列表页。日期能直接从列表拿到的先填上，
 * 拿不到的（OFweek）与正文一并留给 run.js 进详情页补抓。
 */
function parseList(html, source, now = new Date()) {
  const items = [];
  const seen = new Set();
  const push = (o) => {
    if (!o.url || !o.title || seen.has(o.url)) return;
    seen.add(o.url);
    items.push({ rawText: '', ...o, source: source.name, sourceId: source.id, needDetail: !!source.needDetail });
  };

  if (source.id === 'gkzhan') {
    const re =
      /<a\s+href="(https:\/\/www\.gkzhan\.com\/news\/detail\/\d+\.html)"\s+title="([^"]+)"[^>]*>[^<]*<\/a>(?:<span>(\d{2})-(\d{2})<\/span>)?/g;
    let m;
    while ((m = re.exec(html)) !== null && items.length < MAX_PER_SOURCE) {
      const url = m[1];
      const title = decodeLite(m[2]);
      const mo = m[3] ? Number(m[3]) : null;
      const dd = m[4] ? Number(m[4]) : null;
      let time = null;
      if (mo && dd) {
        const year = now.getFullYear();
        let d = new Date(year, mo - 1, dd, 12, 0, 0);
        if (d - now > 30 * 86400000) d = new Date(year - 1, mo - 1, dd, 12, 0, 0); // 跨年
        time = d.toISOString();
      }
      push({ title, url, time });
    }
    return items;
  }

  if (source.id === 'ofweek') {
    const blocks = html.split('<div class="list_model">').slice(1);
    for (const b of blocks) {
      if (items.length >= MAX_PER_SOURCE) break;
      const a = /<h3>\s*<a\s+href="(https:\/\/robot\.ofweek\.com\/20\d\d-\d\d\/ART-[^"]+\.html)"[^>]*>([\s\S]*?)<\/a>/i.exec(b);
      if (!a) continue;
      const url = a[1];
      const title = decodeLite(a[2].replace(/<[^>]+>/g, ''));
      const p = /<p>\s*<span>([\s\S]*?)<\/span>/i.exec(b);
      const text = p ? decodeLite(p[1].replace(/<[^>]+>/g, '')) : '';
      const dm = /(\d{4})-(\d{2})-(\d{2})(?:\s+(\d{2}):(\d{2}))?/.exec(b);
      let time = null;
      if (dm) {
        const d = new Date(
          Number(dm[1]), Number(dm[2]) - 1, Number(dm[3]),
          Number(dm[4] || 0), Number(dm[5] || 0)
        );
        if (!isNaN(d.getTime())) time = d.toISOString();
      }
      push({ title, url, time, text });
    }
    return items;
  }

  return items;
}

module.exports = {
  SOURCES,
  MAX_PER_SOURCE,
  INCLUDE_TERMS,
  EXCLUDE_TERMS,
  isRelevant,
  parseFeed,
  parseList,
};
