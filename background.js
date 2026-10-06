// 后台任务执行器：所有抓取/检测/下载都在这里跑，不随弹窗关闭而中断。
// 状态写入 chrome.storage.session，弹窗随时打开都能续看进度。

import {
  resolveMid,
  getVideoList,
  getVideoSubtitles,
  downloadSubtitleJson,
  filterSubsByLangs
} from './lib/bili.js';
import { renderSubtitle } from './lib/srt.js';
import { createZip } from './lib/zip.js';
import { prepareAuth } from './lib/auth.js';

const JOB_KEY = 'job';
const ACTIVE = ['auth', 'resolving', 'listing', 'detecting', 'downloading', 'packing'];

function idleJob() {
  return {
    phase: 'idle',
    message: '',
    videos: [],
    selected: [],
    progress: { done: 0, total: 0 },
    error: '',
    uname: '',
    isLogin: false,
    fileCount: 0,
    langs: ['zh'],
    format: 'txt',
    upName: '',
    upInput: ''
  };
}

// 本地日期 YYYY-MM-DD（按用户时区）
function todayStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const LANG_NAMES = { zh: '中文（含AI）', en: '英文', other: '其他语种' };
function normalizeLangs(langs) {
  const set = new Set(
    (Array.isArray(langs) ? langs : []).filter((g) => ['zh', 'en', 'other'].includes(g))
  );
  return set.size ? [...set] : ['zh'];
}

let job = idleJob();
let ports = new Set();
let keepAliveTimer = null;

