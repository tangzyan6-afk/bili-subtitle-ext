// 统一请求层
// 关键点：Cookie / Referer 是 forbidden header，不能在 fetch 里手写（会被丢弃）。
// 认证改为两条路：
//   - 自动模式：credentials:'include'。扩展对目标域名有 host 权限时，
//     浏览器把该请求视作 same-site，会自动带上 B站 登录 Cookie。
//   - 手动模式：credentials:'omit'，由 declarativeNetRequest 追加 Cookie 头。

let CREDENTIALS = 'include';

export function setCredentials(mode) {
  CREDENTIALS = mode === 'omit' ? 'omit' : 'include';
}

export function getCredentials() {
  return CREDENTIALS;
}

export async function httpJson(url) {
  const resp = await fetch(url, {
    credentials: CREDENTIALS,
    headers: { Accept: 'application/json, text/plain, */*' }
  });
  return resp.json();
}

export async function httpText(url) {
  const resp = await fetch(url, { credentials: CREDENTIALS });
  return resp.text();
}
