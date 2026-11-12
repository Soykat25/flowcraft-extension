const $ = (s) => document.querySelector(s);
function send(cmd, extra) {
  return chrome.runtime.sendMessage(Object.assign({ cmd }, extra || {}));
}

// Distinct credential (username/password) selectors that have no stored
// value — these are exactly the fields runFlow() will prompt for manually
// before running, since "Store usernames/passwords" was off (or the flow
// predates it) when the flow was saved. A flow with credential steps whose
// values *are* stored needs no prompt at all, so it shouldn't be counted.
function countMissingCredentials(flow) {
  const seen = new Set();
  let count = 0;
  for (const st of flow.steps) {
    if (st.secret && (st.value == null || st.value === '') && !seen.has(st.selector)) {
      seen.add(st.selector);
      count++;
    }
  }
  return count;
}

let flowsCache = [];
let dataFilesCache = {}; // { [flowId]: { fileName, rowCount, runCount, savedAt } }
let historyOpen = false;
let stepsEditorCtx = null; // { source: 'recording'|'flow', flowId, steps }

async function refresh() {
  const rec = (await send('getRecording')).recording;
  flowsCache = (await send('getFlows')).flows || [];
  dataFilesCache = (await send('getFlowDataFiles')).dataFiles || {};
  const { settings = { storeSecrets: false } } = await chrome.storage.local.get('settings');
  const { replayStatus } = await chrome.storage.local.get('replayStatus');
  const { replayRunning } = await chrome.storage.local.get('replayRunning');

  renderRecording(rec);
  renderFlows(flowsCache);
  $('#storeSecrets').checked = !!settings.storeSecrets;
  $('#retryOnFail').checked = !!settings.retryOnFail;
  $('#stopReplayBtn').hidden = !replayRunning;
  renderStatus(replayStatus);
  if (historyOpen) await renderHistory();
}

function renderRecording(rec) {
  const idle = $('#idleView');
  const recording = $('#recordingView');
  const save = $('#saveView');
  idle.hidden = recording.hidden = save.hidden = true;

  if (rec && rec.active) {
    recording.hidden = false;
    $('#stepCount').textContent = (rec.steps.length || 0) + ' steps';
  } else if (rec && rec.steps && rec.steps.length) {
    save.hidden = false;
    $('#saveMeta').textContent =
      rec.steps.length + ' steps captured · start: ' + (rec.startUrl || '—');
    showFlowNameError('');
  } else {
    idle.hidden = false;
  }
}

