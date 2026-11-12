# Security & privacy

Back to the [README](../README.md).

## Passwords / secrets

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

> **Note:** the setting is applied when a recording is *saved*. Turning it off later does not remove credentials from flows that were already saved with it on — re-record such a flow with the option off and delete the old one before sharing or exporting.

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
  project, including [`xlsx-lite.js`](architecture.md#files) (a minimal `.xlsx`
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
