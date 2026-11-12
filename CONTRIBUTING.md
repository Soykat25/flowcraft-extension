# Contributing to Flowcraft

Thanks for helping out! Flowcraft is plain JS/HTML/CSS with **no build step and no dependencies** — please keep it that way.

## Run it locally

1. Fork and clone the repo.
2. `chrome://extensions` → **Developer mode** → **Load unpacked** → select the folder.
3. After editing, click the reload icon on Flowcraft's card (an open popup won't pick up changes).

## Before opening a PR

- Syntax-check changed files: `node --check popup.js` (likewise for the others).
- Test the affected flow by hand: record → save → run, and a data-driven run if you touched that code.
- Don't add third-party code or network requests. The extension has `<all_urls>` access, so this is a hard rule.
- Keep PRs small and focused; describe what you tested.
- Never commit exported flows, data templates or run-history JSON — they can contain credentials or screenshots.

## Reporting bugs

Use the issue templates. Include browser + version, the site type (if shareable), and the steps that failed.
