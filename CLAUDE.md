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

Never exercised by anything but reasoning: the rename prompt, the file and folder
context menus, the bulk preview modal, and `replaceInPlace` — which is the
riskiest code here, because it renames a file and overwrites its bytes. The
`ARCH test/` folder in that vault exists to exercise those; nothing has clicked
through it yet.

## Not yet built

- No setup/detection modal, and with AVIF gone there is no external tool to
  detect. If one is ever needed, lift the `findBinary` / `SetupModal` pair out of
  ARCH YT Playlists rather than writing a new one.
- `{{counter}}` counts within the session, not per folder or per note. Uniqueness
  comes from `uniquePath`, so collisions are safe but the numbering restarts.
- Bulk conversion has never been run on a large vault. It replaces files in
  place; test on a copy first.
