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

// 去掉行内时间标记（如 [00:12] / [01:02:03]），纯文本更干净
function cleanText(s) {
  return String(s || '')
    .replace(/\r/g, '')
    .replace(/\[\d{1,2}:\d{2}(?::\d{2})?\]/g, '')
    .trim();
}

// B站 字幕 JSON -> 纯文本（TXT）：去掉序号与时间轴，一句一行，最适合丢给 AI 精读
export function subtitleJsonToTxt(json) {
  const body = json?.body || [];
  return body
    .map((item) => cleanText(item.content))
    .filter(Boolean)
    .join('\n');
}

// 统一输出分发：format='srt' 走时间轴字幕，否则走纯文本
export function renderSubtitle(json, format) {
  return format === 'srt' ? subtitleJsonToSrt(json) : subtitleJsonToTxt(json);
}
