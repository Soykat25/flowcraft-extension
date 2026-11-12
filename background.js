// background.js — coordinates recording state and drives replay.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- storage helpers ----------
async function get(key, def) {
  const o = await chrome.storage.local.get(key);
  return key in o ? o[key] : def;
}
function set(obj) { return chrome.storage.local.set(obj); }

// Flow names must be unique (case-insensitive, trimmed) so saved flows stay
// unambiguous to pick from and to look up by name.
function isDuplicateFlowName(flows, name, excludeId) {
  const norm = name.trim().toLowerCase();
  if (!norm) return false;
  return flows.some((f) => f.id !== excludeId && f.name.trim().toLowerCase() === norm);
}

async function currentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

// Recording/replay only work on normal web pages, not browser system pages.
function rowLink(row) {
  if (!row || typeof row !== 'object') return '';
  const k = Object.keys(row).find((x) => ['link', 'url'].includes(x.trim().toLowerCase()));
  return k != null ? String(row[k]).trim() : '';
}
function injectable(url) {
  return typeof url === 'string' && /^(https?|file|ftp):/i.test(url);
}
const NOT_INJECTABLE_MSG =
  'Open a normal web page (http/https) first. Browser system pages, the extensions gallery, and the new-tab page can\u2019t be automated.';

// If recording was started on an empty/system tab (no startUrl captured yet),
// pick up the first real page it navigates to as the flow's start URL. This
// lets recording begin on a blank new tab: content.js auto-attaches on the
// next page load via the manifest's content_scripts entry, so nothing else
// needs to happen here besides remembering where the flow should start.
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status !== 'complete') return;
  (async () => {
    const rec = await get('recording', null);
    if (rec && rec.active && rec.tabId === tabId && !rec.startUrl && injectable(tab.url)) {
      rec.startUrl = tab.url;
      await set({ recording: rec });
    }
  })();
});

// A top-frame URL change on the recording tab that no click/Enter just caused
// (typed address, bookmark, redirect) leaves no trace in the steps, so replay
// would stay on the old page. Record it as an editable `navigate` step.
const NAV_CAUSED_MS = 3000;
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (!info.url || !injectable(info.url)) return;
  (async () => {
    const rec = await get('recording', null);
    if (!rec || !rec.active || rec.tabId !== tabId) return;
    const prev = rec.lastUrl || rec.startUrl;
    rec.lastUrl = info.url;
    await set({ recording: rec });
    if (!prev || prev === info.url) return; // first page load, or same URL
    const last = rec.steps[rec.steps.length - 1];
    const caused = last && (last.type === 'click' || last.type === 'keypress') &&
      Date.now() - (rec.lastStepAt || 0) < NAV_CAUSED_MS;
    if (!caused) appendStep({ type: 'navigate', url: info.url });
  })();
});

// Serialize recording appends so rapid events keep their order.
let recChain = Promise.resolve();
function appendStep(step) {
  recChain = recChain.then(async () => {
    const rec = await get('recording', null);
    if (rec && rec.active) {
      rec.steps.push(step);
      rec.lastStepAt = Date.now();
      await set({ recording: rec });
      // Keep the on-page floating indicator's step count live.
      if (rec.tabId != null) {
        chrome.tabs.sendMessage(rec.tabId, { cmd: 'stepCount', count: rec.steps.length }).catch(() => {});
      }
    }
  });
  return recChain;
}

// ---------- replay ----------
let replayCtrl = null; // { stop: bool, resume: fn|null }

// chrome.scripting.executeScript throws these when the target frame is torn
// down by a real navigation between our "is the page settled" check and the
// injection actually landing — an internal race, not a step that actually
// failed on the page. Worth one retry once the new page has settled.
const TRANSIENT_FRAME_ERROR = /frame with id \d+ was removed|no frame with id|cannot access .* of the page/i;

// Unlike a torn-down frame, a closed/gone tab never comes back — retrying
// just repeats the same error, and letting a non-assertion step's failure
// fall through (the normal behavior) burns the rest of the run failing
// every remaining step against a tab that no longer exists.
const TAB_GONE_ERROR = /no tab with id|the tab was closed/i;

