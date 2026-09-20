// 认证：Cookie 解析 / 注入浏览器 Cookie 库 / 真实校验，以及 Referer 请求头规则
// 被 background.js 与 popup.js 共用。

import { httpJson, setCredentials } from './http.js';

// 注入到 .bilibili.com 域（覆盖 www / api / space 等所有子域），
// 这样打向 api.bilibili.com 的字幕接口才会带上 SESSDATA —— 否则 B站 判定未登录、
// 字幕列表返回空（"明明有字幕却识别不到"的主因之一）。
export const INJECT_HOST = 'https://www.bilibili.com/';
export const DNR_RULE_IDS = [1001, 1002];

// 兼容 DevTools 复制出来的各种格式：带 "cookie:" 前缀、换行、引号、值含 '='
export function parseCookies(str) {
  const s = (str || '')
    .replace(/^\s*cookie\s*:\s*/i, '')
    .replace(/[\r\n]+/g, ';')
    .trim();
  const out = [];
  for (const part of s.split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const name = part.slice(0, i).trim();
    const value = part.slice(i + 1).trim().replace(/^"(.*)"$/, '$1');
    if (!name) continue;
    if (/^(path|domain|expires|max-age|samesite|secure|httponly|priority|version)$/i.test(name)) {
      continue;
    }
    out.push({ name, value });
  }
  return out;
}

// 把 name=value 写进浏览器 Cookie 库（域 Cookie，落在 .bilibili.com，覆盖所有子域）
export async function injectCookieToJar(list) {
  let ok = 0;
  for (const c of list) {
    try {
      await chrome.cookies.set({
        url: INJECT_HOST,
        domain: 'bilibili.com',
        name: c.name,
        value: c.value,
        path: '/',
        secure: true
      });
      ok++;
    } catch (e) {
      /* 单个失败忽略 */
    }
  }
  await chrome.storage.local.set({ injectedNames: list.map((c) => c.name) });
  return ok;
}

export async function clearInjectedCookies() {
  const { injectedNames = [] } = await chrome.storage.local.get('injectedNames');
  for (const name of injectedNames) {
    try {
      await chrome.cookies.remove({ url: INJECT_HOST, name });
    } catch (e) {
      /* ignore */
    }
  }
  await chrome.storage.local.set({ injectedNames: [] });
}

// 用 DNR 补 Referer（fetch 设不了的头）
export async function syncHeaderRules() {
  const referer = { header: 'Referer', operation: 'set', value: 'https://www.bilibili.com/' };
  const rules = [
    {
      id: 1001,
      priority: 1,
      action: { type: 'modifyHeaders', requestHeaders: [referer] },
      condition: { urlFilter: '||api.bilibili.com', resourceTypes: ['xmlhttprequest', 'other'] }
    },
    {
      id: 1002,
      priority: 1,
      action: { type: 'modifyHeaders', requestHeaders: [referer] },
      condition: { urlFilter: '||hdslb.com', resourceTypes: ['xmlhttprequest', 'other'] }
    }
  ];
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: DNR_RULE_IDS,
      addRules: rules
    });
  } catch (e) {
    console.warn('更新请求头规则失败：', e);
  }
}

// 真实登录校验：打 nav 看 isLogin / uname
export async function fetchNav() {
  try {
    const j = await httpJson('https://api.bilibili.com/x/web-interface/nav');
    return j?.data || null;
  } catch (e) {
    return null;
  }
}

// 统一认证：读 storage 里的 Cookie → 注入或清除 → 校验。一律 credentials:'include'
export async function prepareAuth() {
  const { biliCookie = '' } = await chrome.storage.local.get('biliCookie');
  const raw = String(biliCookie || '').trim();
  await syncHeaderRules();
  setCredentials('include');

  if (raw) {
    const list = parseCookies(raw);
    if (!list.length) return { ok: false, reason: 'format' };
    await injectCookieToJar(list);
  } else {
    await clearInjectedCookies();
  }

  const nav = await fetchNav();
  return { ok: true, manual: !!raw, isLogin: !!nav?.isLogin, uname: nav?.uname || '' };
}
