# ARCH Images Plus — working notes

An Obsidian plugin that renames and converts an image in one step, at the moment
it is pasted or dropped, and converts images already in the vault in bulk.

Read `CHANGELOG.md` before changing behaviour. It is the reliable record of why
things are the way they are, and it is kept current.

## Why this plugin exists

It replaces **Paste Image Rename** + **Image Converter** running together. Both
of those register their own `editor-paste` handler, and both call
`preventDefault()` and then save the file. Whichever runs second is operating on
a file the first one already moved, so the outcome depends on plugin load order:
an image gets converted and then renamed back, or renamed and then re-saved
unconverted, or written twice under two names.

**The fix is not better cooperation between two handlers. It is one handler.**
`onPaste` calls `preventDefault()` synchronously — before any `await` — and then
owns the whole pipeline: decode, resize, encode, name, write, insert the link.
Nothing else is racing for the file because nothing else ever starts.

If a future change makes conversion happen anywhere other than inside that single
handler, the original bug is back.

## Environment

macOS Intel (`darwin x64`), Obsidian 1.13.4. Desktop only.

- ffmpeg at `/usr/local/bin/ffmpeg`, used **only** for AVIF
- No other external tool; WebP and JPEG are encoded in-process

## Things that cost hours to learn

**AVIF is gone, and it should stay gone.** It was offered in 0.1.0 and removed
after the first real run. Two independent reasons, either of which is enough:

Chromium cannot *encode* AVIF and does not say so — `convertToBlob({ type:
'image/avif' })` silently returns a **PNG**, so the file is larger than the JPEG
it came from and is not AVIF. Chromium encodes `image/png`, `image/jpeg` and
`image/webp`, nothing else.

The ffmpeg fallback written to work around that hardcoded `-c:v libaom-av1`, and
this machine's ffmpeg ships `libsvtav1` instead, so every AVIF conversion failed.
Encoder names are a per-build detail, not something to hardcode, and probing for
them is more machinery than a second lossy format is worth when WebP is already
smaller than JPEG for almost everything.

`needsExternalEncoder()` survives as a **guard**, not a feature: with the formats
now offered it is always false, and it exists so that adding a format the canvas
cannot write fails loudly instead of writing a mislabelled PNG.

Note that AVIF *decoding* still works, so an `.avif` already in the vault
converts to WebP fine and `avif` stays in `IMAGE_EXTS`.

**Bulk conversion renames before it overwrites, and the order is the point.**
`fileManager.renameFile` is the API Obsidian itself uses, so it rewrites every
reference to the file: wikilinks, markdown links, embeds with sizes and aliases,
frontmatter values, and `.canvas` files. Renaming first and then calling
`modifyBinary` on the renamed file means this plugin never parses or rewrites a
link at all.

The obvious alternative — write the new file, grep the vault for the old name,
delete the original — was the first plan. It loses canvas references silently,
because a canvas is JSON and does not look like a link.

**An image bigger after conversion is the normal case for small JPEGs**, not a
bug. Re-encoding an already-compressed 40 KB JPEG at quality 0.82 routinely
produces a larger file. `skipIfLarger` keeps the original and reports it. Turning
that off makes the plugin reliably waste space.

**A GIF survives `createImageBitmap` as its first frame only.** There is no
frame-by-frame decode available here, so "converting" an animated GIF throws the
animation away with no warning. `skipAnimated` leaves them alone, and
`bulkSkipExtensions` lists `gif` and `svg` by default — SVG is vector and
rasterising it is a downgrade, not a conversion.

**The embed is anchored to a placeholder, never to the cursor.** The cursor at
paste time and the cursor when the save finishes are not the same thing: the
conversion and the rename prompt sit between them, and a modal plus a
re-rendered note once put the embed three characters short of the paste point,
inside the closing frontmatter fence. `insertPlaceholders` writes `[Saving
image …]` synchronously in the paste handler, and `replacePlaceholder` finds
that text in the document when the save resolves and replaces it there. Do not
"simplify" this back to `replaceSelection` after an `await`.

