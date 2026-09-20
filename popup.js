// 弹窗 = 显示器 + 遥控器。真正的活都在 background.js 里跑，
// 所以切标签/关弹窗都不会中断任务；重新打开弹窗会自动续看进度。
import {
  parseCookies,
  injectCookieToJar,
  clearInjectedCookies,
  syncHeaderRules,
  fetchNav
} from './lib/auth.js';

const $ = (id) => document.getElementById(id);

const ACTIVE = ['auth', 'resolving', 'listing', 'detecting', 'downloading', 'packing'];
let job = null;
let renderedKey = '';
let keyword = '';
let currentFiltered = [];

// 关键词过滤：只按标题 / BV号 在已拉取的结果里筛选（纯前端，不重新请求）
function getFiltered(videos) {
  const kw = (keyword || '').trim().toLowerCase();
  if (!kw) return videos;
  return (videos || []).filter(
    (v) =>
      (v.title || '').toLowerCase().includes(kw) ||
      (v.bvid || '').toLowerCase().includes(kw)
  );
}

function setStatus(msg, isErr = false) {
  const el = $('status');
  el.textContent = msg || '';
  el.classList.toggle('err', !!isErr);
}

function manualCookie() {
  return $('cookie').value.trim();
}

// ---------- 语言筛选 ----------
function readLangs() {
  const langs = [];
  if ($('langZh').checked) langs.push('zh');
  if ($('langEn').checked) langs.push('en');
  if ($('langOther').checked) langs.push('other');
  return langs.length ? langs : ['zh'];
}

async function saveLangs(silent) {
  const langs = readLangs();
  // 至少保留一个语种：全不勾时自动回到中文（含AI）
  if (!$('langZh').checked && !$('langEn').checked && !$('langOther').checked) {
    $('langZh').checked = true;
    langs.push('zh');
  }
  await chrome.storage.local.set({ langFilter: langs });
  if (!silent) setStatus(`语言筛选已保存：${langs.join(' / ')}。重新「获取视频列表」后生效。`);
}

async function saveCookie(silent) {
  await chrome.storage.local.set({ biliCookie: manualCookie() });
  if (!silent) setStatus('Cookie 已保存到本机。');
}

// ---------- 渲染 ----------
function isActive(j) {
  return j && ACTIVE.includes(j.phase);
}

function render(j) {
  job = j || job;
  if (!job) return;

  setStatus(job.message || '', job.phase === 'error');
  $('progress').classList.toggle('hidden', !isActive(job));

  const all = job.videos || [];
  currentFiltered = getFiltered(all);
  $('listSection').classList.toggle('hidden', all.length === 0);

  const selected = new Set(job.selected || []);
  // key 同时纳入 keyword，关键词变化时整体重渲染行
  const key = all.map((v) => v.bvid).join(',') + '|' + keyword;
  if (key !== renderedKey) {
    renderedKey = key;
    renderRows(selected);
  } else {
    updateRows(selected);
  }
  updateCount(all, selected);
  updateControls();
}

function renderRows(selected) {
  const list = $('list');
  list.innerHTML = '';
  if (currentFiltered.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = keyword.trim()
      ? `没有匹配「${keyword.trim()}」的视频`
      : '该 UP主 暂无可显示视频';
    list.appendChild(empty);
    return;
  }
  currentFiltered.forEach((v) => {
    const row = document.createElement('div');
    row.className = 'row';
    row.dataset.bvid = v.bvid;

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = selected.has(v.bvid);
    cb.addEventListener('change', () => {
      const s = new Set(job.selected || []);
      if (cb.checked) s.add(v.bvid);
      else s.delete(v.bvid);
      job.selected = [...s];
      chrome.runtime.sendMessage({ type: 'setSelection', bvids: job.selected });
      updateCount(job.videos, new Set(job.selected));
      updateControls();
    });

    const meta = document.createElement('div');
    meta.className = 'meta';
    const title = document.createElement('div');
    title.className = 'title';
    title.textContent = v.title;
    const badge = document.createElement('span');
    badge.className = 'badge';
    title.appendChild(badge);
    const sub = document.createElement('div');
    sub.className = 'sub';
    sub.textContent = v.bvid;
    meta.appendChild(title);
    meta.appendChild(sub);

    row.appendChild(cb);
    row.appendChild(meta);
    list.appendChild(row);
  });
  updateRows(selected);
}

