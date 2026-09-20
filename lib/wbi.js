// Bilibili WBI 签名
// 注意：签名用的是 MD5，而浏览器 WebCrypto 不提供 MD5，
// 所以这里用 lib/md5.js 的纯 JS 实现（不能用 crypto.subtle）。
import { md5 } from './md5.js';
import { httpJson } from './http.js';

const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
  27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
  37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
  22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52
];

// 打乱 img_key + sub_key，取前 32 位得到 mixin_key
export function getMixinKey(orig) {
  let s = '';
  for (const i of MIXIN_KEY_ENC_TAB) s += orig[i] || '';
  return s.slice(0, 32);
}

// 纯函数：给定密钥和时间戳，拼出带 w_rid 的 query（便于离线单测）
export function buildSignedQuery(params, imgKey, subKey, wts) {
  const mixinKey = getMixinKey(imgKey + subKey);
  const p = Object.assign({}, params, { wts });
  const keys = Object.keys(p).sort();
  const parts = [];
  for (const k of keys) {
    const val = String(p[k]).replace(/[!'()*]/g, '');
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(val)}`);
  }
  const query = parts.join('&');
  const w_rid = md5(query + mixinKey);
  return query + '&w_rid=' + w_rid;
}

// 从 nav 接口拿 img_key / sub_key（未登录也返回）
export async function getWbiKeys() {
  const json = await httpJson('https://api.bilibili.com/x/web-interface/nav');
  const imgUrl = json?.data?.wbi_img?.img_url || '';
  const subUrl = json?.data?.wbi_img?.sub_url || '';
  const imgKey = imgUrl.split('/').pop().split('.')[0];
  const subKey = subUrl.split('/').pop().split('.')[0];
  if (!imgKey || !subKey) throw new Error('WBI 密钥获取失败');
  return { imgKey, subKey };
}

// 对参数做 WBI 签名，返回 query string
export async function signWbi(params) {
  const { imgKey, subKey } = await getWbiKeys();
  const wts = Math.floor(Date.now() / 1000);
  return buildSignedQuery(params, imgKey, subKey, wts);
}