// Runs INSIDE the page (MAIN world) for each step. Fully self-contained.
async function pageExec(step) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const TIMEOUT = 15000;

  const isVisible = (el) => {
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };

  const isEnabled = (el) => !el.disabled && el.getAttribute('aria-disabled') !== 'true';
  const isEditable = (el) => !el.readOnly && isEnabled(el);
  const isStable = async (el) => {
    const r1 = el.getBoundingClientRect();
    await sleep(50);
    const r2 = el.getBoundingClientRect();
    return r1.x === r2.x && r1.y === r2.y && r1.width === r2.width && r1.height === r2.height;
  };
  const receivesEvents = (el) => {
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return !!hit && (el === hit || el.contains(hit) || hit.contains(el));
  };

  // Multi-level flyout/dropdown menus are commonly revealed by a JS
  // mouseenter/mouseleave listener (toggling an "open" class) rather than a
  // click — a synthetic click on the correct selector can't trigger that, so
  // walk the ancestor chain and fire a real hover sequence on each level
  // first. This reveals the submenu for the common JS-driven case; a
  // pure-CSS `:hover` menu can't be reproduced this way (no synthetic event
  // triggers `:hover` matching), which is what waitActionable's caller-side
  // fallback below is for.
  const hoverChain = async (el) => {
    const chain = [];
    let node = el.parentElement;
    while (node && node !== document.body && chain.length < 8) {
      chain.unshift(node);
      node = node.parentElement;
    }
    chain.push(el);
    for (const n of chain) {
      const r = n.getBoundingClientRect();
      const opts = { bubbles: true, cancelable: true, view: window, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
      for (const type of ['pointerover', 'mouseover', 'mouseenter']) {
        try { n.dispatchEvent(new MouseEvent(type, opts)); } catch (e) {}
      }
      await sleep(40);
    }
  };

  const deadline = Date.now() + TIMEOUT;

  // Playwright-style actionability: an element showing up in the DOM isn't
  // necessarily safe to act on yet — it can still be off-screen, animating
  // into place, covered by a modal/overlay, or disabled until some async
  // work finishes. This also catches the post-reload case where a step's
  // target renders early (skeleton/placeholder) and keeps shifting until the
  // page actually settles. Shares the element-search deadline above rather
  // than stacking a second full timeout on top.
  const waitActionable = async (el, { editable, receivesEvents: needsEvents, stable } = {}) => {
    while (Date.now() < deadline) {
      if (!document.contains(el)) return false;
      if (!isVisible(el)) { await sleep(80); continue; }
      if (!isEnabled(el)) { await sleep(80); continue; }
      if (editable && !isEditable(el)) { await sleep(80); continue; }
      if (stable && !(await isStable(el))) continue;
      if (needsEvents && !receivesEvents(el)) { await sleep(80); continue; }
      return true;
    }
    return false;
  };

  // Popup/dropdown/modal libraries frequently render their content by
  // appending it to <body> (or some portal container) at whatever index it
  // happens to land on, so a structural CSS path recorded earlier can point
  // at the wrong node — or nothing — next time. Falling back to matching the
  // element's visible text (captured at record time) is far more stable for
  // this kind of UI: dropdown options, menu items, and modal buttons.
  const findByText = (text) => {
    const norm = text && text.trim();
    if (!norm) return null;
    const candidates = document.querySelectorAll(
      'a,button,li,option,label,span,div,' +
      '[role="option"],[role="menuitem"],[role="menuitemradio"],' +
      '[role="menuitemcheckbox"],[role="button"],[role="tab"]'
    );
    let fallback = null;
    for (const el of candidates) {
      const t = (el.innerText || el.textContent || el.value || '').trim();
      if (t !== norm || !isVisible(el)) continue;
      // Prefer the most specific element (no clickable descendant of its
      // own) so we don't match a big wrapper that merely contains the text.
      if (!el.querySelector('a,button,li,[role="option"],[role="menuitem"]')) return el;
      if (!fallback) fallback = el;
    }
    return fallback;
  };

  const waitFor = async (sel, text) => {
    const norm = text && text.trim();
    while (Date.now() < deadline) {
      if (sel) {
        const el = document.querySelector(sel);
        if (el) {
          // The CSS path resolved to *an* element, but dynamic/reordered
          // lists (search results, paginated pickers) can put a different
          // row at the same structural position between recording and
          // replay. If we captured this element's own label at record
          // time, trust it over a positional match that disagrees with it.
          if (!norm) return el;
          const elText = ((el.innerText || el.value || '') + '').trim().slice(0, 80);
          if (elText === norm) return el;
          const byText = findByText(norm);
          if (byText) return byText;
          return el; // no better candidate — fall back to the positional match
        }
      }
      if (text) {
        const el = findByText(text);
        if (el) return el;
      }
      await sleep(120);
    }
    return null;
  };

  // Set a value so that frameworks like React detect the change. Clears the
  // field first — browser autofill can silently populate (and the page can
  // react to) a value before this step runs; clearing makes the flow's own
  // value win either way, and is a no-op on an already-empty field.
  const setNativeValue = (el, value) => {
    // <select>: accept the option's visible label as well as its value, so a
    // data file can say "Dhaka" instead of the internal value.
    if (el.tagName === 'SELECT') {
      const want = String(value).trim().toLowerCase();
      const opt = Array.from(el.options).find((o) => o.value === value) ||
        Array.from(el.options).find((o) => o.text.trim().toLowerCase() === want);
      if (opt) value = opt.value;
    }
    const proto = Object.getPrototypeOf(el);
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    const set = (v) => {
      const prev = el.value;
      if (desc && desc.set) desc.set.call(el, v);
      else el.value = v;
      try { if (el._valueTracker) el._valueTracker.setValue(prev); } catch (e) {}
    };
    set('');
    set(value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };

  // Fire a full pointer/mouse sequence, not just a bare click() — many
  // custom dropdown/menu widgets (select2, chosen, and similar) finalize
  // selection on 'mousedown', not 'click', so el.click() alone misses them.
  const fullClick = (el) => {
    const rect = el.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const opts = { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy };
    for (const type of ['pointerdown', 'mousedown']) {
      try { el.dispatchEvent(new MouseEvent(type, opts)); } catch (e) {}
    }
    for (const type of ['pointerup', 'mouseup']) {
      try { el.dispatchEvent(new MouseEvent(type, opts)); } catch (e) {}
    }
    el.click();
  };

  try {
    switch (step.type) {
      case 'click': {
        const el = await waitFor(step.selector, step.text);
        if (!el) return { ok: false, error: 'Not found: ' + step.selector };
        el.scrollIntoView({ block: 'center', inline: 'center' });
        await hoverChain(el);
        // Best-effort: wait for the element to look genuinely clickable, but
        // don't hard-fail if it never does — a hover-only flyout menu can
        // stay "covered"/invisible by these checks even though a direct
        // click on it still works fine (JS click handlers don't care about
        // CSS visibility). Only bail if the element is truly gone.
        await waitActionable(el, { stable: true, receivesEvents: true });
        if (!document.contains(el)) return { ok: false, error: 'Not found: ' + step.selector };
        if (el.focus) el.focus();
        fullClick(el);
        return { ok: true };
      }
      case 'input': {
        const el = await waitFor(step.selector);
        if (!el) return { ok: false, error: 'Not found: ' + step.selector };
        if (!(await waitActionable(el, { editable: true }))) {
          return { ok: false, error: 'Field not editable (disabled, readonly, or hidden): ' + step.selector };
        }
        if (el.focus) el.focus();
        setNativeValue(el, step.value != null ? step.value : '');
        return { ok: true };
      }
      case 'fileUpload': {
        const el = await waitFor(step.selector);
        if (!el) return { ok: false, error: 'Not found: ' + step.selector };
        if (!(await waitActionable(el, { editable: true }))) {
          return { ok: false, error: 'Field not editable (disabled or hidden): ' + step.selector };
        }
        if (!step.file || !step.file.base64) return { ok: false, error: 'No file chosen for this upload step' };
        // Same accept="..." matching the browser's own native file picker
        // uses to filter choices — check it here too so a mismatched file
        // fails with a clear reason instead of silently being rejected (or
        // accepted) by whatever the page does with it.
        const accept = (el.getAttribute('accept') || '').trim();
        if (accept) {
          const rules = accept.split(',').map((r) => r.trim().toLowerCase()).filter(Boolean);
          const ext = '.' + (step.file.name || '').split('.').pop().toLowerCase();
          const type = (step.file.type || '').toLowerCase();
          const matches = rules.some((rule) =>
            rule.startsWith('.') ? ext === rule :
            rule.endsWith('/*') ? type.startsWith(rule.slice(0, -1)) :
            type === rule
          );
          if (!matches) return { ok: false, error: 'This field only accepts: ' + accept };
        }
        const bin = atob(step.file.base64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const file = new File([bytes], step.file.name || 'upload', { type: step.file.type || '' });
        // input.value can't be set to a real path (browser security), but
        // .files can be replaced directly — the same technique headless
        // browser-automation tools use to fill file inputs.
        const dt = new DataTransfer();
        dt.items.add(file);
        Object.defineProperty(el, 'files', { value: dt.files, configurable: true });
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true };
      }
      case 'setChecked': {
        const el = await waitFor(step.selector);
        if (!el) return { ok: false, error: 'Not found: ' + step.selector };
        if (!!el.checked !== !!step.checked) {
          el.scrollIntoView({ block: 'center', inline: 'center' });
          await hoverChain(el);
          await waitActionable(el, { stable: true, receivesEvents: true });
          if (!document.contains(el)) return { ok: false, error: 'Not found: ' + step.selector };
          fullClick(el);
        }
        return { ok: true };
      }
      case 'assertVisible': {
        const el = await waitFor(step.selector, step.text);
        if (!el) return { ok: false, error: 'Assertion failed: element not found: ' + step.selector };
        if (!isVisible(el)) return { ok: false, error: 'Assertion failed: element not visible: ' + step.selector };
        return { ok: true };
      }
      case 'assertText': {
        const expected = (step.expectedText || '').trim();
        // The element can exist in the DOM before its text settles (loading
        // placeholder swapped for real content after an async fetch), so
        // poll for a match up to the shared deadline instead of checking
        // once right after the selector first resolves.
        let el = null, actual = '';
        while (Date.now() < deadline) {
          el = document.querySelector(step.selector) || findByText(step.text);
          if (el) {
            actual = ((el.innerText || el.textContent || el.value || '') + '').trim();
            const ok = step.matchMode === 'contains' ? actual.includes(expected) : actual === expected;
            if (ok) return { ok: true };
          }
          await sleep(120);
        }
        if (!el) return { ok: false, error: 'Assertion failed: element not found: ' + step.selector };
        return {
          ok: false,
          error: 'Assertion failed: expected text ' + (step.matchMode === 'contains' ? 'to contain' : 'to equal') +
            ' "' + expected + '", got "' + actual + '"'
        };
      }
      case 'keypress': {
        const el = await waitFor(step.selector, step.text);
        if (!el) return { ok: false, error: 'Not found: ' + step.selector };
        if (!(await waitActionable(el, {}))) {
          return { ok: false, error: 'Not actionable (disabled or hidden): ' + step.selector };
        }
        if (el.focus) el.focus();
        const KEYS = {
          Enter: { key: 'Enter', code: 'Enter', keyCode: 13 },
          Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
          Tab: { key: 'Tab', code: 'Tab', keyCode: 9 }
        };
        const k = KEYS[step.key] || { key: step.key, code: step.key, keyCode: 0 };
        const base = { bubbles: true, cancelable: true, key: k.key, code: k.code, keyCode: k.keyCode, which: k.keyCode };
        for (const type of ['keydown', 'keypress', 'keyup']) {
          try { el.dispatchEvent(new KeyboardEvent(type, base)); } catch (e) {}
        }
        return { ok: true };
      }
      default:
        return { ok: true, skipped: true };
    }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

function navigateAndWait(tabId, url, timeout = 30000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; chrome.tabs.onUpdated.removeListener(listener); resolve(); } };
    const listener = (id, info) => {
      if (id === tabId && info.status === 'complete') finish();
    };
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.update(tabId, { url }).catch(finish);
    setTimeout(finish, timeout);
  });
}

