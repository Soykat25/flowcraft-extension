# Usage guide

Full reference for every control, data-driven runs and the step editor. Back to the [README](../README.md).

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
| **Edit steps** | Opens the [step editor](#step-editor) on this saved flow's steps: reorder, edit a selector/value, delete a step, or add a manual **Wait**, **Go to URL** or **Assert** step; the **Start URL** field at the top can also be changed. |
| **Run with data** (grid-lines icon) | Opens the data-run picker — see [Data-driven replay](#data-driven-replay). |
| **Download data template** (Excel icon) | Downloads a ready-to-fill `.xlsx` for this specific flow — one column per input/checkbox step's selector (pre-filled with its currently recorded value) plus a **Link** column (a per-row start URL; empty = the flow's own) and a **Repeat** column. |
| **Duplicate** | Clones the flow (steps + start URL) under an auto-suffixed name (`… (copy)`), so you can branch it without re-recording. Does not carry over an associated data file. |
| **Export** | Downloads this one flow as its own JSON file, named after the flow. |
| 🗑️ **Delete** | Deletes the flow (confirmation required) and any data file associated with it. |

### Run settings

| Control | What it does |
|---|---|
| **Repeat** | Number of times a plain **Run** repeats. For a **Run with data** session, it instead *caps* how many of the file's expanded rows run (see [Data-driven replay](#data-driven-replay)); left at its default of `1`, it caps nothing. Has no effect on **Run data**, which always runs exactly what the file specifies. |
| **Delay between steps (ms)** | Extra pause after each step, on top of the fixed settling time already built into replay. Raise this for slow/async pages. |
| **Store usernames/passwords inside saved flows** | Off by default. See [Passwords / secrets](security.md#passwords--secrets). |
| **Retry a failed step once before giving up** | Off by default. If a step fails, wait 500&nbsp;ms and try it exactly once more before recording it as a failure. |
| **Stop replay** | Appears only while a run is in progress; stops it after the current step. |
| Status line | Live progress ("Run 2/5 · step 8/12"), or the final "Finished!" / "Stopped." / error state. |

### Floating run widget

During a run, a draggable pill on the page shows `Run n/N · Step n/N`. Its status button pulses while replaying; if a step fails the run **pauses**, an error line appears, and clicking the button **retries that step**. The red ■ button stops the run.

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
   with that step's currently recorded value, plus a **Link** column (a per-row start URL; empty = the flow's own) and a **Repeat** column.
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

Reading and writing `.xlsx` is handled by [`xlsx-lite.js`](architecture.md#files), a small,
dependency-free reader/writer written specifically for this extension — see
[Security & privacy](security.md) for why that matters.

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
| `navigate` | Auto-recorded for typed/bookmark/redirect URL changes; can be added manually ("Go to URL") | Loads the URL and waits for the page. |
| `fileUpload` | Yes (field only) | You're asked to choose a file on the page; tick **Remember this file** (max 2 MB) to store it in the flow so later runs don't ask. A stored file is embedded in exports and can be removed in Edit steps. |
| `keypress` | `Enter` / `Escape` auto-captured; also add one via **Add step → Key press** (Enter, Escape or Tab; an empty selector presses the key on the focused element) | Dispatches a real `keydown`/`keypress`/`keyup` sequence for the given key. Reaches JS `keydown` listeners, but — being synthetic — won't trigger a browser's *native* default action (e.g. a plain `<form>` submitting on Enter with no JS involved). |
| `dialog` | Yes (informational) | Not replayed — `alert`/`confirm`/`prompt` calls are auto-handled during recording/replay by `dialog-guard.js`; this step just records that one happened. |
| `wait` | No — add manually | A fixed pause (ms), no page access needed. |
| `assertVisible` | No — add manually | Fails the run if the selector's element isn't found or isn't visible. |
| `assertText` | No — add manually | Fails the run unless an element's text exactly matches (or, in "contains" mode, includes) an expected value. |

