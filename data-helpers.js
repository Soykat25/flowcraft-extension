// data-helpers.js — shared by popup.js and dataUpload.js so the two places
// that need to know a flow's data-file naming/column rules can't drift apart.

function sanitizeFilenameBase(name) {
  const safe = (name || 'flow').trim().replace(/[\\/:*?"<>|]+/g, '-');
  return safe || 'flow';
}

// The only filename a flow's data upload is accepted under — matches what
// "Download template" produces for that flow, so a fresh template always
// works and a browser-renamed duplicate ("...-data-template (1).xlsx") or a
// file meant for a different flow is rejected outright rather than silently
// used.
function expectedDataFileName(flow, ext) {
  return sanitizeFilenameBase(flow.name) + '-data-template.' + ext;
}

function parseCsv(text) {
  const lines = text.split(/\r\n|\n|\r/).filter((l) => l.trim() !== '');
  if (!lines.length) return [];
  const headers = lines[0].split(',').map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const cells = line.split(',');
    const obj = {};
    headers.forEach((h, i) => { obj[h] = cells[i] != null ? cells[i].trim() : ''; });
    return obj;
  });
}

function dataDrivableSelectors(flow) {
  const sels = new Set();
  for (const s of flow.steps) {
    if ((s.type === 'input' || s.type === 'setChecked') && s.selector) sels.add(s.selector);
  }
  return sels;
}

// A "Repeat" column/key lets a single data row stand for more than one run
// iteration — e.g. a row with Repeat=3 runs the flow 3 times with that row's
// values before moving to the next row.
function expandRowsByRepeat(rows) {
  const expanded = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const repeatKey = Object.keys(row).find((k) => k.trim().toLowerCase() === 'repeat');
    let n = 1;
    if (repeatKey != null) {
      const parsed = parseInt(String(row[repeatKey]).trim(), 10);
      if (Number.isFinite(parsed) && parsed >= 0) n = parsed;
    }
    for (let i = 0; i < n; i++) expanded.push(row);
  }
  return expanded;
}

// A "Link" (or "URL") column gives each data row its own start address, so one
// flow can run against several sites/environments. Empty = use the flow's own.
function rowLink(row) {
  if (!row || typeof row !== 'object') return '';
  const k = Object.keys(row).find((x) => ['link', 'url'].includes(x.trim().toLowerCase()));
  return k != null ? String(row[k]).trim() : '';
}