function renderFlows(flows) {
  const list = $('#flowList');
  list.innerHTML = '';
  $('#noFlows').hidden = flows.length > 0;

  for (const f of flows) {
    const el = document.createElement('div');
    el.className = 'flow';
    const missingSecrets = countMissingCredentials(f);
    el.innerHTML =
      '<div class="flow-head">' +
        '<div class="name"></div>' +
        '<span class="data-badge" hidden title="">' +
          '<span class="data-badge-label">DATA</span>' +
          '<button type="button" class="data-badge-clear" title="Remove data file" aria-label="Remove data file">✕</button>' +
        '</span>' +
      '</div>' +
      '<div class="meta"></div>' +
      '<div class="actions">' +
        '<div class="run-row">' +
          '<button class="primary" data-act="run">Run</button>' +
          '<button class="data-run-btn" data-act="run-data" hidden type="button">Run data</button>' +
        '</div>' +
        '<div class="icon-row">' +
        '<button class="small icon-btn tint-violet" data-act="rename" title="Rename" aria-label="Rename">' +
          '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false">' +
            '<path d="M11.3 1.7a1.5 1.5 0 0 1 2.1 0l.9.9a1.5 1.5 0 0 1 0 2.1L6 13l-3.3.7L3.4 10.4z" ' +
              'fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>' +
          '</svg>' +
        '</button>' +
        '<button class="small icon-btn tint-cyan" data-act="edit" title="Edit steps" aria-label="Edit steps">' +
          '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false">' +
            '<path d="M2 12.5h12M3 9.5l6-6 2.5 2.5-6 6H3z" fill="none" stroke="currentColor" ' +
              'stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>' +
          '</svg>' +
        '</button>' +
        '<button class="small icon-btn tint-cyan" data-act="data" title="Run with data" aria-label="Run with data">' +
          '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false">' +
            '<path d="M2 3.5h12M2 8h12M2 12.5h12M5.5 3.5v9" fill="none" stroke="currentColor" ' +
              'stroke-width="1.3" stroke-linecap="round"/>' +
          '</svg>' +
        '</button>' +
        '<button class="small icon-btn tint-green" data-act="template" title="Download data template (Excel)" ' +
          'aria-label="Download data template (Excel)">' +
          '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false">' +
            '<rect x="1.5" y="2.5" width="13" height="11" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.2"/>' +
            '<path d="M1.5 6.5h13M6 2.5v11M10.5 2.5v11" stroke="currentColor" stroke-width="1" fill="none"/>' +
          '</svg>' +
        '</button>' +
        '<button class="small icon-btn tint-violet" data-act="duplicate" title="Duplicate" aria-label="Duplicate">' +
          '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false">' +
            '<rect x="2" y="2" width="9" height="9" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.3"/>' +
            '<path d="M6.5 11.5v1.5a1 1 0 0 0 1 1H14a1 1 0 0 0 1-1V7a1 1 0 0 0-1-1h-1.5" ' +
              'fill="none" stroke="currentColor" stroke-width="1.3"/>' +
          '</svg>' +
        '</button>' +
        '<button class="small icon-btn tint-green" data-act="export" title="Export" aria-label="Export">' +
          '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false">' +
            '<path d="M8 1.5v8m0 0L5 6.5M8 9.5l3-3M2.5 11.5v2a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-2" ' +
              'fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>' +
          '</svg>' +
        '</button>' +
        '<button class="small icon-btn tint-danger" data-act="delete" title="Delete" aria-label="Delete">' +
          '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false">' +
            '<path d="M3 4.5h10M6.5 4.5V3a1 1 0 0 1 1-1h1a1 1 0 0 1 1 1v1.5M4.5 4.5l.6 8.4a1 1 0 0 0 1 .9h3.8' +
              'a1 1 0 0 0 1-.9l.6-8.4" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" ' +
              'stroke-linejoin="round"/>' +
          '</svg>' +
        '</button>' +
        '</div>' +
      '</div>';
    el.querySelector('.name').textContent = f.name;
    el.querySelector('.meta').textContent =
      f.steps.length + ' steps' + (missingSecrets ? ' · ' + missingSecrets + ' credential field(s) need input' : '');

    const dataFile = dataFilesCache[f.id];
    const badge = el.querySelector('.data-badge');
    const runDataBtn = el.querySelector('[data-act="run-data"]');
    if (dataFile) {
      badge.hidden = false;
      badge.title = 'Data file: ' + dataFile.fileName + ' — ' + dataFile.rowCount + ' row(s)' +
        (dataFile.runCount !== dataFile.rowCount ? ' → ' + dataFile.runCount + ' run(s) with Repeat' : '');
      badge.querySelector('.data-badge-clear').onclick = (e) => {
        e.stopPropagation();
        clearFlowDataFile(f);
      };
      if (Array.isArray(dataFile.rows) && dataFile.rows.length) {
        runDataBtn.hidden = false;
        runDataBtn.title = 'Run using ' + dataFile.fileName + ' — ' + dataFile.rows.length +
          ' run(s), exactly as the file specifies (ignores the Repeat field).';
        runDataBtn.onclick = () => runFlowWithStoredData(f);
      }
    }

    el.querySelector('[data-act="run"]').onclick = () => runFlow(f);
    el.querySelector('[data-act="rename"]').onclick = () => renameFlow(f);
    el.querySelector('[data-act="edit"]').onclick = () => openStepsEditor({ source: 'flow', flowId: f.id, steps: f.steps, startUrl: f.startUrl });
    el.querySelector('[data-act="data"]').onclick = () => openDataRun(f);
    el.querySelector('[data-act="template"]').onclick = () => downloadDataTemplate(f);
    el.querySelector('[data-act="duplicate"]').onclick = () => duplicateFlow(f);
    el.querySelector('[data-act="export"]').onclick = () => exportFlow(f);
    el.querySelector('[data-act="delete"]').onclick = () => deleteFlow(f);
    list.appendChild(el);
  }
}

function renderStatus(s) {
  const el = $('#status');
  el.className = 'status';
  if (!s) { el.textContent = ''; return; }
  if (s.type === 'progress' || s.type === 'paused') {
    let t = (s.type === 'paused' ? 'Paused · ' : '') + 'Run ' + s.iter + '/' + s.total + ' · step ' + s.step + '/' + s.steps;
    if (s.last && s.last.ok === false) {
      el.classList.add('err');
      t += ' · ' + s.last.error;
    } else {
      el.classList.add('running');
    }
    el.textContent = t;
  } else if (s.type === 'done') {
    if (s.error) {
      el.classList.add('err');
      el.textContent = 'Error: ' + s.error;
    } else if (s.stopped) {
      el.classList.add('warn');
      el.textContent = 'Stopped.';
    } else {
      el.classList.add('ok');
      el.textContent = 'Finished!';
    }
  }
}

// ---------- actions ----------
$('#startBtn').onclick = async () => {
  const res = await send('startRecording');
  if (res && res.ok === false) { setError(res.error); return; }
  // Close the popup so the on-page floating indicator (added in content.js)
  // is what shows recording is active — the popup itself would just be in
  // the way, and closes on its own the moment the user clicks the page.
  window.close();
};
$('#stopBtn').onclick  = async () => { await send('stopRecording'); refresh(); };

function setError(text) {
  const el = $('#status');
  el.className = 'status err';
  el.textContent = text;
}

