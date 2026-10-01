'use strict';

const { Plugin, PluginSettingTab, Setting, Notice, Modal, TFile, TFolder, normalizePath } = require('obsidian');
const path = require('path');
const fs = require('fs');
const os = require('os');

/* ---------------- one computer does the automatic work (0.6.0) ---------------- */

// Since 2026-09-25 the vaults are mirrored between the Mac and an Ubuntu PC by
// Syncthing. A note written on one machine arrives on the other as a new file,
// so with Obsidian open on both, both would process it: two downloads, two
// conversions, conflict files. The setting automaticOn names the one computer
// that runs the automatic work; the settings file syncs, so both machines read
// the same answer. Commands and menus run anywhere. computerName and
// automaticRunsHere are shared with ARCH After Clipping, copied word for word;
// the default is not: here it is every computer (0.7.7, his choice).
//
// The name is macOS's Local Hostname there, because the kernel hostname can
// change with the network; elsewhere os.hostname().
function computerName() {
  if (process.platform === 'darwin') {
    try {
      const n = require('child_process')
        .execFileSync('/usr/sbin/scutil', ['--get', 'LocalHostName'], { encoding: 'utf8', timeout: 3000 })
        .trim();
      if (n) return n;
    } catch (_) {}
  }
  return os.hostname().replace(/\.local$/, '');
}

// automaticOn: '' or '*' is every computer, anything else one computer's name.
function automaticRunsHere(settings, here) {
  const a = String(settings.automaticOn || '');
  return !a || a === '*' || a === here;
}

const DEFAULT_SETTINGS = {
  // --- conversion ---
  format: 'webp',            // webp | jpeg | png | keep
  // 0.90, not the 0.75-0.80 usually recommended. That advice optimises for
  // bandwidth while a master copy is kept elsewhere; here conversion REPLACES
  // the original, so the quality chosen is the quality kept forever.
  // Measured by SSIM against real images from this vault:
  //   screenshots and text pages  0.996+ at q75 -- indistinguishable at any level,
  //                               and the extra bytes for q90 are tens of KB
  //   high-resolution photographs 0.898 at q75, 0.917 at q80, 0.971 at q90
  // Below about 0.95 the artifacts on skin and faces become visible, which is
  // the complaint people have about WebP. q90 clears it, and a 21.6 MB PNG still
  // lands at 2.3 MB.
  quality: 0.90,             // 0.1 - 1.0, lossy formats only
  maxLongEdge: 0,            // 0 = never resize
  skipIfLarger: true,
  skipAnimated: true,
  skipSmallerThanKb: 0,      // leave tiny images alone entirely

  // --- naming ---
  // {{counter}} counts per name since 0.8.0 (the next number after the highest
  // already in the vault), so this numbers each note's images 01, 02, 03.
  nameTemplate: '{{noteName}} {{counter}}',
  askOnPaste: true,          // show the rename prompt before saving

  // --- where the file lands ---
  // Same choices as Obsidian's "Default location for new attachments", so the
  // setting reads the way Obsidian's own does.
  locationMode: 'obsidian',  // obsidian | vault | same | subfolder | specified
  subfolder: 'Materials',
  folder: 'Attachments',

  // --- watch for images arriving from anywhere ---
  // Paste and drop are handled by this plugin's own handler. Everything else --
  // a clipper saving an image, another plugin downloading one, a file dropped
  // into the vault folder in Finder -- arrives as a vault 'create' event.
  autoConvert: true,
  autoConvertDelayMs: 1500,
  autoConvertFolders: '',
  // Excluded folders apply to EVERY path -- the watcher, the bulk commands, the
  // right-click menu and the whole-vault button. An original you cannot
  // re-download must not be convertible by accident from any direction.
  excludeFolders: '',
  // Folders whose images are converted LOSSLESSLY -- still WebP, still smaller
  // than PNG, but pixel-for-pixel identical. For originals that cannot be
  // re-downloaded but are not worth leaving as 20 MB PNGs.
  losslessFolders: '',

  // --- bulk conversion of images already in the vault ---
  bulkFormat: 'webp',
  bulkSkipExtensions: 'svg, gif',
  bulkDryRun: true,

  setupDone: false,
  // The computer whose watcher converts images arriving in the vault (0.6.0).
  // '*' every computer, else a computer's name. Paste, drop, the menus and the
  // commands work everywhere. Every computer by default since 0.7.7, at his
  // word; until then the first computer to load a vault claimed it.
  automaticOn: '*',
};

const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'webp', 'avif', 'bmp', 'gif', 'tif', 'tiff', 'heic', 'heif'];
// Renaming by order takes SVG too: it is never converted, but it is numbered.
const RENAMABLE_EXTS = [...IMAGE_EXTS, 'svg'];