// A step (click on a link/submit button, etc.) may trigger a navigation
// asynchronously — there's no way to know in advance whether it will. Rather
// than guessing with a fixed sleep (which races the navigation actually
// starting), watch the tab for a 'loading' -> 'complete' transition within a
// short grace window; if one starts, wait for it to genuinely finish before
// the next step runs. If nothing starts within the grace window, assume the
// step didn't navigate and move on.
function waitForNavigation(tabId, graceMs, timeout = 30000) {
  return new Promise((resolve) => {
    let started = false;
    let done = false;
    const finish = () => { if (!done) { done = true; chrome.tabs.onUpdated.removeListener(listener); resolve(); } };
    const listener = (id, info) => {
      if (id !== tabId) return;
      if (info.status === 'loading') started = true;
      else if (info.status === 'complete' && started) finish();
    };
    chrome.tabs.onUpdated.addListener(listener);
    setTimeout(() => { if (!started) finish(); }, graceMs);
    setTimeout(finish, timeout);
  });
}

// chrome.tabs.update() to a URL the tab is effectively already "at" is a
// no-op — no real navigation happens, so no fresh page load occurs. That's
// the case whenever a flow is replayed from a tab that's already sitting on
// (or near) the start URL: an existing tab left open on the site, or the 2nd+
// iteration of a repeated run landing back on the same page. It's especially
// common with hash-routed single-page apps, where only the #fragment differs
// and the app just client-side-routes instead of reloading — leaving behind
// whatever DOM/form state the previous run left, which is exactly the kind
// of "works from a blank tab, breaks from an existing one" inconsistency
// this fixes. Bouncing through about:blank first guarantees the next
// navigation is always a genuine full load, regardless of what the tab had
// open before — so every run starts from identical, predictable page state.
async function resetTab(tabId) {
  try {
    const t = await chrome.tabs.get(tabId);
    // Already neutral (e.g. a fresh new tab) — no bounce needed, the
    // upcoming navigation to the start URL will already be a real one.
    if (t && t.url === 'about:blank') return;
  } catch (e) { return; }
  await navigateAndWait(tabId, 'about:blank', 8000);
}