function updateRows(selected) {
  currentFiltered.forEach((v) => {
    const row = document.querySelector(`.row[data-bvid="${v.bvid}"]`);
    if (!row) return;
    const cb = row.querySelector('input[type=checkbox]');
    const badge = row.querySelector('.badge');
    const loading = !v.done;
    cb.disabled = loading || !v.hasSub || isActive();
    if (document.activeElement !== cb) cb.checked = selected.has(v.bvid);
    badge.className = 'badge ' + (loading ? 'loading' : v.hasSub ? 'yes' : 'no');
    badge.textContent = loading ? '检测中' : v.hasSub ? '有字幕' : '无字幕';
  });
}

function updateCount(all, selected) {
  const withSub = all.filter((v) => v.hasSub).length;
  const selAll = [...selected].filter((b) => all.find((v) => v.bvid === b && v.hasSub)).length;
  const kwActive = !!keyword.trim();
  const shown = currentFiltered.length;
  const shownWithSub = currentFiltered.filter((v) => v.hasSub).length;
  const shownSel = currentFiltered.filter((v) => v.hasSub && selected.has(v.bvid)).length;
  let tip = `共 ${all.length} 个 · 有字幕 ${withSub} · 已选 ${selAll}`;
  if (kwActive) tip += `（筛选显示 ${shown} 个 · 有字幕 ${shownWithSub} · 已选 ${shownSel}）`;
  $('countTip').textContent = tip;
}

function updateControls() {
  const active = isActive(job);
  $('btnFetch').disabled = active;
  $('btnReset').disabled = active;
  $('btnSelectAll').disabled = active;
  $('btnSelectNone').disabled = active;
  // 任务运行中不允许改语言，避免「检测口径」和「下载口径」对不上
  for (const id of ['langZh', 'langEn', 'langOther']) $(id).disabled = active;
  const sel = (job?.selected || []).length;
  $('btnDownload').disabled = active || sel === 0;
}

// ---------- 与后台通信 ----------
const port = chrome.runtime.connect({ name: 'job' });
port.onMessage.addListener((msg) => {
  if (msg?.type === 'job') render(msg.job);
});
chrome.runtime.sendMessage({ type: 'getJob' }, (res) => {
  if (res?.job) render(res.job);
});

// ---------- 操作 ----------
$('btnFetch').addEventListener('click', async () => {
  const input = $('upInput').value.trim();
  if (!input) {
    setStatus('请输入 UP主 名称 / 主页链接 / UID', true);
    return;
  }
  // 重新获取前清空关键词，避免旧关键词把新列表过滤空
  keyword = '';
  $('searchInput').value = '';
  $('searchClear').classList.add('hidden');
  await saveCookie(true);
  await saveLangs(true);
  chrome.runtime.sendMessage({ type: 'startFetch', input, langs: readLangs() });
});

$('btnDownload').addEventListener('click', () => {
  const bvids = (job?.videos || []).filter((v) => v.hasSub && (job.selected || []).includes(v.bvid))
    .map((v) => v.bvid);
  if (!bvids.length) {
    setStatus('请先勾选含字幕的视频', true);
    return;
  }
  chrome.runtime.sendMessage({ type: 'startDownload', bvids });
});

$('btnSelectAll').addEventListener('click', () => {
  // 有筛选时只选「筛选后并显示」的视频；无筛选则作用于全部
  const base = keyword.trim() ? currentFiltered : job.videos;
  const add = (base || []).filter((v) => v.hasSub).map((v) => v.bvid);
  const s = new Set(job.selected || []);
  add.forEach((b) => s.add(b));
  job.selected = [...s];
  chrome.runtime.sendMessage({ type: 'setSelection', bvids: job.selected });
  currentFiltered.forEach((v) => {
    if (v.hasSub) {
      const cb = document.querySelector(`.row[data-bvid="${v.bvid}"] input[type=checkbox]`);
      if (cb) cb.checked = true;
    }
  });
  updateCount(job.videos, new Set(job.selected));
  updateControls();
});

