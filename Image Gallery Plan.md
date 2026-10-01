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
- **On the Mac it loads and works**, his check on 2026-09-26 after 0.7.5: *"I check on
  Mac, the plugin load and work well.."*
- **Still to do:** he compares the two galleries on the Mac and removes Bases Image
  Gallery.
- **Done in 0.9.0, the same night** (the numbers are in `CHANGELOG.md`): grouping by linking note in the gallery, cards added as the view scrolls. Opening either CHAOS image base now takes about 0.2 s, from 6.4 s and 4.6 s. The history of the request follows.
- **Planned: load only what is on screen** (his request, 2026-10-01). On the PC the
  H-games gallery now holds about 2,500 images and takes several seconds to load,
  and he suspects it in an Obsidian freeze that day (opening ARCH Adult Contents'
  settings froze the PC's Obsidian, one renderer at 100% CPU; the plugin's only suspect
  was removed in its 0.5.2 and the freeze stopped, so the cause is not confirmed). His
  words: *"I could be because of Image Gallery from Arch Image Plus, we will need to
  optimize this later, like to not loads everthing which is 2500 images and tooks
  several seonds to load."* Not started.
  **What was found, 2026-10-01 (read in the code, not yet timed):** the images
  themselves already load lazily (a thumbnail only near the screen, let go far from
  it), so the cost is the drawing: `render()` makes a card for every image at once,
  3,933 in the H-games base (1.1 GB, median 153 KB), each a `div` and an `img` with
  four listeners and two IntersectionObserver entries, and the browser lays all of them
  out. The 1,518-image base drew in about 350 ms on 2026-09-26; at 3,933 that is
  about a second, plus Bases' own query. **The fix, in two steps:** CSS
  `content-visibility: auto` on each group (the browser skips layout and paint of
  groups off screen; small and safe), then drawing only the groups near the screen,
  with the rest added as they scroll close, sized from the cached image sizes so the
  scroll bar stays right. Measure `plugin.galleryDraws` before and after, in the
  CHAOS base. The lag when the `Images` folder is opened in the file explorer is
  Obsidian's own (3,933 files in one folder) and this plugin cannot change it; the
  ways round it are keeping the folder collapsed, or one folder per game, which
  touches Adult Contents, the bases and the cover tool.
  **Timed the same evening, his report:** the vault's `@IMAGES.base` took about 10
  seconds to open, and the log read *"drew 2468 images in 933 groups (2468 cards) in
  5286 ms"*. Timed inside his Obsidian (read only): `getBacklinksForFile` costs 8.3 ms
  per image, because it scans every note's links (1,778 notes, 9,886 links), so the
  2,468 images' backlinks take about 20 seconds of lookups; looking up a card's
  cached size costs 0.004 ms. Both image bases are grouped by `file.backlinks`
  (`@IMAGES.base`, and `Lewds/H-games/@IMAGES.base` with 3,933 images). **So the
  first fix is the grouping, not the drawing:** the gallery inverts
  `metadataCache.resolvedLinks` once (one pass over the links, milliseconds) and groups
  by the linking note itself, and the bases drop `groupBy: file.backlinks`. Drawing only
  the groups near the screen comes second.
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
- **0.7.6, the same day: the web-design-guidelines review.** The first use of the skill:
  keyboard access to cards and the lightbox, visible focus rings, a steady counter,
  number fields in the settings, and Title Case for every label, his preference
  (*"Actually, I much prefer Title Case."*). `CHANGELOG.md` has the list.

## Still open

- *"when I open the vault from external storage"*: he offered to open the CHAOS
  backup on 4T-HDD; the test copy above stands in for it.

## Planned: groups he orders by hand (his words, 2026-09-29)

For the H-games gallery in CHAOS. He will put games into groups himself through a
text property, rather than a tag the plugin assigns, because a rare, highly rated
game is not always a hidden gem: *"few of these games are not really "hidden-game",
they are just weird and unique, which is little different than Hidden Gem, like Her
Last Piece is ligit Hidden Gem."* Then the gallery view: *"I want to sort by group
and be able to sort them, place Hidden Gem at second, below My Favorites."* So the
view needs a group order he sets by hand (My Favorites first, Hidden Gem second),
and inside each group the base's own sort, which for H-games is `weighted-rating`
(ARCH Adult Contents 0.3.0). The property's name is not decided yet. Not started.