// ---------- flow name uniqueness ----------
function isDuplicateFlowName(name, excludeId) {
  const norm = name.trim().toLowerCase();
  if (!norm) return false;
  return flowsCache.some((f) => f.id !== excludeId && f.name.trim().toLowerCase() === norm);
}

function showFlowNameError(msg) {
  const el = $('#flowNameError');
  if (!msg) { el.hidden = true; el.textContent = ''; return; }
  el.hidden = false;
  el.textContent = msg;
}

$('#flowName').oninput = () => showFlowNameError('');

$('#saveBtn').onclick = async () => {
  const name = $('#flowName').value.trim();
  if (name && isDuplicateFlowName(name, null)) {
    showFlowNameError('A saved flow named "' + name + '" already exists. Choose a different name.');
    return;
  }
  const res = await send('saveFlow', { name });
  if (res && res.ok === false) {
    showFlowNameError(res.error || 'Could not save flow.');
    return;
  }
  showFlowNameError('');
  $('#flowName').value = '';
  refresh();
};
$('#discardBtn').onclick = async () => {
  showFlowNameError('');
  await send('discardRecording');
  refresh();
};

$('#storeSecrets').onchange = async (e) => {
  const { settings = {} } = await chrome.storage.local.get('settings');
  settings.storeSecrets = e.target.checked;
  await chrome.storage.local.set({ settings });
};

$('#retryOnFail').onchange = async (e) => {
  const { settings = {} } = await chrome.storage.local.get('settings');
  settings.retryOnFail = e.target.checked;
  await chrome.storage.local.set({ settings });
};

$('#stopReplayBtn').onclick = async () => { await send('stopReplay'); };

// ---------- export / import ----------
// Every downloaded file (exports, data templates, run logs, screenshots)
// lands in Downloads/Flowcraft/<Mon DD YYYY>/ instead of loose in the
// top-level Downloads folder, so they don't pile up and stay easy to find
// by the day they were produced.
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function dateFolderName() {
  const d = new Date();
  return MONTH_NAMES[d.getMonth()] + String(d.getDate()).padStart(2, '0') + d.getFullYear();
}

function downloadToFlowcraftFolder(url, filename, revoke) {
  chrome.downloads.download(
    { url, filename: 'Flowcraft/' + dateFolderName() + '/' + filename, saveAs: false },
    () => { if (revoke) setTimeout(() => URL.revokeObjectURL(url), 1000); }
  );
}

function downloadJson(payload, filename) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  downloadToFlowcraftFolder(URL.createObjectURL(blob), filename, true);
}

