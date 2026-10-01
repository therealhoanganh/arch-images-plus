# Changelog

## 0.8.0 (2026-10-01)

Three requests from Hoang Anh, in his words:

- **The default name is `{{noteName}} {{counter}}`** (*"Make name template
  {{noteName}} {{counter}} as default."*), so a note's images are `Note 01`, `Note 02`.
  It was `{{noteName}} {{date}}-{{counter}}`. A vault whose `data.json` holds the old
  default word for word follows the new one on load: THOUGHTS and TESTFIELD had it
  saved by the 0.6.0 claim, not chosen. CHAOS already had `{{noteName}} {{counter}}`,
  set by hand.
- **`{{counter}}` counts per name, from the images already in the vault.** His report:
  *"{{noteName}} {{counter}} doesn't count flexibly based on image name but based on
  current session! Like it will keep count up number even though I paste in different
  note. Like A1 A2 then move to be it will be B3 even thought note B doesn't have any
  images yet."* The counter was one number for the whole session. Now the template is
  turned into a pattern with the counter as `(\d+)` (`counterPattern` in
  `lib/naming.js`), every image in the vault is matched against it, in every folder and
  ignoring case, and the next number is one past the highest. A gap left by a deleted
  image is not filled, so a later image never sorts before an earlier one.
- **New command: *Rename Images in the Active Note by Their Order*** (*"Add function in
  command pallate of renaming images based on order of them in note"*). It numbers the
  images the note shows or links to, in the order they appear, with the name template
  (a template without `{{counter}}` gets one appended), each staying in its folder. A
  preview lists every change first. Renames go through `fileManager.renameFile`, so links
  follow, in two steps so that names can swap (`A 02` → `A 01` while `A 01` → `A 03`).
  An image another note also links to is left alone unless *Rename Images Other Notes
  Use Too* is switched on in the preview, since taking this note's name would pull it out
  of the other note's numbering. A new name already used by a file outside the note is
  reported and that image left alone, because the next free name would break the order.
  SVGs are numbered too. Tested in TESTFIELD on the PC: a swap, a skipped shared image, a
  taken name, and a plain link following its embed.

## 0.7.8 (2026-09-26)

- **An arriving image whose WebP twin is already there is left alone.** With every
  computer converting (0.7.7), an image can sync across before the first computer has
  converted it; the second then found `name.webp` taken, saved `name 1.webp`, and both
  computers rewrote the note's link, which can leave a Syncthing conflict copy of the
  note. Asked whether to switch the vaults, Hoang Anh answered *"They all ultimate become
  .webp right? Why the hussle?"*; this guard is what makes that true. Logged as "left
  alone, … is already there". Every vault's `automaticOn` was set to `*` the same day
  (all but CHAOS named the Mac, from the old claim).

## 0.7.7 (2026-09-26)

- **Automatic conversion runs on every computer by default.** Hoang Anh: *"Also set
  auto-convert on "Every Computer" by default."* Until now a vault with no choice saved
  was claimed by the first computer to load it (0.6.0), so every vault except CHAOS
  names the Mac. Now `automaticOn` defaults to `*`, nothing is claimed or saved on load,
  and *Every Computer* comes first in the dropdown. A choice already saved in a vault is
  kept. The risk the claim guarded against still exists: with Obsidian open on both
  computers, an image that syncs across before it is converted can be converted on both.
  The setting's description now says to pick one computer if that happens.

## 0.7.6 (2026-09-26)

- **A review against Vercel's Web Interface Guidelines** (the `web-design-guidelines`
  skill, its first use). Hoang Anh: *"Let's try apply all"*, meaning every finding worth
  fixing and every small one.
  - **Keyboard.** A gallery card is now a button to the keyboard: Tab reaches it, Enter
    or Space opens the lightbox. In the lightbox, Tab goes round its own buttons instead
    of the page behind, and closing puts focus back on the card that was opened. The
    lightbox is marked as a dialog, its image has the file name as alt text, and the
    icons beside button labels are hidden from screen readers.
  - **Focus rings.** The lightbox's buttons had `box-shadow: none`, which removed
    Obsidian's keyboard focus ring; they now show a white ring, and a card shows an
    accent outline, both only when focus came from the keyboard.
  - **The counter uses tabular figures**, so the note name beside it no longer shifts
    as the count goes from 9 to 10.
  - **Small things.** "1 image in 1 group" instead of "1 images in 1 groups"; a card
    brightens under the mouse; the 120 ms fade-in is off when the system asks for
    reduced motion; the Shuffle tooltip says what it does instead of repeating the
    label; "Converting…" with a real ellipsis; the paste error and "No note is open"
    say what to do next; the bulk dialog's button says how many images it converts.
  - **Settings.** Headings are Obsidian's own setting headings (`setHeading()`) instead
    of plain `h3`. *Maximum long edge*, *Skip images under* and *Wait before converting*
    are number fields, and anything that is not a number is no longer saved: it used to
    become 0, which for the long edge means "never resize", without a word. Spellcheck
    is off in the path, template and extension fields and in the rename box.
- **Title Case for labels.** The review set aside the guideline's Title Case because
  Obsidian uses sentence case; Hoang Anh: *"Actually, I much prefer Title Case."* The
  view name (*ARCH Image Gallery*), the view menu's options and choices, the settings'
  headings, names and choices, buttons, dialog titles, the right-click item and the
  command names are now Title Case (Chicago: articles, short conjunctions and
  prepositions stay lower case). Descriptions, tooltips and notices stay sentence case,
  being sentences. Only display text changed; view keys, option values and command ids
  are the same, so no base or hotkey needs touching.









## 0.7.5 (2026-09-26)

- **One text size and one baseline across the lightbox's top bar.** Hoang Anh: *"Inrease
  size of note name and order number to match button, they are also not well-aligned
  horizontally. Remote little dot between note name and order number too. Also add
  resolution next to image title like name (resolution)"*. The note and counter were
  the buttons' size already (13 px) but dimmed, beside 18 px icons, so they read
  smaller. The whole bar (title, note, counter, button labels) is now the UI's medium
  size (15 px), undimmed, on one 26 px line, and the four texts measure on the same
  baseline. The dot is gone. The title reads *name (width × height)*, from the cached
  size until the image is in.

## 0.7.4 (2026-09-26)

- **The lightbox is titled like an open file.** Hoang Anh, after 0.7.3: *"I want title
  of image to be on top middle like how normal file is. Remove the other details
  resolution, size, date line. Add note name next to order of image."* The file name
  sits at the top middle (hover shows its path); the top right reads *note · 3 / 1519*,
  then *Open note*, *Open image*, close. The size in pixels, size on disk and date are
  gone, and the image moves back up into the space they took. The bar is three
  columns with equal outer ones, so the name stays centred on screen whatever the
  note's name, and a long name is cut with an ellipsis rather than running into the
  buttons.

## 0.7.3 (2026-09-26)

- **The lightbox's details go under its buttons.** Hoang Anh, after 0.7.2: *"I want
  image info to be placed under instead of next to buttons, keep order of image
  1/1518 next to buttons though."* The top-right corner is now two lines: the counter
  and the buttons, then the name and note · size in pixels · size on disk · date
  under them, right-aligned. The image starts a little lower to leave them room.

## 0.7.2 (2026-09-26)

- **The view menu's one toggle is a dropdown now, and last.** Hoang Anh: *"the toggle
  on of button is middle of the slide down, which is not nice visually."* Bases draws a
  toggle small and on its own line between full-width dropdowns. *One group per link*
  became **Grouped by a list (backlinks, tags)**: *One group per link or tag* /
  *One group per whole list* (`listGroups: split | whole`), placed after *Groups* and
  *Group order*. Bases that still carry `splitLists: true/false` are read as before.
- **The lightbox's details sit beside its buttons.** His words: *"when I open image,
  the image info and open button are on opposite size of each other! Make me have to
  cross my eyes a whole screen! Move image info to top corner with the button
  please!"* Name on one line and note · size in pixels · size on disk · date on the
  next, right-aligned against the counter and *Open note*, *Open image*, close; nothing
  at the bottom now, so the image gets that space. Everything is at the right, clear of
  the Mac's window buttons in the top-left corner.
- **The buttons at the top could not be clicked** (his report after the move: *"both
  button and image info are way over top conrner and unable to click on"*). The
  lightbox covers Obsidian's tab bar, which drags the window when the frame is hidden,
  so a click there went to the window. The lightbox is marked `no-drag`.
- **A base tab open when the plugin is reloaded or updated is rebuilt.** It kept the
  gallery made by the old code while the new styles applied, which is what put the
  details at the very top edge in his test. Only when the layout is already ready, so
  never at vault startup.

## 0.7.1 (2026-09-26)

- **Groups kept together, without headings.** Hoang Anh, after using grouping by
  backlink in CHAOS: *"So group by backlink is not very good because it has too much
  blank gap. My idea to fix it is not explictly group by backlink but sort based on
  backlink and randomize that sort each time because backlink idea works. But the
  problem is there is not sort by backlink option and we need to randomize smartly
  like based on the group, not individual."* Bases' Sort cannot sort by backlink, but
  its Group by can group by it, so the new view option **Groups** (`groupDisplay`)
  offers *Each under its own heading* (`headings`, the default, as before) or *Kept
  together in one grid* (`together`): the groups only decide which images sit next
  to each other, Group order still shuffles them as whole groups, and Image order
  shuffles inside each. An image linked from two notes shows once, with its first
  group. `Lewds/H-games/@IMAGES.base` in CHAOS uses it.
- **Vertical masonry reads left to right.** It was CSS columns, which fill the first
  column top to bottom before the second, so in one grid a group would run down one
  column and the four columns would show four distant parts of the order. The cards
  are now dealt out left to right, each to the column that is shortest so far (heights
  from the cached image sizes), so a group's images sit side by side across the page.
  This also means the lightbox's next image is the one to the right, and a small
  group under a heading no longer leaves its images stacked in one column.
  Tried in TESTFIELD on the 1,519 H-games images: 119 games in one grid, about 490 ms
  for the first draw; the headed view still draws in about 370 ms.

## 0.7.0 (2026-09-26)

- **Released the same day, without the cold-start test from the drive.** Hoang Anh
  tried it and said to skip the test: *"It didn't happen on PC and 4TB-HDD, it
  happened on Mac and on VALERIE SSD drive. Let's skip it for now."* So the freeze
  belongs to the Mac, and the test copy on 4T-HDD opened from the PC could not have
  shown it. Built on the Mac from the PC over `ssh mac`. Copied into CHAOS by hand;
  its three gallery bases were switched over, each view keeping its old order (a
  `Random` sort became *Shuffled*, no sort became *As the base sorts them*).

- **ARCH Image gallery, a view for Bases**, to replace Bases Image Gallery in CHAOS.
  Hoang Anh asked for shuffling built in, grouping by backlink with the groups
  shuffled too, and an end to the lag: *"it was even completely shut down the vault,
  make it unable to open if the image base window was the first to load when I open
  the vault from external storage."* Built as planned in `Image Gallery Plan.md`: Bases'
  own groups, list keys split per link; Image order and Group order each shuffled or as
  the base sorts; a Shuffle button; lazy loading; thumbnails cached outside the vault;
  no work on updates that change nothing; the first draw waits for the vault to open;
  a lightbox that loads one image and its neighbours; no 500-image cap. Written fresh,
  because the old plugin's lightbox (lightGallery) is GPLv3.
- **The first draw waited a fixed 3 s** on every open with a public `'resolved'`
  listener (draw at 9.2 s after a reload); `metadataCache.onCleanCache` brought it to
  6.0 s.
- **Reloading `lib/` also clears `window.require.cache`**, the fix ARCH Recreations
  found; the old code walked only the wrapper's cache.
- Command *Clear the gallery thumbnail cache*.

## Planned 2026-09-26: an image gallery view for Bases

- **Planned, not built.** Hoang Anh asked for a gallery view to replace Bases Image
  Gallery in CHAOS, with shuffling built in, grouping by backlink with the groups
  shuffled too, and no more lag: *"it was even completely shut down the vault, make it
  unable to open if the image base window was the first to load when I open the vault
  from external storage."* The plan, the diagnosis of Bases Image Gallery 0.1.6 (every
  update rebuilds every full-size image, the lightbox loads them all again, grouping is
  never read) and the order of work are in `Image Gallery Plan.md`.

## 0.6.0

- **Images arriving in the vault are converted on one computer only, named in the new
  setting *Automatic conversion runs on*.** Since 2026-09-25 the vaults are mirrored
  between the Mac and an Ubuntu PC by Syncthing, so an image saved on one arrives on the
  other as a new file; with Obsidian open on both, both converted it and left conflict
  files. The setting holds a computer's name or *Every computer* and lives in the synced
  settings file. Paste, drop, the menus and the commands work on every computer. A vault
  without the setting is claimed by the first computer to load this version. The same
  setting, with the same helper code, is in ARCH After Clipping 1.18.0.
- **Settings changed on disk are reloaded** (`onExternalSettingsChange`), so a settings
  edit synced from the other machine is not overwritten by this machine's next save.

Tested in TESTFIELD with a noisy 300×200 PNG (a flat-colour one is smaller as PNG and is
rightly left alone, which hides the result): with the PC named it stayed a PNG and nothing
was logged; with the Mac named it became a 42 KB WebP.

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
