// xlsx-lite.js — a minimal, dependency-free .xlsx (OOXML spreadsheet) reader
// and single-sheet writer. No external libraries: this hand-rolls just enough
// of the ZIP container format (store + DEFLATE/RFC1951 inflate) and the
// spreadsheetml XML schema to read/write simple data tables. It is NOT a
// general-purpose spreadsheet engine (no formulas, styles, multiple sheets,
// merged cells, etc.) — it only needs to round-trip flat selector/value
// tables for Flowcraft's data-driven replay feature.
(function (root) {
  'use strict';

  // ---------- bytes / text helpers ----------
  function strToBytes(str) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(str);
    return new Uint8Array(Buffer.from(str, 'utf8')); // Node fallback (test harness only)
  }
  function decodeUtf8(bytes) {
    if (typeof TextDecoder !== 'undefined') return new TextDecoder('utf-8').decode(bytes);
    return Buffer.from(bytes).toString('utf8'); // Node fallback (test harness only)
  }
  function readUint16LE(b, o) { return b[o] | (b[o + 1] << 8); }
  function readUint32LE(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }

  // ---------- tiny XML parser (subset: elements, attrs, text — no DOM dependency) ----------
  function decodeXmlEntities(s) {
    return s.replace(/&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos);/g, (m, ent) => {
      if (ent === 'amp') return '&';
      if (ent === 'lt') return '<';
      if (ent === 'gt') return '>';
      if (ent === 'quot') return '"';
      if (ent === 'apos') return "'";
      if (ent[0] === '#') {
        const code = ent[1] === 'x' ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
        return String.fromCodePoint(code);
      }
      return m;
    });
  }
  function escapeXml(s) {
    return String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  }

  function parseXml(xml) {
    let i = 0;
    const n = xml.length;
    function parseAttrs(str) {
      const attrs = {};
      const re = /([:\w-]+)\s*=\s*"([^"]*)"/g;
      let m;
      while ((m = re.exec(str))) attrs[m[1]] = decodeXmlEntities(m[2]);
      return attrs;
    }
    function parseElement() {
      const closeGt = xml.indexOf('>', i);
      let tagContent = xml.slice(i + 1, closeGt);
      const selfClosing = tagContent.endsWith('/');
      if (selfClosing) tagContent = tagContent.slice(0, -1);
      const spaceIdx = tagContent.search(/\s/);
      const tag = spaceIdx === -1 ? tagContent : tagContent.slice(0, spaceIdx);
      const attrs = spaceIdx === -1 ? {} : parseAttrs(tagContent.slice(spaceIdx));
      i = closeGt + 1;
      const node = { tag, attrs, children: [], text: '' };
      if (selfClosing) return node;
      const closeTag = '</' + tag + '>';
      let textBuf = '';
      while (i < n) {
        if (xml[i] === '<') {
          if (xml.startsWith(closeTag, i)) { i += closeTag.length; break; }
          if (xml.startsWith('<!--', i)) { i = xml.indexOf('-->', i) + 3; continue; }
          node.children.push(parseElement());
        } else {
          const nextLt = xml.indexOf('<', i);
          textBuf += xml.slice(i, nextLt === -1 ? n : nextLt);
          i = nextLt === -1 ? n : nextLt;
        }
      }
      node.text = decodeXmlEntities(textBuf);
      return node;
    }
    // skip XML declaration / doctype / comments before the root element
    while (i < n) {
      if (xml.startsWith('<?', i)) { i = xml.indexOf('?>', i) + 2; }
      else if (xml.startsWith('<!--', i)) { i = xml.indexOf('-->', i) + 3; }
      else if (xml[i] !== '<') { i++; }
      else break;
    }
    return parseElement();
  }
  function findAll(node, tag, out) {
    out = out || [];
    for (const c of node.children) {
      if (c.tag === tag || c.tag.endsWith(':' + tag)) out.push(c);
      findAll(c, tag, out);
    }
    return out;
  }
  function getText(node) {
    let s = node.text || '';
    for (const c of node.children) s += getText(c);
    return s;
  }

  // ---------- CRC32 (needed to write valid ZIP entries) ----------
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let nb = 0; nb < 256; nb++) {
      let c = nb;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[nb] = c >>> 0;
    }
    return t;
  })();
  function crc32(bytes) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  // ---------- DEFLATE (RFC 1951) raw inflate — needed because Excel/Sheets/
  // LibreOffice always compress .xlsx parts, so reading real-world files
  // requires decompressing them, not just the ones we generate ourselves. ----------
  function makeBitReader(bytes) {
    let pos = 0, bitBuf = 0, bitCount = 0;
    return {
      readBit() {
        if (bitCount === 0) { bitBuf = bytes[pos++]; bitCount = 8; }
        const bit = bitBuf & 1;
        bitBuf >>= 1; bitCount--;
        return bit;
      },
      readBits(k) {
        let v = 0;
        for (let i = 0; i < k; i++) v |= this.readBit() << i;
        return v;
      },
      alignByte() { bitBuf = 0; bitCount = 0; },
      readByteDirect() { return bytes[pos++]; }
    };
  }
  function buildHuffman(lengths) {
    let maxLen = 0;
    for (const l of lengths) if (l > maxLen) maxLen = l;
    const blCount = new Array(maxLen + 1).fill(0);
    for (const l of lengths) if (l > 0) blCount[l]++;
    const nextCode = new Array(maxLen + 1).fill(0);
    let code = 0;
    for (let bits = 1; bits <= maxLen; bits++) {
      code = (code + blCount[bits - 1]) << 1;
      nextCode[bits] = code;
    }
    const map = Object.create(null);
    for (let sym = 0; sym < lengths.length; sym++) {
      const len = lengths[sym];
      if (len > 0) { map[len + '_' + nextCode[len]] = sym; nextCode[len]++; }
    }
    return { map };
  }
  function decodeSymbol(br, table) {
    let code = 0, len = 0;
    while (len <= 15) {
      code = (code << 1) | br.readBit();
      len++;
      const sym = table.map[len + '_' + code];
      if (sym !== undefined) return sym;
    }
    throw new Error('Corrupt DEFLATE stream (bad Huffman code)');
  }
  const LENGTH_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
  const LENGTH_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
  const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
  const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
  const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

  function buildFixedTables() {
    const lit = new Array(288);
    for (let i = 0; i < 144; i++) lit[i] = 8;
    for (let i = 144; i < 256; i++) lit[i] = 9;
    for (let i = 256; i < 280; i++) lit[i] = 7;
    for (let i = 280; i < 288; i++) lit[i] = 8;
    const dist = new Array(30).fill(5);
    return { lit: buildHuffman(lit), dist: buildHuffman(dist) };
  }
  function readDynamicTables(br) {
    const hlit = br.readBits(5) + 257;
    const hdist = br.readBits(5) + 1;
    const hclen = br.readBits(4) + 4;
    const clLengths = new Array(19).fill(0);
    for (let i = 0; i < hclen; i++) clLengths[CL_ORDER[i]] = br.readBits(3);
    const clTable = buildHuffman(clLengths);
    const all = [];
    while (all.length < hlit + hdist) {
      const sym = decodeSymbol(br, clTable);
      if (sym < 16) { all.push(sym); }
      else if (sym === 16) { const rep = br.readBits(2) + 3; const prev = all[all.length - 1]; for (let i = 0; i < rep; i++) all.push(prev); }
      else if (sym === 17) { const rep = br.readBits(3) + 3; for (let i = 0; i < rep; i++) all.push(0); }
      else { const rep = br.readBits(7) + 11; for (let i = 0; i < rep; i++) all.push(0); }
    }
    return { lit: buildHuffman(all.slice(0, hlit)), dist: buildHuffman(all.slice(hlit, hlit + hdist)) };
  }
  function inflateRaw(input) {
    const br = makeBitReader(input);
    // A plain JS array grown one element at a time via .push() hits V8's
    // internal array-growth limit on a large enough sheet (tens of MB of
    // decompressed XML, easily reached by a few tens of thousands of rows)
    // and crashes with a FATAL, non-catchable engine error instead of a
    // normal exception — silently killing whatever's running this (e.g. the
    // extension popup) with no error ever reaching a try/catch. A typed
    // array that grows by reallocation doesn't hit that path, and if it
    // ever does fail to allocate, that failure is a normal catchable error.
    let out = new Uint8Array(Math.max(4096, input.length * 3));
    let len = 0;
    function ensure(extra) {
      if (len + extra <= out.length) return;
      let cap = out.length * 2;
      while (cap < len + extra) cap *= 2;
      const grown = new Uint8Array(cap);
      grown.set(out.subarray(0, len));
      out = grown;
    }
    let final = 0;
    do {
      final = br.readBit();
      const type = br.readBits(2);
      if (type === 0) {
        br.alignByte();
        const blockLen = br.readByteDirect() | (br.readByteDirect() << 8);
        br.readByteDirect(); br.readByteDirect(); // NLEN, unused
        ensure(blockLen);
        for (let i = 0; i < blockLen; i++) out[len++] = br.readByteDirect();
      } else if (type === 1 || type === 2) {
        const tables = type === 1 ? buildFixedTables() : readDynamicTables(br);
        for (;;) {
          const sym = decodeSymbol(br, tables.lit);
          if (sym < 256) { ensure(1); out[len++] = sym; continue; }
          if (sym === 256) break;
          const li = sym - 257;
          const length = LENGTH_BASE[li] + br.readBits(LENGTH_EXTRA[li]);
          const dsym = decodeSymbol(br, tables.dist);
          const distance = DIST_BASE[dsym] + br.readBits(DIST_EXTRA[dsym]);
          ensure(length);
          const start = len - distance;
          for (let i = 0; i < length; i++) out[len + i] = out[start + i];
          len += length;
        }
      } else {
        throw new Error('Corrupt DEFLATE stream (reserved block type)');
      }
    } while (!final);
    return out.subarray(0, len);
  }

  // ---------- ZIP container ----------
  function findEOCD(bytes) {
    const minLen = 22, maxCommentLen = 65535;
    const searchStart = Math.max(0, bytes.length - minLen - maxCommentLen);
    for (let i = bytes.length - minLen; i >= searchStart; i--) {
      if (readUint32LE(bytes, i) === 0x06054b50) return i;
    }
    throw new Error('Not a valid .xlsx file (no ZIP end-of-central-directory record found).');
  }
  function parseZipEntries(bytes) {
    const eocdOff = findEOCD(bytes);
    const cdCount = readUint16LE(bytes, eocdOff + 10);
    const cdOff = readUint32LE(bytes, eocdOff + 16);
    const entries = {};
    let p = cdOff;
    for (let i = 0; i < cdCount; i++) {
      if (readUint32LE(bytes, p) !== 0x02014b50) throw new Error('Corrupt .xlsx file (bad ZIP central directory).');
      const method = readUint16LE(bytes, p + 10);
      const compSize = readUint32LE(bytes, p + 20);
      const nameLen = readUint16LE(bytes, p + 28);
      const extraLen = readUint16LE(bytes, p + 30);
      const commentLen = readUint16LE(bytes, p + 32);
      const localOff = readUint32LE(bytes, p + 42);
      const name = decodeUtf8(bytes.subarray(p + 46, p + 46 + nameLen));
      entries[name] = { method, compSize, localOff };
      p += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
  }
  function extractEntry(bytes, entry) {
    const lp = entry.localOff;
    if (readUint32LE(bytes, lp) !== 0x04034b50) throw new Error('Corrupt .xlsx file (bad ZIP local header).');
    const nameLen = readUint16LE(bytes, lp + 26);
    const extraLen = readUint16LE(bytes, lp + 28);
    const dataStart = lp + 30 + nameLen + extraLen;
    const raw = bytes.subarray(dataStart, dataStart + entry.compSize);
    if (entry.method === 0) return raw;
    if (entry.method === 8) return inflateRaw(raw);
    throw new Error('Unsupported compression method in .xlsx file: ' + entry.method);
  }
  function buildZipStore(files) {
    const localParts = [], centralParts = [];
    let offset = 0;
    const dosTime = 0, dosDate = (1 << 5) | 1; // fixed arbitrary valid DOS date; Excel doesn't care
    for (const f of files) {
      const nameBytes = strToBytes(f.name);
      const data = f.data;
      const crc = crc32(data);

      const local = new Uint8Array(30 + nameBytes.length);
      const lv = new DataView(local.buffer);
      lv.setUint32(0, 0x04034b50, true);
      lv.setUint16(4, 20, true);
      lv.setUint16(6, 0, true);
      lv.setUint16(8, 0, true);
      lv.setUint16(10, dosTime, true);
      lv.setUint16(12, dosDate, true);
      lv.setUint32(14, crc, true);
      lv.setUint32(18, data.length, true);
      lv.setUint32(22, data.length, true);
      lv.setUint16(26, nameBytes.length, true);
      lv.setUint16(28, 0, true);
      local.set(nameBytes, 30);
      localParts.push(local, data);

      const central = new Uint8Array(46 + nameBytes.length);
      const cv = new DataView(central.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, 20, true);
      cv.setUint16(6, 20, true);
      cv.setUint16(8, 0, true);
      cv.setUint16(10, 0, true);
      cv.setUint16(12, dosTime, true);
      cv.setUint16(14, dosDate, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, data.length, true);
      cv.setUint32(24, data.length, true);
      cv.setUint16(28, nameBytes.length, true);
      cv.setUint16(30, 0, true);
      cv.setUint16(32, 0, true);
      cv.setUint16(34, 0, true);
      cv.setUint16(36, 0, true);
      cv.setUint32(38, 0, true);
      cv.setUint32(42, offset, true);
      central.set(nameBytes, 46);
      centralParts.push(central);

      offset += local.length + data.length;
    }
    const centralStart = offset;
    let centralSize = 0;
    for (const c of centralParts) centralSize += c.length;

    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, files.length, true);
    ev.setUint16(10, files.length, true);
    ev.setUint32(12, centralSize, true);
    ev.setUint32(16, centralStart, true);

    const out = new Uint8Array(centralStart + centralSize + eocd.length);
    let p = 0;
    for (const part of localParts) { out.set(part, p); p += part.length; }
    for (const part of centralParts) { out.set(part, p); p += part.length; }
    out.set(eocd, p);
    return out;
  }

  // ---------- cell reference <-> column index ----------
  function colLettersToIndex(letters) {
    let n = 0;
    for (let i = 0; i < letters.length; i++) n = n * 26 + (letters.charCodeAt(i) - 64);
    return n - 1;
  }
  function colIndexToLetters(idx) {
    let n = idx + 1, s = '';
    while (n > 0) {
      const rem = (n - 1) % 26;
      s = String.fromCharCode(65 + rem) + s;
      n = Math.floor((n - 1) / 26);
    }
    return s;
  }

  // ---------- public: read ----------
  // Returns an array of row objects keyed by the first row's (trimmed)
  // header cell text, mirroring the shape popup.js's CSV parser produces.
  function xlsxRead(arrayBuffer) {
    const bytes = new Uint8Array(arrayBuffer);
    const entries = parseZipEntries(bytes);

    let sheetPath = entries['xl/worksheets/sheet1.xml'] ? 'xl/worksheets/sheet1.xml' : null;
    if (!sheetPath) {
      sheetPath = Object.keys(entries).filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort()[0];
    }
    if (!sheetPath) throw new Error('No worksheet found — is this a valid .xlsx file?');

    let sharedStrings = [];
    if (entries['xl/sharedStrings.xml']) {
      const ssRoot = parseXml(decodeUtf8(extractEntry(bytes, entries['xl/sharedStrings.xml'])));
      sharedStrings = findAll(ssRoot, 'si').map((si) => getText(si));
    }

    const sheetRoot = parseXml(decodeUtf8(extractEntry(bytes, entries[sheetPath])));
    const rowNodes = findAll(sheetRoot, 'row');

    const grid = [];
    let maxCol = 0;
    for (const rowNode of rowNodes) {
      const rAttr = rowNode.attrs.r;
      const rowIndex = rAttr ? parseInt(rAttr, 10) - 1 : grid.length;
      const rowArr = grid[rowIndex] || (grid[rowIndex] = []);
      for (const cellNode of findAll(rowNode, 'c')) {
        const ref = cellNode.attrs.r || '';
        const letters = ref.replace(/[0-9]/g, '');
        const colIndex = letters ? colLettersToIndex(letters) : rowArr.length;
        const type = cellNode.attrs.t || 'n';
        let value;
        if (type === 'inlineStr') {
          const isNode = findAll(cellNode, 'is')[0];
          value = isNode ? getText(isNode) : '';
        } else {
          const vNode = findAll(cellNode, 'v')[0];
          const raw = vNode ? getText(vNode) : '';
          if (type === 's') value = sharedStrings[parseInt(raw, 10)] || '';
          else if (type === 'b') value = raw === '1' ? 'TRUE' : 'FALSE';
          else value = raw;
        }
        rowArr[colIndex] = value;
        if (colIndex > maxCol) maxCol = colIndex;
      }
    }

    const headerRow = grid[0] || [];
    const headers = [];
    for (let c = 0; c <= maxCol; c++) headers.push((headerRow[c] != null ? String(headerRow[c]) : '').trim());

    const out = [];
    for (let r = 1; r < grid.length; r++) {
      const rowArr = grid[r];
      if (!rowArr || rowArr.every((v) => v == null || String(v).trim() === '')) continue;
      const obj = {};
      for (let c = 0; c <= maxCol; c++) {
        const h = headers[c];
        if (!h) continue;
        obj[h] = rowArr[c] != null ? String(rowArr[c]) : '';
      }
      out.push(obj);
    }
    return out;
  }

  // ---------- public: write ----------
  // headers: string[]; rows: string[][] (same column order as headers).
  // A column literally named "Repeat" (case-insensitive) with a plain
  // integer value is written as a real numeric cell; everything else is
  // written as text so Excel never "helpfully" reinterprets it as a date,
  // strips leading zeros, etc.
  function xlsxWrite(sheetName, headers, rows) {
    let rowsXml = '';
    const allRows = [headers].concat(rows);
    allRows.forEach((rowValues, rIdx) => {
      const rNum = rIdx + 1;
      let cellsXml = '';
      rowValues.forEach((val, cIdx) => {
        const ref = colIndexToLetters(cIdx) + rNum;
        const isRepeatCol = String(headers[cIdx] || '').trim().toLowerCase() === 'repeat';
        const isNumeric = rIdx > 0 && isRepeatCol && /^-?\d+$/.test(String(val).trim());
        if (isNumeric) {
          cellsXml += '<c r="' + ref + '"><v>' + Number(val) + '</v></c>';
        } else {
          cellsXml += '<c r="' + ref + '" t="inlineStr"><is><t xml:space="preserve">' + escapeXml(val) + '</t></is></c>';
        }
      });
      rowsXml += '<row r="' + rNum + '">' + cellsXml + '</row>';
    });
    const sheetXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<sheetData>' + rowsXml + '</sheetData></worksheet>';

    const contentTypes = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
      '</Types>';
    const rootRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
      '</Relationships>';
    const workbookXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      '<sheets><sheet name="' + escapeXml(sheetName) + '" sheetId="1" r:id="rId1"/></sheets>' +
      '</workbook>';
    const workbookRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
      '</Relationships>';

    return buildZipStore([
      { name: '[Content_Types].xml', data: strToBytes(contentTypes) },
      { name: '_rels/.rels', data: strToBytes(rootRels) },
      { name: 'xl/workbook.xml', data: strToBytes(workbookXml) },
      { name: 'xl/_rels/workbook.xml.rels', data: strToBytes(workbookRels) },
      { name: 'xl/worksheets/sheet1.xml', data: strToBytes(sheetXml) }
    ]);
  }

  const XlsxLite = { read: xlsxRead, write: xlsxWrite };
  if (typeof module !== 'undefined' && module.exports) module.exports = XlsxLite;
  root.XlsxLite = XlsxLite;
})(typeof self !== 'undefined' ? self : this);