// Filesystem-safe filename from a flow name; keeps the name recognizable
// while stripping characters that are invalid (or awkward) in file names.
function filenameFromFlowName(name) {
  const safe = (name || 'flow').trim().replace(/[\\/:*?"<>|]+/g, '-');
  return (safe || 'flow') + '.json';
}

function exportFlow(flow) {
  const payload = { app: 'flowcraft', version: 1, exportedAt: Date.now(), flows: [flow] };
  downloadJson(payload, filenameFromFlowName(flow.name));
}

// Lets the user pick which saved flows to include in a bulk export.
// Resolves with the selected flow objects, or null if cancelled.
function showBulkExportPicker(flows) {
  return new Promise((resolve) => {
    const overlay = $('#bulkExportOverlay');
    const listEl = $('#bulkExportList');
    const okBtn = $('#bulkExportOkBtn');
    const cancelBtn = $('#bulkExportCancelBtn');
    const allBtn = $('#bulkExportAllBtn');
    const noneBtn = $('#bulkExportNoneBtn');

    listEl.innerHTML = '';
    const checks = flows.map((f) => {
      const label = document.createElement('label');
      label.className = 'check';
      const input = document.createElement('input');
      input.type = 'checkbox';
      const span = document.createElement('span');
      span.textContent = f.name + ' (' + f.steps.length + ' steps)';
      label.append(input, span);
      listEl.appendChild(label);
      return { flow: f, input };
    });

    function setAll(checked) {
      for (const c of checks) c.input.checked = checked;
    }
    function cleanup() {
      overlay.hidden = true;
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      allBtn.removeEventListener('click', onAll);
      noneBtn.removeEventListener('click', onNone);
      overlay.removeEventListener('keydown', onKeydown);
    }
    function onOk() {
      const selected = checks.filter((c) => c.input.checked).map((c) => c.flow);
      cleanup();
      resolve(selected);
    }
    function onCancel() { cleanup(); resolve(null); }
    function onAll() { setAll(true); }
    function onNone() { setAll(false); }
    function onKeydown(e) {
      if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
    }

    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    allBtn.addEventListener('click', onAll);
    noneBtn.addEventListener('click', onNone);
    overlay.addEventListener('keydown', onKeydown);
    overlay.hidden = false;
  });
}

$('#exportBtn').onclick = async () => {
  if (!flowsCache.length) { await showAlert('No flows to export.'); return; }
  const selected = await showBulkExportPicker(flowsCache);
  if (selected == null) return;
  if (!selected.length) { await showAlert('Select at least one flow to export.'); return; }
  const payload = { app: 'flowcraft', version: 1, exportedAt: Date.now(), flows: selected };
  downloadJson(payload, 'flowcraft-' + new Date().toISOString().slice(0, 10) + '.json');
};

$('#importBtn').onclick = () => $('#importFile').click();

$('#importFile').onchange = async (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!file) return;

  let data;
  try {
    data = JSON.parse(await file.text());
  } catch (err) {
    await showAlert('Could not read file: invalid JSON.');
    return;
  }

  const incoming = Array.isArray(data) ? data : (data && data.flows);
  if (!Array.isArray(incoming) || !incoming.length) {
    await showAlert('No flows found in that file.');
    return;
  }

  const res = await send('importFlows', { flows: incoming });
  if (res && res.ok) {
    if (!res.count && res.duplicates && !res.skipped) {
      // Every flow in the file matches one already saved by name — most
      // often the same file being imported again.
      await showAlert('Nothing to import — every flow in this file is already saved.');
    } else {
      const parts = ['Imported ' + res.count + ' flow(s).'];
      if (res.duplicates) {
        parts.push(res.duplicates + ' skipped — already saved.');
      }
      if (res.skipped) {
        parts.push(res.skipped + ' invalid entr' + (res.skipped === 1 ? 'y' : 'ies') + ' skipped.');
      }
      await showAlert(parts.join(' '));
    }
    refresh();
  } else {
    await showAlert('Import failed: ' + (res && res.error ? res.error : 'unknown error'));
  }
};

// ---------- step editor ----------
// Shared by "Edit steps" on a pending (not-yet-saved) recording and on an
// already-saved flow — both just hand in an array of steps and get told
// where to persist the edited array back to.
const STEP_BADGE_LABEL = {
  click: 'Click', input: 'Input', setChecked: 'Checkbox', dialog: 'Dialog',
  wait: 'Wait', assertVisible: 'Assert visible', assertText: 'Assert text', keypress: 'Key',
  fileUpload: 'File upload', navigate: 'Go to URL'
};

function mkStepBtn(label, title, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'small ghost';
  b.textContent = label;
  b.title = title;
  b.setAttribute('aria-label', title);
  b.onclick = onClick;
  return b;
}

function buildStepItem(step, idx, total) {
  const item = document.createElement('div');
  item.className = 'step-item';

  const head = document.createElement('div');
  head.className = 'step-head';
  const badge = document.createElement('span');
  badge.className = 'badge';
  badge.textContent = (idx + 1) + '. ' + (STEP_BADGE_LABEL[step.type] || step.type);
  head.appendChild(badge);
  if (step.secret) {
    const sb = document.createElement('span');
    sb.className = 'badge warn';
    sb.textContent = 'credential';
    head.appendChild(sb);
  }
  item.appendChild(head);

  const needsSelector = ['click', 'input', 'setChecked', 'assertVisible', 'assertText', 'keypress', 'fileUpload'].includes(step.type);
  if (needsSelector) {
    const selInput = document.createElement('input');
    selInput.type = 'text';
    selInput.value = step.selector || '';
    selInput.placeholder = 'CSS selector';
    selInput.oninput = () => { step.selector = selInput.value; };
    item.appendChild(selInput);
  }

  if (step.type === 'input') {
    if (step.secret) {
      const note = document.createElement('div');
      note.className = 'hint';
      note.textContent = 'Credential value hidden — you’ll be prompted for it at run time.';
      item.appendChild(note);
    } else {
      const valInput = document.createElement('input');
      valInput.type = 'text';
      valInput.value = step.value || '';
      valInput.placeholder = 'Value';
      valInput.oninput = () => { step.value = valInput.value; };
      item.appendChild(valInput);
    }
  }

  if (step.type === 'setChecked') {
    const label = document.createElement('label');
    label.className = 'check';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!step.checked;
    cb.onchange = () => { step.checked = cb.checked; };
    const span = document.createElement('span');
    span.textContent = 'Checked';
    label.append(cb, span);
    item.appendChild(label);
  }

  if (step.type === 'navigate') {
    const urlInput = document.createElement('input');
    urlInput.type = 'text';
    urlInput.value = step.url || '';
    urlInput.placeholder = 'https://…';
    urlInput.oninput = () => { step.url = urlInput.value.trim(); };
    item.appendChild(urlInput);
  }

  if (step.type === 'wait') {
    if (step.ms == null) step.ms = 500;
    const msInput = document.createElement('input');
    msInput.type = 'number';
    msInput.min = '0';
    msInput.value = step.ms;
    msInput.placeholder = 'Milliseconds';
    msInput.oninput = () => { step.ms = Math.max(0, Number(msInput.value) || 0); };
    item.appendChild(msInput);
  }

  if (step.type === 'assertText') {
    const txtInput = document.createElement('input');
    txtInput.type = 'text';
    txtInput.value = step.expectedText || '';
    txtInput.placeholder = 'Expected text';
    txtInput.oninput = () => { step.expectedText = txtInput.value; };
    item.appendChild(txtInput);

    const modeSel = document.createElement('select');
    modeSel.innerHTML = '<option value="exact">Exact match</option><option value="contains">Contains</option>';
    modeSel.value = step.matchMode === 'contains' ? 'contains' : 'exact';
    modeSel.onchange = () => { step.matchMode = modeSel.value; };
    item.appendChild(modeSel);
  }

  if (step.type === 'keypress') {
    const keySel = document.createElement('select');
    keySel.innerHTML = '<option value="Enter">Enter</option><option value="Escape">Escape</option><option value="Tab">Tab</option>';
    keySel.value = step.key || 'Enter';
    keySel.onchange = () => { step.key = keySel.value; };
    item.appendChild(keySel);
  }

  if (step.type === 'fileUpload') {
    const note = document.createElement('div');
    note.className = 'hint';
    note.textContent = 'You’ll be asked to choose a file for this field each time the flow runs.';
    item.appendChild(note);
  }

  if (step.type === 'dialog') {
    const note = document.createElement('div');
    note.className = 'hint';
    note.textContent = (step.dialogType || 'dialog') + ': ' + (step.message || '') + ' (informational only — not replayed)';
    item.appendChild(note);
  }

  const controls = document.createElement('div');
  controls.className = 'step-controls';
  const upBtn = mkStepBtn('↑', 'Move up', () => moveStep(idx, -1));
  const downBtn = mkStepBtn('↓', 'Move down', () => moveStep(idx, 1));
  const delBtn = mkStepBtn('✕', 'Delete step', () => deleteStep(idx));
  if (idx === 0) upBtn.disabled = true;
  if (idx === total - 1) downBtn.disabled = true;
  controls.append(upBtn, downBtn, delBtn);
  item.appendChild(controls);

  return item;
}

function renderStepsList() {
  const steps = stepsEditorCtx.steps;
  const list = $('#stepsList');
  list.innerHTML = '';
  steps.forEach((s, i) => list.appendChild(buildStepItem(s, i, steps.length)));
  $('#stepsCount').textContent = steps.length + ' step' + (steps.length === 1 ? '' : 's');
}

function moveStep(idx, dir) {
  const steps = stepsEditorCtx.steps;
  const j = idx + dir;
  if (j < 0 || j >= steps.length) return;
  const tmp = steps[idx];
  steps[idx] = steps[j];
  steps[j] = tmp;
  renderStepsList();
}

function deleteStep(idx) {
  stepsEditorCtx.steps.splice(idx, 1);
  renderStepsList();
}

function openStepsEditor(ctx) {
  stepsEditorCtx = { source: ctx.source, flowId: ctx.flowId, steps: ctx.steps.map((s) => Object.assign({}, s)) };
  $('#startUrlInput').value = ctx.startUrl || '';
  renderStepsList();
  $('#stepsOverlay').hidden = false;
}

$('#addStepBtn').onclick = () => {
  if (!stepsEditorCtx) return;
  const type = $('#addStepType').value;
  let step;
  if (type === 'wait') step = { type: 'wait', ms: 500 };
  else if (type === 'navigate') step = { type: 'navigate', url: '' };
  else if (type === 'assertVisible') step = { type: 'assertVisible', selector: '' };
  else step = { type: 'assertText', selector: '', expectedText: '', matchMode: 'exact' };
  stepsEditorCtx.steps.push(step);
  renderStepsList();
};

$('#stepsCancelBtn').onclick = () => { $('#stepsOverlay').hidden = true; stepsEditorCtx = null; };

$('#stepsSaveBtn').onclick = async () => {
  if (!stepsEditorCtx) return;
  let startUrl = $('#startUrlInput').value.trim();
  if (startUrl && !/^[a-z][a-z0-9+.-]*:/i.test(startUrl)) startUrl = 'https://' + startUrl;
  const cmd = stepsEditorCtx.source === 'flow' ? 'updateFlowSteps' : 'updateRecordingSteps';
  const extra = stepsEditorCtx.source === 'flow'
    ? { id: stepsEditorCtx.flowId, steps: stepsEditorCtx.steps, startUrl }
    : { steps: stepsEditorCtx.steps, startUrl };
  const res = await send(cmd, extra);
  $('#stepsOverlay').hidden = true;
  stepsEditorCtx = null;
  if (res && res.ok === false) await showAlert(res.error || 'Could not save steps.');
  refresh();
};

$('#editRecordingStepsBtn').onclick = async () => {
  const rec = (await send('getRecording')).recording;
  if (!rec || !rec.steps) return;
  openStepsEditor({ source: 'recording', steps: rec.steps, startUrl: rec.startUrl });
};

// ---------- data-driven run ----------
// Picking a file here would mean a native <input type=file> click inside
// this action popup — which opens the OS file dialog, steals window focus,
// and Chrome closes action popups on that (same issue fileUpload steps hit
// — see content.js's promptFileUpload). A plain tab has no such behavior to
// trip over, so the actual file picking happens there instead — and so does
// the credentials prompt (dataUpload.js has its own copy of
// promptForSecrets), asked only once a file's actually been picked and
// validated, same as before this moved out of the popup. Asking up front
// just to open the file picker would mean demanding a password before the
// user has even chosen (or possibly has) a data file to run.
async function openDataRun(flow) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  await chrome.storage.local.set({
    pendingDataRun: {
      flowId: flow.id,
      tabId: tab && tab.id,
      repeat: Number($('#repeat').value) || 1,
      delay: Number($('#delay').value) || 0
    }
  });
  await chrome.tabs.create({ url: chrome.runtime.getURL('dataUpload.html') });
  window.close();
}

