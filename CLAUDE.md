# ARCH Images — working notes

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

## Location modes

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

## Not yet built

- No setup/detection modal, and with AVIF gone there is no external tool to
  detect. If one is ever needed, lift the `findBinary` / `SetupModal` pair out of
  ARCH YT Playlists rather than writing a new one.
- `{{counter}}` counts within the session, not per folder or per note. Uniqueness
  comes from `uniquePath`, so collisions are safe but the numbering restarts.
- Bulk conversion has never been run on a large vault. It replaces files in
  place; test on a copy first.
