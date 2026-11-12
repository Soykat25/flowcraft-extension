// Runs in its own plain tab (opened by popup.js's openDataRun), not the
// toolbar action popup — a native <input type=file> dialog steals window
// focus, and Chrome closes action popups on that; an ordinary tab has no
// such special-window behavior. Same reasoning as content.js's
// promptFileUpload, but this one doesn't touch the target page at all (it
// just parses a data file and hands rows to background.js), so a plain
// extension tab is enough — no need to live inside the page itself.
const $ = (s) => document.querySelector(s);
function send(cmd, extra) {
  return chrome.runtime.sendMessage(Object.assign({ cmd }, extra || {}));
}

function setStatus(text, kind) {
  const el = $('#preview');
  el.className = 'status' + (kind ? ' ' + kind : '');
  el.textContent = text;
}

// Same modal as popup.js's promptForSecrets — duplicated here (not shared
// via data-helpers.js) because it's DOM-heavy UI tied to this page's own
// overlay markup, not reusable logic. Asked only at Run time, once a file's
// been picked and validated — not up front just to open this tab.
function promptForSecrets(missing) {
  return new Promise((resolve) => {
    const overlay = $('#secretsOverlay');
    const fieldsEl = $('#secretsFields');
    const okBtn = $('#secretsOkBtn');
    const cancelBtn = $('#secretsCancelBtn');

    fieldsEl.innerHTML = '';
    const inputs = missing.map((m) => {
      const wrap = document.createElement('div');
      wrap.className = 'field';
      const label = document.createElement('label');
      label.textContent = (m.credentialType === 'username' ? 'Username' : 'Password') +
        ' — ' + m.selector;
      const input = document.createElement('input');
      input.type = m.credentialType === 'username' ? 'text' : 'password';
      input.autocomplete = 'off';
      wrap.append(label, input);
      fieldsEl.appendChild(wrap);
      return { selector: m.selector, input };
    });

    function cleanup() {
      overlay.hidden = true;
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      overlay.removeEventListener('keydown', onKeydown);
    }
    function onOk() {
      const result = {};
      for (const { selector, input } of inputs) result[selector] = input.value;
      cleanup();
      resolve(result);
    }
    function onCancel() {
      cleanup();
      resolve(null);
    }
    function onKeydown(e) {
      if (e.key === 'Enter') { e.preventDefault(); onOk(); }
      else if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
    }

    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    overlay.addEventListener('keydown', onKeydown);
    overlay.hidden = false;
  });
}