// ---------- data template download ----------
function downloadBlob(blob, filename) {
  downloadToFlowcraftFolder(URL.createObjectURL(blob), filename, true);
}

// The value currently recorded for a selector, used to pre-fill the
// downloaded template's example row so it's obvious what each column means.
function currentValueFor(flow, selector) {
  for (const s of flow.steps) {
    if (s.selector !== selector) continue;
    if (s.type === 'setChecked') return s.checked ? 'true' : 'false';
    if (s.type === 'input') return s.value || '';
  }
  return '';
}

async function downloadDataTemplate(flow) {
  const selectors = Array.from(dataDrivableSelectors(flow));
  if (!selectors.length) {
    await showAlert('This flow has no input or checkbox steps to drive with data.');
    return;
  }
  const headers = ['Link'].concat(selectors, ['Repeat']);
  const exampleRow = [flow.startUrl || ''].concat(selectors.map((sel) => currentValueFor(flow, sel)), ['1']);
  const bytes = XlsxLite.write('Data', headers, [exampleRow]);
  const blob = new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  downloadBlob(blob, sanitizeFilenameBase(flow.name) + '-data-template.xlsx');
}

// ---------- run history ----------
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// Converts a JPEG (or any) data URL screenshot to a PNG Blob via canvas —
// the async Clipboard API's image support is most reliably PNG across
// Chrome versions, regardless of the format the screenshot was captured in.
function screenshotToPngBlob(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Could not convert image.'))), 'image/png');
    };
    img.onerror = () => reject(new Error('Could not load screenshot image.'));
    img.src = dataUrl;
  });
}