class ArchImagesPlugin extends Plugin {
  async onload() {
    await this.loadSettings();
    this.queue = Promise.resolve();
    // Paths this plugin wrote itself, so the create-watcher can ignore them.
    this.justWrote = new Set();

    this.registerEvent(this.app.workspace.on('editor-paste', (evt, editor, view) => this.onPaste(evt, editor, view)));
    this.registerEvent(this.app.workspace.on('editor-drop', (evt, editor, view) => this.onDrop(evt, editor, view)));

    // 'create' fires for EVERY existing file while the vault is being indexed at
    // startup, so binding it before layout-ready would convert the whole vault
    // on every launch. onLayoutReady is what makes this mean "new file".
    this.app.workspace.onLayoutReady(() => {
      this.registerEvent(this.app.vault.on('create', (file) => this.onCreated(file)));
    });

    this.registerEvent(this.app.workspace.on('file-menu', (menu, file) => this.onFileMenu(menu, [file])));
    this.registerEvent(this.app.workspace.on('files-menu', (menu, files) => this.onFileMenu(menu, files)));

    this.addCommand({
      id: 'convert-vault-images',
      name: 'Convert Images in the Whole Vault',
      callback: () => this.bulkConvert(this.allImages()),
    });
    this.addCommand({
      id: 'convert-images-in-note',
      name: 'Convert Images Linked from the Active Note',
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file) return false;
        if (!checking) this.bulkConvert(this.imagesLinkedFrom(file));
        return true;
      },
    });

    this.addCommand({
      id: 'rename-images-by-order',
      name: 'Rename Images in the Active Note by Their Order',
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || file.extension !== 'md') return false;
        if (!checking) this.renameByOrder(file);
        return true;
      },
    });

    this.registerGallery();

    this.addSettingTab(new ArchImagesSettingTab(this.app, this));
    this.log('loaded', this.manifest.version);
  }

  onunload() {
    if (this.thumbs) this.thumbs.close();
    if (this.galleryStyle) this.galleryStyle.remove();
  }

  /* ---------------- the gallery view for Bases ---------------- */

  // A view for Bases, built to replace Bases Image Gallery in CHAOS. The view
  // itself is lib/gallery.js, the thumbnails lib/thumbs.js; why each part is
  // there is in "Image Gallery Plan.md".
  registerGallery() {
    if (typeof this.registerBasesView !== 'function') return; // Obsidian before 1.10
    const g = this.lib();
    this.thumbs = new g.ThumbCache(this.vaultRoot(), (...a) => this.log('[gallery]', ...a));

    // The first draw waits for this. Bases Image Gallery drew while the vault was
    // still opening, and from a slow drive that held up the whole app. Links are
    // resolved after the layout is ready, and the backlink groups need them, so
    // it waits for the metadata cache too.
    //
    // `onCleanCache` is internal (not in obsidian.d.ts) but is what Obsidian
    // itself uses: it calls back at once when the cache is already clean, and
    // when it becomes clean otherwise. Waiting for the public 'resolved' event
    // instead cost a fixed 3 s on every open (measured 2026-09-26), because it
    // had usually fired before this plugin was listening. If the internal hook
    // ever disappears, 'resolved' and a timer take over.
    this.galleryReady = new Promise((resolve) => {
      this.app.workspace.onLayoutReady(() => {
        let done = false;
        const finish = () => { if (!done) { done = true; resolve(); } };
        const mc = this.app.metadataCache;
        if (typeof mc.onCleanCache === 'function') {
          mc.onCleanCache(finish);
          setTimeout(finish, 30000);
        } else {
          this.registerEvent(mc.on('resolved', finish));
          setTimeout(finish, 3000);
        }
      });
    });

    this.galleryStyle = document.head.createEl('style', { attr: { id: 'arch-images-plus-gallery' } });
    this.galleryStyle.textContent = g.GALLERY_CSS;

    const View = g.makeGalleryView(require('obsidian'), this);
    this.registerBasesView(g.GALLERY_VIEW_TYPE, {
      name: 'ARCH Image Gallery',
      icon: 'lucide-images',
      factory: (controller, containerEl) => new View(controller, containerEl),
      options: (config) => g.galleryOptions(config),
    });

    // A base tab already open when the plugin is reloaded or updated keeps the
    // gallery made by the old code, with the new styles, so its lightbox came
    // out broken. Such tabs are rebuilt. Not at vault startup (the layout is not
    // ready yet then), when no gallery exists and the tabs are still loading.
    if (this.app.workspace.layoutReady) {
      for (const leaf of this.app.workspace.getLeavesOfType('bases')) {
        if (typeof leaf.rebuildView === 'function') leaf.rebuildView();
      }
    }

    this.addCommand({
      id: 'clear-gallery-thumbnails',
      name: 'Clear the Gallery Thumbnail Cache',
      callback: async () => {
        await this.thumbs.clear();
        new Notice('ARCH Images Plus: gallery thumbnails cleared. They are made again as images are shown.');
        this.log('[gallery] thumbnail cache cleared', this.thumbs.dir);
      },
    });
  }

  /* ---------------- lib loading ---------------- */

  // Takes the bundle when built, falls back to disk so the repo runs unbuilt.
  // See CLAUDE.md: losing either half costs something real.
  lib() {
    if (this._lib) return this._lib;
    if (typeof ARCH_LIB !== 'undefined') { this._lib = ARCH_LIB; return this._lib; }
    const dir = path.join(this.vaultRoot(), this.app.vault.configDir, 'plugins', this.manifest.id, 'lib');
    this.dropLibFromRequireCache(dir);
    this._lib = require(path.join(dir, 'index.js'));
    return this._lib;
  }

  // Electron's require() caches by resolved path, and disabling and re-enabling
  // a plugin does NOT clear that cache. Without this, editing lib/ and reloading
  // the plugin silently keeps running the OLD code -- which makes the disk
  // fallback, whose whole purpose is the edit-and-reload loop, useless.
  //
  // The plugin folder is often a symlink into the repo during development, and
  // require resolves symlinks, so the cached keys live under the REAL path, not
  // the one under .obsidian. Both are matched.
  //
  // The `require` a plugin is handed is Obsidian's wrapper, and its `.cache` is
  // not Node's; Electron's real one is `window.require.cache` (found in ARCH
  // Recreations). Both caches are walked, since which one holds the entries is
  // not something to rely on.
  dropLibFromRequireCache(dir) {
    const caches = [];
    if (typeof window !== 'undefined' && window.require && window.require.cache) caches.push(window.require.cache);
    if (typeof require !== 'undefined' && require.cache && !caches.includes(require.cache)) caches.push(require.cache);
    const roots = [dir];
    try { roots.push(fs.realpathSync(dir)); } catch (_) { /* not a link, or gone */ }
    let dropped = 0;
    for (const cache of caches) {
      for (const key of Object.keys(cache)) {
        if (roots.some((root) => key.startsWith(root + path.sep))) {
          delete cache[key];
          dropped++;
        }
      }
    }
    if (dropped) this.log(`reloaded ${dropped} lib module(s) from disk`);
  }

  vaultRoot() { return this.app.vault.adapter.getBasePath(); }
  log(...a) { console.log('[arch-images]', ...a); }

  /* ---------------- paste and drop ---------------- */

  // ONE handler owns the event. preventDefault runs before any await, so
  // Obsidian's own attachment save never starts and there is nothing to race
  // with -- this is the whole reason this plugin exists. See CLAUDE.md.
  onPaste(evt, editor, view) {
    const files = this.imageFilesFrom(evt.clipboardData);
    if (!files.length) return;
    evt.preventDefault();
    const markers = this.insertPlaceholders(editor, files.length);
    this.enqueue(() => this.handleFiles(files, editor, view, markers));
  }

  onDrop(evt, editor, view) {
    const files = this.imageFilesFrom(evt.dataTransfer);
    if (!files.length) return;
    evt.preventDefault();
    const markers = this.insertPlaceholders(editor, files.length);
    this.enqueue(() => this.handleFiles(files, editor, view, markers));
  }

  // The embed is NOT inserted at the cursor once the image is saved. By then
  // the conversion and the rename prompt have both run, and the cursor is
  // wherever the editor left it -- which, after a modal and a reload of the
  // note, was once three characters short of where the paste happened, inside
  // the closing frontmatter fence. A placeholder written synchronously, here,
  // is the only thing that still marks the paste position afterwards.
  insertPlaceholders(editor, count) {
    const markers = [];
    for (let i = 0; i < count; i++) {
      markers.push(`[Saving image ${Math.random().toString(36).slice(2, 8)}…]`);
    }
    editor.replaceSelection(markers.map((m) => m + '\n').join(''));
    return markers;
  }

  // Replaces a placeholder wherever it is now, or removes it when text is
  // empty. Searching the document rather than remembering an offset is what
  // makes edits, cursor moves and a re-rendered note while the prompt is open
  // harmless. If the placeholder is gone the user removed it, so nothing is
  // inserted: guessing a position is exactly the bug this replaces.
  replacePlaceholder(editor, marker, text) {
    const doc = editor.getValue();
    const at = doc.indexOf(marker);
    if (at === -1) {
      this.log('placeholder no longer in the note, not inserting:', marker);
      return;
    }
    let end = at + marker.length;
    if (!text && doc[end] === '\n') end++;   // take the line with it
    editor.replaceRange(text, editor.offsetToPos(at), editor.offsetToPos(end));
    // The modal's focus round-trip can leave the selection anywhere; put it
    // where Obsidian's own paste would, on the line after the embed.
    if (text) editor.setCursor(editor.offsetToPos(at + text.length + 1));
  }

  imageFilesFrom(transfer) {
    if (!transfer || !transfer.files || !transfer.files.length) return [];
    return Array.from(transfer.files).filter((f) => f.type && f.type.startsWith('image/'));
  }

  // Saves run one at a time. Two images pasted together otherwise resolve their
  // counters against the same folder listing and collide on the same name.
  enqueue(task) {
    this.queue = this.queue.then(task, task).catch((e) => {
      console.error('[arch-images]', e);
      new Notice(`Image failed: ${e.message}. Try it again; the full error is in the developer console.`, 8000);
    });
    return this.queue;
  }

  async handleFiles(files, editor, view, markers) {
    const note = view && view.file ? view.file : this.app.workspace.getActiveFile();
    let failure = null;
    for (let i = 0; i < files.length; i++) {
      let saved = null;
      if (!failure) {
        try { saved = await this.saveOne(files[i], note); } catch (e) { failure = e; }
      }
      // Every placeholder is resolved, including those after a failure, so a
      // thrown save never leaves "[Saving image …]" text behind in the note.
      this.replacePlaceholder(editor, markers[i], saved ? this.embedFor(saved, note) : '');
    }
    if (failure) throw failure;
  }

  async saveOne(file, note) {
    const { convertBlob, formatInfo, buildStem } = this.lib();
    const tooSmall = this.settings.skipSmallerThanKb > 0 && file.size < this.settings.skipSmallerThanKb * 1024;

    let bytes = new Uint8Array(await file.arrayBuffer());
    let ext = this.extFor(file);
    let result = null;

    // WHERE the image will land has to be known BEFORE it is encoded, or the
    // folder rules cannot apply to a paste: pasting into a note whose images go
    // to an excluded folder would convert it anyway, which is precisely what
    // "never convert this folder" is supposed to prevent.
    const folder = await this.destinationFolder(note, ext);
    const excluded = this.inFolderList(folder, this.settings.excludeFolders);
    const quality = this.inFolderList(folder, this.settings.losslessFolders)
      ? 1
      : Number(this.settings.quality);

    if (excluded) {
      this.log(`pasting into an excluded folder (${folder || 'vault root'}) — keeping the original format`);
    }

    if (!excluded && !tooSmall && this.settings.format !== 'keep') {
      result = await convertBlob(file, {
        format: this.settings.format,
        quality,
        maxLongEdge: Number(this.settings.maxLongEdge),
        skipIfLarger: this.settings.skipIfLarger,
        skipAnimated: this.settings.skipAnimated,
      });
      if (result && result.data) {
        bytes = result.data;
        ext = result.ext || formatInfo(this.settings.format).ext;
      } else if (result && result.skipped) {
        this.log('kept original:', result.skipped, file.name || '(clipboard)');
      }
    }

    const vars = {
      template: this.settings.nameTemplate,
      noteName: note ? note.basename : '',
      originalName: file.name,
      width: result && result.width,
      height: result && result.height,
      now: new Date(),
    };
    let stem = buildStem({ ...vars, counter: this.nextCounter(vars) });

    if (this.settings.askOnPaste) {
      const answer = await this.promptForName(stem);
      if (answer === null) return null;
      stem = answer || stem;
    }

    const target = await this.attachmentPathFor(note, stem, ext);
    this.justWrote.add(target);
    await this.app.vault.createBinary(target, bytes);
    this.report(file, bytes, result, target);
    return this.app.vault.getAbstractFileByPath(target) || { path: target };
  }

  // The folder an attachment would land in, resolved without committing to a
  // filename. For the 'obsidian' mode that means asking Obsidian for a path and
  // taking its parent -- the extension passed in only affects the name, not the
  // folder, so the source extension is good enough to ask with.
  async destinationFolder(note, ext) {
    if ((this.settings.locationMode || 'obsidian') === 'obsidian') {
      try {
        const probe = await this.app.vault.getAvailablePathForAttachments('probe', String(ext).replace(/^\./, ''), note);
        if (probe) {
          const p = normalizePath(probe);
          const cut = p.lastIndexOf('/');
          return cut === -1 ? '' : p.slice(0, cut);
        }
      } catch (_) { /* older build: fall through to the folder setting */ }
    }
    return this.resolveFolder(note);
  }

  // The next number for this name, read off the images already in the vault
  // (0.8.0), so each note counts on its own: B's first image is B 01 even
  // after A 01 and A 02 were pasted. Every folder is searched, since two
  // images of one name in different folders make a wikilink ambiguous. Saves
  // run one at a time through the queue, so an image pasted with others sees
  // the ones before it already on disk.
  nextCounter(vars) {
    const { counterPattern, nextCounterFrom } = this.lib();
    const pattern = counterPattern(vars);
    if (!pattern) return null;
    return nextCounterFrom(this.allImages().map((f) => f.basename), pattern);
  }

  extFor(file) {
    const fromName = path.extname(file.name || '');
    if (fromName) return fromName.toLowerCase();
    const sub = (file.type || '').split('/')[1] || 'png';
    return '.' + (sub === 'jpeg' ? 'jpg' : sub);
  }

  report(file, bytes, result, target) {
    if (!result || !result.data) {
      this.log(`pasted ${file.name || '(clipboard)'} kept as-is → ${target}`);
      return;
    }
    const before = file.size;
    const pct = before ? Math.round((1 - bytes.length / before) * 100) : 0;
    this.log(`pasted → ${target} — ${kb(before)} → ${kb(bytes.length)} (${pct}% smaller)` +
      (result.lossless ? ' [lossless]' : '') +
      (result.resized ? `, resized to ${result.width}×${result.height}` : ''));
    new Notice(`${path.basename(target)} — ${kb(before)} → ${kb(bytes.length)} (${pct}% smaller)`, 4000);
  }

  /* ---------------- images arriving from elsewhere ---------------- */

  // Folder scoping, shared by every conversion path. `excluded` wins over
  // `autoConvertFolders`: a folder named in both is left alone.
  inFolderList(path, raw) {
    const folders = String(raw || '').split(/[,\n]/).map((x) => x.trim().replace(/\/+$/, '')).filter(Boolean);
    if (!folders.length) return false;
    return folders.some((f) => path === f || path.startsWith(f + '/'));
  }

  isExcluded(file) {
    return this.inFolderList(file.path, this.settings.excludeFolders);
  }

  // Quality 1.0 is not "lossy at maximum" -- Chromium's canvas encoder switches
  // to lossless WebP there. Verified in headless Chrome against a noise image:
  // q=0.9 differed in 194,633 subpixels, q=1.0 in zero. Do not assume; if this
  // ever needs re-checking, the test is a canvas round-trip and a pixel compare.
  qualityFor(file) {
    return this.inFolderList(file.path, this.settings.losslessFolders)
      ? 1
      : Number(this.settings.quality);
  }

  onCreated(file) {
    if (!this.settings.autoConvert) return;
    if (!automaticRunsHere(this.settings, this.computer)) return;
    if (!(file instanceof TFile)) return;
    if (!IMAGE_EXTS.includes(file.extension.toLowerCase())) return;
    if (this.isExcluded(file)) return;

    // Never touch what this plugin just wrote. Without this, a paste converts,
    // fires 'create', and gets picked up for conversion a second time.
    if (this.justWrote.has(file.path)) { this.justWrote.delete(file.path); return; }

    const { formatInfo } = this.lib();
    if ('.' + file.extension.toLowerCase() === formatInfo(this.settings.bulkFormat).ext) return;

    const skip = new Set(String(this.settings.bulkSkipExtensions || '')
      .split(/[,\n]/).map((x) => x.trim().toLowerCase().replace(/^\./, '')).filter(Boolean));
    if (skip.has(file.extension.toLowerCase())) return;

    if (String(this.settings.autoConvertFolders || '').trim() && !this.inFolderList(file.path, this.settings.autoConvertFolders)) return;

    // A file that has only just been created may still be being written to --
    // a download in progress reads as a truncated image and converts to
    // garbage. The delay is a deliberate wait for the writer to finish.
    window.setTimeout(() => this.enqueue(() => this.convertExisting(file)), Number(this.settings.autoConvertDelayMs) || 0);
  }

  async convertExisting(file) {
    const current = this.app.vault.getAbstractFileByPath(file.path);
    if (!(current instanceof TFile)) return; // moved or deleted while we waited
    const { convertBlob, formatInfo } = this.lib();
    // With every computer converting (0.7.7), the other one may already have
    // converted this image and its copy arrived first. Converting again would
    // save "name 1.webp" and both computers would rewrite the note's link.
    const folder = current.parent ? current.parent.path : '';
    const twin = normalizePath((folder ? folder + '/' : '') + current.basename + formatInfo(this.settings.bulkFormat).ext);
    if (this.app.vault.getAbstractFileByPath(twin) instanceof TFile) {
      this.log(`left alone, ${twin} is already there (converted on the other computer?): ${current.path}`);
      return;
    }
    const raw = await this.app.vault.readBinary(current);
    const before = raw.byteLength;
    if (this.settings.skipSmallerThanKb > 0 && before < this.settings.skipSmallerThanKb * 1024) return;

    const lossless = this.qualityFor(current) === 1;
    const result = await convertBlob(new Blob([raw], { type: mimeForExt(current.extension) }), {
      format: this.settings.bulkFormat,
      quality: this.qualityFor(current),
      maxLongEdge: Number(this.settings.maxLongEdge),
      skipIfLarger: this.settings.skipIfLarger,
      skipAnimated: this.settings.skipAnimated,
    });
    if (!result || !result.data) {
      this.log('left alone:', result && result.skipped, current.path);
      return;
    }
    const ext = result.ext || formatInfo(this.settings.bulkFormat).ext;
    await this.replaceInPlace(current, result.data, ext);
    this.log(`auto-converted${lossless ? ' (lossless)' : ''} ${current.path} — ${kb(before)} → ${kb(result.data.length)}`);
  }

  /* ---------------- bulk conversion ---------------- */

  allImages() {
    return this.app.vault.getFiles().filter((f) => IMAGE_EXTS.includes(f.extension.toLowerCase()));
  }

  imagesLinkedFrom(note) {
    const links = this.app.metadataCache.resolvedLinks[note.path] || {};
    return Object.keys(links)
      .map((p) => this.app.vault.getAbstractFileByPath(p))
      .filter((f) => f instanceof TFile && IMAGE_EXTS.includes(f.extension.toLowerCase()));
  }

  imagesUnder(folder) {
    const out = [];
    const walk = (f) => {
      for (const child of f.children || []) {
        if (child instanceof TFolder) walk(child);
        else if (child instanceof TFile && IMAGE_EXTS.includes(child.extension.toLowerCase())) out.push(child);
      }
    };
    walk(folder);
    return out;
  }

  onFileMenu(menu, files) {
    const targets = [];
    for (const f of files) {
      if (f instanceof TFolder) targets.push(...this.imagesUnder(f));
      else if (f instanceof TFile && IMAGE_EXTS.includes(f.extension.toLowerCase())) targets.push(f);
    }
    if (!targets.length) return;
    menu.addItem((item) => {
      item.setTitle(`Convert ${targets.length.toLocaleString()} Image${targets.length > 1 ? 's' : ''} to ${this.settings.bulkFormat.toUpperCase()}`)
        .setIcon('image-file')
        .onClick(() => this.bulkConvert(targets));
    });
  }

  async bulkConvert(files) {
    const { formatInfo } = this.lib();
    const skip = new Set(String(this.settings.bulkSkipExtensions || '')
      .split(/[,\n]/).map((s) => s.trim().toLowerCase().replace(/^\./, '')).filter(Boolean));
    const targetExt = formatInfo(this.settings.bulkFormat).ext;

    const excluded = files.filter((f) => this.isExcluded(f));
    const work = files.filter((f) => !this.isExcluded(f) && !skip.has(f.extension.toLowerCase()) && '.' + f.extension.toLowerCase() !== targetExt);
    if (excluded.length) this.log(`${excluded.length} images skipped: in an excluded folder`);
    this.log(`${files.length} images selected, ${work.length} to convert` +
      (files.length - work.length ? ` (${files.length - work.length} already ${this.settings.bulkFormat.toUpperCase()} or excluded)` : ''));
    if (!work.length) return new Notice('Nothing to convert.', 4000);

    if (this.settings.bulkDryRun) {
      new BulkPreviewModal(this.app, this, work, () => this.runBulk(work)).open();
      return;
    }
    await this.runBulk(work);
  }

  async runBulk(files) {
    const { convertBlob, formatInfo } = this.lib();
    const notice = new Notice('Converting…', 0);
    let done = 0, saved = 0, failed = 0, skipped = 0;
    const started = Date.now();
    const reasons = {};

    this.log(`converting ${files.length} images to ${this.settings.bulkFormat.toUpperCase()}` +
      ` at quality ${Math.round(this.settings.quality * 100)}%` +
      (Number(this.settings.maxLongEdge) ? `, max long edge ${this.settings.maxLongEdge}px` : ', no resize'));

    for (const file of files) {
      try {
        notice.setMessage(`Converting ${done + 1}/${files.length}\n${file.name}`);
        const raw = await this.app.vault.readBinary(file);
        const before = raw.byteLength;
        const blob = new Blob([raw], { type: mimeForExt(file.extension) });

        const losslessHere = this.qualityFor(file) === 1;
        const result = await convertBlob(blob, {
          format: this.settings.bulkFormat,
          quality: this.qualityFor(file),
          maxLongEdge: Number(this.settings.maxLongEdge),
          skipIfLarger: this.settings.skipIfLarger,
          skipAnimated: this.settings.skipAnimated,
        });
        if (!result || !result.data) {
          const why = (result && result.skipped) || 'unknown';
          reasons[why] = (reasons[why] || 0) + 1;
          this.log(`  skipped (${why}): ${file.path}`);
          skipped++; done++; continue;
        }

        const ext = result.ext || formatInfo(this.settings.bulkFormat).ext;
        await this.replaceInPlace(file, result.data, ext);
        saved += before - result.data.length;
        done++;
        const pct = before ? Math.round((1 - result.data.length / before) * 100) : 0;
        this.log(`  ${file.path}${losslessHere ? ' [lossless]' : ''} — ${kb(before)} → ${kb(result.data.length)} (${pct}% smaller)` +
          (result.resized ? `, resized to ${result.width}×${result.height}` : ''));
      } catch (e) {
        failed++;
        done++;
        // Full stack, because the failures worth chasing here are Obsidian API
        // errors from replaceInPlace, not decode errors.
        console.error('[arch-images]', file.path, e);
      }
    }
    notice.hide();
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    this.log(`done in ${secs}s — ${done - failed - skipped} converted, ${skipped} left alone, ${failed} failed, ${kb(saved)} saved`);
    if (Object.keys(reasons).length) this.log('  left alone because:', reasons);
    new Notice(`Converted ${done - failed - skipped}/${files.length}. ${kb(saved)} saved.` +
      (skipped ? ` ${skipped} left alone.` : '') + (failed ? ` ${failed} failed.` : ''), 10000);
  }

  // The trick that makes bulk conversion safe: RENAME FIRST, then overwrite the
  // bytes. fileManager.renameFile is what Obsidian itself uses, so it rewrites
  // every reference -- wikilinks, markdown links, embeds, frontmatter and
  // canvas files -- including forms this plugin would never think to grep for.
  // Doing it the other way round (write new, rewrite links by hand, delete old)
  // was the original plan and it loses canvas references silently.
  async replaceInPlace(file, bytes, newExt) {
    const currentExt = '.' + file.extension;
    if (newExt && newExt !== currentExt) {
      const folder = file.parent ? file.parent.path : '';
      const target = await this.uniquePath(folder, file.basename + newExt);
      await this.app.fileManager.renameFile(file, target);
    }
    const moved = this.app.vault.getAbstractFileByPath(file.path);
    await this.app.vault.modifyBinary(moved instanceof TFile ? moved : file, bytes);
  }

  /* ---------------- renaming a note's images by their order (0.8.0) ---------------- */

  // The images a note shows or links to, in the order they appear in it, each
  // once. Remote images and links to notes resolve to nothing and drop out.
  imagesInOrder(note) {
    const cache = this.app.metadataCache.getFileCache(note) || {};
    const refs = [...(cache.embeds || []), ...(cache.links || [])]
      .sort((a, b) => a.position.start.offset - b.position.start.offset);
    const seen = new Set();
    const out = [];
    for (const ref of refs) {
      const f = this.app.metadataCache.getFirstLinkpathDest(String(ref.link).split('#')[0], note.path);
      if (!(f instanceof TFile) || !RENAMABLE_EXTS.includes(f.extension.toLowerCase()) || seen.has(f.path)) continue;
      seen.add(f.path);
      out.push(f);
    }
    return out;
  }

  // Which other notes link to each of these images. An image two notes share
  // is left alone by default: renaming it after one note takes it out of the
  // other's numbering.
  otherNotesUsing(images, note) {
    const wanted = new Set(images.map((f) => f.path));
    const users = new Map();
    const resolved = this.app.metadataCache.resolvedLinks;
    for (const source of Object.keys(resolved)) {
      if (source === note.path) continue;
      for (const target of Object.keys(resolved[source])) {
        if (!wanted.has(target)) continue;
        if (!users.has(target)) users.set(target, []);
        users.get(target).push(source);
      }
    }
    return users;
  }

  // What each image would become. Images are numbered 1, 2, 3 in the order of
  // the note, counting only those that will carry the note's name, and each
  // stays in its own folder. A name already taken by a file outside this set
  // is reported and that image left alone: taking the next free name would
  // break the numbering, which is the point of the command.
  async planRenameByOrder(note, images, users, includeShared) {
    const { buildStem, hasCounter } = this.lib();
    let template = this.settings.nameTemplate;
    if (!hasCounter(template)) template += ' {{counter}}';
    const rows = [];
    let n = 0;
    for (const file of images) {
      const shared = users.get(file.path) || [];
      if (shared.length && !includeShared) { rows.push({ file, skip: 'shared', shared }); continue; }
      n++;
      const stem = buildStem({ template, noteName: note.basename, originalName: file.name, counter: n, now: new Date(file.stat.ctime) });
      const folder = file.parent ? file.parent.path : '';
      const target = normalizePath((folder ? folder + '/' : '') + stem + '.' + file.extension);
      rows.push({ file, target, shared, same: target === file.path });
    }
    // The Mac's disk ignores case, so occupancy is compared in lower case.
    const moving = new Set(rows.filter((r) => r.target).map((r) => r.file.path.toLowerCase()));
    for (const r of rows) {
      if (!r.target || r.same || moving.has(r.target.toLowerCase())) continue;
      if (await this.app.vault.adapter.exists(r.target)) r.skip = 'taken';
    }
    return rows;
  }

  async renameByOrder(note) {
    const images = this.imagesInOrder(note);
    if (!images.length) return new Notice(`No images in ${note.basename}.`, 4000);
    const users = this.otherNotesUsing(images, note);
    new RenameByOrderModal(this.app, this, note,
      (includeShared) => this.planRenameByOrder(note, images, users, includeShared),
      (rows) => this.enqueue(() => this.runRenameByOrder(note, rows))).open();
  }

  // Through fileManager.renameFile, so Obsidian rewrites every link, as in
  // replaceInPlace. Two steps: an image sitting on a name another image needs
  // (A 02 that becomes A 01 while A 01 becomes A 02) first moves to a
  // temporary name, then every image takes its new name.
  async runRenameByOrder(note, rows) {
    const moves = rows.filter((r) => r.target && !r.skip && !r.same);
    this.log(`renaming ${moves.length} images in ${note.path} by their order`);
    for (const r of rows) {
      if (r.skip === 'shared') this.log(`  left alone, also used in ${r.shared.join(', ')}: ${r.file.path}`);
      else if (r.skip === 'taken') this.log(`  left alone, ${r.target} is another file: ${r.file.path}`);
      else if (r.same) this.log(`  already named: ${r.file.path}`);
    }
    const targets = new Set(moves.map((r) => r.target.toLowerCase()));
    let done = 0, failed = 0;
    for (const r of moves) {
      if (!targets.has(r.file.path.toLowerCase())) continue;
      const folder = r.file.parent ? r.file.parent.path : '';
      const tmp = await this.uniquePath(folder, `${r.file.basename} arch-renaming.${r.file.extension}`);
      try { await this.app.fileManager.renameFile(r.file, tmp); }
      catch (e) { r.failed = true; failed++; console.error('[arch-images]', r.file.path, e); }
    }
    for (const r of moves) {
      if (r.failed) continue;
      const from = r.file.path;
      try {
        await this.app.fileManager.renameFile(r.file, r.target);   // the TFile follows the rename
        this.log(`  ${from} → ${r.target}`);
        done++;
      } catch (e) {
        failed++;
        console.error('[arch-images]', from, '→', r.target, e);
      }
    }
    const left = rows.length - moves.length;
    this.log(`done: ${done} renamed, ${left} left as they were, ${failed} failed`);
    new Notice(`Renamed ${done} image${done === 1 ? '' : 's'} in ${note.basename}.` +
      (failed ? ` ${failed} failed; the error is in the developer console.` : ''), 6000);
  }

  /* ---------------- paths and links ---------------- */

  // Blank/'obsidian' means "wherever Obsidian puts attachments", which respects
  // the vault's own setting instead of a folder this plugin invented.
  async attachmentPathFor(note, stem, ext) {
    if ((this.settings.locationMode || 'obsidian') === 'obsidian') {
      try {
        const p = await this.app.vault.getAvailablePathForAttachments(stem, ext.replace(/^\./, ''), note);
        if (p) return normalizePath(p);
      } catch (e) {
        this.log('attachment API unavailable, using the folder setting:', String(e.message));
      }
    }
    const folder = this.resolveFolder(note);
    await this.ensureFolder(folder);
    return this.uniquePath(folder, this.lib().sanitizeName(stem) + ext);
  }

  resolveFolder(note) {
    const mode = this.settings.locationMode === 'obsidian' ? 'specified' : this.settings.locationMode;
    const parentPath = note && note.parent ? note.parent.path : '';
    if (mode === 'vault') return '';
    if (mode === 'same') return parentPath;
    if (mode === 'subfolder') {
      const sub = this.expandFolderTokens(this.settings.subfolder, note);
      return sub ? (parentPath ? `${parentPath}/${sub}` : sub) : parentPath;
    }
    return this.expandFolderTokens(this.settings.folder, note) || 'Attachments';
  }

  expandFolderTokens(raw, note) {
    const { sanitizeName } = this.lib();
    return String(raw || '')
      .replace(/\\/g, '/')
      .replace(/\{\{noteName\}\}/gi, note ? note.basename : '')
      .replace(/\{\{notePath\}\}/gi, note && note.parent ? note.parent.path : '')
      .replace(/\{\{date\}\}/g, window.moment ? window.moment().format('YYYY-MM-DD') : '')
      .split('/')
      .map((seg) => (seg === '.' || seg === '' ? '' : sanitizeName(seg, '')))
      .filter(Boolean)
      .join('/');
  }

  async ensureFolder(folderPath) {
    const parts = String(folderPath || '').split('/').filter(Boolean);
    let current = '';
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      const existing = this.app.vault.getAbstractFileByPath(current);
      if (existing instanceof TFolder) continue;
      if (existing) throw new Error(`"${current}" exists but is a file, not a folder.`);
      try { await this.app.vault.createFolder(current); }
      catch (e) { if (!/exists/i.test(String(e && e.message))) throw e; }
    }
  }

  async uniquePath(folder, filename) {
    const ext = path.extname(filename);
    const stem = filename.slice(0, filename.length - ext.length);
    let candidate = normalizePath(folder ? `${folder}/${stem}${ext}` : `${stem}${ext}`);
    let n = 1;
    while (this.app.vault.getAbstractFileByPath(candidate)) {
      candidate = normalizePath(folder ? `${folder}/${stem} ${n}${ext}` : `${stem} ${n}${ext}`);
      n++;
    }
    return candidate;
  }

  embedFor(file, note) {
    let useMarkdown = false;
    try { useMarkdown = !!this.app.vault.getConfig('useMarkdownLinks'); } catch (_) { /* older builds */ }
    const link = this.app.metadataCache.fileToLinktext
      ? this.app.metadataCache.fileToLinktext(file, note ? note.path : '', true)
      : file.path;
    if (useMarkdown) return `![](<${link}>)`;
    return `![[${link}]]`;
  }

  promptForName(suggested) {
    return new Promise((resolve) => new RenameModal(this.app, suggested, resolve).open());
  }

  /* ---------------- settings ---------------- */

  async loadSettings() {
    const saved = (await this.loadData()) || {};
    this.settings = Object.assign({}, DEFAULT_SETTINGS, saved);
    // AVIF was offered briefly and removed. A saved 'avif' would otherwise fall
    // through formatInfo's default and write WebP bytes while the settings tab
    // showed a format that is no longer in the dropdown.
    if (this.settings.format === 'avif') this.settings.format = 'webp';
    if (this.settings.bulkFormat === 'avif') this.settings.bulkFormat = 'webp';
    // The old default, saved word for word, was saved by the 0.6.0 claim
    // (THOUGHTS, TESTFIELD), not chosen, so it follows the new default.
    if (saved.nameTemplate === '{{noteName}} {{date}}-{{counter}}') this.settings.nameTemplate = DEFAULT_SETTINGS.nameTemplate;
    delete this.settings.ffmpegPath;
    if (!this.computer) this.computer = computerName();
  }

  async saveSettings() { await this.saveData(this.settings); }

  // The settings file changed on disk under a running Obsidian: with the vaults
  // mirrored, an edit made on the other computer. Without reloading, the next
  // save here would write the old settings back over it.
  async onExternalSettingsChange() {
    await this.loadSettings();
    this.log('settings changed on disk (the other computer?), reloaded; automatic conversion runs on', this.settings.automaticOn);
  }
}