**The rename prompt cancels the key that closes it.** Closing a modal on
`keydown` returns focus to the editor while that keystroke is still in flight,
and the browser delivers the keypress there — with the selection snapped to
the start of the document, so every Enter in the prompt added a blank line
above the frontmatter. `preventDefault` + `stopPropagation` on the keydown is
what stops it; do not switch the prompt to closing on a bare key handler.

**Saves run through a single queue.** Two images pasted together otherwise
resolve `uniquePath` against the same folder listing before either has been
written, and both get the same name; the second `createBinary` then throws. The
queue uses `.then(task, task)` so one failure does not stall what is behind it.

## Quality, and why it is 0.90 rather than the usual 0.75-0.80

The common advice — 75 to 80 for photographs and web graphics, above which file
size climbs for little visible gain — is correct **for web delivery**, where a
master copy is kept and a compressed copy is served. It is the wrong frame here:
conversion **replaces the original**, so the quality chosen is the quality kept
forever. There is no master to go back to.

Measured with `cwebp` and SSIM against real images from this vault:

| content | q75 | q80 | q85 | q90 |
|---|---|---|---|---|
| screenshots, text pages | 0.994–0.9998 | 0.996 | 0.997 | 0.998 |
| 1.4 MB mixed images | 0.973 | 0.979 | 0.984 | 0.989 |
| 21 MB photographs of people | **0.898** | **0.917** | 0.940 | 0.971 |

Below roughly 0.95 the artifacts on skin and faces become visible — that is the
substance behind the common complaint that WebP looks worse than JPEG on
portraits, and at q75-80 on a high-resolution photograph it is real.

The size argument does not survive contact with the numbers either. On
screenshots, q75 to q90 is the difference between 0.03 MB and 0.04 MB — nothing.
On a photograph it is 0.74 MB versus 2.29 MB, which sounds like a lot until you
remember the source PNG was 21.6 MB. q90 is still an 89% saving.

So: **0.90**, which costs almost nothing on the many small images and is what
keeps the few large photographs intact.

**Quality 1.0 is not "lossy at maximum" — Chromium's canvas encoder switches to
lossless WebP there.** Verified in headless Chrome, running the same encoder
Obsidian does, by round-tripping a noise image through `convertToBlob` and
comparing every subpixel:

```
quality=0.9  bytes=45682   differingSubpixels=194633  maxDelta=180  lossy
quality=1    bytes=143278  differingSubpixels=0       maxDelta=0    LOSSLESS
```

That is what `losslessFolders` is built on. Do not take it on trust if it ever
needs rechecking — the test is a canvas round-trip and a pixel compare, and it
takes a minute.

On real files: lossless WebP gave 11.7 MB from a 21.6 MB PNG and 0.16 MB from a
0.37 MB text page. Smaller than PNG, identical to it.

## Excluded folders

`excludeFolders` applies to **every** path — the create watcher, both commands,
the right-click menu and the whole-vault button. An original that cannot be
re-downloaded must not be convertible by accident from any direction, and a guard
that only covers the automatic path is the one that gets bypassed by a stray
right-click.

Matching is prefix-with-boundary, so `Archive` excludes `Archive/x.png` but not
`Archived/x.png`.

There are three tiers, and they resolve in this order:

1. `excludeFolders` — never touched at all.
2. `losslessFolders` — converted to WebP at quality 1.0, which is lossless.
3. everything else — WebP at the configured quality, 0.90 by default.

Exclusion wins over lossless, because "do not touch this" is a stronger statement
than "touch it carefully".

**Paste and drop obey these lists too, and making them do so required resolving
the destination folder before encoding.** The obvious ordering — convert, then
work out where the file goes — cannot consult the lists at all, because the image
has no path while it is being encoded. So pasting into a note whose attachments
land in an excluded folder converted it anyway, which is exactly what "never
convert this folder" is supposed to prevent.

`destinationFolder()` answers "where would this land" without committing to a
filename. For the `obsidian` mode it asks
`getAvailablePathForAttachments` with the *source* extension and takes the parent
of the answer — the extension only affects the name, not the folder, so it does
not matter that it is not the final one.

