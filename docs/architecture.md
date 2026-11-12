# Architecture

Back to the [README](../README.md).

## How it works

- `dialog-guard.js` runs in the page's own JS world (`world: "MAIN"`, every
  frame, at `document_start`) and overrides `window.alert/confirm/prompt`.
  It's a no-op pass-through unless armed, and is armed/disarmed via
  `postMessage` from `content.js`.
- `content.js` records `click`, `change`, and `Enter`/`Escape` `keydown`
  events (plus intercepted dialogs), building a stable-ish CSS selector for
  each element and tagging steps with the frame they happened in. Recording
  state is persisted so it survives page navigations, and content scripts
  run in every frame (`all_frames: true`).
- `background.js` is the service worker: it holds recording state, routes
  every popup↔page message (see the `cmd` switch in
  `chrome.runtime.onMessage`), and drives replay. Before each run (and each
  repeat/data-row iteration) it bounces the tab through `about:blank` then
  to the start URL, guaranteeing a genuine full page load every time. It
  re-arms the dialog guard for the freshly-loaded page, and runs each step
  by injecting a function into the right frame
  (`chrome.scripting.executeScript`, MAIN world, targeted by the step's
  recorded `frameId`) that waits for the target element, then waits for it
  to be actionable (visible, enabled, stable, and — for clicks — not
  covered by another element) before acting, Playwright-actionability-style.
  After a step runs, the background script also watches for and waits out
  any navigation the step triggered before starting the next one. `wait`
  steps are handled directly (no page access needed); a failed step is
  retried once if enabled, and either way a screenshot is captured into the
  error log. `chrome.commands` wires the `Ctrl+Shift+E` shortcut to the same
  start/stop logic the popup uses.
- `popup.*` is the control panel — record/save/run, the step editor,
  data-driven run, and the run-history panel.
- `xlsx-lite.js` is a small, self-contained `.xlsx` reader/writer used only
  by the popup, described above.

## Files

| File | Purpose |
|---|---|
| `manifest.json` | Extension manifest (MV3) |
| `background.js` | Service worker: state, message routing, and the replay engine |
| `content.js` | Records interactions on the page |
| `dialog-guard.js` | Intercepts native `alert`/`confirm`/`prompt` during recording/replay |
| `xlsx-lite.js` | Dependency-free `.xlsx` reader/writer for data-driven replay |
| `popup.html` / `popup.css` / `popup.js` | Control panel UI |
| `dataUpload.html` / `dataUpload.js` | Data-run picker page (file upload, validation, run) |
| `data-helpers.js` | Shared helpers for parsing and validating data files |
| `icons/` | Extension icons |