/* ---------------- helpers ---------------- */

function kb(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// A settings text box for a whole number of 0 or more. Only a real number is
// saved: anything else used to become 0, which for the long edge means "never
// resize", without a word.
function numberInput(t, value, set) {
  t.inputEl.type = 'number';
  t.inputEl.min = '0';
  t.inputEl.inputMode = 'numeric';
  t.setValue(String(value)).onChange(async (v) => {
    const n = Number(v);
    if (String(v).trim() === '' || !Number.isFinite(n) || n < 0) return;
    await set(Math.round(n));
  });
  return t;
}

// A settings text box holding paths, tokens or extensions, which spellcheck
// only underlines.
function plainInput(t) {
  t.inputEl.spellcheck = false;
  t.inputEl.setAttr('autocomplete', 'off');
  return t;
}

function mimeForExt(ext) {
  const e = String(ext || '').toLowerCase();
  if (e === 'jpg' || e === 'jpeg') return 'image/jpeg';
  if (e === 'tif') return 'image/tiff';
  return `image/${e}`;
}

/* ---------------- modals ---------------- */

class RenameModal extends Modal {
  constructor(app, suggested, resolve) {
    super(app);
    this.suggested = suggested;
    this.resolve = resolve;
    this.answered = false;
  }
  onOpen() {
    this.titleEl.setText('Name This Image');
    const input = this.contentEl.createEl('input', { type: 'text', value: this.suggested, attr: { 'aria-label': 'Image name', spellcheck: 'false', autocomplete: 'off' } });
    input.style.width = '100%';
    input.focus();
    input.select();
    // The key that closes this prompt must not reach the editor. Closing on
    // keydown hands focus back to the note while the same keystroke is still
    // in flight, and the browser then delivers its keypress/beforeinput there
    // -- with the editor's selection snapped to the start of the document, so
    // each Enter added a blank line ABOVE the frontmatter. preventDefault on
    // the keydown stops the keystroke producing any input at all.
    input.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      this.answered = true;
      this.resolve(e.key === 'Enter' ? input.value.trim() : null);
      this.close();
    });
    const row = this.contentEl.createDiv({ cls: 'modal-button-container' });
    row.createEl('button', { text: 'Save Name', cls: 'mod-cta' }).onclick = () => {
      this.answered = true; this.resolve(input.value.trim()); this.close();
    };
  }
  onClose() { if (!this.answered) this.resolve(null); }
}