Note that an excluded folder still gets the **name template**: exclusion is about
conversion, not naming. The original bytes and format are kept, and the file is
still named the way you asked.

## Naming and the counter (0.8.0)

The default template is `{{noteName}} {{counter}}`, his choice. **`{{counter}}` is read
off the names already in the vault**, not kept in memory: `counterPattern` turns the
template into a pattern with the counter as `(\d+)`, and the next number is one past
the highest match in any folder, ignoring case. Until 0.8.0 it was one number for the
whole session, so the first image in note B came out `B 03` after `A 01` and `A 02`.
The search covers every folder because two images of one name in different folders
make a wikilink ambiguous. It costs one pass over the vault's image list per save.

**Rename Images in the Active Note by Their Order** renumbers a note's images to match
the note. Always previewed; through `fileManager.renameFile`, for the same reason as
bulk conversion; in two steps through `… arch-renaming` names, so two images can swap
names. An image another note links to is skipped unless the preview's toggle says
otherwise, and a name taken by a file outside the note leaves that image alone rather
than taking `name 1`, which would break the order.

## Location modes

The default, `obsidian`, defers to `vault.getAvailablePathForAttachments`, which
means **this plugin does not decide where images go unless asked to**. That is the
right default: the vault already has an attachment setting, and other plugins
respect it too. The other four modes exist so a pasted image can go somewhere
different without changing that vault-wide setting — not to replace it.


The five modes mirror Obsidian's own "Default location for new attachments", so
the setting reads the way Obsidian's does. `obsidian` is the default and defers
to `vault.getAvailablePathForAttachments`, which respects whatever the vault is
already configured to do; the other four are this plugin's own folders. When that
API is missing on an older build the code falls through to the `specified` path
rather than failing.

## The `lib()` split

Nothing in `lib/` may `require('obsidian')`. That module is injected into
`main.js`'s scope only; a file loaded from disk by plain Node cannot resolve it,
and `build.mjs` lists `obsidian` as external so a stray require fails loudly at
build time rather than silently at load time.

`lib()` takes `ARCH_LIB` when the bundle defined it and falls back to reading
`lib/` from disk when it did not. That fallback is what keeps the repo runnable
unbuilt: edit, reload in Obsidian, no build step. Losing the fallback costs the
edit-and-reload loop; losing the bundle means a release install cannot find
`lib/` and the plugin dies on load. Keep both.

**Editing `lib/` and reloading the plugin was silently running the OLD code.**
Electron's `require()` caches by resolved path, and disabling and re-enabling a
plugin does **not** clear that cache — only a full app reload did. So the disk
fallback, whose whole purpose is the edit-and-reload loop, quietly did nothing
for `lib/`, and it looked exactly like the edit had not been saved.

`dropLibFromRequireCache()` deletes the cached entries before requiring. It
matches the plugin folder **and its realpath**, because during development that
folder is a symlink into the repo and `require` resolves symlinks, so the cached
keys live under the repo path rather than under `.obsidian`.

**It walks `window.require.cache` as well as `require.cache`** (since 2026-09-26).
ARCH Recreations found that the `require` a plugin is handed is Obsidian's wrapper,
whose `.cache` is not Node's. Not yet confirmed here by editing `lib/` and running
`plugin:reload`; a full `reload` of the vault always picks the edit up.

Changes to `main.js` were never affected — Obsidian re-evaluates that itself.
That asymmetry is what made this confusing: some edits took, others did not.


## Logging

Always on, no toggle, the same as the other ARCH plugins: a log that is off by
default is a log nobody has when they need it.

`runBulk` used to log **nothing per file**, so converting the whole vault
produced a progress notice and then silence — no way to tell a conversion that
worked from one that skipped everything. It now logs the settings it is running
with, a line per file with before/after sizes, every skip **with its reason**, and
a summary with the time taken and bytes saved. The reasons matter more than the
successes here: `larger`, `animated` and `keep` are all normal outcomes, and
without them a run where nothing converted looks identical to a broken one.

