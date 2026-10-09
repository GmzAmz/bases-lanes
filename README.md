# Bases Lanes

A timeline view for [Obsidian Bases](https://help.obsidian.md/bases). Rows come from the base's own group-by,
every row can hold many notes, and a note whose group-by value is a list (e.g. several assignees) appears in
each of those rows. Made for "who's on what, when", but it works for any notes with a start (and optional end)
date or date-and-time.

## Setup

1. Install the plugin (see [Installing](#installing)) and enable it.
2. In a base, add a view and choose **Lanes**.
3. In the view options pick a **Start** property, and optionally an **End** property.
4. Use the toolbar's **Sort → Group by** to choose what the rows are. Grouping by a list property puts a note in
   one row per value.

## Using it

| Action | How |
|---|---|
| Pan left / right | Mouse wheel over the timeline, or middle-drag |
| Scroll rows | Mouse wheel over the row names (or shift + wheel) |
| Zoom | Ctrl + wheel (or pinch) |
| Open a note | Click its bar (ctrl/cmd + click: new tab). Right-click for the usual note menu |
| Move / reschedule | Drag a bar. Drag up or down to move it to another row (rewrites the group-by value) |
| Change start / end | Drag the left or right edge of a bar |
| Create an event | Drag across an empty part of a row. The note is pre-filled with the dates and the row's value |
| Undo | Ctrl/cmd + Z (moves, row changes and creations) |
| Cancel a drag | Escape, or release outside the view |
| Resize the row-name column | Drag its edge; double-click to fit |

Date-only values snap to whole days; date-and-time values snap to whole hours and keep their minutes.
Values are written back in the format they were read in.

## Properties the view understands

Each can be a property on the note or a base formula of the same name (the formula wins).

| Name | Effect |
|---|---|
| `lanes_title` | Text shown on the bar instead of the file name, e.g. `'"[" + status + "] " + file.basename'` |
| `lanes_color` | Any CSS colour for the bar |
| `lanes_bucket_color` | Notes with the same value get the same colour from a fixed palette, e.g. `file.tags` |
| `lanes_group` | Groups rows into collapsible sections, e.g. `assigned.map(value.asFile().properties.department)`. A list puts a row in several sections |

Checked properties (toolbar **Properties**) are shown as lines under the bar's title.

## Slow or unreliable drives

Saves run in the background. A save that is still running is shown striped; after a few seconds a notice
explains that it isn't saved yet. Failed saves are retried automatically, and if they keep failing the change
stays on screen with **Retry** / **Discard** buttons, so a dropped connection never silently loses or doubles
an edit.

## Installing

Download `main.js`, `manifest.json` and `styles.css` from the latest
[release](../../releases/latest) into `<vault>/.obsidian/plugins/bases-lanes/`, then enable **Bases Lanes** in
Settings → Community plugins. Requires Obsidian 1.10 or later.

## Development

```sh
npm install
npm run dev     # rebuild on change
npm run build   # type-check and production build
```

`scripts/gen-perf.mjs` generates a large test dataset (100 people, ~5,000 events). Run it with Obsidian closed.

Releases are built by GitHub Actions when a version tag (e.g. `0.1.0`) is pushed.

## License

MIT