class BulkPreviewModal extends Modal {
  constructor(app, plugin, files, onConfirm) {
    super(app);
    this.plugin = plugin;
    this.files = files;
    this.onConfirm = onConfirm;
  }
  onOpen() {
    this.titleEl.setText(`Convert ${this.files.length.toLocaleString()} Images to ${this.plugin.settings.bulkFormat.toUpperCase()}`);
    const total = this.files.reduce((n, f) => n + (f.stat ? f.stat.size : 0), 0);
    this.contentEl.createEl('p', {
      text: `${kb(total)} of images. Originals are replaced in place and every link is updated by Obsidian. This cannot be undone from inside Obsidian — make sure the vault is backed up or committed.`,
    });
    const list = this.contentEl.createEl('ul');
    list.style.maxHeight = '220px';
    list.style.overflow = 'auto';
    for (const f of this.files.slice(0, 200)) list.createEl('li', { text: `${f.path} — ${kb(f.stat ? f.stat.size : 0)}` });
    if (this.files.length > 200) list.createEl('li', { text: `… and ${this.files.length - 200} more` });

    const row = this.contentEl.createDiv({ cls: 'modal-button-container' });
    row.createEl('button', { text: 'Cancel' }).onclick = () => this.close();
    row.createEl('button', { text: `Convert ${this.files.length.toLocaleString()} Images`, cls: 'mod-cta' }).onclick = () => { this.close(); this.onConfirm(); };
  }
}

