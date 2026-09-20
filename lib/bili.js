// B站 数据层：解析 UP主、拉视频列表、查字幕
// 认证由 lib/http.js 统一处理（credentials 模式），此处不再手写 Cookie 头。
import { httpJson } from './http.js';
import { signWbi } from './wbi.js';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// 通用 GET（wbi=true 时自动签名）
export async function biliGet(url, params, wbi = true) {
  let qs;
  if (wbi) {
    qs = await signWbi(params || {});
  } else {
    qs = new URLSearchParams(params || {}).toString();
  }
  const sep = url.includes('?') ? '&' : '?';
  return httpJson(url + sep + qs);
}

// 把用户输入（名称 / 主页链接 / UID）解析成 UID
export async function resolveMid(input) {
  const t = (input || '').trim();
  if (!t) throw new Error('输入为空');

  if (/^\d+$/.test(t)) return { mid: t, name: null };

  const m = t.match(/space\.bilibili\.com\/(\d+)/);
  if (m) return { mid: m[1], name: null };

  const name = t
    .replace(/^https?:\/\/(www\.)?bilibili\.com\//, '')
    .replace(/\/+$/, '')
    .trim();
  const json = await biliGet(
    'https://api.bilibili.com/x/web-interface/search/all/v2',
    { keyword: name },
    false
  );
  if (json.code !== 0) {
    throw new Error('搜索接口返回 ' + json.code + '，请改用「主页链接」或「UID」');
  }
  const groups = json?.data?.result || [];
  for (const g of groups) {
    if (g.result_type === 'bili_user' && Array.isArray(g.data) && g.data.length) {
      const u = g.data[0];
      if (u && u.mid) return { mid: String(u.mid), name: u.uname };
    }
  }
  for (const g of groups) {
    const u = (g.data || []).find((x) => x && x.mid);
    if (u) return { mid: String(u.mid), name: u.uname };
  }
  throw new Error('未找到该 UP主，请改用「主页链接」或「UID」');
}

// 拉取 UP主 全部投稿视频
export async function getVideoList(mid) {
  const videos = [];
  let pn = 1;
  const ps = 50;
  while (true) {
    const json = await biliGet('https://api.bilibili.com/x/space/wbi/arc/search', {
      mid,
      ps,
      pn,
      order: 'pubdate'
    });
    if (json.code !== 0) {
      throw new Error('获取视频列表失败：' + (json.message || json.code));
    }
    const vlist = json.data?.list?.vlist || [];
    for (const v of vlist) {
      videos.push({ bvid: v.bvid, title: v.title, aid: v.aid, pubdate: v.pubdate });
    }
    const page = json.data?.page || {};
    if (!vlist.length || videos.length >= (page.count || 0)) break;
    pn++;
    await sleep(300);
  }
  return videos;
}

// 取视频全部分P：优先用 view 接口拿权威 cid（含多P），失败再回退 pagelist
async function getPages(bvid) {
  try {
    const j = await biliGet('https://api.bilibili.com/x/web-interface/view', { bvid }, false);
    if (j?.code === 0 && Array.isArray(j.data?.pages) && j.data.pages.length) {
      return j.data.pages.map((p) => ({ cid: p.cid, part: p.part || null, index: p.page }));
    }
  } catch (e) {
    /* ignore */
  }
  try {
    const pl = await biliGet('https://api.bilibili.com/x/player/pagelist', { bvid }, false);
    if (Array.isArray(pl?.data)) {
      return pl.data.map((p, i) => ({ cid: p.cid, part: p.part || null, index: i + 1 }));
    }
  } catch (e) {
    /* ignore */
  }
  return [];
}

// 从 player 接口响应里提取字幕列表。
// 关键：现网接口字段名不稳定，有的返回 subtitle.list，有的返回 subtitle.subtitles，
// 两个都读并合并，否则会系统性漏检（"明明有字幕却识别不到"的主因之一）。
function extractSubs(json) {
  const sub = json?.data?.subtitle;
  if (!sub) return [];
  const arr = [
    ...(Array.isArray(sub.list) ? sub.list : []),
    ...(Array.isArray(sub.subtitles) ? sub.subtitles : [])
  ];
  return arr
    .filter((s) => s && s.subtitle_url)
    .map((s) => ({
      lan: s.lan,
      lanDoc: s.lan_doc || s.lanDoc || s.lan,
      url: s.subtitle_url.startsWith('//') ? 'https:' + s.subtitle_url : s.subtitle_url
    }));
}

// 语言分组：B站 字幕 lan 常见值 ai-zh / zh-CN / zh-Hans / en-US / en / ja / ko ...
// 归成三类供 UI 勾选：zh（中文含AI）、en（英文）、other（其他语种）
export function langGroup(lan) {
  const l = String(lan || '').toLowerCase();
  if (l === 'ai-zh' || l.startsWith('zh')) return 'zh';
  if (l.startsWith('en')) return 'en';
  return 'other';
}

// 按勾选的语种组过滤字幕列表；langs 为空/非法时默认只要中文
export function filterSubsByLangs(subs, langs) {
  const set = new Set(
    Array.isArray(langs) && langs.length ? langs.filter((g) => ['zh', 'en', 'other'].includes(g)) : ['zh']
  );
  return (subs || []).filter((s) => set.has(langGroup(s.lan)));
}

// 取单个视频某 cid 的字幕列表（未登录时列表为空——B站字幕已强制登录）
async function fetchSubtitlesFor(bvid, cid) {
  const params = { bvid };
  if (cid) params.cid = cid;
  try {
    const json = await biliGet('https://api.bilibili.com/x/player/wbi/v2', params);
    if (json.code !== 0) return [];
    return extractSubs(json);
  } catch (e) {
    return [];
  }
}

// 取视频全部分P的字幕（多P视频每个分P单独查）
export async function getVideoSubtitles(bvid) {
  const pages = await getPages(bvid);
  if (!pages.length) {
    const subs = await fetchSubtitlesFor(bvid, null);
    return [{ index: 1, part: null, cid: null, subtitles: subs }];
  }
  const out = [];
  for (const p of pages) {
    const subs = await fetchSubtitlesFor(bvid, p.cid);
    out.push({ index: p.index, part: p.part, cid: p.cid, subtitles: subs });
  }
  return out;
}

// 下载字幕 JSON 原文
export async function downloadSubtitleJson(url) {
  return httpJson(url);
}