// A failure screenshot plus "copy / save" actions — clicking the thumbnail
// itself still opens it full-size.
function buildScreenshotBlock(dataUrl, filenameBase) {
  const wrap = document.createElement('div');
  wrap.className = 'shot-wrap';

  const img = document.createElement('img');
  img.src = dataUrl;
  img.title = 'Click to view full size';
  img.onclick = () => window.open(dataUrl, '_blank');
  wrap.appendChild(img);

  const toolbar = document.createElement('div');
  toolbar.className = 'shot-toolbar';

  const copyBtn = document.createElement('button');
  copyBtn.type = 'button';
  copyBtn.className = 'small ghost';
  copyBtn.textContent = 'Copy image';
  copyBtn.onclick = async () => {
    try {
      const blob = await screenshotToPngBlob(dataUrl);
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      copyBtn.textContent = 'Copied ✓';
    } catch (err) {
      await showAlert(
        'Could not copy the image to your clipboard: ' + (err && err.message ? err.message : err) +
        '. Use "Save image" instead.'
      );
    }
    setTimeout(() => { copyBtn.textContent = 'Copy image'; }, 1600);
  };

  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'small ghost';
  saveBtn.textContent = 'Save image';
  saveBtn.onclick = () => downloadToFlowcraftFolder(dataUrl, filenameBase + '.jpg', false);

  toolbar.append(copyBtn, saveBtn);
  wrap.appendChild(toolbar);
  return wrap;
}