// The preview for renaming a note's images by their order. Always shown: the
// command renames files other notes may link to, and the list is the only
// place to see what will happen before it does.
class RenameByOrderModal extends Modal {
  constructor(app, plugin, note, plan, onConfirm) {
    super(app);
    this.plugin = plugin;
    this.note = note;
    this.plan = plan;
    this.onConfirm = onConfirm;
    this.includeShared = false;
  }
  async onOpen() {
    this.titleEl.setText(`Rename the Images in ${this.note.basename}`);
    await this.draw();
  }
  async draw() {
    const rows = await this.plan(this.includeShared);
    const el = this.contentEl;
    el.empty();
    const moves = rows.filter((r) => r.target && !r.skip && !r.same);
    const shared = rows.filter((r) => r.shared && r.shared.length).length;
    el.createEl('p', { text: 'Numbered in the order they appear in the note. Obsidian updates every link to them.' });
    if (shared) {
      new Setting(el)
        .setName('Rename Images Other Notes Use Too')
        .setDesc(`${shared} of these images ${shared === 1 ? 'is' : 'are'} also linked from another note, and would take this note's name.`)
        .addToggle((t) => t.setValue(this.includeShared).onChange(async (v) => { this.includeShared = v; await this.draw(); }));
    }
    const list = el.createEl('ul');
    list.style.maxHeight = '300px';
    list.style.overflow = 'auto';
    for (const r of rows) {
      let text;
      if (r.skip === 'shared') text = `${r.file.name}: left alone, also used in ${r.shared.map((p) => p.replace(/\.md$/, '')).join(', ')}`;
      else if (r.skip === 'taken') text = `${r.file.name}: left alone, ${r.target.split('/').pop()} is already another file`;
      else if (r.same) text = `${r.file.name}: already named`;
      else text = `${r.file.name} → ${r.target.split('/').pop()}`;
      list.createEl('li', { text });
    }
    const row = el.createDiv({ cls: 'modal-button-container' });
    row.createEl('button', { text: 'Cancel' }).onclick = () => this.close();
    const go = row.createEl('button', { text: `Rename ${moves.length} Image${moves.length === 1 ? '' : 's'}`, cls: 'mod-cta' });
    go.disabled = !moves.length;
    go.onclick = () => { this.close(); this.onConfirm(rows); };
  }
}