async function settle(tabId, timeout = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const t = await chrome.tabs.get(tabId);
      if (t.status === 'complete') return;
    } catch (e) { return; }
    await sleep(150);
  }
}

async function notify(payload, tabId) {
  await set({ replayStatus: payload });
  chrome.runtime.sendMessage({ cmd: 'replayEvent', payload }).catch(() => {});
  // Also relay to the tab so its on-page floating widget can show live
  // progress even when the popup isn't open (it closes right after Run).
  if (tabId != null) {
    chrome.tabs.sendMessage(tabId, { cmd: 'replayProgress', payload }).catch(() => {});
  }
}

// Arms/disarms the page's native alert/confirm/prompt guard (dialog-guard.js)
// for a tab. Content scripts reload on every navigation with the guard
// defaulted off, so this is re-sent after each navigation during replay.
async function setReplayGuard(tabId, active) {
  try { await chrome.tabs.sendMessage(tabId, { cmd: 'setReplaying', active }); } catch (e) {}
}

// Asks the page itself (via content.js's on-page overlay, top frame only —
// same as the replay indicator) to prompt the user for a file and waits for
// them to pick one or cancel. Returns { name, type, base64 }, or null.
async function promptFileInTab(tabId, selector) {
  try {
    const res = await chrome.tabs.sendMessage(
      tabId, { cmd: 'promptFileUpload', selector }, { frameId: 0 }
    );
    return (res && res.ok && res.file) || null;
  } catch (e) {
    return null;
  }
}

// ---------- diagnostics / log history ----------
// Runs and extension errors are kept in storage as history — never written
// to disk automatically. The popup's Run history panel can save an
// individual run (with its screenshots/errors) as its own JSON file, or
// clear the whole history.
const LOG_MAX_RUNS = 20;
const LOG_MAX_ERRORS = 50;

async function pushLog(key, entry, max) {
  const list = await get(key, []);
  list.push(entry);
  while (list.length > max) list.shift();
  await set({ [key]: list });
}

async function logRun(entry) {
  await pushLog('runLogs', entry, LOG_MAX_RUNS);
}

async function logError(entry) {
  await pushLog('errorLogs', entry, LOG_MAX_ERRORS);
}

