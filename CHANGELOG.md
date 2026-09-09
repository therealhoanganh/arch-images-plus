# Changelog

## 0.2.0 — unreleased

- **AVIF removed.** Chromium cannot encode it (it silently returns a PNG), and
  the ffmpeg fallback hardcoded `libaom-av1` while this machine's ffmpeg carries
  `libsvtav1`, so every AVIF conversion failed. WebP is smaller than JPEG for
  almost everything, so a second lossy format was not worth probing encoder names
  for. Decoding is unaffected: an `.avif` already in the vault still converts.
- The ffmpeg path setting and the whole external-encoder path are gone with it.
  A saved `format: 'avif'` migrates to WebP on load.
- **The rename prompt is now on by default.** Naming an image at the moment of
  pasting is the reason the plugin exists; defaulting it off buried the feature.

## 0.1.0 — unreleased

First working version. Scaffolded to replace **Paste Image Rename** +
**Image Converter**, which conflict because each registers its own
`editor-paste` handler and both save the file.

**Paste and drop**
- A single `editor-paste` / `editor-drop` handler calls `preventDefault()`
  synchronously and then owns the whole pipeline, so there is nothing to race.
- Decode → optional resize to a maximum long edge → encode to WebP, JPEG or PNG
  → name from a template → write → insert the embed.
- Saves run one at a time through a queue, so two images pasted together cannot
  resolve to the same filename.
- Optional rename prompt before the file is written.

**Naming**
- Template tokens: `{{noteName}}`, `{{date}}`, `{{time}}`, `{{year}}`,
  `{{month}}`, `{{day}}`, `{{counter}}`, `{{originalName}}`, `{{width}}`,
  `{{height}}`, `{{ms}}`. An unknown token is left in place rather than blanked,
  so a typo is visible instead of silently collapsing two names into one.
- Names are sanitised against the union of macOS, Windows and Obsidian's own
  illegal characters, so a vault that later syncs to Windows still opens.

**Location**
- Five modes mirroring Obsidian's "Default location for new attachments":
  Obsidian's own setting (default), vault root, same folder, subfolder beside the
  note, or one fixed folder. The folder settings take `{{noteName}}`,
  `{{notePath}}` and `{{date}}`.

**Bulk conversion**
- Commands for the whole vault and for images linked from the active note, plus
  a right-click item on files and folders.
- A preview modal listing what will change and the total size, shown by default.
- Conversion is in place: the file is renamed via `fileManager.renameFile` first,
  so Obsidian rewrites every link including canvas references, and the bytes are
  overwritten afterwards.

**Guards, each of which is deliberate**
- AVIF goes through ffmpeg. Chromium's canvas silently returns a PNG for
  `image/avif`, so the canvas path would write a larger, mislabelled file.
  *(Removed in 0.2.0 — see above.)*
- An image that gets bigger after conversion keeps its original.
- Animated GIF/APNG is left alone; it decodes as a single frame.
- SVG and GIF are excluded from bulk conversion by default.
