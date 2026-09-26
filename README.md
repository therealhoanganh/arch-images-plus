# ARCH Images Plus

Renames and converts images in a single step. Paste or drop an image into a note
and it is encoded to WebP, JPEG or PNG, resized if you asked for that, saved
under a name you confirm, and linked — all before anything else touches the
file.

It exists because **Paste Image Rename** and **Image Converter** do not work
together: both hook the paste event and both save the file, so the result depends
on which loads first. One handler, one pipeline, no race.

## What it does

**On paste and drop**
- Converts to WebP, JPEG or PNG at a quality you choose
- Optionally resizes to a maximum long edge, never enlarging
- Names the file from a template — `{{noteName}} {{date}}-{{counter}}` by default
- Saves it where Obsidian would, or in a folder of your choosing
- Asks you to confirm the name first (on by default; turn it off for silent
  pasting)

**On images already in the vault**
- Convert the whole vault, one folder, a selection, or just the images used by
  the current note
- Shows exactly what will change before it does anything
- Links are rewritten by Obsidian itself, so embeds, aliases, frontmatter and
  canvas references all follow

**A gallery view for Bases** (*ARCH Image gallery*)
- Vertical or horizontal masonry, with columns, row height, gutter and corner radius
- Images shuffled each time the base opens, or in the base's own order, with a
  Shuffle button
- Uses the base's Group by, including backlinks: each group under its own heading,
  or kept together in one grid with no headings, the groups shuffled as wholes
- Fast on thousands of images: images load only near the screen, thumbnails are
  cached outside the vault, and the first draw waits for the vault to finish opening
- A lightbox with arrow keys, and buttons to open the image or the note linking to it

## Requirements

Desktop only. No external tools at all — every format is encoded in-process.

## Settings worth knowing

- **Keep the original when conversion makes it bigger** — on by default.
  Re-encoding a small JPEG usually does.
- **Leave animated images alone** — on by default. A GIF converts as its first
  frame only.
- **Show what will change first** — on by default for bulk conversion, which
  replaces files in place.

## Install

Not in the community catalogue. Install with BRAT, or copy `main.js` and
`manifest.json` into `.obsidian/plugins/arch-images-plus/`.

## Licence

MIT.