A failure logs the full stack via `console.error`, because the failures worth
chasing in bulk conversion are Obsidian API errors out of `replaceInPlace`, not
decode errors.

## Releasing

`npm run build` writes `dist/main.js` and `dist/manifest.json`. Those two files
are what a release ships; `dist/` is gitignored.

Verify a release the way it actually installs: copy only `dist/main.js` and
`dist/manifest.json` into a folder with no `lib/`, and load it.

## Which computer converts arriving images (0.6.0; every computer by default since 0.7.7)

The vaults are mirrored between the Mac and an Ubuntu PC (Syncthing, since 2026-09-25), so
the `create` watcher can convert an arriving image on both machines. `automaticOn`
names the one computer whose watcher runs, or `*` for every computer. **The default is
`*` since 0.7.7, his choice** (*"set auto-convert on "Every Computer" by default"*); until
then the first computer to load a vault claimed it. Every vault was set to `*` on
2026-09-26. **An arriving image whose converted twin (`name.webp`) is already there is left
alone** (0.7.8): the other computer converted it first, and converting again would save
`name 1.webp` and fight over the note's link. After Clipping keeps the claim; `computerName()` and `automaticRunsHere()` are
copied word for word from ARCH After Clipping, whose `CLAUDE.md` has the reasoning. Paste,
drop, the menus and the commands are started by hand and must stay ungated.
`onExternalSettingsChange` reloads settings a sync changed on disk.

Until 0.7.7, the claim on first load saved the whole settings object, like any save from the settings
tab. A vault that had no `data.json` (every vault until 0.6.0, so all of them followed the
current defaults) therefore keeps the defaults of the day it claimed: CHAOS and THOUGHTS,
which were open on 2026-09-25. The other vaults were given a `data.json` holding only
`automaticOn`, so they still follow new defaults.

## The gallery view for Bases (0.7.0, released 2026-09-26; 0.7.1 to 0.7.8 the same day)

`lib/gallery.js` registers **ARCH Image Gallery** (`arch-image-gallery`), built on
2026-09-26 to replace Bases Image Gallery 0.1.6 in CHAOS, which froze the vault. His
request, the diagnosis of the old plugin and the plan are in `Image Gallery Plan.md`;
read it before changing the view. The rules that keep it fast:

- **The first draw waits for `plugin.galleryReady`**: layout ready, then
  `metadataCache.onCleanCache` (internal, what Obsidian itself uses; a public
  `'resolved'` listener cost a fixed 3 s because it had usually already fired).
- **An update that changes nothing visible does nothing.** `render()` compares a
  signature of groups, paths and mtimes. Cards are kept in a map and moved, never
  rebuilt, so a loaded image is not loaded again.
- **Images load only near the screen** (two IntersectionObservers against the
  scrolling `.bases-view`, load at 1,200 px, let go at 5,000 px).
- **Thumbnails** (`lib/thumbs.js`) for images of 300 KB and over, at 320/640/1024 px,
  in `~/.cache/arch-images-plus/<vault hash>/` on Linux (`~/Library/Caches/…` on the
  Mac), outside the vault so Syncthing and the backup leave them alone. Shown through
  `Platform.resourcePathPrefix`. GIFs are always shown as they are, for the animation.
- **Group keys that are lists are split** into one group per item (backlinks: one
  group per linking note), a toggle in the view options.
- **Groups under headings or kept together** (`groupDisplay`, 0.7.1): *together*
  puts every group's cards in one grid with no headings, so Group by acts as the
  sort by backlink that Bases lacks; each image shows once there.
- **Vertical masonry is laid out in code**, not CSS columns: `fillGrid` deals cards
  left to right into the shortest column by cached aspect, so order reads across the
  page. A size learned only after the card loads does not move it; the columns can
  end a little uneven.
- **Open base tabs are rebuilt when the plugin loads after the layout is ready**
  (a reload or an update), since an old view keeps the old code under the new CSS.
- **The lightbox is `-webkit-app-region: no-drag`**: it covers the tab bar, which
  drags the window in Obsidian's hidden frame and would swallow clicks on its buttons.
