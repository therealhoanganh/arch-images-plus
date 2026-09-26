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

## Where it stands (2026-09-26, end of session)

- Steps 1 to 3 are built (view, thumbnail cache, lightbox) and work in TESTFIELD on
  the 1,519 H-games images: grouping by game (119 groups, as the Table view shows),
  shuffle, horizontal layout, the lightbox, one 330 ms draw after a reload.
- **Released as 0.7.0 on 2026-09-26** and running in CHAOS (copied in by hand, BRAT
  agrees with it). Switched: `@IMAGES.base` (All and Games shuffled, Lewds and
  Cosplayers in the base's order, as before), `Lewds/H-games/@IMAGES.base` (images and
  games shuffled; he had already switched its type himself) and `Games/@GAMES.base`
  (base order). The first draw of the H-games base in CHAOS on the PC: 1,518 images,
  119 groups, about 350 ms.
- **Where the freeze happens, his finding:** *"It didn't happen on PC and 4TB-HDD, it
  happened on Mac and on VALERIE SSD drive."* So the real test is CHAOS opening on the
  Mac with the new gallery; the cold-start test below was skipped at his word ("Let's
  skip it for now").
- **Still to do:** he compares the two galleries on the Mac and removes Bases Image
  Gallery. CHAOS on the Mac needs Obsidian restarted (or Images Plus turned off and on)
  to load 0.7.0 once Syncthing has brought it over; until then its gallery bases show
  an unknown view.
- **Test copy on the drive:** `4T-HDD/_Gallery Test/CHAOS Gallery Test` is today's
  CHAOS without video, music and `.git` (2,397 images), with the development build
  installed, `@IMAGES ARCH.base` (the same views, new type) beside `@IMAGES.base`,
  and the files evicted from the page cache. He opened it on the old gallery:
  *"Yes, it works so far!"* **Still to do there:** open `@IMAGES ARCH.base` as the
  first tab from a cold cache and compare (`obsidian vault="CHAOS Gallery Test" …`;
  the eviction script is `os.posix_fadvise(..., POSIX_FADV_DONTNEED)` over every file).
- **Built** on the Mac from the PC over `ssh mac` (the Mac has Node 24; the PC has
  none and does not need it while that works).
- **Delete when done:** `TESTFIELD/_/Gallery Test/` (hard links to CHAOS's H-games
  images, 118 stub notes, two test bases; it syncs to the Mac as 444 MB) and
  `4T-HDD/_Gallery Test/`.
- **0.7.1, the same day: groups kept together.** Headed groups left too much blank
  space, in his words, so the option **Groups: Kept together in one grid** puts every
  group's images in one grid with no headings, still shuffled as whole groups
  (`CHANGELOG.md` has his words). Vertical masonry now deals cards left to right into
  the shortest column instead of using CSS columns, so the lightbox's next image is the
  one to the right. `Lewds/H-games/@IMAGES.base` got its Group by backlink back, with
  `groupDisplay: together`.
- **0.7.2, the same day: his two UI notes.** The view menu's toggle became a dropdown
  at the end of the menu, and the lightbox's details moved up beside its buttons,
  which are now clickable over the tab bar (`CHANGELOG.md`). In 0.7.3, at his word, the
  details went under the buttons, with the counter staying beside them; in 0.7.4 the
  file name moved to the top middle, the note's name beside the counter, and the size
  and date were dropped; in 0.7.5 the bar got one size and baseline, and the title the
  size in pixels, *name (width × height)*.

## Still open

- *"when I open the vault from external storage"*: he offered to open the CHAOS
  backup on 4T-HDD; the test copy above stands in for it.