async function runFlow({ flowId, repeat, delay, secrets, dataRows, ignoreRepeatCap }, tabId) {
  const runEntry = {
    runId: crypto.randomUUID(),
    flowId,
    flowName: '',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    repeatRequested: repeat,
    delayMs: delay,
    dataRows: Array.isArray(dataRows) ? dataRows.length : 0,
    usedFileRepeatOnly: !!ignoreRepeatCap,
    iterations: [],
    stopped: false,
    error: null
  };

  try {
    const flows = await get('flows', []);
    const flow = flows.find((f) => f.id === flowId);
    if (!flow) {
      runEntry.error = 'Flow not found';
      runEntry.finishedAt = new Date().toISOString();
      await logRun(runEntry);
      await notify({ type: 'done', error: 'Flow not found' }, tabId);
      return;
    }
    runEntry.flowName = flow.name;

    const settings = await get('settings', {});
    const retryOnFail = !!settings.retryOnFail;
    let rows = Array.isArray(dataRows) && dataRows.length ? dataRows : null;
    if (rows && !ignoreRepeatCap) {
      // The popup's own Repeat field acts as a cap on the data file's
      // already-expanded row sequence (each row repeated per its own
      // "Repeat" column) — e.g. row1 x1 + row2 x2 + row3 x2 = 5 expanded
      // entries; a Repeat of 3 takes the first 3 of that sequence (row1
      // once, then row2 twice). Repeat's default of 1 means "wasn't set for
      // this" rather than "cap to 1" — otherwise every data-driven run
      // would silently collapse to just row 1 unless the field is touched
      // first — so only an explicit Repeat > 1 caps the run. The dedicated
      // "Run data" button (ignoreRepeatCap: true) skips this entirely and
      // always runs exactly what the file specifies, unaffected by
      // whatever is currently in the Repeat field.
      const cap = Math.max(1, Number(repeat) || 1);
      if (cap > 1 && cap < rows.length) rows = rows.slice(0, cap);
    }
    const total = rows ? rows.length : Math.max(1, Number(repeat) || 1);
    const perStepDelay = Math.max(0, Number(delay) || 0);
    replayCtrl = { stop: false, resume: null };
    await set({ replayRunning: true });

    for (let iter = 1; iter <= total && !replayCtrl.stop; iter++) {
      const iterEntry = { iter, steps: [] };
      const rowData = rows ? rows[iter - 1] : null;
      // A data row's Link column overrides the flow's start URL for that run.
      const link = rowData ? rowLink(rowData) : '';
      if (link && !injectable(link)) {
        iterEntry.steps.push({ step: 0, type: 'navigate', ok: false, error: 'Invalid Link in data row ' + iter + ': ' + link });
        runEntry.iterations.push(iterEntry);
        continue;
      }
      const startUrl = link || flow.startUrl;
      if (startUrl) {
        await resetTab(tabId);
        await navigateAndWait(tabId, startUrl);
      }
      await settle(tabId);
      // Content scripts reload fresh on navigation with the guard off by
      // default; re-arm it for this page before running any steps on it.
      await setReplayGuard(tabId, true);

      for (let s = 0; s < flow.steps.length && !replayCtrl.stop; s++) {
        const step = Object.assign({}, flow.steps[s]);
        if (step.secret && secrets && secrets[step.selector] != null) {
          step.value = secrets[step.selector];
        } else if (step.type === 'fileUpload') {
          // A script can never recover what was picked at record time
          // (browsers only expose a fake path), so pause right here and ask
          // for a real file via the on-page overlay — pageExec's own "No
          // file chosen" check below covers a cancel (picked stays null).
          const picked = await promptFileInTab(tabId, step.selector);
          if (picked) step.file = picked;
        } else if (rowData && rowData[step.selector] != null &&
          (step.type === 'input' || step.type === 'setChecked')) {
          // Data-driven run: substitute this iteration's row value, keyed by
          // the step's recorded selector (see "Run with data" in the popup).
          if (step.type === 'setChecked') {
            step.checked = ['true', '1', 'yes', 'y'].includes(String(rowData[step.selector]).trim().toLowerCase());
          } else {
            step.value = String(rowData[step.selector]);
          }
        }
        await settle(tabId);

        let res;
        if (step.type === 'navigate') {
          if (!injectable(step.url)) {
            res = { ok: false, error: 'Invalid navigate URL: ' + (step.url || '(empty)') };
          } else {
            await navigateAndWait(tabId, step.url);
            await settle(tabId);
            await setReplayGuard(tabId, true);
            res = { ok: true };
          }
        } else if (step.type === 'wait') {
          // Pure delay — no page access needed.
          await sleep(Math.max(0, Number(step.ms) || 0));
          res = { ok: true };
        } else {
          const attempt = async () => {
            try {
              // Steps recorded inside an iframe carry the frame they came
              // from; steps with no frameId (or old flows saved before this
              // existed) target the top frame.
              const frameId = typeof step.frameId === 'number' ? step.frameId : 0;
              const out = await chrome.scripting.executeScript({
                target: { tabId, frameIds: [frameId] },
                world: 'MAIN',
                func: pageExec,
                args: [step]
              });
              return out && out[0] && out[0].result;
            } catch (e) {
              return { ok: false, error: String((e && e.message) || e) };
            }
          };
          res = await attempt();
          if (res && res.ok === false && TRANSIENT_FRAME_ERROR.test(res.error || '')) {
            // The step's click (or the previous step's) kicked off a real
            // navigation that tore the target frame down between our
            // settle() check and the injection actually landing — not a
            // genuine step failure. Wait for the new page to finish
            // loading and retry once, regardless of the user's "retry
            // failed step" setting (that's for real failures, not this).
            await settle(tabId);
            // Content scripts (and the dialog guard) reload fresh on real
            // navigation with the guard off by default — this navigation
            // wasn't the once-per-iteration start-URL load that normally
            // re-arms it, so do it here too.
            await setReplayGuard(tabId, true);
            res = await attempt();
          }
          if (res && res.ok === false && retryOnFail && !TAB_GONE_ERROR.test(res.error || '')) {
            await sleep(500);
            res = await attempt();
          }
        }

        if (res && res.ok === false) {
          let screenshot = null;
          try {
            const tabInfo = await chrome.tabs.get(tabId);
            screenshot = await chrome.tabs.captureVisibleTab(tabInfo.windowId, { format: 'jpeg', quality: 40 });
          } catch (e) {}
          logError({
            ts: new Date().toISOString(),
            runId: runEntry.runId,
            flowId, flowName: flow.name,
            iter, step: s + 1, type: step.type, selector: step.selector,
            error: res.error, screenshot
          }).catch(() => {});
          const tabGone = TAB_GONE_ERROR.test(res.error || '');
          if (tabGone) {
            replayCtrl.stop = true;
            runEntry.error = 'Stopped: tab closed at step ' + (s + 1) + (res.error ? ' — ' + res.error : '');
          } else {
            // Any other failure pauses the run instead of ploughing on against
            // a page that never confirmed the previous step. Play retries this
            // same step; Stop ends the run.
            await notify({ type: 'paused', iter, total, step: s + 1, steps: flow.steps.length, last: res }, tabId);
            await new Promise((resolve) => { replayCtrl.resume = resolve; });
            replayCtrl.resume = null;
            if (replayCtrl.stop) {
              runEntry.error = 'Stopped: step ' + (s + 1) + ' failed' + (res.error ? ' — ' + res.error : '');
            } else {
              await settle(tabId);
              await setReplayGuard(tabId, true);
              s--;
              continue;
            }
          }
        }

        iterEntry.steps.push({
          step: s + 1,
          type: step.type,
          selector: step.selector,
          // The actual value/checked state used for this step on this
          // iteration — lets a data-driven run be verified after the fact
          // (e.g. via "Save log file") instead of having to guess whether
          // stale data was used. Credential values are never logged.
          value: (step.type === 'input' && !step.secret) ? step.value : undefined,
          checked: step.type === 'setChecked' ? step.checked : undefined,
          ok: !!(res && res.ok),
          skipped: !!(res && res.skipped),
          error: (res && res.error) || null
        });

        await notify({
          type: 'progress',
          iter, total,
          step: s + 1, steps: flow.steps.length,
          last: res
        }, tabId);

        // Wait out any navigation the step triggered before moving on.
        await waitForNavigation(tabId, 250);
        if (perStepDelay) await sleep(perStepDelay);
      }

      runEntry.iterations.push(iterEntry);
    }

    runEntry.stopped = replayCtrl.stop;
    runEntry.finishedAt = new Date().toISOString();
    replayCtrl = null;
    await set({ replayRunning: false });
    await setReplayGuard(tabId, false);
    await logRun(runEntry);
    await notify({ type: 'done', stopped: runEntry.stopped }, tabId);
  } catch (e) {
    runEntry.error = String((e && e.message) || e);
    runEntry.finishedAt = new Date().toISOString();
    replayCtrl = null;
    await set({ replayRunning: false });
    await setReplayGuard(tabId, false);
    await logRun(runEntry);
    await notify({ type: 'done', error: runEntry.error }, tabId);
  }
}