// Downloads just one run (plus the failure screenshots/errors that belong
// to it) as its own JSON file, instead of the full history dump.
function downloadSingleRunLog(run, runErrors) {
  const payload = {
    extension: 'Flowcraft',
    version: chrome.runtime.getManifest().version,
    exportedAt: new Date().toISOString(),
    run,
    errors: runErrors
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const stamp = new Date(run.startedAt).toISOString().replace(/[:.]/g, '-');
  downloadBlob(blob, sanitizeFilenameBase(run.flowName || 'run') + '-' + stamp + '.json');
}

async function renderHistory() {
  const res = await send('getLogs');
  const runLogs = (res.runLogs || []).slice().reverse();
  const errorLogs = (res.errorLogs || []).slice().reverse();
  const list = $('#logList');
  list.innerHTML = '';
  $('#noLogs').hidden = !!(runLogs.length || errorLogs.length);

  // Group each run's failure screenshots/errors with that run (by runId) so
  // the relationship is obvious, instead of two disconnected flat lists.
  // Errors from before this grouping existed (no runId) fall back to their
  // own "Other errors" entries below, same as before.
  const errorsByRun = {};
  const unlinkedErrors = [];
  for (const e of errorLogs) {
    if (e.runId) (errorsByRun[e.runId] = errorsByRun[e.runId] || []).push(e);
    else unlinkedErrors.push(e);
  }

  for (const r of runLogs) {
    const runErrors = errorsByRun[r.runId] || [];
    const failed = r.iterations.reduce(
      (n, it) => n + it.steps.filter((s) => !s.ok && !s.skipped).length, 0
    );
    const el = document.createElement('div');
    el.className = 'log-item' + (r.error ? ' err' : '');

    const head = document.createElement('div');
    head.className = 'log-item-head';
    const info = document.createElement('div');
    info.className = 'log-item-info';
    info.innerHTML =
      '<div><b>' + escapeHtml(r.flowName || '(deleted flow)') + '</b> — ' +
      escapeHtml(new Date(r.startedAt).toLocaleString()) + '</div>' +
      '<div class="hint">' + r.iterations.length + '/' + r.repeatRequested + ' iteration(s)' +
      (r.dataRows ? ' · data-driven' : '') +
      (failed ? ' · ' + failed + ' failed step(s)' : '') +
      (r.stopped ? ' · stopped' : '') +
      (r.error ? ' · error: ' + escapeHtml(r.error) : '') + '</div>';
    const saveRunBtn = document.createElement('button');
    saveRunBtn.type = 'button';
    saveRunBtn.className = 'small tint-cyan';
    saveRunBtn.textContent = 'Save this run';
    saveRunBtn.onclick = () => downloadSingleRunLog(r, runErrors);
    head.append(info, saveRunBtn);
    el.appendChild(head);

    runErrors.forEach((e) => {
      if (!e.screenshot) return;
      el.appendChild(buildScreenshotBlock(
        e.screenshot,
        sanitizeFilenameBase(r.flowName || 'run') + '-iter' + e.iter + '-step' + e.step
      ));
    });

    list.appendChild(el);
  }

  for (const e of unlinkedErrors) {
    const el = document.createElement('div');
    el.className = 'log-item err';
    el.innerHTML =
      '<div><b>' + escapeHtml(e.flowName || e.cmd || 'Error') + '</b> — ' +
      escapeHtml(new Date(e.ts).toLocaleString()) + '</div>' +
      '<div class="hint">' + escapeHtml(e.error || '') + '</div>';
    if (e.screenshot) {
      el.appendChild(buildScreenshotBlock(e.screenshot, 'flowcraft-error-' + new Date(e.ts).getTime()));
    }
    list.appendChild(el);
  }
}

$('#toggleHistoryBtn').onclick = async () => {
  historyOpen = !historyOpen;
  $('#historyPanel').hidden = !historyOpen;
  $('#toggleHistoryBtn').textContent = historyOpen ? 'Hide' : 'Show';
  if (historyOpen) await renderHistory();
};

$('#clearLogBtn').onclick = async () => {
  if (!(await showConfirm('Clear run history and error log?'))) return;
  await send('clearLogs');
  await renderHistory();
};

$('#clearCacheBtn').onclick = async () => {
  if (!(await showConfirm(
    'Clear cached "Run with data" files? Every flow\'s uploaded data file will be forgotten ' +
    '(you\'ll need to re-pick the file next time you run with data). Saved flows themselves are not affected.'
  ))) return;
  await send('clearCache');
  dataFilesCache = {};
  renderFlows(flowsCache);
};

// Shows one combined form for every credential field that needs a value,
// instead of a separate native prompt() per field. Resolves with a
// { selector: value } map, or null if the user cancelled.
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
    inputs[0] && inputs[0].input.focus();
  });
}

async function clearFlowDataFile(flow) {
  await send('clearFlowDataFile', { flowId: flow.id });
  delete dataFilesCache[flow.id];
  renderFlows(flowsCache);
}

async function duplicateFlow(flow) {
  const res = await send('duplicateFlow', { id: flow.id });
  if (res && res.ok === false) { await showAlert(res.error || 'Could not duplicate flow.'); return; }
  refresh();
}

async function runFlow(flow, dataRows, opts) {
  opts = opts || {};
  const repeat = Number($('#repeat').value) || 1;
  const delay = Number($('#delay').value) || 0;

  // Collect distinct credential fields (username/password) with no stored
  // value, and ask for all of them in one form before running.
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
    if (result == null) return;
    secrets = result;
  }

  // File-input steps aren't prompted here \u2014 nothing usable was captured at
  // record time (browsers only expose a fake path), and picking a file via a
  // native OS dialog from inside this popup closes the popup before the pick
  // can complete. Instead, the run pauses right on the page when it reaches
  // each fileUpload step and prompts there \u2014 see content.js's
  // "promptFileUpload" overlay and background.js's runFlow loop.
  const payload = { flowId: flow.id, repeat, delay, secrets };
  if (Array.isArray(dataRows) && dataRows.length) payload.dataRows = dataRows;
  // "Run data" (the dedicated button) always runs exactly what the file
  // specifies, regardless of the Repeat field \u2014 see background.js.
  if (opts.ignoreRepeatCap) payload.ignoreRepeatCap = true;

  const res = await send('runFlow', payload);
  if (res && res.ok === false) { setError(res.error); return; }
  // Close the popup so the on-page floating indicator (added in content.js)
  // is what shows replay progress \u2014 same reasoning as Start Recording.
  window.close();
}

