// B站 字幕 JSON -> SRT 字幕文件

function secToSrtTime(sec) {
  const totalMs = Math.max(0, Math.round(Number(sec) * 1000));
  const h = Math.floor(totalMs / 3600000);
  const m = Math.floor((totalMs % 3600000) / 60000);
  const s = Math.floor((totalMs % 60000) / 1000);
  const ms = totalMs % 1000;
  const pad = (n, l = 2) => String(n).padStart(l, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms, 3)}`;
}

export function subtitleJsonToSrt(json) {
  const body = json?.body || [];
  let out = '';
  body.forEach((item, i) => {
    out += i + 1 + '\n';
    out += secToSrtTime(item.from) + ' --> ' + secToSrtTime(item.to) + '\n';
    out += (item.content || '').replace(/\r/g, '') + '\n\n';
  });
  return out;
}
