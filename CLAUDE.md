# ARCH Images Plus

## Rules

### What It Is

- An Obsidian plugin that renames and converts an image in one step, the moment it is pasted or dropped.
- It also converts images already in the vault in bulk, and draws the ARCH Image Gallery view for Bases.
- It replaces Paste Image Rename and Image Converter running together. Both handled the same paste, so the result depended on load order.
- Read `CHANGELOG.md` before changing behaviour. It records why each thing is the way it is.
- The old file word for word, with the measurements: `Documents/_/AI/arch-images-plus/Details.md`.
- No coupling to the other ARCH plugins. After Clipping saves images that arrive with a clip and never goes through `editor-paste`.

### One Handler

- `onPaste` calls `preventDefault()` before any `await`, then owns the whole job: decode, resize, encode, name, write, insert the link.
- Conversion anywhere outside that one handler brings the original bug back.
- The embed is anchored to a placeholder, never the cursor. `insertPlaceholders` writes `[Saving image …]` at paste time, and `replacePlaceholder` swaps it when the save ends. Never go back to `replaceSelection` after an `await`.
- The rename prompt cancels the key that closes it (`preventDefault` and `stopPropagation` on keydown). Otherwise Enter lands in the editor.
- Saves run through one queue, `.then(task, task)`. Two images pasted together would otherwise get the same name.

### Formats and Quality

- WebP and JPEG only, encoded in the app. No AVIF, and keep it gone.
- Chromium silently returns a PNG when asked for AVIF. The ffmpeg fallback named an encoder this Mac's ffmpeg lacks.
- `needsExternalEncoder()` stays as a guard, so a format the canvas cannot write fails loudly.
- An `.avif` already in the vault still converts to WebP. `avif` stays in `IMAGE_EXTS`.
- Quality is 0.90, not the usual 0.75 to 0.80. Conversion replaces the original, so the quality chosen is kept forever.
- At 0.75 to 0.80, photographs of people fall below SSIM 0.95, where faces show artifacts. The table: `Details.md`.
- Quality 1.0 is lossless WebP in Chromium, checked pixel by pixel. Convert These Folders Losslessly is built on it.
- A small JPEG coming out larger is normal. `skipIfLarger` keeps the original and says so.
- An animated GIF converts to its first frame only. `skipAnimated` leaves them, and Never Convert These Extensions lists `gif` and `svg`.

### Folders

- Never Convert These Folders (`excludeFolders`) applies to every path: paste, drop, the watcher, the commands, the menus and the whole-vault button.
- Matching is by folder: `Archive` excludes `Archive/x.png`, not `Archived/x.png`.
- The order: never convert, then lossless, then everything else at the set quality.
- Paste and drop work out the destination folder before encoding (`destinationFolder()`), so the lists can apply.
- An excluded folder still gets the name template. Exclusion is about conversion, not naming.
- The default location, `obsidian`, defers to `vault.getAvailablePathForAttachments`. The other four modes are for a different place without changing the vault's setting.

### Renaming

- Bulk conversion renames with `fileManager.renameFile`, then overwrites with `modifyBinary`. Obsidian then rewrites every link, embeds and `.canvas` files included.
- Never write a new file and search the vault for the old name. It silently misses canvas links.
- The default template is `{{noteName}} {{counter}}`, his choice.
- `{{counter}}` is read off the names in the whole vault, one past the highest. Two images of one name in different folders make a wikilink ambiguous.
- Rename Images in the Active Note by Their Order always previews, and renames in two steps through `… arch-renaming` names, so two images can swap.
- It skips an image another note links, unless the preview's toggle says otherwise. A name taken outside the note leaves that image alone.

### Which Computer Converts

- `automaticOn` names the computer whose watcher converts arriving images, or `*` for every computer. Default `*` since 0.7.7, his choice.
- An arriving image whose `name.webp` already exists is left alone. The other computer converted it first.
- `computerName()` and `automaticRunsHere()` are copied word for word from After Clipping.
- Paste, drop, the menus and the commands are started by hand and stay ungated.

### The Gallery View

