// Thumbnails for the gallery view, cached on this computer, outside the vault.
//
// Why a cache at all: a 90-pixel card showing a 6000-pixel photograph still
// decodes all 6000 pixels, and from a slow drive it also reads every byte. The
// first time an image is shown it is shrunk once; after that the gallery reads a
// file of a few tens of KB. See "Image Gallery Plan.md".
//
// Why outside the vault: the vaults are mirrored with Syncthing and backed up
// wholesale. A thumbnail is worth nothing on another machine (it rebuilds in
// seconds there) and nothing in a backup, and deleting the folder loses nothing.
//
// Nothing here may require('obsidian'); see CLAUDE.md, "The lib() split".
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

// Below this size the original is shown as it is. Most images in the vaults are
// already small WebP (H-games: median 162 KB), and shrinking them costs a decode
// and a write for almost no saving.
const ORIGINAL_BELOW_BYTES = 300 * 1024;

// Thumbnail widths. The card width times the pixel ratio is rounded up to one of
// these, so resizing the view does not make a new thumbnail for every pixel.
const WIDTHS = [320, 640, 1024];

function cacheRoot() {
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Caches', 'arch-images-plus');
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'arch-images-plus');
  return path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'arch-images-plus');
}

function sha1(s) {
  return crypto.createHash('sha1').update(s).digest('hex');
}

function thumbWidthFor(px) {
  for (const w of WIDTHS) if (px <= w) return w;
  return WIDTHS[WIDTHS.length - 1];
}

class ThumbCache {
  // vaultPath: absolute path of the vault. log: the plugin's logger.
  constructor(vaultPath, log) {
    this.vaultPath = vaultPath;
    this.log = log || (() => {});
    this.dir = path.join(cacheRoot(), sha1(vaultPath).slice(0, 16));
    this.indexPath = path.join(this.dir, 'index.json');
    // key -> { w, h } of the ORIGINAL image, and which thumbnail widths exist.
    this.index = {};
    this.dirty = false;
    this.saveTimer = null;
    this.queue = [];
    this.running = 0;
    this.concurrency = 2;
    this.made = 0;
    // One job per thumbnail, however many cards ask for it at once.
    this.inflight = new Map();
    this.ready = this.open();
  }

  async open() {
    try {
      await fs.promises.mkdir(this.dir, { recursive: true });
      const text = await fs.promises.readFile(this.indexPath, 'utf8');
      this.index = JSON.parse(text) || {};
    } catch (_) {
      this.index = {};
    }
    // A note beside the cache, for whoever finds the folder.
    fs.promises.writeFile(
      path.join(this.dir, 'README.txt'),
      `Thumbnails made by the ARCH Images Plus gallery for the vault at\n${this.vaultPath}\n\nSafe to delete; they are made again when needed.\n`,
    ).catch(() => {});
  }

  // A changed image gets a new key, because size and modified time are in it.
  key(file) {
    return sha1(`${file.path}\0${file.stat.size}\0${file.stat.mtime}`);
  }

  // The original's width and height, if known, so a card can be laid out
  // before its image arrives.
  dims(file) {
    const e = this.index[this.key(file)];
    return e && e.w ? { w: e.w, h: e.h } : null;
  }

  // Called when an original was shown directly and its size became known.
  noteDims(file, w, h) {
    if (!w || !h) return;
    const k = this.key(file);
    const e = this.index[k] || (this.index[k] = {});
    if (e.w === w && e.h === h) return;
    e.w = w; e.h = h;
    this.scheduleSave();
  }

  // Should this file be shown as it is, without a thumbnail?
  useOriginal(file) {
    const ext = file.extension.toLowerCase();
    // A GIF keeps its animation only as the original.
    if (ext === 'gif') return true;
    return file.stat.size < ORIGINAL_BELOW_BYTES;
  }

  thumbPath(file, width) {
    return path.join(this.dir, `${this.key(file)}-${width}.webp`);
  }

  // Resolves to the absolute path of a thumbnail at least `px` wide (or the
  // widest made), making it if needed; null if the file should be shown as it
  // is or the thumbnail could not be made. `token.cancelled = true` drops a
  // request still waiting in the queue, so scrolling past does not leave work
  // behind.
  async get(file, px, token) {
    await this.ready;
    const width = thumbWidthFor(px);
    const k = this.key(file);
    const e = this.index[k];
    if (e && e.thumbs && e.thumbs.includes(width)) {
      const p = this.thumbPath(file, width);
      if (fs.existsSync(p)) return p;
    }
    // An image narrower than the thumbnail is never shrunk.
    if (e && e.w && e.w <= width) return null;
    const id = `${k}-${width}`;
    if (this.inflight.has(id)) return this.inflight.get(id);
    const p = new Promise((resolve) => {
      this.queue.push({ file, width, token: token || {}, resolve });
      this.pump();
    }).finally(() => this.inflight.delete(id));
    this.inflight.set(id, p);
    return p;
  }

  pump() {
    while (this.running < this.concurrency && this.queue.length) {
      const job = this.queue.shift();
      if (job.token.cancelled) { job.resolve(null); continue; }
      this.running++;
      this.make(job.file, job.width)
        .then(job.resolve, (err) => {
          this.log('thumbnail failed, showing the original', job.file.path, err && err.message);
          job.resolve(null);
        })
        .finally(() => { this.running--; this.pump(); });
    }
  }

  async make(file, width) {
    const full = path.join(this.vaultPath, file.path);
    const bytes = await fs.promises.readFile(full);
    // createImageBitmap decodes off the main thread in Chromium, which is what
    // keeps scrolling smooth while the cache fills.
    const original = await createImageBitmap(new Blob([bytes]));
    const w = original.width, h = original.height;
    const k = this.key(file);
    const e = this.index[k] || (this.index[k] = {});
    e.w = w; e.h = h;
    this.scheduleSave();
    if (w <= width) { original.close(); return null; }
    const th = Math.max(1, Math.round(h * width / w));
    const small = await createImageBitmap(original, { resizeWidth: width, resizeHeight: th, resizeQuality: 'high' });
    original.close();
    const canvas = new OffscreenCanvas(width, th);
    canvas.getContext('2d').drawImage(small, 0, 0);
    small.close();
    const blob = await canvas.convertToBlob({ type: 'image/webp', quality: 0.85 });
    const out = this.thumbPath(file, width);
    await fs.promises.writeFile(out, Buffer.from(await blob.arrayBuffer()));
    e.thumbs = Array.from(new Set([...(e.thumbs || []), width]));
    this.scheduleSave();
    this.made++;
    return out;
  }

  scheduleSave() {
    this.dirty = true;
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => { this.saveTimer = null; this.save(); }, 2000);
  }

  save() {
    if (!this.dirty) return;
    this.dirty = false;
    fs.promises.writeFile(this.indexPath, JSON.stringify(this.index)).catch((err) => {
      this.log('could not save the thumbnail index', err && err.message);
    });
  }

  // Empties the queue and writes the index; the plugin calls this on unload.
  close() {
    for (const job of this.queue) job.resolve(null);
    this.queue = [];
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    this.save();
  }

  async clear() {
    this.close();
    this.index = {};
    await fs.promises.rm(this.dir, { recursive: true, force: true });
    await fs.promises.mkdir(this.dir, { recursive: true });
  }
}

module.exports = { ThumbCache, thumbCacheRoot: cacheRoot };