/* ---------------- settings tab ---------------- */

class ArchImagesSettingTab extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    const s = this.plugin.settings;
    const save = () => this.plugin.saveSettings();

    new Setting(containerEl).setName('Conversion').setHeading();

    new Setting(containerEl)
      .setName('Format')
      .setDesc('WebP is the smallest of these for almost every image.')
      .addDropdown((d) => d
        .addOptions({ webp: 'WebP', jpeg: 'JPEG', png: 'PNG', keep: 'Keep Original' })
        .setValue(s.format)
        .onChange(async (v) => { s.format = v; await save(); this.display(); }));

    if (s.format !== 'keep' && s.format !== 'png') {
      new Setting(containerEl)
        .setName('Quality')
        .setDesc(`${Math.round(s.quality * 100)}%`)
        .addSlider((sl) => sl.setLimits(10, 100, 1).setValue(Math.round(s.quality * 100))
          .onChange(async (v) => { s.quality = v / 100; await save(); }));
    }

    new Setting(containerEl)
      .setName('Maximum Long Edge')
      .setDesc('Pixels. 0 never resizes. Images smaller than this are never enlarged.')
      .addText((t) => numberInput(t, s.maxLongEdge, async (n) => { s.maxLongEdge = n; await save(); }));

    new Setting(containerEl)
      .setName('Keep the Original When Conversion Makes It Bigger')
      .addToggle((t) => t.setValue(s.skipIfLarger).onChange(async (v) => { s.skipIfLarger = v; await save(); }));

    new Setting(containerEl)
      .setName('Leave Animated Images Alone')
      .setDesc('A GIF decodes as its first frame only, so converting one throws the animation away.')
      .addToggle((t) => t.setValue(s.skipAnimated).onChange(async (v) => { s.skipAnimated = v; await save(); }));

    new Setting(containerEl)
      .setName('Skip Images Under')
      .setDesc('KB. 0 converts everything.')
      .addText((t) => numberInput(t, s.skipSmallerThanKb, async (n) => { s.skipSmallerThanKb = n; await save(); }));

    new Setting(containerEl).setName('Naming').setHeading();

    new Setting(containerEl)
      .setName('Name Template')
      .setDesc('Tokens: {{noteName}} {{date}} {{time}} {{year}} {{month}} {{day}} {{counter}} {{originalName}} {{width}} {{height}} {{ms}}. {{counter}} continues from the highest number already used by an image of that name, so each note counts from 01 on its own.')
      .addText((t) => plainInput(t).setValue(s.nameTemplate).onChange(async (v) => { s.nameTemplate = v; await save(); }));

    new Setting(containerEl)
      .setName('Ask for a Name on Every Paste')
      .addToggle((t) => t.setValue(s.askOnPaste).onChange(async (v) => { s.askOnPaste = v; await save(); }));

    new Setting(containerEl).setName('Location').setHeading();

    new Setting(containerEl)
      .setName('Where New Images Go')
      .setDesc("The default hands this to Obsidian's own attachment setting, so the vault decides and this plugin does not. The other modes are for putting pasted images somewhere different without changing that vault-wide setting.")
      .addDropdown((d) => d
        .addOptions({
          obsidian: "Obsidian's Attachment Setting",
          vault: 'Vault Root',
          same: 'Same Folder as the Note',
          subfolder: 'Subfolder beside the Note',
          specified: 'One Folder',
        })
        .setValue(s.locationMode)
        .onChange(async (v) => { s.locationMode = v; await save(); this.display(); }));

    if (s.locationMode === 'subfolder') {
      new Setting(containerEl).setName('Subfolder Name')
        .addText((t) => plainInput(t).setValue(s.subfolder).onChange(async (v) => { s.subfolder = v; await save(); }));
    }
    if (s.locationMode === 'specified') {
      new Setting(containerEl).setName('Folder').setDesc('Tokens: {{noteName}} {{notePath}} {{date}}')
        .addText((t) => plainInput(t).setValue(s.folder).onChange(async (v) => { s.folder = v; await save(); }));
    }

    new Setting(containerEl).setName('Convert Images from Elsewhere').setHeading();

    new Setting(containerEl)
      .setName('Convert Every Image That Appears in the Vault')
      .setDesc('Catches images this plugin did not create — a clipper saving one, another plugin downloading one, a file dropped into the vault in Finder. Uses the bulk format and quality below. This rewrites files in place, so turn it off if you want to convert by hand.')
      .addToggle((t) => t.setValue(s.autoConvert).onChange(async (v) => { s.autoConvert = v; await save(); this.display(); }));

    if (s.autoConvert) {
      const here = this.plugin.computer;
      const cur = s.automaticOn || '*';
      new Setting(containerEl)
        .setName('Automatic Conversion Runs On')
        .setDesc('Which computer converts images arriving in the vault. The vaults are mirrored between computers, so an image saved on one arrives on the other as new; with Obsidian open on both, both may convert it. Pick one computer if that happens. Paste, drop, the menus and the commands work on every computer. ' + `This computer is ${here}.`)
        .addDropdown((d) => {
          d.addOption('*', 'Every Computer');
          d.addOption(here, `${here} (This Computer)`);
          if (cur !== here && cur !== '*') d.addOption(cur, cur);
          d.setValue(cur).onChange(async (v) => { s.automaticOn = v; await save(); });
        });
      new Setting(containerEl)
        .setName('Only in These Folders')
        .setDesc('Comma-separated. Blank watches the whole vault.')
        .addText((t) => plainInput(t).setPlaceholder('whole vault').setValue(s.autoConvertFolders)
          .onChange(async (v) => { s.autoConvertFolders = v; await save(); }));
      new Setting(containerEl)
        .setName('Wait before Converting')
        .setDesc('Milliseconds. A file that has only just appeared may still be being written; converting a half-written download produces garbage.')
        .addText((t) => numberInput(t, s.autoConvertDelayMs, async (n) => { s.autoConvertDelayMs = n; await save(); }));
    }

    new Setting(containerEl)
      .setName('Never Convert These Folders')
      .setDesc('Comma-separated, and it applies everywhere — the watcher, the commands, the right-click menu and the whole-vault button. Conversion replaces the original, so put anything you cannot re-download here.')
      .addTextArea((t) => {
        plainInput(t).setPlaceholder('Photos/Originals, Scans').setValue(s.excludeFolders)
          .onChange(async (v) => { s.excludeFolders = v; await save(); });
        t.inputEl.rows = 3;
        t.inputEl.style.width = '100%';
      });

    new Setting(containerEl)
      .setName('Convert These Folders Losslessly')
      .setDesc('Still WebP and still smaller than PNG — a 21 MB PNG lands around 12 MB — but pixel-for-pixel identical to the original. For images you cannot re-download but do not want to leave as huge PNGs. Excluded folders win over this.')
      .addTextArea((t) => {
        plainInput(t).setPlaceholder('Photos/Masters').setValue(s.losslessFolders)
          .onChange(async (v) => { s.losslessFolders = v; await save(); });
        t.inputEl.rows = 3;
        t.inputEl.style.width = '100%';
      });

    new Setting(containerEl).setName('Bulk Conversion').setHeading();

    new Setting(containerEl)
      .setName('Bulk Target Format')
      .addDropdown((d) => d.addOptions({ webp: 'WebP', jpeg: 'JPEG' })
        .setValue(s.bulkFormat).onChange(async (v) => { s.bulkFormat = v; await save(); }));

    new Setting(containerEl)
      .setName('Never Convert These Extensions')
      .addText((t) => plainInput(t).setValue(s.bulkSkipExtensions).onChange(async (v) => { s.bulkSkipExtensions = v; await save(); }));

    new Setting(containerEl)
      .setName('Show What Will Change First')
      .setDesc('Bulk conversion replaces files in place. Leave this on.')
      .addToggle((t) => t.setValue(s.bulkDryRun).onChange(async (v) => { s.bulkDryRun = v; await save(); }));

    // The commands existed from the start; the buttons did not, so the feature
    // was effectively invisible unless you went looking in the command palette.
    const all = this.plugin.allImages();
    const target = this.plugin.lib().formatInfo(s.bulkFormat).ext;
    const pending = all.filter((f) => '.' + f.extension.toLowerCase() !== target);
    const bytes = pending.reduce((n, f) => n + (f.stat ? f.stat.size : 0), 0);

    new Setting(containerEl)
      .setName('Convert Now')
      .setDesc(pending.length
        ? `${pending.length} of ${all.length} images are not ${s.bulkFormat.toUpperCase()} yet — ${kb(bytes)}. Also on the right-click menu of any file or folder.`
        : `All ${all.length} images in the vault are already ${s.bulkFormat.toUpperCase()}.`)
      .addButton((b) => b.setButtonText(`Whole Vault (${pending.length.toLocaleString()})`).setCta()
        .setDisabled(!pending.length)
        .onClick(() => this.plugin.bulkConvert(this.plugin.allImages())))
      .addButton((b) => b.setButtonText('This Note')
        .onClick(() => {
          const file = this.app.workspace.getActiveFile();
          if (!file) return new Notice('No note is open. Open one, then press This Note again.', 5000);
          this.plugin.bulkConvert(this.plugin.imagesLinkedFrom(file));
        }));

  }
}

module.exports = ArchImagesPlugin;