(async () => {
  const { pendingDataRun } = await chrome.storage.local.get('pendingDataRun');
  const pickBtn = $('#pickBtn');
  const okBtn = $('#okBtn');
  const cancelBtn = $('#cancelBtn');
  const fileInput = $('#fileInput');

  if (!pendingDataRun) {
    setStatus('Nothing to run — this tab can be closed.', 'err');
    pickBtn.hidden = true;
    okBtn.hidden = true;
    cancelBtn.textContent = 'Close';
    cancelBtn.onclick = () => window.close();
    return;
  }

  const { flowId, tabId, repeat, delay } = pendingDataRun;
  const { flows } = await send('getFlows');
  const flow = (flows || []).find((f) => f.id === flowId);
  if (!flow) {
    setStatus('This flow no longer exists — close this tab and try again.', 'err');
    pickBtn.hidden = true;
    okBtn.hidden = true;
    return;
  }
  $('#flowName').textContent = flow.name;

  let rows = null;

  pickBtn.onclick = () => fileInput.click();

  fileInput.onchange = async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return; // user just cancelled the OS file picker — genuinely nothing to do

    // Everything below can throw in ways that are hard to fully enumerate
    // (a malformed file, a messaging error, etc.) — wrapping the whole thing
    // guarantees the user always sees *something* instead of the picker
    // just closing with no visible result.
    try {
      rows = null;
      okBtn.disabled = true;

      const extMatch = file.name.match(/\.([A-Za-z0-9]+)$/);
      const ext = extMatch ? extMatch[1].toLowerCase() : 'xlsx';
      const expectedName = expectedDataFileName(flow, ext);
      if (file.name.toLowerCase() !== expectedName.toLowerCase()) {
        setStatus(
          '✕ Wrong file — this flow only accepts a file named exactly "' + expectedName + '" (got "' + file.name +
          '"). Click "Download template" (in the popup) to get it. A browser-renamed duplicate (e.g. "' +
          sanitizeFilenameBase(flow.name) + '-data-template (1).' + ext + '") won\'t be accepted — ' +
          're-download or rename it back first.',
          'err'
        );
        return;
      }

      setStatus('Reading ' + file.name + '…', 'running');

      let rawRows;
      try {
        if (/\.xlsx$/i.test(file.name)) {
          rawRows = XlsxLite.read(await file.arrayBuffer());
        } else if (/\.json$/i.test(file.name)) {
          const data = JSON.parse(await file.text());
          rawRows = Array.isArray(data) ? data : [];
        } else {
          rawRows = parseCsv(await file.text());
        }
      } catch (err) {
        setStatus('✕ ' + file.name + ' — could not read file: ' + (err && err.message ? err.message : err), 'err');
        return;
      }
      if (!rawRows.length) {
        setStatus('✕ ' + file.name + ' — no rows found in that file.', 'err');
        return;
      }

      const validSelectors = dataDrivableSelectors(flow);
      const usedCols = new Set();
      for (const row of rawRows) {
        if (!row || typeof row !== 'object') continue;
        for (const k of Object.keys(row)) if (validSelectors.has(k)) usedCols.add(k);
        if (rowLink(row)) usedCols.add('Link');
      }
      if (!usedCols.size) {
        setStatus(
          '✕ ' + file.name + ' — none of its columns/keys match a selector this flow uses. ' +
          'Try "Download template" for a ready-made file.',
          'err'
        );
        return;
      }

      const expanded = expandRowsByRepeat(rawRows);
      rows = expanded;
      pickBtn.textContent = 'Change file…';

      // The popup's Repeat field, captured when this tab was opened, caps
      // how many of the file's expanded rows actually get used — mirrors
      // what background.js's runFlow does at run time, so this preview
      // matches what will really happen.
      const repeatCap = Math.max(1, Number(repeat) || 1);
      const effective = repeatCap > 1 ? Math.min(expanded.length, repeatCap) : expanded.length;
      let msg = '✓ ' + file.name + ' loaded — ' + rawRows.length + ' row(s)';
      if (expanded.length !== rawRows.length) msg += ' → ' + expanded.length + ' run(s) with Repeat column';
      msg += ' · ' + usedCols.size + ' matching field(s) of ' + validSelectors.size + ' total.';
      if (repeatCap > 1 && effective < expanded.length) {
        msg += ' Popup Repeat=' + repeatCap + ' will cap this to the first ' + effective + ' run(s).';
      } else {
        msg += ' Will run all ' + effective + ' run(s).';
      }
      setStatus(msg, 'ok');
      okBtn.disabled = false;

      // Remember this flow's validated data file — filename/counts for the
      // DATA badge, and the actual expanded rows so the dedicated "Run data"
      // button on the flow card can fire immediately without re-picking.
      await send('saveFlowDataFile', {
        flowId: flow.id,
        fileName: file.name,
        rowCount: rawRows.length,
        runCount: expanded.length,
        rows: expanded
      });
    } catch (err) {
      setStatus(
        '✕ Unexpected error while loading "' + file.name + '": ' + (err && err.message ? err.message : err),
        'err'
      );
    }
  };

  cancelBtn.onclick = async () => {
    await chrome.storage.local.remove('pendingDataRun');
    window.close();
  };

  okBtn.onclick = async () => {
    if (!rows) return;

    // Same check popup.js's runFlow() does: secret fields with no stored
    // value need a value from the user before this can actually run.
    const seen = new Set();
    const missing = [];
    for (const st of flow.steps) {
      if (st.secret && (st.value == null || st.value === '') && !seen.has(st.selector)) {
        seen.add(st.selector);
        missing.push({ selector: st.selector, credentialType: st.credentialType });
      }
    }
    let secrets = {};
    if (missing.length) {
      const result = await promptForSecrets(missing);
      if (result == null) return; // cancelled — stay on this tab, file stays loaded
      secrets = result;
    }

    await chrome.storage.local.remove('pendingDataRun');
    const res = await send('runFlow', { flowId: flow.id, repeat, delay, secrets, dataRows: rows, tabId });
    if (res && res.ok === false) { setStatus('✕ ' + res.error, 'err'); return; }
    window.close();
  };
})();
