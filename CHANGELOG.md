# Changelog








## 0.5.3

- **The Enter or Escape that closes the rename prompt no longer reaches the
  note.** The prompt closed on `keydown`, handing focus back to the editor
  while the same keystroke was still in flight, so the browser typed its
  newline into the note — with the selection snapped to the start of the
  document, above the frontmatter. One blank line per paste, and after a few
  pastes the properties stopped being recognised. The key event is now
  cancelled inside the prompt.
- After the embed is inserted the cursor is placed on the line after it, as
  Obsidian's own paste does, instead of wherever the prompt's focus round-trip
  left it.

## 0.5.2

- **The embed no longer lands wherever the cursor happens to be once the image
  is saved.** It was inserted with `replaceSelection` *after* the conversion and
  the rename prompt, so it went to the cursor position at that moment — and
  after a modal and a re-render of the note that was once three characters
  short of the paste point, inside the closing frontmatter `---`, which broke
  every property in the note. A `[Saving image …]` placeholder is now written
  synchronously at paste time and replaced wherever it is when the save
  finishes; cancelling the prompt or a failed save removes it. If the
  placeholder has been deleted meanwhile, nothing is inserted rather than
  guessing.

## 0.5.1 — unreleased

- **Pasting now obeys the excluded and lossless folder lists.** It did not:
  pasting into a note whose attachments land in an excluded folder converted the
  image anyway, which is precisely what that setting exists to prevent. The
  destination folder is now resolved *before* encoding, since an image being
  converted has no path yet to match against.
- An excluded folder still applies the name template — exclusion is about
  conversion, not naming — and keeps the original bytes and format.

## 0.5.0 — unreleased

- **New: convert these folders losslessly.** A third tier between "convert" and
  "never touch": still WebP, still smaller than PNG (11.7 MB from a 21.6 MB
  original), but pixel-for-pixel identical. For images that cannot be
  re-downloaded but are not worth leaving as huge PNGs. Excluded folders win.
- This rests on a measured fact rather than an assumption: **Chromium's canvas
  encoder produces true lossless WebP at quality 1.0.** Verified in headless
  Chrome by round-tripping a noise image — q=0.9 differed in 194,633 subpixels,
  q=1.0 in zero.
- Lossless conversions are marked as such in the log.

Known gap: paste and drop use the global quality, because the image has no path
yet when it is encoded, so the folder lists cannot be consulted.

## 0.4.0 — unreleased

- **New: never convert these folders.** Applies to every path — the watcher, both
  commands, the right-click menu and the whole-vault button — because a guard
  that only covers the automatic path is the one a stray right-click bypasses.
  Matching is prefix-with-boundary, so `Archive` does not catch `Archived`.
- **Default quality raised from 0.82 to 0.90.** The usual 75–80 advice optimises
  for bandwidth while a master copy is kept elsewhere; here conversion replaces
  the original, so the quality chosen is kept forever. Measured by SSIM on real
  images: screenshots and text pages are indistinguishable at any level (0.996+
  at q75) and cost tens of KB more at q90, while high-resolution photographs run
  0.898 at q75 and 0.917 at q80 — below the ~0.95 where artifacts on skin become
  visible — reaching 0.971 at q90. A 21.6 MB PNG still lands at 2.3 MB.

## 0.3.2 — unreleased

- **Bulk conversion logs what it did.** It previously logged nothing per file, so
  a whole-vault run showed a progress notice and then silence, and a run that
  skipped everything looked identical to one that worked. It now logs the
  settings in force, a line per file with before/after sizes, every skip with its
  reason, and a summary with elapsed time and bytes saved.
- Pasting logs its result too, not just the notice.

## 0.3.1 — unreleased

- **A "Convert now" button in settings**, for the whole vault and for the active
  note. Both were commands from the start, which meant the feature was invisible
  unless you went looking in the command palette. The button shows how many
  images are not in the target format yet, and how much they weigh.
- The "Where new images go" setting says plainly that its default hands the
  decision to Obsidian's own attachment setting.

## 0.3.0 — unreleased

- **Renamed to ARCH Images Plus** (`arch-images-plus`).
- **New: convert every image that appears in the vault**, not just pasted ones.
  Catches images this plugin did not create — a clipper saving one, another
  plugin downloading one, a file dropped into the vault folder in Finder. **On by
  default**, optionally scoped to folders. It rewrites files in place.
- The watcher binds only after layout-ready: `create` fires for every existing
  file while the vault is indexed at startup, so binding earlier would convert
  the whole vault on every launch.
- It waits before converting (1.5s by default). A file that has only just
  appeared may still be being written, and a half-written download converts to
  garbage.
- Images this plugin wrote itself are skipped, so a paste is not converted twice.

## 0.2.1 — unreleased

- **Reloading the plugin now actually reloads `lib/`.** Electron's `require()`
  caches by resolved path and a disable/enable does not clear it, so editing
  anything in `lib/` and reloading kept running the old code while `main.js`
  edits took effect. The cache entries are dropped before requiring.

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
