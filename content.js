// content.js — records user interactions while recording is active.
// Replay is handled separately by background.js via chrome.scripting, so this
// script only needs to CAPTURE events, not replay them.
(() => {
  // Guard against being injected twice (manifest + programmatic inject).
  if (window.__flowRecorderLoaded) return;
  window.__flowRecorderLoaded = true;

  let recording = false;
  let replaying = false;

  // Covers native controls plus common ARIA widget roles used by custom
  // dropdowns, popup menus, comboboxes, and radio/checkbox-style controls
  // that aren't built from real <input> elements.
  const CLICKABLE =
    'a,button,input,select,textarea,label,summary,details,' +
    '[role="button"],[role="link"],[role="tab"],[role="option"],[role="menuitem"],' +
    '[role="menuitemradio"],[role="menuitemcheckbox"],[role="checkbox"],[role="radio"],' +
    '[role="switch"],[role="combobox"],[onclick]';

  function escAttr(v) {
    return String(v).replace(/["\\]/g, '\\$&');
  }

  // Build a reasonably-stable CSS selector for an element.
  function getSelector(el) {
    if (!(el instanceof Element)) return null;

    // 1) A unique id.
    if (el.id && safeUnique('#' + CSS.escape(el.id))) {
      return '#' + CSS.escape(el.id);
    }

    // 2) A unique stable attribute.
    const attrs = [
      'data-testid', 'data-test', 'data-cy', 'data-qa',
      'name', 'aria-label', 'placeholder'
    ];
    for (const a of attrs) {
      const v = el.getAttribute && el.getAttribute(a);
      if (v) {
        const sel = el.tagName.toLowerCase() + '[' + a + '="' + escAttr(v) + '"]';
        if (safeUnique(sel)) return sel;
      }
    }

    // 3) A structural path using :nth-of-type, stopping at the nearest id.
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && node !== document.documentElement) {
      if (node.id && safeUnique('#' + CSS.escape(node.id))) {
        parts.unshift('#' + CSS.escape(node.id));
        break;
      }
      let part = node.tagName.toLowerCase();
      const parent = node.parentElement;
      if (parent) {
        const sameTag = Array.prototype.filter.call(
          parent.children, (c) => c.tagName === node.tagName
        );
        if (sameTag.length > 1) {
          part += ':nth-of-type(' + (sameTag.indexOf(node) + 1) + ')';
        }
      }
      parts.unshift(part);
      node = node.parentElement;
    }
    return parts.join(' > ');
  }

  function safeUnique(sel) {
    try { return document.querySelectorAll(sel).length === 1; }
    catch (e) { return false; }
  }

  function record(step) {
    step.url = location.href;
    step.ts = Date.now();
    try { chrome.runtime.sendMessage({ cmd: 'recordStep', step }); } catch (e) {}
  }

  // Arm/disarm the MAIN-world dialog guard (dialog-guard.js) via postMessage
  // — content scripts in the isolated world can't reach page globals directly.
  function armGuard(active) {
    window.postMessage({ __flowRecorderGuard: true, active: !!active }, '*');
  }

  // The guard reports intercepted alert/confirm/prompt calls back here so
  // they can be recorded as a step (only while actively recording).
  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    const data = e.data;
    if (!data || data.__flowRecorderDialog !== true) return;
    if (!recording) return;
    record({
      type: 'dialog',
      dialogType: data.dialogType,
      message: (data.message || '').slice(0, 200),
      answer: data.answer
    });
  });

  function resolveTarget(rawTarget) {
    return (rawTarget.closest && rawTarget.closest(CLICKABLE)) || rawTarget;
  }

  function describeTarget(target) {
    const sel = getSelector(target);
    if (!sel) return null;
    return {
      selector: sel,
      tag: target.tagName ? target.tagName.toLowerCase() : '',
      text: ((target.innerText || target.value || '') + '').trim().slice(0, 80)
    };
  }

  // Custom dropdown/menu widgets (select2, chosen, and similar libraries)
  // often finalize an option selection on 'mousedown' — sometimes removing
  // the option from the DOM immediately — so the 'click' event that would
  // normally fire on mouseup never happens and the selection is silently
  // lost. To catch these, every mousedown is tentatively recorded; if a
  // matching 'click' follows shortly after (the normal case for ordinary
  // buttons/links), the mousedown record is cancelled so nothing is
  // duplicated. If no click follows, the mousedown recording stands in for it.
  let lastMouseDown = null;

  // Interactions with our own floating recorder/replay widgets (dragging
  // them, clicking Stop) must never be captured as steps of the flow itself.
  function isOverlayEvent(e) {
    if (!overlayHost && !replayOverlayHost) return false;
    if (typeof e.composedPath === 'function') {
      const path = e.composedPath();
      return (!!overlayHost && path.includes(overlayHost)) ||
        (!!replayOverlayHost && path.includes(replayOverlayHost));
    }
    return e.target === overlayHost || e.target === replayOverlayHost;
  }

  function onMouseDown(e) {
    if (!recording || isOverlayEvent(e)) return;
    const target = resolveTarget(e.target);
    const info = describeTarget(target);
    if (!info) return;
    const entry = Object.assign({ handled: false }, info);
    lastMouseDown = entry;
    setTimeout(() => {
      if (!entry.handled) {
        record({ type: 'click', selector: entry.selector, tag: entry.tag, text: entry.text });
      }
    }, 200);
  }

  // Enter/Escape often trigger app behavior (submit a form, close a modal)
  // through a JS keydown handler rather than a click, so they need to be
  // captured as their own step. Tab is deliberately not auto-captured here
  // (it's mostly plain focus navigation and would add noise to every
  // multi-field form) — it can still be added manually via the step editor.
  const RECORDED_KEYS = new Set(['Enter', 'Escape']);

  function onKeyDown(e) {
    if (!recording || isOverlayEvent(e)) return;
    if (!RECORDED_KEYS.has(e.key)) return;
    const target = resolveTarget(e.target);
    const info = describeTarget(target);
    if (!info) return;
    record({ type: 'keypress', key: e.key, selector: info.selector, tag: info.tag, text: info.text });
  }

  function onClick(e) {
    if (!recording || isOverlayEvent(e)) return;
    const target = resolveTarget(e.target);
    const info = describeTarget(target);
    if (!info) return;
    if (lastMouseDown && lastMouseDown.selector === info.selector) {
      lastMouseDown.handled = true;
    }
    record(Object.assign({ type: 'click' }, info));
  }

  // Identify login-credential fields so they get the same "don't store,
  // prompt at run time" treatment as passwords. Password fields are always
  // credentials; text/email fields are only treated as a username when the
  // field's own metadata (autocomplete, id, name, placeholder) says so.
  const USERNAME_HINT = /\b(user(name)?|login|e-?mail|account)\b/i;

  function credentialTypeOf(el, type) {
    if (type === 'password') return 'password';
    if (!['text', 'email', 'tel', ''].includes(type)) return null;

    const autocomplete = (el.getAttribute('autocomplete') || '').toLowerCase();
    if (autocomplete === 'username' || autocomplete === 'email') return 'username';

    const hint = [el.id, el.getAttribute('name'), el.getAttribute('placeholder'), autocomplete]
      .filter(Boolean).join(' ');
    return USERNAME_HINT.test(hint) ? 'username' : null;
  }

  // Capture the final value on 'change' (fires on blur / commit) rather than
  // every keystroke, so replay uses the completed value.
  function onChange(e) {
    if (!recording) return;
    const el = e.target;
    if (!(el instanceof Element)) return;
    const tag = el.tagName.toLowerCase();
    if (!['input', 'select', 'textarea'].includes(tag)) return;

    const type = (el.getAttribute('type') || '').toLowerCase();
    const sel = getSelector(el);
    if (!sel) return;

    if (type === 'checkbox' || type === 'radio') {
      record({ type: 'setChecked', selector: sel, checked: !!el.checked });
    } else if (type === 'file') {
      // The browser only ever exposes a fake path here (e.g.
      // "C:\fakepath\report.xlsx"), never the real file, so there's nothing
      // useful to store at record time — the actual file is picked fresh at
      // run time instead (see runFlow's file-upload prompt).
      record({ type: 'fileUpload', selector: sel });
    } else {
      const credentialType = credentialTypeOf(el, type);
      record({
        type: 'input',
        selector: sel,
        value: el.value,
        secret: !!credentialType,
        credentialType: credentialType || '',
        inputType: type || tag
      });
    }
  }

  function attach() {
    document.addEventListener('mousedown', onMouseDown, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('change', onChange, true);
    document.addEventListener('keydown', onKeyDown, true);
  }
  function detach() {
    document.removeEventListener('mousedown', onMouseDown, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('change', onChange, true);
    document.removeEventListener('keydown', onKeyDown, true);
  }

  // ---------- floating recording indicator (top frame only) ----------
  // The extension's toolbar popup closes as soon as the user clicks into the
  // page, so this on-page widget is what tells them recording is still on,
  // shows a live step count, and lets them stop without reopening the popup.
  let overlayHost = null;
  let overlayCountEl = null;

  // Lets the user click-drag the panel (everywhere except the Stop button)
  // to reposition it; switches from right/bottom to left/top positioning on
  // the first drag so the math is plain pixel math.
  function makeDraggable(panel) {
    let dragging = false;
    let offsetX = 0;
    let offsetY = 0;

    panel.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.stop') || e.target.closest('.play.btn')) return;
      dragging = true;
      panel.classList.add('dragging');
      const rect = panel.getBoundingClientRect();
      offsetX = e.clientX - rect.left;
      offsetY = e.clientY - rect.top;
      panel.style.left = rect.left + 'px';
      panel.style.top = rect.top + 'px';
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
      panel.setPointerCapture(e.pointerId);
    });

    panel.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const maxX = Math.max(0, window.innerWidth - panel.offsetWidth);
      const maxY = Math.max(0, window.innerHeight - panel.offsetHeight);
      panel.style.left = Math.min(Math.max(0, e.clientX - offsetX), maxX) + 'px';
      panel.style.top = Math.min(Math.max(0, e.clientY - offsetY), maxY) + 'px';
    });

    function endDrag(e) {
      if (!dragging) return;
      dragging = false;
      panel.classList.remove('dragging');
      try { panel.releasePointerCapture(e.pointerId); } catch (err) {}
    }
    panel.addEventListener('pointerup', endDrag);
    panel.addEventListener('pointercancel', endDrag);
  }

  function buildOverlay() {
    if (overlayHost) return;
    overlayHost = document.createElement('div');
    overlayHost.style.cssText = 'all:initial;position:fixed;z-index:2147483647;';
    const shadow = overlayHost.attachShadow({ mode: 'open' });
    shadow.innerHTML =
      '<style>' +
      '.panel{position:fixed;right:16px;bottom:16px;display:flex;align-items:center;' +
      'gap:9px;padding:8px 10px 8px 11px;' +
      'background:linear-gradient(180deg,rgba(15,22,40,.92),rgba(9,13,24,.94));' +
      'backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);' +
      'border:1px solid rgba(53,230,255,.22);border-radius:999px;' +
      'box-shadow:0 10px 28px rgba(0,0,0,.5),0 0 0 1px rgba(255,255,255,.02) inset;' +
      'font:600 12px/1.2 ui-monospace,"SF Mono",Consolas,monospace;color:#dbe7f7;' +
      'cursor:grab;user-select:none;touch-action:none;animation:fr-in .2s ease-out;}' +
      '.panel.dragging{cursor:grabbing;}' +
      '@keyframes fr-in{from{opacity:0;transform:translateY(6px);}to{opacity:1;transform:translateY(0);}}' +
      '.grip{display:flex;flex:none;flex-wrap:wrap;width:8px;gap:2px;opacity:.4;}' +
      '.grip i{width:2px;height:2px;border-radius:50%;background:#9fb2d1;}' +
      '.rec{position:relative;width:14px;height:14px;flex:none;' +
      'display:flex;align-items:center;justify-content:center;}' +
      '.rec-ring{position:absolute;inset:0;border-radius:50%;' +
      'background:rgba(255,77,109,.45);animation:fr-pulse 1.6s ease-out infinite;}' +
      '.rec-dot{position:relative;width:7px;height:7px;border-radius:50%;' +
      'background:#ff4d6d;box-shadow:0 0 6px rgba(255,77,109,.9);}' +
      '@keyframes fr-pulse{0%{transform:scale(.5);opacity:.7;}100%{transform:scale(2.1);opacity:0;}}' +
      '.label{white-space:nowrap;letter-spacing:.2px;color:#aebbd4;}' +
      '.count{color:#35e6ff;font-weight:700;}' +
      '.divider{width:1px;height:16px;background:rgba(255,255,255,.08);flex:none;}' +
      '.stop{cursor:pointer;flex:none;display:flex;align-items:center;justify-content:center;' +
      'width:25px;height:25px;border:none;border-radius:50%;' +
      'background:linear-gradient(180deg,#ff7d95,#ff4d6d);color:#1a0308;' +
      'box-shadow:0 2px 10px rgba(255,77,109,.4);' +
      'transition:transform .12s ease,box-shadow .12s ease,filter .12s ease;}' +
      '.stop:hover{filter:brightness(1.08);box-shadow:0 3px 14px rgba(255,77,109,.55);}' +
      '.stop:active{transform:scale(.9);}' +
      '</style>' +
      '<div class="panel">' +
      '<span class="grip" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i></span>' +
      '<span class="rec" title="Recording" aria-hidden="true">' +
      '<span class="rec-ring"></span><span class="rec-dot"></span></span>' +
      '<span class="label"><span class="count">0</span>&nbsp;steps</span>' +
      '<span class="divider"></span>' +
      '<button class="stop" type="button" title="Stop recording" aria-label="Stop recording">' +
      '<svg viewBox="0 0 16 16" width="9" height="9" aria-hidden="true" focusable="false">' +
      '<rect x="1" y="1" width="14" height="14" rx="3" fill="currentColor"/></svg>' +
      '</button>' +
      '</div>';
    const panel = shadow.querySelector('.panel');
    overlayCountEl = shadow.querySelector('.count');
    shadow.querySelector('.stop').addEventListener('click', () => {
      try { chrome.runtime.sendMessage({ cmd: 'stopRecording' }); } catch (e) {}
    });
    makeDraggable(panel);
    (document.body || document.documentElement).appendChild(overlayHost);
  }

  function showOverlay(count) {
    if (window !== window.top) return;
    buildOverlay();
    overlayCountEl.textContent = String(count || 0);
  }

  function hideOverlay() {
    if (overlayHost) overlayHost.remove();
    overlayHost = null;
    overlayCountEl = null;
  }

  function setOverlayCount(count) {
    if (overlayCountEl) overlayCountEl.textContent = String(count);
  }

  // ---------- floating replay indicator (top frame only) ----------
  // Run closes the popup the same way Start Recording does, so this on-page
  // widget is what shows replay progress (which run, which step) and lets
  // the user stop without reopening the popup. It disappears on its own the
  // moment the run finishes.
  let replayOverlayHost = null;
  let replayRunEl = null;
  let replayStepEl = null;
  let replayErrEl = null;
  let replayPanelEl = null;
  let replayPlayEl = null;

  function buildReplayOverlay() {
    if (replayOverlayHost) return;
    replayOverlayHost = document.createElement('div');
    replayOverlayHost.style.cssText = 'all:initial;position:fixed;z-index:2147483647;';
    const shadow = replayOverlayHost.attachShadow({ mode: 'open' });
    shadow.innerHTML =
      '<style>' +
      '.wrap{position:fixed;right:16px;bottom:16px;display:flex;' +
      'flex-direction:column;align-items:flex-end;gap:8px;}' +
      '.panel{display:flex;align-items:center;' +
      'gap:9px;padding:8px 10px 8px 11px;' +
      'background:linear-gradient(180deg,rgba(15,22,40,.92),rgba(9,13,24,.94));' +
      'backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);' +
      'border:1px solid rgba(53,230,255,.25);border-radius:999px;' +
      'box-shadow:0 10px 28px rgba(0,0,0,.5),0 0 0 1px rgba(255,255,255,.02) inset;' +
      'font:600 12px/1.2 ui-monospace,"SF Mono",Consolas,monospace;color:#dbe7f7;' +
      'cursor:grab;user-select:none;touch-action:none;animation:fr-in .2s ease-out;}' +
      '.panel.dragging{cursor:grabbing;}' +
      '.panel.leaving{animation:fr-out .18s ease-in forwards;}' +
      '@keyframes fr-in{from{opacity:0;transform:translateY(6px);}to{opacity:1;transform:translateY(0);}}' +
      '@keyframes fr-out{to{opacity:0;transform:translateY(6px);}}' +
      '.grip{display:flex;flex:none;flex-wrap:wrap;width:8px;gap:2px;opacity:.4;}' +
      '.grip i{width:2px;height:2px;border-radius:50%;background:#9fb2d1;}' +
      '.play{position:relative;width:14px;height:14px;flex:none;' +
      'display:flex;align-items:center;justify-content:center;}' +
      '.play.btn{border:none;background:none;padding:0;cursor:pointer;}' +
      '.paused .play-ring{animation:none;opacity:0;}' +
      '.paused .play{width:22px;height:22px;border-radius:50%;background:rgba(53,230,255,.18);' +
      'box-shadow:0 0 0 1px rgba(53,230,255,.6);}' +
      '.paused .play.btn:hover{background:rgba(53,230,255,.32);}' +
      '.paused .play-tri{width:11px;height:11px;}' +
      '.play-ring{position:absolute;inset:0;border-radius:50%;' +
      'background:rgba(53,230,255,.4);animation:fr-pulse 1.6s ease-out infinite;}' +
      '.play-tri{position:relative;filter:drop-shadow(0 0 4px rgba(53,230,255,.9));}' +
      '@keyframes fr-pulse{0%{transform:scale(.5);opacity:.7;}100%{transform:scale(2.1);opacity:0;}}' +
      '.label{white-space:nowrap;letter-spacing:.2px;color:#aebbd4;}' +
      '.label b{color:#35e6ff;font-weight:700;}' +
      '.mid{margin:0 5px;opacity:.5;}' +
      '.divider{width:1px;height:16px;background:rgba(255,255,255,.08);flex:none;}' +
      '.stop{cursor:pointer;flex:none;display:flex;align-items:center;justify-content:center;' +
      'width:25px;height:25px;border:none;border-radius:50%;' +
      'background:linear-gradient(180deg,#ff7d95,#ff4d6d);color:#1a0308;' +
      'box-shadow:0 2px 10px rgba(255,77,109,.4);' +
      'transition:transform .12s ease,box-shadow .12s ease,filter .12s ease;}' +
      '.stop:hover{filter:brightness(1.08);box-shadow:0 3px 14px rgba(255,77,109,.55);}' +
      '.stop:active{transform:scale(.9);}' +
      // Failure reason — only ever shown while the last step actually
      // failed, so it stays out of the way the rest of the time.
      '.err{display:none;max-width:280px;padding:8px 11px;border-radius:10px;' +
      'background:linear-gradient(180deg,rgba(40,10,16,.92),rgba(26,6,10,.94));' +
      'backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);' +
      'border:1px solid rgba(255,77,109,.45);' +
      'box-shadow:0 10px 24px rgba(0,0,0,.5);' +
      'font:600 11px/1.4 ui-monospace,"SF Mono",Consolas,monospace;color:#ffb3c0;' +
      'animation:fr-in .2s ease-out;word-break:break-word;}' +
      '.err.show{display:block;}' +
      '</style>' +
      '<div class="wrap">' +
      '<div class="err"></div>' +
      '<div class="panel">' +
      '<span class="grip" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i></span>' +
      '<button class="play btn" type="button" title="Replaying" aria-label="Replaying">' +
      '<span class="play-ring"></span>' +
      '<svg class="play-tri" viewBox="0 0 16 16" width="8" height="8" aria-hidden="true" focusable="false">' +
      '<path d="M3 1.5v13l11-6.5z" fill="#35e6ff"/></svg>' +
      '</button>' +
      '<span class="label">Run&nbsp;<b class="run-num">1/1</b><span class="mid">·</span>' +
      'Step&nbsp;<b class="step-num">0/0</b></span>' +
      '<span class="divider"></span>' +
      '<button class="stop" type="button" title="Stop replay" aria-label="Stop replay">' +
      '<svg viewBox="0 0 16 16" width="9" height="9" aria-hidden="true" focusable="false">' +
      '<rect x="1" y="1" width="14" height="14" rx="3" fill="currentColor"/></svg>' +
      '</button>' +
      '</div>' +
      '</div>';
    const panel = shadow.querySelector('.panel');
    replayRunEl = shadow.querySelector('.run-num');
    replayStepEl = shadow.querySelector('.step-num');
    replayErrEl = shadow.querySelector('.err');
    shadow.querySelector('.stop').addEventListener('click', () => {
      try { chrome.runtime.sendMessage({ cmd: 'stopReplay' }); } catch (e) {}
    });
    replayPanelEl = panel;
    replayPlayEl = shadow.querySelector('.play');
    replayPlayEl.addEventListener('click', () => {
      if (!panel.classList.contains('paused')) return;
      panel.classList.remove('paused');
      try { chrome.runtime.sendMessage({ cmd: 'resumeReplay' }); } catch (e) {}
    });
    makeDraggable(panel);
    (document.body || document.documentElement).appendChild(replayOverlayHost);
  }

  function updateReplayOverlay(payload) {
    if (!payload) return;
    if (replayRunEl) replayRunEl.textContent = (payload.iter || 1) + '/' + (payload.total || 1);
    if (replayStepEl) replayStepEl.textContent = (payload.step || 0) + '/' + (payload.steps || 0);
    if (replayPanelEl) {
      const paused = payload.type === 'paused';
      replayPanelEl.classList.toggle('paused', paused);
      replayPlayEl.title = paused ? 'Failed — click to retry this step' : 'Replaying';
      replayPlayEl.setAttribute('aria-label', replayPlayEl.title);
    }
    if (replayErrEl) {
      const failed = payload.last && payload.last.ok === false && payload.last.error;
      replayErrEl.textContent = failed ? payload.last.error : '';
      replayErrEl.classList.toggle('show', !!failed);
    }
  }

  function showReplayOverlay(payload) {
    if (window !== window.top) return;
    buildReplayOverlay();
    updateReplayOverlay(payload);
  }

  function hideReplayOverlay() {
    if (!replayOverlayHost) return;
    const host = replayOverlayHost;
    const panel = host.shadowRoot && host.shadowRoot.querySelector('.panel');
    replayOverlayHost = null;
    replayRunEl = null;
    replayStepEl = null;
    replayErrEl = null;
    if (panel) {
      panel.classList.add('leaving');
      setTimeout(() => host.remove(), 180);
    } else {
      host.remove();
    }
  }

  // ---------- inline file-upload prompt (top frame only) ----------
  // A script can never recover what was picked at record time for a file
  // input (browsers only expose a fake path), and picking one from inside
  // the extension's own popup closes the popup before the pick can finish
  // (native OS file dialogs steal window focus, which Chrome treats as the
  // popup losing focus). Asking right here, on the actual page, sidesteps
  // that entirely — it's a normal in-page interaction, not an extension
  // window of any kind.
  function promptFileUpload(selector) {
    return new Promise((resolve) => {
      if (window !== window.top) { resolve({ ok: false }); return; }
      const host = document.createElement('div');
      host.style.cssText = 'all:initial;position:fixed;z-index:2147483647;';
      const shadow = host.attachShadow({ mode: 'open' });
      shadow.innerHTML =
        '<style>' +
        '.backdrop{position:fixed;inset:0;display:flex;align-items:center;' +
        'justify-content:center;background:rgba(6,9,18,.55);' +
        'font:13px/1.45 ui-sans-serif,system-ui,sans-serif;animation:fu-in .15s ease-out;}' +
        '@keyframes fu-in{from{opacity:0;}to{opacity:1;}}' +
        '.card{width:320px;padding:16px 18px;border-radius:14px;' +
        'background:linear-gradient(180deg,rgba(15,22,40,.97),rgba(9,13,24,.98));' +
        'border:1px solid rgba(53,230,255,.3);' +
        'box-shadow:0 20px 60px rgba(0,0,0,.6);color:#dbe7f7;}' +
        '.card strong{display:block;margin-bottom:4px;color:#eaf3ff;}' +
        '.sel{font:11px ui-monospace,"SF Mono",Consolas,monospace;color:#8fa2c2;' +
        'word-break:break-all;margin-bottom:12px;}' +
        'input[type=file]{width:100%;font:12px sans-serif;color:#dbe7f7;}' +
        '.row{display:flex;gap:8px;justify-content:flex-end;margin-top:14px;}' +
        'button{cursor:pointer;border:none;border-radius:8px;padding:7px 14px;' +
        'font:600 12px ui-sans-serif,sans-serif;}' +
        '.cancel{background:rgba(255,255,255,.08);color:#dbe7f7;}' +
        '.ok{background:linear-gradient(180deg,#35e6ff,#20b8d6);color:#00232b;}' +
        '.ok:disabled{opacity:.4;cursor:not-allowed;}' +
        '</style>' +
        '<div class="backdrop"><div class="card">' +
        '<strong>Flowcraft needs a file</strong>' +
        '<div class="sel"></div>' +
        '<input type="file">' +
        '<div class="row">' +
        '<button class="cancel" type="button">Cancel</button>' +
        '<button class="ok" type="button" disabled>Run</button>' +
        '</div>' +
        '</div></div>';
      shadow.querySelector('.sel').textContent = selector;
      const fileInput = shadow.querySelector('input[type=file]');
      const okBtn = shadow.querySelector('.ok');
      const cancelBtn = shadow.querySelector('.cancel');

      function done(result) {
        host.remove();
        resolve(result);
      }
      fileInput.addEventListener('change', () => { okBtn.disabled = !fileInput.files[0]; });
      cancelBtn.addEventListener('click', () => done({ ok: false }));
      okBtn.addEventListener('click', () => {
        const file = fileInput.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
          const base64 = String(reader.result).split(',', 2)[1] || '';
          done({ ok: true, file: { name: file.name, type: file.type, base64 } });
        };
        reader.onerror = () => done({ ok: false });
        reader.readAsDataURL(file);
      });

      (document.body || document.documentElement).appendChild(host);
    });
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.cmd === 'setRecording') {
      recording = !!msg.active;
      if (recording) attach(); else detach();
      armGuard(recording || replaying);
      if (recording) showOverlay(0); else hideOverlay();
    } else if (msg && msg.cmd === 'setReplaying') {
      replaying = !!msg.active;
      armGuard(recording || replaying);
      if (!replaying) hideReplayOverlay();
    } else if (msg && msg.cmd === 'stepCount') {
      setOverlayCount(msg.count);
    } else if (msg && msg.cmd === 'replayProgress') {
      if (msg.payload && msg.payload.type === 'done') {
        hideReplayOverlay();
      } else {
        showReplayOverlay(msg.payload);
      }
    } else if (msg && msg.cmd === 'promptFileUpload') {
      promptFileUpload(msg.selector).then(sendResponse);
      return true; // async response
    }
  });

  // Resume recording/replay automatically after a navigation reloads this script.
  chrome.storage.local.get(['recording', 'replayRunning', 'replayStatus']).then(
    ({ recording: rec, replayRunning, replayStatus }) => {
      if (rec && rec.active) {
        recording = true;
        attach();
        armGuard(true);
        showOverlay(rec.steps ? rec.steps.length : 0);
      }
      if (replayRunning) {
        replaying = true;
        armGuard(recording || replaying);
        showReplayOverlay(replayStatus);
      }
    }
  );
})();