- **The shuffle is the view's own**: ranks held per view instance, so an update never
  reorders; the Shuffle button or reopening makes new ones.
- **Labels are Title Case, his preference** (0.7.6): view menu, settings names and
  headings, buttons, dialog titles, commands. Descriptions, tooltips and notices stay
  sentence case. Change display text only; option values and command ids are what
  bases and hotkeys store.
- **Keyboard and focus** (0.7.6): cards are `tabindex=0 role=button` (Enter/Space
  open), the lightbox traps Tab and returns focus on close. Never set `box-shadow:
  none` on a focused `clickable-icon`: that is Obsidian's focus ring. `:focus-visible`
  never matches while the window is not focused, so to see a ring from `obsidian eval`
  force it with the devtools protocol (`webContents.debugger`, `CSS.forcePseudoState`).
- `plugin.galleryDraws` holds the last 20 draws (time after load, ms, counts), for
  checking from the console or `obsidian eval`.

Measured 2026-09-26 in TESTFIELD, 1,519 H-games images: one draw of about 330 ms after
a vault reload, about 40 images holding a picture at any time while scrolling all of
them, slowest frame 120 ms.

## Coupling to the other ARCH plugins

None, deliberately. ARCH After Clipping saves images that arrive with a clipped
page; this one handles images a human pastes. They do not share code and do not
need to know about each other, because After Clipping never goes through
`editor-paste`.

## What has actually been verified

Loaded and used in Obsidian 1.13.4 in the `TESTFIELD` vault, where the plugin is
**symlinked** from `~/Documents/arch-images-plus` rather than copied, so editing the
repo and reloading picks the change up.

Confirmed working by hand: the plugin loads, the settings tab renders, and paste
conversion to WebP produces the expected file and embed.

Confirmed broken and since removed: AVIF (see above).

The rename prompt has been used for real on notes with frontmatter (0.5.2 and
0.5.3 came out of that — the embed landing in the closing fence, then the Enter
key leaking a blank line above it). Both fixes were confirmed by hand.

Never exercised by anything but reasoning: the file and folder context menus,
the bulk preview modal, and `replaceInPlace` — which is the riskiest code here,
because it renames a file and overwrites its bytes. The `ARCH test/` folder in
that vault exists to exercise those; nothing has clicked through it yet.

Checked 2026-09-23: `replaceInPlace` has since run on every automatic
conversion (`onCreated` calls it), and about 2,000 WebP images sit in the vaults.
The context menus and the bulk preview modal are still unexercised.

## Not yet built

- No setup/detection modal, and with AVIF gone there is no external tool to
  detect. If one is ever needed, lift the `findBinary` / `SetupModal` pair out of
  ARCH YT Playlists rather than writing a new one.
- Bulk conversion has never been run on a large vault. It replaces files in
  place; test on a copy first.

## Rewriting history means repointing every tag

If commits are ever rewritten — an author correction, stripping a trailer —
moving `main` is not enough. **A tag is a reference**, so any tag left on an old
commit keeps that commit alive on GitHub, and it keeps whatever was wrong with it
alive too: the old author, the old trailer, the contributor entry derived from
them. This has already caused an afternoon of confusion, where `main` was clean
and the contributors list was not.

The steps, in order:

1. Note which commit each tag points at **before** rewriting, by commit subject —
   the SHAs are about to change.
2. Rewrite, e.g. `git rebase --root --exec '<amend script>'`.
3. Move every local tag onto its new equivalent: `git tag -f <tag> <new sha>`.
4. `git push --force-with-lease origin main`.
5. Repoint each remote tag:
   `gh api --method PATCH repos/<owner>/<repo>/git/refs/tags/<tag> -f sha=<new> -F force=true`
6. Verify no ref is orphaned:
   `gh api repos/<owner>/<repo>/git/refs --jq '.[] | "\(.ref) \(.object.sha)"'`
   — every one should be an ancestor of `main`.

Release assets survive a tag move; they are attached to the release, not the
commit. GitHub's contributors widget is cached separately and lags behind all of
this, so check `git/refs` rather than the web page to know whether the work is
actually done.