// ---------- recording start/stop (shared by the popup and the keyboard shortcut) ----------
async function startRecordingCore() {
  const tab = await currentTab();
  if (!tab || tab.id == null) return { ok: false, error: 'No active tab' };
  const onRealPage = injectable(tab.url);
  await set({
    recording: { active: true, steps: [], startUrl: onRealPage ? tab.url : '', tabId: tab.id }
  });
  if (onRealPage) {
    // Make sure the recorder (and its dialog guard) are present on the
    // already-open tab — the manifest's content_scripts only apply
    // automatically to future navigations, not pages already loaded before
    // recording started.
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        files: ['content.js']
      });
      await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        world: 'MAIN',
        files: ['dialog-guard.js']
      });
    } catch (e) {}
    chrome.tabs.sendMessage(tab.id, { cmd: 'setRecording', active: true }).catch(() => {});
  }
  // If this tab is empty/system (e.g. a fresh new tab), recording is still
  // armed: content.js attaches automatically (per manifest) as soon as the
  // user navigates to a real page, and the onUpdated listener above captures
  // that page as the flow's start URL.
  return { ok: true, startUrl: onRealPage ? tab.url : '' };
}

async function stopRecordingCore() {
  const rec = await get('recording', null);
  if (rec) { rec.active = false; await set({ recording: rec }); }
  // Prefer the tab recording actually happened on (rec.tabId) over
  // "whichever tab is active right now" — the stop can come from the
  // floating on-page button while a different tab has focus.
  const targetTabId = (rec && rec.tabId != null) ? rec.tabId : (await currentTab())?.id;
  if (targetTabId != null) {
    chrome.tabs.sendMessage(targetTabId, { cmd: 'setRecording', active: false }).catch(() => {});
  }
  return { ok: true, steps: rec ? rec.steps : [] };
}

