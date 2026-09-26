# ARCH Images Plus – Image Gallery Plan

A gallery view for Bases, built into ARCH Images Plus, to replace **Bases Image
Gallery** (0.1.6, by Gilbert Hyatt) in the CHAOS vault. Planned 2026-09-26, not
built yet.

His request, 2026-09-26:

> Copy and improve on Base Image Gallery plugin
> - Like add built-in randomiz images, randomize displayed images each time load, I've already had this using random() property in @IMAGES base.
> - Enable group by backlink, and able to randomize backlink sort along too, Base Image Gallery don't allow you to group by backlink.
>
> Optimize so it won't be so laggy, it was even completely shut down the vault, make it unable to open if the image base window was the first to load when I open the vault from external storage.

And on grouping: *"It only works in normal view, when change to Image Gallery view,
it doesn't work."*

## Why Bases Image Gallery freezes the vault

Read in its `main.js` (CHAOS, `.obsidian/plugins/bases-image-gallery/`). Five causes,
which add up:

1. **Every data update rebuilds everything.** `onDataUpdated` empties the view and
   creates every `<img>` again. Bases calls it whenever a matching file changes, and
   while a vault is opening the metadata cache is still indexing, so it fires again
   and again. Each rebuild starts every image loading from the beginning.
2. **Every image loads at full size, at once.** No lazy loading, no async decode, no
   thumbnails. A 90-pixel card showing a 6000-pixel photograph still decodes all
   6000 pixels. CHAOS holds 2,353 images, 1.1 GB; `Lewds` alone has 1,805, some
   over 8 MB.
3. **The lightbox loads them all a second time.** lightGallery's thumbnail strip is
   built for all of the up to 500 images when the view opens, each from the
   full-size file.
4. **`random()` in the base re-rolls on every update**, so each rebuild also puts
   the images in a new order, and nothing that was already loaded is reused.
5. **Nothing waits for the vault to finish opening.** When the image base is the
   first tab restored, all of the above runs while Obsidian is still starting, and
   from a slow drive that holds up the whole app.

**Grouping is simply not implemented.** The view reads only the flat list
(`this.data.data`) and never the groups Bases computes (`this.data.groupedData`),
so `groupBy: file.backlinks` in `Lewds/H-games/@IMAGES.base` works in a table and
disappears in the gallery.

It also shows at most 500 images (`MAX_ENTRIES`), so the `Lewds` views (about
1,800 images) show a random 500 each time.

## What gets built

A new Bases view type, **ARCH Image gallery** (`arch-image-gallery`), registered by
Images Plus. It is written fresh, not copied: the gallery's own code is about 150
lines, and the lightbox it bundles, lightGallery, is GPLv3, which does not fit
Images Plus's MIT licence. Its layouts (vertical and horizontal masonry, columns,
gutter, corner radius, row height) are kept, with the same option names so a base
switches over by changing only `type:`.

### Shuffle, built in

- **Order: shuffled / as the base sorts it.** Shuffled is picked per view.
- A shuffle happens **when the base is opened or the view is switched to**, and when
  the *Shuffle* button in the view is clicked. It stays put while the view is open:
  a note edited or an image added does not reorder everything. The `Random: random()`
  formula can then be dropped from the bases.

### Groups, including by backlink

- **The view uses Bases' own Group by**, so anything picked there (folder, a
  property) works in the gallery as it does in a table. Each group gets a heading and
  its own grid.
- **Grouping by backlink puts each image under the note that links to it**, with the
  note's name as a clickable heading. Bases treats `file.backlinks` as one list, so an
  image linked from two notes would form a group of its own named after both; the
  gallery splits that list and shows the image under each note. In H-games this
  hardly arises: 1,511 of the 1,518 images are linked from exactly one note, and 7
  from none. Images no note links to go in a last group, *No backlink*.
- **Group order: shuffled / as the base sorts it**, separately from the order of
  images inside a group, so the games can come up in a different order each time
  with their images shuffled or not.

### Speed

1. **Images load only when they come near the screen** (an `IntersectionObserver`),
   and leave memory again when scrolled far away. With that, the 500 cap goes: every
   image in the base is shown, since an off-screen card costs almost nothing.
2. **Thumbnails, cached per computer.** The first time an image is shown it is
   shrunk to the card size (about 400 pixels wide, WebP) and saved in
   `~/.cache/arch-images-plus/`, keyed by vault, path, size and modified time. After
   that the gallery reads a 20–40 KB file instead of a multi-megabyte one. The cache
   is outside the vault so Syncthing does not copy it to the other machine and the
   backup does not keep it; deleting it loses nothing. The cache also holds each
   image's width and height, so the masonry lays out before the images arrive,
   without cards jumping around.
3. **Updates are merged, not rebuilt.** Updates are gathered for a moment and then
   only the cards that changed are added or removed.
4. **The first draw waits for Obsidian to finish opening** (layout ready and the
   metadata cache resolved), with a "Loading…" line until then. This is the fix for
   the vault that would not open.
5. **Thumbnails are made one or two at a time**, off the main thread where
   possible, so scrolling stays smooth while the cache fills.

### The lightbox

A small one of its own: arrow keys and swipe between images in the current order,
Escape or double-click to close, a panel with name, size in pixels and on disk,
date, and **Open note** (the note that links to it) plus **Open image**. It loads
the full-size image only for the one being viewed and its two neighbours.

## Changing CHAOS over

Once it works in TESTFIELD: change `type: image-gallery` to `type: arch-image-gallery`
in `@IMAGES.base` and `Lewds/H-games/@IMAGES.base`, and turn Shuffle on where
`formula.Random` is the sort now. **Bases Image Gallery stays installed** until he
has compared the two, and he removes it himself. Its leftover options in those bases
(`cardSize`, `imageAspectRatio`, `imageFit`, `image`) belong to Obsidian's Cards view
and are left alone.

## Order of work

1. The view with layouts, shuffle and groups (including splitting backlinks), lazy
   loading, merged updates and the wait-for-startup. Tried in TESTFIELD on a copy of
   the H-games images.
2. The thumbnail cache.
3. The lightbox.
4. Release as 0.7.0 and switch the CHAOS bases over.

## Still open

- *"when I open the vault from external storage"*: which drive, and on which
  computer? CHAOS on the PC is on the internal disk. The fix does not depend on the
  answer, but testing it the way it failed does.