- `lib/gallery.js` registers ARCH Image Gallery (`arch-image-gallery`). It replaced Bases Image Gallery 0.1.6, which froze CHAOS.
- Read `Image Gallery Plan.md` in this repo before changing the view.
- The first draw waits for `plugin.galleryReady`: layout ready, then `metadataCache.onCleanCache`.
- An update that changes nothing visible does nothing. Cards are kept in a map and moved, never rebuilt.
- Images load only near the screen: load at 1,200 px, let go at 5,000 px.
- Thumbnails for images of 300 KB and over live outside the vault, in `~/Library/Caches/arch-images-plus/` (Linux `~/.cache/`), so Syncthing and the backup skip them. GIFs are never thumbnailed.
- Masonry is laid out in code (`fillGrid`), so order reads across the page.
- Never group a big gallery by `file.backlinks` in the base: 8.3 ms an image in CHAOS. Use the view's Group By set to the linking notes (`groupSource: links`).
- Cards go on the page as the view scrolls toward them, and only then are they watched for loading.
- The shuffle is held per view, so an update never reorders.
- The lightbox is `-webkit-app-region: no-drag`, or the window's drag area swallows its buttons.
- Never set `box-shadow: none` on a focused `clickable-icon`: that is Obsidian's focus ring.
- Labels take Title Case. Change display text only: option values and command ids are stored in bases and hotkeys.
- `plugin.galleryDraws` holds the last 20 draws, for timing from `obsidian eval`. How to time a base: `Details.md`.

### Building and Releasing

- `npm run build` writes `dist/main.js` and `dist/manifest.json`. A release ships those two.
- `lib()` takes `ARCH_LIB` when the build defined it, else reads `lib/` from disk. Keep both paths.
- `dropLibFromRequireCache()` clears the plugin folder and its real path, in `require.cache` and `window.require.cache`. Without it a reload ran the old `lib/`.
- Check a release as it installs: only `dist/main.js` and `dist/manifest.json` in a folder with no `lib/`.
- Rewriting history means moving every tag too. The steps: `Details.md`, Rewriting History Means Repointing Every Tag.

### Logging

- A bulk run logs its settings, a line per file with sizes, every skip with its reason, and a summary. `larger`, `animated` and `keep` are normal outcomes.
- A failure logs the full stack with `console.error`.

## Mistakes and Lessons

- 0.1.0: AVIF shipped, and the first real run produced PNGs and failed conversions.
- 0.5.2: a popup and a redraw put the embed inside the closing frontmatter fence.
- 0.5.3: every Enter in the rename prompt added a blank line above the frontmatter.
- Editing `lib/` and reloading the plugin ran the old code, which looked like an unsaved edit.
- `runBulk` once logged nothing per file. A run that skipped everything looked like one that worked.
- Until 0.7.7, the first computer to load a vault saved every setting. CHAOS and THOUGHTS keep the defaults of Sep 25.
- Oct 1: CHAOS's image bases took 6.4 s to open, from `file.backlinks`. 0.9.0 brought it to 0.2 s.

## Where It Stands

- 0.9.1 is current (Oct 2). In `~/Documents` and 12 vaults through BRAT, checked Oct 9.
- MONEY, [KN] Technicals, PROJECTS, SOCIALS and Languages still run 0.7.8, installed Sep 27. BRAT updates each at its next startup.
- `automaticOn` is `*` in every vault. TESTFIELD has the symlink.
- No vault has a Never Convert or lossless folder set. The first conversion cannot be undone, so irreplaceable folders go in Never Convert first.
- Only a person has used the file and folder menus and the bulk preview, and none has clicked through TESTFIELD's `ARCH test/` folder.
- Bulk conversion has never run on a large vault. It replaces files in place: test on a copy first.
- `window.require.cache` in `dropLibFromRequireCache` is not yet confirmed by editing `lib/` and running `plugin:reload`.
- CHAOS's three image bases use the gallery view.
- His plan moves the group-by-linking-note feature out of here into ARCH Base Gallery: `CHAOS Plans.md`, item 7, step 3. Not started.
- His hand-ordered groups (My Favorites first, Hidden Gem second) are in `Image Gallery Plan.md`, for that step.