// Lets the keyboard shortcut (see manifest "commands") start/stop recording
// without opening the popup at all.
chrome.commands.onCommand.addListener((command) => {
  if (command !== 'toggle-recording') return;
  (async () => {
    const rec = await get('recording', null);
    if (rec && rec.active) await stopRecordingCore();
    else await startRecordingCore();
  })().catch((e) => {
    logError({ ts: new Date().toISOString(), cmd: 'toggle-recording', error: String((e && e.message) || e) }).catch(() => {});
  });
});

// ---------- message router ----------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg.cmd) {
        case 'recordStep': {
          const step = Object.assign({}, msg.step);
          // Non-zero frameId means the interaction happened inside an
          // iframe; replay needs this to target the right frame later.
          if (sender && typeof sender.frameId === 'number' && sender.frameId !== 0) {
            step.frameId = sender.frameId;
          }
          await appendStep(step);
          return sendResponse({ ok: true });
        }

        case 'startRecording':
          return sendResponse(await startRecordingCore());

        case 'stopRecording':
          return sendResponse(await stopRecordingCore());

        case 'getRecording':
          return sendResponse({ ok: true, recording: await get('recording', null) });

        case 'discardRecording':
          await set({ recording: null });
          return sendResponse({ ok: true });

        case 'saveFlow': {
          const rec = await get('recording', null);
          const flows = await get('flows', []);
          const settings = await get('settings', { storeSecrets: false });

          const name = (msg.name || '').trim() || ('Flow ' + new Date().toLocaleString());
          if (isDuplicateFlowName(flows, name, null)) {
            return sendResponse({
              ok: false,
              error: 'A saved flow named "' + name + '" already exists. Choose a different name.',
              duplicate: true
            });
          }

          let steps = (rec && rec.steps) ? rec.steps : [];
          if (!settings.storeSecrets) {
            steps = steps.map((s) => (s.secret ? Object.assign({}, s, { value: '' }) : s));
          }

          const flow = {
            id: crypto.randomUUID(),
            name,
            startUrl: (rec && rec.startUrl) ? rec.startUrl : '',
            steps,
            createdAt: Date.now()
          };
          flows.push(flow);
          await set({ flows });
          await set({ recording: null });
          return sendResponse({ ok: true, flow });
        }

        case 'getFlows':
          return sendResponse({ ok: true, flows: await get('flows', []) });

        case 'deleteFlow': {
          let flows = await get('flows', []);
          flows = flows.filter((f) => f.id !== msg.id);
          await set({ flows });
          const dataFiles = await get('dataFiles', {});
          if (dataFiles[msg.id]) {
            delete dataFiles[msg.id];
            await set({ dataFiles });
          }
          return sendResponse({ ok: true });
        }

        // "Run with data" state — which flows currently have a validated
        // data file associated, so the popup can show a DATA badge and a
        // one-click "Run data" button on the flow card. The expanded rows
        // (each row repeated per its own Repeat column) are kept here too,
        // so that button can fire immediately without re-picking the file.
        case 'getFlowDataFiles':
          return sendResponse({ ok: true, dataFiles: await get('dataFiles', {}) });

        case 'saveFlowDataFile': {
          const dataFiles = await get('dataFiles', {});
          // Explicitly drop whatever was there before writing the new
          // entry, so nothing from a previous upload can ever survive a
          // replacement (belt-and-suspenders on top of the plain
          // reassignment below, which already fully replaces it).
          delete dataFiles[msg.flowId];
          dataFiles[msg.flowId] = {
            fileName: msg.fileName,
            rowCount: msg.rowCount,
            runCount: msg.runCount,
            rows: Array.isArray(msg.rows) ? msg.rows : [],
            savedAt: Date.now()
          };
          await set({ dataFiles });
          return sendResponse({ ok: true });
        }

        case 'clearFlowDataFile': {
          const dataFiles = await get('dataFiles', {});
          if (dataFiles[msg.flowId]) {
            delete dataFiles[msg.flowId];
            await set({ dataFiles });
          }
          return sendResponse({ ok: true });
        }

        case 'renameFlow': {
          const flows = await get('flows', []);
          const f = flows.find((x) => x.id === msg.id);
          if (!f) return sendResponse({ ok: false, error: 'Flow not found' });

          const name = (msg.name || '').trim() || f.name;
          if (isDuplicateFlowName(flows, name, f.id)) {
            return sendResponse({
              ok: false,
              error: 'A saved flow named "' + name + '" already exists. Choose a different name.',
              duplicate: true
            });
          }

          f.name = name;
          await set({ flows });
          return sendResponse({ ok: true });
        }

        case 'updateFlowSteps': {
          const flows = await get('flows', []);
          const f = flows.find((x) => x.id === msg.id);
          if (!f) return sendResponse({ ok: false, error: 'Flow not found' });
          if (!Array.isArray(msg.steps)) return sendResponse({ ok: false, error: 'Invalid steps' });
          f.steps = msg.steps;
          if (typeof msg.startUrl === 'string') f.startUrl = msg.startUrl;
          await set({ flows });
          return sendResponse({ ok: true });
        }

        case 'updateRecordingSteps': {
          const rec = await get('recording', null);
          if (!rec) return sendResponse({ ok: false, error: 'No recording in progress' });
          if (!Array.isArray(msg.steps)) return sendResponse({ ok: false, error: 'Invalid steps' });
          rec.steps = msg.steps;
          if (typeof msg.startUrl === 'string') { rec.startUrl = msg.startUrl; rec.lastUrl = msg.startUrl; }
          await set({ recording: rec });
          return sendResponse({ ok: true });
        }

        case 'duplicateFlow': {
          const flows = await get('flows', []);
          const f = flows.find((x) => x.id === msg.id);
          if (!f) return sendResponse({ ok: false, error: 'Flow not found' });
          const base = f.name + ' (copy)';
          let name = base;
          let n = 2;
          while (isDuplicateFlowName(flows, name, null)) { name = base + ' ' + n; n++; }
          const copy = {
            id: crypto.randomUUID(),
            name,
            startUrl: f.startUrl,
            steps: JSON.parse(JSON.stringify(f.steps)),
            createdAt: Date.now()
          };
          flows.push(copy);
          await set({ flows });
          return sendResponse({ ok: true, flow: copy });
        }

        case 'importFlows': {
          const flows = await get('flows', []);
          const incoming = Array.isArray(msg.flows) ? msg.flows : [];
          let count = 0, skipped = 0, duplicates = 0;
          for (const f of incoming) {
            if (!f || !Array.isArray(f.steps)) { skipped++; continue; }
            // Only keep known step shapes; drop anything unexpected.
            const KNOWN_TYPES = ['click', 'input', 'setChecked', 'wait', 'assertVisible', 'assertText', 'keypress', 'fileUpload', 'navigate'];
            const steps = f.steps
              .filter((s) => s && KNOWN_TYPES.includes(s.type) &&
                (s.type === 'wait' || s.type === 'navigate' || typeof s.selector === 'string'))
              .map((s) => ({
                type: s.type,
                selector: s.selector || '',
                value: s.value != null ? String(s.value) : '',
                checked: !!s.checked,
                secret: !!s.secret,
                credentialType: s.credentialType || '',
                inputType: s.inputType || '',
                tag: s.tag || '',
                text: s.text || '',
                url: s.url || '',
                ms: s.ms != null ? Number(s.ms) || 0 : undefined,
                expectedText: s.expectedText != null ? String(s.expectedText) : undefined,
                matchMode: s.matchMode || undefined,
                key: s.key || undefined
              }));
            if (!steps.length) { skipped++; continue; }

            const name = (f.name ? String(f.name).trim() : '') || 'Imported flow';
            // Re-importing a file already imported (or one that collides with
            // an existing flow) would otherwise silently create a duplicate —
            // skip it and let the caller report it instead.
            if (isDuplicateFlowName(flows, name, null)) { duplicates++; continue; }

            flows.push({
              id: crypto.randomUUID(),
              name,
              startUrl: f.startUrl ? String(f.startUrl) : '',
              steps,
              createdAt: Date.now()
            });
            count++;
          }
          await set({ flows });
          return sendResponse({ ok: true, count, skipped, duplicates });
        }

        case 'runFlow': {
          // dataUpload.html (the "Run with data" file picker — see
          // popup.js's openDataRun) runs in its own tab, not this popup, so
          // by the time it sends this, ITS tab is "current" — the actual
          // target tab has to be passed explicitly instead.
          let tab;
          if (msg.tabId != null) {
            try { tab = await chrome.tabs.get(Number(msg.tabId)); } catch (e) { tab = null; }
          } else {
            tab = await currentTab();
          }
          if (!tab || tab.id == null) return sendResponse({ ok: false, error: 'No active tab' });

          // A flow with its own (injectable) start URL will navigate the tab
          // there before touching the page, so it can be launched from a
          // blank/system tab (e.g. a fresh new tab) just fine. Only flows
          // with no start URL need the current tab to already be a real page.
          const flows = await get('flows', []);
          const flow = flows.find((f) => f.id === msg.flowId);
          const willNavigate = !!(flow && flow.startUrl && injectable(flow.startUrl));
          if (!willNavigate && !injectable(tab.url)) {
            return sendResponse({ ok: false, error: NOT_INJECTABLE_MSG });
          }

          sendResponse({ ok: true }); // ack now; progress comes via replayEvent
          runFlow(msg, tab.id);       // fire-and-forget
          return;
        }

        case 'stopReplay':
          if (replayCtrl) { replayCtrl.stop = true; if (replayCtrl.resume) replayCtrl.resume(); }
          return sendResponse({ ok: true });

        case 'resumeReplay':
          if (replayCtrl && replayCtrl.resume) replayCtrl.resume();
          return sendResponse({ ok: true });

        case 'getLogs':
          return sendResponse({
            ok: true,
            runLogs: await get('runLogs', []),
            errorLogs: await get('errorLogs', [])
          });

        case 'clearLogs':
          await set({ runLogs: [], errorLogs: [] });
          return sendResponse({ ok: true });

        // Drops every cached "Run with data" file (uploaded Excel/CSV/JSON
        // rows kept per-flow so "Run data" can fire without re-picking the
        // file). These can pile up as stale/garbage row data across many
        // flows over time; this wipes all of them in one click instead of
        // clearing each flow's data file individually.
        case 'clearCache':
          await set({ dataFiles: {} });
          return sendResponse({ ok: true });

        default:
          return sendResponse({ ok: false, error: 'unknown cmd' });
      }
    } catch (e) {
      const message = String((e && e.message) || e);
      logError({ ts: new Date().toISOString(), cmd: msg.cmd, error: message }).catch(() => {});
      sendResponse({ ok: false, error: message });
    }
  })();
  return true; // async response
});