// ---------- 基础设施 ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sanitizeName(s) {
  return (
    (s || '')
      .replace(/[\\/:*?"<>|\r\n]+/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 70) || 'untitled'
  );
}

function bytesToBase64(bytes) {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

function setBadge(text, color) {
  try {
    chrome.action.setBadgeText({ text: text || '' });
    if (color) chrome.action.setBadgeBackgroundColor({ color });
  } catch (e) {
    /* ignore */
  }
}

// 保活：长循环期间定期调用扩展 API，重置 SW 的 30s 空闲计时器
function startKeepAlive() {
  if (keepAliveTimer) return;
  keepAliveTimer = setInterval(() => {
    chrome.runtime.getPlatformInfo(() => {});
  }, 20000);
}
function stopKeepAlive() {
  if (keepAliveTimer) {
    clearInterval(keepAliveTimer);
    keepAliveTimer = null;
  }
}

async function persist() {
  try {
    await chrome.storage.session.set({ [JOB_KEY]: job });
  } catch (e) {
    /* ignore */
  }
  broadcast();
}
function broadcast() {
  for (const p of ports) {
    try {
      p.postMessage({ type: 'job', job });
    } catch (e) {
      /* ignore */
    }
  }
}

function isActive() {
  return ACTIVE.includes(job.phase);
}

// ---------- 任务执行 ----------
async function startFetch(input, langs) {
  if (isActive()) return;
  startKeepAlive();
  try {
    const langList = normalizeLangs(langs);
    job = { ...idleJob(), phase: 'auth', message: '正在校验登录…', langs: langList };
    await persist();

    const auth = await prepareAuth();
    if (!auth.ok && auth.reason === 'format') {
      throw new Error('Cookie 格式不对，应形如 SESSDATA=xxx; bili_jct=yyy');
    }
    job.isLogin = auth.isLogin;
    job.uname = auth.uname || '';

    job.phase = 'resolving';
    job.message = auth.isLogin
      ? `已登录：${auth.uname || '（已登录）'}，正在解析 UP主…`
      : '未登录（Cookie 可能无效），仍尝试解析…';
    await persist();

    const { mid, name } = await resolveMid(input);
    job.upName = name || input;
    job.upInput = input;

    job.phase = 'listing';
    job.message = `已找到 UID ${mid}${name ? `（${name}）` : ''}，正在拉取视频列表…`;
    await persist();

    const videos = await getVideoList(mid);
    if (!videos.length) throw new Error('该 UP主 没有公开视频，或账号需要登录后可见');

    job.videos = videos.map((v) => ({ bvid: v.bvid, title: v.title, hasSub: false, done: false }));
    job.selected = [];
    job.progress = { done: 0, total: videos.length };
    job.phase = 'detecting';
    job.message = `共 ${videos.length} 个视频，正在检测字幕（语言筛选：${langList
      .map((g) => LANG_NAMES[g])
      .join('、')}）…`;
    await persist();
    setBadge(`0/${videos.length}`, '#fb7299');

    await detectAll();

    const withSub = job.videos.filter((v) => v.hasSub).length;
    job.phase = 'ready';
    if (withSub === 0) {
      if (!job.isLogin) {
        job.message = `检测完成：0/${job.videos.length} 含字幕。⚠️ 当前未登录，B站 字幕（含 AI 字幕）必须登录才显示——请在「设置 Cookie」里粘贴登录后的 Cookie（含 SESSDATA），或在本浏览器登录 bilibili.com 后重新检测。`;
      } else {
        job.message = `检测完成：0/${job.videos.length} 含字幕。已登录，但这些视频确实没有字幕轨道（B站 没有上传/生成字幕）。`;
      }
    } else {
      job.message = `检测完成：${withSub}/${job.videos.length} 个含所选语言（${job.langs
        .map((g) => LANG_NAMES[g])
        .join('、')}）的字幕。勾选后下载。`;
    }
    setBadge(String(withSub), '#00a854');
    await persist();
  } catch (e) {
    finishError(e);
  } finally {
    stopKeepAlive();
  }
}

async function detectAll() {
  const total = job.videos.length;
  let idx = 0;
  let done = 0;
  const pool = 6;
  async function worker() {
    while (idx < total) {
      const i = idx++;
      try {
        const subs = await getVideoSubtitles(job.videos[i].bvid);
        const kept = subs.reduce(
          (a, s) => a + filterSubsByLangs(s.subtitles, job.langs).length,
          0
        );
        job.videos[i].hasSub = kept > 0;
      } catch (e) {
        job.videos[i].hasSub = false;
      }
      job.videos[i].done = true;
      done++;
      job.progress = { done, total };
      setBadge(`${done}/${total}`, '#fb7299');
      await persist();
      await sleep(120);
    }
  }
  const workers = [];
  for (let k = 0; k < Math.min(pool, total); k++) workers.push(worker());
  await Promise.all(workers);
}

async function startDownload() {
  if (isActive()) return;
  const selected = job.videos.filter((v) => v.hasSub && job.selected.includes(v.bvid));
  if (!selected.length) {
    job.message = '请先勾选含字幕的视频';
    await persist();
    return;
  }
  startKeepAlive();
  try {
    job.phase = 'downloading';
    job.progress = { done: 0, total: selected.length };
    await persist();

    const files = [];
    let n = 0;
    const pad = (x) => String(x).padStart(3, '0');

    for (const v of selected) {
      job.message = `下载字幕 ${n}/${selected.length}：${v.title}`;
      await persist();
      let subs;
      try {
        subs = await getVideoSubtitles(v.bvid);
      } catch (e) {
        subs = [];
      }
      for (const part of subs) {
        for (const s of filterSubsByLangs(part.subtitles, job.langs)) {
          try {
            const text = renderSubtitle(await downloadSubtitleJson(s.url), job.format);
            const ext = job.format === 'srt' ? 'srt' : 'txt';
            const partLabel =
              subs.length > 1 && part.part ? ` - P${part.index}_${sanitizeName(part.part)}` : '';
            files.push({
              name: `${pad(++n)}_${sanitizeName(v.title)}${partLabel} [${sanitizeName(s.lanDoc)}].${ext}`,
              data: text
            });
          } catch (e) {
            /* 单条失败不影响整体 */
          }
          await sleep(60);
        }
      }
      job.progress = { done: job.progress.done + 1, total: selected.length };
      setBadge(`${job.progress.done}/${selected.length}`, '#fb7299');
      await persist();
    }

    if (!files.length) throw new Error('没有成功下载到任何字幕（可能都需登录，或字幕已失效）');

    job.phase = 'packing';
    job.message = `正在打包 ${files.length} 个字幕文件…`;
    await persist();

    const zip = createZip(files);
    const url = 'data:application/zip;base64,' + bytesToBase64(zip);
    // 包名：UP主名_下载日期.zip（带 UTF-8 标志位，中文不乱码）
    const baseName = sanitizeName(job.upName) || 'B站字幕';
    const filename = `${baseName}_${todayStr()}.zip`;
    await chrome.downloads.download({
      url,
      filename,
      saveAs: true
    });

    job.phase = 'done';
    job.fileCount = files.length;
    job.message = `已打包 ${files.length} 个字幕，保存到本地完成 ✅`;
    setBadge('', '');
    await persist();
  } catch (e) {
    finishError(e);
  } finally {
    stopKeepAlive();
  }
}

function finishError(e) {
  job.phase = 'error';
  job.error = e?.message || String(e);
  job.message = '失败：' + job.error;
  setBadge('!', '#f53f3f');
  stopKeepAlive();
  persist();
}

// ---------- 消息与端口 ----------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'getJob') {
    sendResponse({ job });
    return false;
  }
  if (msg?.type === 'startFetch') {
    if (!isActive()) startFetch(String(msg.input || ''), msg.langs);
    sendResponse({ ok: true });
    return false;
  }
  if (msg?.type === 'startDownload') {
    job.selected = Array.isArray(msg.bvids) ? msg.bvids : job.selected;
    job.format = msg.format === 'srt' ? 'srt' : 'txt';
    if (!isActive()) startDownload();
    sendResponse({ ok: true });
    return false;
  }
  if (msg?.type === 'setSelection') {
    job.selected = Array.isArray(msg.bvids) ? msg.bvids : [];
    persist();
    sendResponse({ ok: true });
    return false;
  }
  if (msg?.type === 'clear') {
    job = idleJob();
    setBadge('', '');
    persist();
    sendResponse({ ok: true });
    return false;
  }
  return false;
});

chrome.runtime.onConnect.addListener((port) => {
  ports.add(port);
  try {
    port.postMessage({ type: 'job', job });
  } catch (e) {
    /* ignore */
  }
  port.onDisconnect.addListener(() => ports.delete(port));
});

// SW 被回收后重启时，恢复上次状态（不恢复运行中的任务，Chrome 会重放事件）
chrome.storage.session.get(JOB_KEY).then((r) => {
  if (r && r[JOB_KEY]) {
    const j = r[JOB_KEY];
    // 若上次停在运行中（说明 SW 被杀），标记为中断
    if (ACTIVE.includes(j.phase)) {
      j.phase = 'error';
      j.message = '任务被浏览器中断，请重新开始。';
      j.error = 'interrupted';
    }
    job = j;
    broadcast();
  }
});
