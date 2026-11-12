# Flowcraft

> **Status: Beta.** Flowcraft works and is actively used, but it hasn't had a
> wide audit and its data formats/behavior may still change between
> versions. Read [Security & privacy](#security--privacy) before pointing it
> at anything sensitive.

A Chrome/Edge (Manifest V3) extension that records your clicks and form
inputs on any site, saves them as named **flows**, and replays a flow a
configurable number of times — optionally driven by a spreadsheet of
per-run data. It's a personal test-automation helper in the spirit of
Selenium IDE / iMacros, built to run entirely client-side with no backend
and no third-party dependencies.

## Table of contents

- [Install](#install-unpacked)
- [Quick start](#quick-start)
- [Popup reference](#popup-reference) — what every button does
- [Data-driven replay](#data-driven-replay)
- [Step editor](#step-editor)
- [Passwords / secrets](#passwords--secrets-read-this)
- [Security & privacy](#security--privacy)
- [How it works](#how-it-works)
- [Known limitations](#known-limitations)
- [Files](#files)
- [Changelog](#changelog)

## Install (unpacked)

1. Open `chrome://extensions` (or `edge://extensions`).
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select this extension's folder.
4. Pin the extension so its icon is visible.

There's no build step — every file is plain, unminified JS/HTML/CSS, loaded
directly by the manifest. After pulling changes (including from this repo),
click the reload icon on Flowcraft's card at `chrome://extensions` — an
already-open popup does **not** pick up new code on its own.

## Quick start

1. Open the page you want to start from, click the extension icon, then
   **● Start recording**. Click buttons, fill in fields — Flowcraft records
   them as steps.
2. Click **Stop**, give the flow a name, and **Save flow**.
3. Set **Repeat** / **Delay between steps**, then click **Run** on the saved
   flow. A small floating widget on the page shows progress; the popup
   itself closes so it isn't in the way.

## Popup reference

### Record / Save panel

| Control | What it does |
|---|---|
| **● Start recording** | Begins recording clicks, form input, checkbox/radio toggles, `Enter`/`Escape` key presses, and native dialogs on the active tab. Closes the popup — an on-page floating widget takes over, showing a live step count with its own **Stop** button. |
| **Ctrl+Shift+E** (**⌘⇧E** on Mac) | Keyboard shortcut that starts/stops recording on the active tab without opening the popup at all. Remappable at `chrome://extensions/shortcuts`. |
| **Stop** | Ends recording. The popup then shows the **Save** view. |
| **Save flow** | Saves the recording under the typed name. Names must be unique (case-insensitive) — a duplicate name shows an inline error and blocks the save until changed. |
| **Edit steps** | Opens the [step editor](#step-editor) on the just-recorded (not-yet-saved) steps, so you can fix a step before it's ever saved. |
| **Discard** | Throws away the current recording without saving. |

### Saved flows

| Control | What it does |
|---|---|
| **Bulk export** | Opens a checklist of your saved flows and downloads the selected ones as one JSON file. |
| **Import** | Loads flows from a JSON file (single-flow export or bulk export). Each imported flow gets a fresh ID; a flow whose name collides with one you already have is skipped (reported in a summary), so re-importing the same file twice never creates duplicates. |
| **Run** | Runs the flow: navigates the active tab to its recorded start URL, replays each step, repeating **Repeat** times with **Delay between steps** between actions. Prompts for any unstored username/password fields first. Closes the popup so the on-page progress widget can take over. |
| **Run data** *(only shown once a data file is set up for this flow — see below)* | Runs the flow using the last file uploaded via **Run with data**, exactly as that file specifies — every row, repeated per its own **Repeat** column — with no dependency on the popup's own **Repeat** field. Shows a confirmation with the filename and the first run's actual values before anything happens on the page. |
| **DATA** badge | Appears once a data file has been validated for this flow (filename + row count on hover). Click **✕** on it to remove the stored file (this also hides **Run data**). |
| ✏️ **Rename** | Renames the flow (same uniqueness rule as saving). |
| **Edit steps** | Opens the [step editor](#step-editor) on this saved flow's steps: reorder, edit a selector/value, delete a step, or add a manual **Wait**/**Assert** step. |
| **Run with data** (grid-lines icon) | Opens the data-run picker — see [Data-driven replay](#data-driven-replay). |
| **Download data template** (Excel icon) | Downloads a ready-to-fill `.xlsx` for this specific flow — one column per input/checkbox step's selector (pre-filled with its currently recorded value) plus a **Repeat** column. |
| **Duplicate** | Clones the flow (steps + start URL) under an auto-suffixed name (`… (copy)`), so you can branch it without re-recording. Does not carry over an associated data file. |
| **Export** | Downloads this one flow as its own JSON file, named after the flow. |
| 🗑️ **Delete** | Deletes the flow (confirmation required) and any data file associated with it. |

### Run settings

| Control | What it does |
|---|---|
| **Repeat** | Number of times a plain **Run** repeats. For a **Run with data** session, it instead *caps* how many of the file's expanded rows run (see [Data-driven replay](#data-driven-replay)); left at its default of `1`, it caps nothing. Has no effect on **Run data**, which always runs exactly what the file specifies. |
| **Delay between steps (ms)** | Extra pause after each step, on top of the fixed settling time already built into replay. Raise this for slow/async pages. |
| **Store usernames/passwords inside saved flows** | Off by default. See [Passwords / secrets](#passwords--secrets-read-this). |
| **Retry a failed step once before giving up** | Off by default. If a step fails, wait 500&nbsp;ms and try it exactly once more before recording it as a failure. |
| **Stop replay** | Appears only while a run is in progress; stops it after the current step. |
| Status line | Live progress ("Run 2/5 · step 8/12"), or the final "Finished!" / "Stopped." / error state. |

### Run history

| Control | What it does |
|---|---|
| **Show / Hide** | Expands/collapses the history panel. |
| **Clear** | Wipes all stored run and error history. |
| **Save this run** *(per run)* | Downloads just that one run — its steps/results plus its failure screenshots and errors — as a standalone JSON file. |
| Screenshot **Copy image** / **Save image** | On a failed step's screenshot: copy it to the clipboard (as PNG, ready to paste) or save it as its own `.jpg`. Clicking the thumbnail opens it full-size in a new tab. |

## Data-driven replay

Each flow can be run once per row of a spreadsheet instead of replaying the
same recorded values every time.

1. Click the Excel icon (**Download data template**) on a flow — it downloads
   a `.xlsx` with one column per input/checkbox step's selector, pre-filled
   with that step's currently recorded value, plus a **Repeat** column.
2. Edit that file — one row per run, and (optionally) a **Repeat** value per
   row to run that row more than once, e.g. row 1 `Repeat=1` + row 2
   `Repeat=2` expands to 3 runs: row 1, row 2, row 2.
3. Click **Run with data** (grid icon) on the same flow and pick the edited
   file.

**The file must be named exactly** what "Download template" produced (e.g.
`dv-data-template.xlsx`) — a file for a different flow, or a browser-renamed
duplicate like `dv-data-template (1).xlsx` from downloading the template
twice, is rejected rather than silently used. This is deliberate: it's the
main guard against accidentally running one flow with another's (or a
stale) dataset. CSV and JSON files work too as a fallback, using the same
naming rule with their own extension.

Once a file is accepted:
- A yellow **DATA** badge appears on the flow, and a **Run data** button
  appears next to **Run** — this runs the stored file directly (every row,
  repeated per its own **Repeat** column), with **no dependency on the
  popup's Repeat field**, and shows a confirmation of the filename/values
  before running.
- Alternatively, clicking **Run** inside the **Run with data** modal uses
  the popup's own **Repeat** field as a cap on the file's expanded run
  sequence — left at its default of `1`, nothing is capped; set it above 1
  to only run the first *N* of the sequence, in file order.
- Uploading a new file for the same flow always **fully replaces** the
  previous one (never merges) — clicking the badge's **✕** clears it
  outright.

Reading and writing `.xlsx` is handled by [`xlsx-lite.js`](#files), a small,
dependency-free reader/writer written specifically for this extension — see
[Security & privacy](#security--privacy) for why that matters.

## Step editor

Opened via the pencil-and-ruler **Edit steps** icon (on a saved flow, or on
a pending recording before it's even saved). Lets you reorder steps
(↑/↓), delete a step, edit a step's selector/value/checked state, and add
manual steps that can't be captured by recording alone:

| Step type | Captured by recording? | What it does on replay |
|---|---|---|
| `click` | Yes | Clicks the element (full pointer/mouse event sequence, with a text-based fallback if the selector no longer resolves). |
| `input` | Yes | Sets a text/number/date/etc. field's value, dispatching `input`/`change` so React-style forms register it. |
| `setChecked` | Yes | Sets a checkbox/radio/switch's checked state. |
| `keypress` | `Enter` / `Escape` only (auto-captured); `Tab` can be added manually | Dispatches a real `keydown`/`keypress`/`keyup` sequence for the given key. Reaches JS `keydown` listeners, but — being synthetic — won't trigger a browser's *native* default action (e.g. a plain `<form>` submitting on Enter with no JS involved). |
| `dialog` | Yes (informational) | Not replayed — `alert`/`confirm`/`prompt` calls are auto-handled during recording/replay by `dialog-guard.js`; this step just records that one happened. |
| `wait` | No — add manually | A fixed pause (ms), no page access needed. |
| `assertVisible` | No — add manually | Fails the run if the selector's element isn't found or isn't visible. |
| `assertText` | No — add manually | Fails the run unless an element's text exactly matches (or, in "contains" mode, includes) an expected value. |

## Passwords / secrets (read this)

By default, **credential fields are NOT stored** in saved flows. This covers
password fields, plus username/email fields recognized via
`autocomplete="username"` (or an id/name/placeholder containing "user",
"login", "email", or "account"). These are recorded as steps but their
values are blanked before saving. When you run a flow, the extension
**prompts you for each username/password field** and injects the value only
for that run — nothing is written to disk.

You can turn on **"Store usernames/passwords inside saved flows"** in the
popup. If you do, values are kept in `chrome.storage.local` in
**plaintext**, readable by anyone with access to the browser profile (and
included if you export that flow). Keep this off unless you understand and
accept that.

## Security & privacy

Flowcraft is **beta, single-developer software** — it hasn't been through a
formal security audit. Use it on sites/accounts you're authorized to
automate (your own test/QA environments), and read the points below before
relying on it for anything sensitive.

**Why it needs the permissions it asks for:**

| Permission | Why |
|---|---|
| `storage` | Saved flows, settings, run history, and data-file metadata all live in `chrome.storage.local` (device-local, never synced to a Google account). |
| `scripting` | Injects the recorder into already-open tabs and drives replay by executing a step function in the page. |
| `tabs` / `activeTab` | Find/navigate the active tab, and (during replay) bounce it through `about:blank` before each run for a clean, predictable page load. |
| `unlimitedStorage` | Failure screenshots are stored as data URLs in run history; this avoids hitting Chrome's default storage quota. |
| `host_permissions: <all_urls>` | Recording/replay need to run on whatever site *you* choose to point them at — the extension has no fixed list of target sites. This is the broadest permission it requests; there is no way to record/replay arbitrary sites without it. |
| `commands` | Powers the `Ctrl+Shift+E` recording shortcut. No permission prompt is needed for this one. |

**What Flowcraft does *not* do:**
- No network requests. It never phones home, and there's no analytics/telemetry of any kind — everything above stays in `chrome.storage.local` on your machine.
- No third-party code. Every file in this repo is hand-written for this
  project, including [`xlsx-lite.js`](#files) (a minimal `.xlsx`
  reader/writer implementing just enough of the ZIP container format and
  DEFLATE decompression to read/write flat data tables) — nothing is pulled
  from a CDN or bundled from an npm package. This was a deliberate choice:
  an extension with `<all_urls>` access is exactly the kind of thing you
  don't want carrying unaudited third-party code.
- Native `alert`/`confirm`/`prompt` interception (`dialog-guard.js`) is
  scoped to *only* while actively recording or replaying on that tab —
  outside of that, dialogs behave normally.

**Before you push this repo anywhere public, double-check you're not
committing:**
- Exported flow JSON files (`Export` / `Bulk export`) if you ever enabled
  "Store usernames/passwords" — these contain plaintext credentials.
- Downloaded data templates or data-run spreadsheets (`*-data-template.xlsx`
  and similar) if you filled in real account details, amounts, or other
  sensitive values while testing.
- Any exported run-history JSON (`Save this run`) — it can include failure
  screenshots, which capture whatever was on-screen at the moment of
  failure (this may include on-screen data, though masked password
  `<input>` fields render as dots, not the typed characters).

If any of those exist in your working copy, add them to `.gitignore` or
delete them before committing — none of them are needed for the extension
to run; they're all runtime output.

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

## Known limitations

- **Selectors can break** on sites with random/hashed class names or heavy
  dynamic DOMs. Prefer flows on elements with stable `id` / `data-testid` /
  `name`.
- **Timing:** replay waits for elements to appear, become actionable
  (visible, enabled, no longer moving/animating, not covered by an
  overlay), and for page loads/navigations to finish before moving on —
  Playwright-style auto-waiting. Very async apps may still need a larger
  **Delay** value on top of that.
- **Bot protection / CAPTCHA / 2FA / OTP** will intentionally resist
  automation.
- **New tabs/windows** opened by a click (e.g. `target="_blank"` links,
  `window.open()`) aren't followed during replay — replay keeps driving the
  original tab, so a step that expects the new tab/window will fail to find
  its target there. (Recording itself does pick up actions taken in a
  resulting new tab, since the content script runs in every tab; it's
  specifically automated replay across tabs that isn't supported yet.)
- **Hover-only / drag / canvas** interactions, and keyboard shortcuts other
  than `Enter`/`Escape`, aren't captured; only clicks, field changes, and
  those two keys are.
- **Keypress replay is synthetic**, not OS-level input — see the
  [step editor](#step-editor) table above.
- `xlsx-lite.js` is intentionally minimal: single-sheet, no formulas, no
  styles. It reads real-world Excel/Sheets/LibreOffice output fine, but
  isn't a general spreadsheet engine.

## Files

| File | Purpose |
|---|---|
| `manifest.json` | Extension manifest (MV3) |
| `background.js` | Service worker: state, message routing, and the replay engine |
| `content.js` | Records interactions on the page |
| `dialog-guard.js` | Intercepts native `alert`/`confirm`/`prompt` during recording/replay |
| `xlsx-lite.js` | Dependency-free `.xlsx` reader/writer for data-driven replay |
| `popup.html` / `popup.css` / `popup.js` | Control panel UI |
| `icons/` | Extension icons |

## Changelog

### Version 1 (Beta)

Additions on top of the original recorder/replayer:

- **Step editor** — reorder, edit, or delete any step of a saved (or
  pending) flow; add manual **Wait**, **Assert visible**, and **Assert
  text** steps.
- **Data-driven replay** — **Download template** / **Run with data** /
  **Run data**, backed by a hand-written `.xlsx` reader/writer
  (`xlsx-lite.js`), with a per-row **Repeat** column and a strict
  filename-matching rule so a flow can't accidentally run with the wrong
  dataset.
- **Keyboard steps** — `Enter`/`Escape` are recorded and replayed as real
  keyboard events.
- **Run history panel** — per-run **Save this run**, failure screenshots
  with **Copy image** / **Save image**, and **Clear**.
- **Retry a failed step once** — opt-in setting.
- **Duplicate flow**.
- **`Ctrl+Shift+E`** keyboard shortcut to toggle recording without opening
  the popup.
- General UI pass: per-flow **DATA** badge, equal-sized/centered button
  groups, centered status messages, and other layout/legibility fixes.