// Runs a flow using its persisted data file exactly as-is (every row,
// repeated per its own Repeat column) \u2014 no file picker, no Repeat-field
// interaction at all.
async function runFlowWithStoredData(flow) {
  const df = dataFilesCache[flow.id];
  if (!df || !Array.isArray(df.rows) || !df.rows.length) return;

  // Show exactly what's about to run — filename, run count, and the first
  // run's field values — so it's visible up front whether this is the data
  // you just uploaded or something stale, instead of finding out only
  // after the flow has already run on the page.
  const first = df.rows[0] || {};
  const keys = Object.keys(first).filter((k) => k.trim().toLowerCase() !== 'repeat');
  const shown = keys.slice(0, 6).map((k) => k + ' = ' + first[k]).join('\n');
  const more = keys.length > 6 ? '\n…' : '';

  const ok = await showConfirm(
    'Run "' + flow.name + '" with ' + df.rows.length + ' run(s) from "' + df.fileName + '"?\n\n' +
    'First run\'s values:\n' + (shown || '(no fields)') + more
  );
  if (!ok) return;

  await runFlow(flow, df.rows, { ignoreRepeatCap: true });
}

// Themed replacement for window.prompt(); resolves the entered text, or
// null if cancelled.
function showPrompt(message, defaultValue) {
  return new Promise((resolve) => {
    const overlay = $('#promptOverlay');
    const okBtn = $('#promptOkBtn');
    const cancelBtn = $('#promptCancelBtn');
    const input = $('#promptInput');
    $('#promptTitle').textContent = message;
    input.value = defaultValue || '';

    function cleanup() {
      overlay.hidden = true;
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      overlay.removeEventListener('keydown', onKeydown);
    }
    function onOk() { const v = input.value; cleanup(); resolve(v); }
    function onCancel() { cleanup(); resolve(null); }
    function onKeydown(e) {
      if (e.key === 'Enter') { e.preventDefault(); onOk(); }
      else if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
    }

    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    overlay.addEventListener('keydown', onKeydown);
    overlay.hidden = false;
    input.focus();
    input.select();
  });
}

async function renameFlow(flow) {
  let name = await showPrompt('Rename flow:', flow.name);
  if (name == null) return;
  name = name.trim() || flow.name;

  while (isDuplicateFlowName(name, flow.id)) {
    name = await showPrompt('That name is already used by another saved flow. Enter a different name:', name);
    if (name == null) return;
    name = name.trim() || flow.name;
  }

  const res = await send('renameFlow', { id: flow.id, name });
  if (res && res.ok === false) {
    await showAlert(res.error || 'Could not rename flow.');
    return;
  }
  refresh();
}

// Themed replacement for window.alert(); resolves once dismissed.
function showAlert(message) {
  return new Promise((resolve) => {
    const overlay = $('#alertOverlay');
    const okBtn = $('#alertOkBtn');
    $('#alertMessage').textContent = message;

    function cleanup() {
      overlay.hidden = true;
      okBtn.removeEventListener('click', onOk);
      overlay.removeEventListener('keydown', onKeydown);
    }
    function onOk() { cleanup(); resolve(); }
    function onKeydown(e) {
      if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); onOk(); }
    }

    okBtn.addEventListener('click', onOk);
    overlay.addEventListener('keydown', onKeydown);
    overlay.hidden = false;
    okBtn.focus();
  });
}

// Themed replacement for window.confirm(); resolves true/false.
function showConfirm(message) {
  return new Promise((resolve) => {
    const overlay = $('#confirmOverlay');
    const okBtn = $('#confirmOkBtn');
    const cancelBtn = $('#confirmCancelBtn');
    $('#confirmMessage').textContent = message;

    function cleanup() {
      overlay.hidden = true;
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      overlay.removeEventListener('keydown', onKeydown);
    }
    function onOk() { cleanup(); resolve(true); }
    function onCancel() { cleanup(); resolve(false); }
    function onKeydown(e) {
      if (e.key === 'Enter') { e.preventDefault(); onOk(); }
      else if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
    }

    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    overlay.addEventListener('keydown', onKeydown);
    overlay.hidden = false;
    cancelBtn.focus();
  });
}

async function deleteFlow(flow) {
  if (!(await showConfirm('Delete "' + flow.name + '"?'))) return;
  await send('deleteFlow', { id: flow.id });
  refresh();
}

// Live progress while the popup is open.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.cmd === 'replayEvent') {
    renderStatus(msg.payload);
    if (msg.payload.type === 'done') {
      $('#stopReplayBtn').hidden = true;
    }
  }
});

document.addEventListener('DOMContentLoaded', refresh);