$('btnSelectNone').addEventListener('click', () => {
  // 有筛选时只取消「筛选后并显示」的视频；无筛选则全部清空
  const base = keyword.trim() ? currentFiltered : job.videos;
  const s = new Set(job.selected || []);
  (base || []).forEach((v) => s.delete(v.bvid));
  job.selected = [...s];
  chrome.runtime.sendMessage({ type: 'setSelection', bvids: job.selected });
  currentFiltered.forEach((v) => {
    const cb = document.querySelector(`.row[data-bvid="${v.bvid}"] input[type=checkbox]`);
    if (cb) cb.checked = false;
  });
  updateCount(job.videos, new Set(job.selected));
  updateControls();
});

$('btnReset').addEventListener('click', () => {
  if (isActive(job)) return; // 任务运行中不允许重置，防止误删正在跑的结果
  renderedKey = '';
  keyword = '';
  $('searchInput').value = '';
  $('searchClear').classList.add('hidden');
  $('upInput').value = '';
  chrome.runtime.sendMessage({ type: 'clear' });
  $('listSection').classList.add('hidden');
  setStatus('已重置：可输入新的 UP主 重新搜索。');
});

// ---------- 关键词搜索（纯前端过滤已拉取的结果） ----------
$('searchInput').addEventListener('input', () => {
  keyword = $('searchInput').value;
  $('searchClear').classList.toggle('hidden', !keyword);
  render();
});
$('searchClear').addEventListener('click', () => {
  keyword = '';
  $('searchInput').value = '';
  $('searchClear').classList.add('hidden');
  render();
});

// ---------- 认证相关 ----------
$('btnCheckLogin').addEventListener('click', async () => {
  await saveCookie(true);
  const raw = manualCookie();
  if (raw) {
    const list = parseCookies(raw);
    if (!list.length) {
      setStatus('Cookie 格式不对：应形如  SESSDATA=xxx; bili_jct=yyy', true);
      return;
    }
    setStatus('正在用你粘贴的 Cookie 验证登录…');
    await injectCookieToJar(list);
  } else {
    setStatus('未填 Cookie，正在用浏览器登录态验证…');
    await clearInjectedCookies();
  }
  await syncHeaderRules();
  const nav = await fetchNav();
  if (!nav) setStatus('验证请求失败：可能网络问题或被风控，稍后再试。', true);
  else if (nav.isLogin) setStatus(`✅ Cookie 有效，当前登录账号：${nav.uname || '（已登录）'}`);
  else setStatus('❌ 登录无效或 Cookie 已过期，请重新从 B站 复制最新的 cookie。', true);
});

$('btnSave').addEventListener('click', () => saveCookie(false));

$('btnClear').addEventListener('click', async () => {
  $('cookie').value = '';
  await saveCookie(true);
  await clearInjectedCookies();
  setStatus('已清空并移除注入的 Cookie。');
});

$('btnHelp').addEventListener('click', () => $('help').classList.toggle('hidden'));

// 输入即自动保存（防抖）
let saveTimer = null;
$('cookie').addEventListener('input', () => {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveCookie(true), 500);
});
$('cookie').addEventListener('blur', () => saveCookie(true));

chrome.storage.local.get(['biliCookie', 'langFilter'], (res) => {
  if (res && res.biliCookie) $('cookie').value = res.biliCookie;
  if (res && Array.isArray(res.langFilter)) {
    $('langZh').checked = res.langFilter.includes('zh');
    $('langEn').checked = res.langFilter.includes('en');
    $('langOther').checked = res.langFilter.includes('other');
  }
});

// 勾选变化即保存（语言筛选在下次「获取视频列表」时生效）
for (const id of ['langZh', 'langEn', 'langOther']) {
  $(id).addEventListener('change', () => saveLangs(false));
}
