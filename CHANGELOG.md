# Changelog

## Unreleased

- **Key press** can now be added from **Add step** (Enter / Escape / Tab). With no selector it presses the key on the focused element.
- **Remember this file** option in the file-upload prompt: the file (max 2 MB) is stored with the flow so later and unattended runs don't prompt again. Embedded in exports; removable in Edit steps.

## 1.1.0 — Version 1 (Beta)

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
