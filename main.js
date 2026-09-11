'use strict';

const { Plugin, PluginSettingTab, Setting, Notice, Modal, TFile, TFolder, normalizePath } = require('obsidian');
const path = require('path');
const fs = require('fs');

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
  nameTemplate: '{{noteName}} {{date}}-{{counter}}',
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
};

const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'webp', 'avif', 'bmp', 'gif', 'tif', 'tiff', 'heic', 'heif'];

class ArchImagesPlugin extends Plugin {
  async onload() {
    await this.loadSettings();
    this.batchCounter = 0;
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
      name: 'Convert images in the whole vault',
      callback: () => this.bulkConvert(this.allImages()),
    });
    this.addCommand({
      id: 'convert-images-in-note',
      name: 'Convert images linked from the active note',
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file) return false;
        if (!checking) this.bulkConvert(this.imagesLinkedFrom(file));
        return true;
      },
    });

    this.addSettingTab(new ArchImagesSettingTab(this.app, this));
    this.log('loaded', this.manifest.version);
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
  dropLibFromRequireCache(dir) {
    if (typeof require === 'undefined' || !require.cache) return;
    const roots = [dir];
    try { roots.push(fs.realpathSync(dir)); } catch (_) { /* not a link, or gone */ }
    let dropped = 0;
    for (const key of Object.keys(require.cache)) {
      if (roots.some((root) => key.startsWith(root + path.sep))) {
        delete require.cache[key];
        dropped++;
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
      new Notice(`Image failed: ${e.message}`, 8000);
    });
    return this.queue;
  }

  async handleFiles(files, editor, view, markers) {
    const note = view && view.file ? view.file : this.app.workspace.getActiveFile();
    let failure = null;
    for (let i = 0; i < files.length; i++) {
      let saved = null;
      if (!failure) {
        try { saved = await this.saveOne(files[i], note, i); } catch (e) { failure = e; }
      }
      // Every placeholder is resolved, including those after a failure, so a
      // thrown save never leaves "[Saving image …]" text behind in the note.
      this.replacePlaceholder(editor, markers[i], saved ? this.embedFor(saved, note) : '');
    }
    if (failure) throw failure;
  }

  async saveOne(file, note, indexInBatch) {
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

    let stem = buildStem({
      template: this.settings.nameTemplate,
      noteName: note ? note.basename : '',
      originalName: file.name,
      width: result && result.width,
      height: result && result.height,
      counter: this.nextCounter(indexInBatch),
    });

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

  nextCounter(indexInBatch) {
    // Restarts each minute-scale batch rather than growing forever; uniqueness
    // is guaranteed by uniquePath, not by this number.
    this.batchCounter = (this.batchCounter || 0) + 1;
    return this.batchCounter;
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
      item.setTitle(`Convert ${targets.length} image${targets.length > 1 ? 's' : ''} to ${this.settings.bulkFormat.toUpperCase()}`)
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
    const notice = new Notice('Converting...', 0);
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
    delete this.settings.ffmpegPath;
  }

  async saveSettings() { await this.saveData(this.settings); }
}

/* ---------------- helpers ---------------- */

function kb(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
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
    this.titleEl.setText('Name this image');
    const input = this.contentEl.createEl('input', { type: 'text', value: this.suggested });
    input.style.width = '100%';
    input.focus();
    input.select();
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { this.answered = true; this.resolve(input.value.trim()); this.close(); }
      if (e.key === 'Escape') { this.answered = true; this.resolve(null); this.close(); }
    });
    const row = this.contentEl.createDiv({ cls: 'modal-button-container' });
    row.createEl('button', { text: 'Save', cls: 'mod-cta' }).onclick = () => {
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
    this.titleEl.setText(`Convert ${this.files.length} images to ${this.plugin.settings.bulkFormat.toUpperCase()}`);
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
    row.createEl('button', { text: 'Convert', cls: 'mod-cta' }).onclick = () => { this.close(); this.onConfirm(); };
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

    containerEl.createEl('h3', { text: 'Conversion' });

    new Setting(containerEl)
      .setName('Format')
      .setDesc('WebP is the smallest of these for almost every image.')
      .addDropdown((d) => d
        .addOptions({ webp: 'WebP', jpeg: 'JPEG', png: 'PNG', keep: 'Keep original' })
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
      .setName('Maximum long edge')
      .setDesc('Pixels. 0 never resizes. Images smaller than this are never enlarged.')
      .addText((t) => t.setValue(String(s.maxLongEdge)).onChange(async (v) => { s.maxLongEdge = Number(v) || 0; await save(); }));

    new Setting(containerEl)
      .setName('Keep the original when conversion makes it bigger')
      .addToggle((t) => t.setValue(s.skipIfLarger).onChange(async (v) => { s.skipIfLarger = v; await save(); }));

    new Setting(containerEl)
      .setName('Leave animated images alone')
      .setDesc('A GIF decodes as its first frame only, so converting one throws the animation away.')
      .addToggle((t) => t.setValue(s.skipAnimated).onChange(async (v) => { s.skipAnimated = v; await save(); }));

    new Setting(containerEl)
      .setName('Skip images under')
      .setDesc('KB. 0 converts everything.')
      .addText((t) => t.setValue(String(s.skipSmallerThanKb)).onChange(async (v) => { s.skipSmallerThanKb = Number(v) || 0; await save(); }));

    containerEl.createEl('h3', { text: 'Naming' });

    new Setting(containerEl)
      .setName('Name template')
      .setDesc('Tokens: {{noteName}} {{date}} {{time}} {{year}} {{month}} {{day}} {{counter}} {{originalName}} {{width}} {{height}} {{ms}}')
      .addText((t) => t.setValue(s.nameTemplate).onChange(async (v) => { s.nameTemplate = v; await save(); }));

    new Setting(containerEl)
      .setName('Ask for a name on every paste')
      .addToggle((t) => t.setValue(s.askOnPaste).onChange(async (v) => { s.askOnPaste = v; await save(); }));

    containerEl.createEl('h3', { text: 'Location' });

    new Setting(containerEl)
      .setName('Where new images go')
      .setDesc("The default hands this to Obsidian's own attachment setting, so the vault decides and this plugin does not. The other modes are for putting pasted images somewhere different without changing that vault-wide setting.")
      .addDropdown((d) => d
        .addOptions({
          obsidian: "Obsidian's attachment setting",
          vault: 'Vault root',
          same: 'Same folder as the note',
          subfolder: 'Subfolder beside the note',
          specified: 'One folder',
        })
        .setValue(s.locationMode)
        .onChange(async (v) => { s.locationMode = v; await save(); this.display(); }));

    if (s.locationMode === 'subfolder') {
      new Setting(containerEl).setName('Subfolder name')
        .addText((t) => t.setValue(s.subfolder).onChange(async (v) => { s.subfolder = v; await save(); }));
    }
    if (s.locationMode === 'specified') {
      new Setting(containerEl).setName('Folder').setDesc('Tokens: {{noteName}} {{notePath}} {{date}}')
        .addText((t) => t.setValue(s.folder).onChange(async (v) => { s.folder = v; await save(); }));
    }

    containerEl.createEl('h3', { text: 'Convert images from elsewhere' });

    new Setting(containerEl)
      .setName('Convert every image that appears in the vault')
      .setDesc('Catches images this plugin did not create — a clipper saving one, another plugin downloading one, a file dropped into the vault in Finder. Uses the bulk format and quality below. This rewrites files in place, so turn it off if you want to convert by hand.')
      .addToggle((t) => t.setValue(s.autoConvert).onChange(async (v) => { s.autoConvert = v; await save(); this.display(); }));

    if (s.autoConvert) {
      new Setting(containerEl)
        .setName('Only in these folders')
        .setDesc('Comma-separated. Blank watches the whole vault.')
        .addText((t) => t.setPlaceholder('whole vault').setValue(s.autoConvertFolders)
          .onChange(async (v) => { s.autoConvertFolders = v; await save(); }));
      new Setting(containerEl)
        .setName('Wait before converting')
        .setDesc('Milliseconds. A file that has only just appeared may still be being written; converting a half-written download produces garbage.')
        .addText((t) => t.setValue(String(s.autoConvertDelayMs))
          .onChange(async (v) => { s.autoConvertDelayMs = Number(v) || 0; await save(); }));
    }

    new Setting(containerEl)
      .setName('Never convert these folders')
      .setDesc('Comma-separated, and it applies everywhere — the watcher, the commands, the right-click menu and the whole-vault button. Conversion replaces the original, so put anything you cannot re-download here.')
      .addTextArea((t) => {
        t.setPlaceholder('Photos/Originals, Scans').setValue(s.excludeFolders)
          .onChange(async (v) => { s.excludeFolders = v; await save(); });
        t.inputEl.rows = 3;
        t.inputEl.style.width = '100%';
      });

    new Setting(containerEl)
      .setName('Convert these folders losslessly')
      .setDesc('Still WebP and still smaller than PNG — a 21 MB PNG lands around 12 MB — but pixel-for-pixel identical to the original. For images you cannot re-download but do not want to leave as huge PNGs. Excluded folders win over this.')
      .addTextArea((t) => {
        t.setPlaceholder('Photos/Masters').setValue(s.losslessFolders)
          .onChange(async (v) => { s.losslessFolders = v; await save(); });
        t.inputEl.rows = 3;
        t.inputEl.style.width = '100%';
      });

    containerEl.createEl('h3', { text: 'Bulk conversion' });

    new Setting(containerEl)
      .setName('Bulk target format')
      .addDropdown((d) => d.addOptions({ webp: 'WebP', jpeg: 'JPEG' })
        .setValue(s.bulkFormat).onChange(async (v) => { s.bulkFormat = v; await save(); }));

    new Setting(containerEl)
      .setName('Never convert these extensions')
      .addText((t) => t.setValue(s.bulkSkipExtensions).onChange(async (v) => { s.bulkSkipExtensions = v; await save(); }));

    new Setting(containerEl)
      .setName('Show what will change first')
      .setDesc('Bulk conversion replaces files in place. Leave this on.')
      .addToggle((t) => t.setValue(s.bulkDryRun).onChange(async (v) => { s.bulkDryRun = v; await save(); }));

    // The commands existed from the start; the buttons did not, so the feature
    // was effectively invisible unless you went looking in the command palette.
    const all = this.plugin.allImages();
    const target = this.plugin.lib().formatInfo(s.bulkFormat).ext;
    const pending = all.filter((f) => '.' + f.extension.toLowerCase() !== target);
    const bytes = pending.reduce((n, f) => n + (f.stat ? f.stat.size : 0), 0);

    new Setting(containerEl)
      .setName('Convert now')
      .setDesc(pending.length
        ? `${pending.length} of ${all.length} images are not ${s.bulkFormat.toUpperCase()} yet — ${kb(bytes)}. Also on the right-click menu of any file or folder.`
        : `All ${all.length} images in the vault are already ${s.bulkFormat.toUpperCase()}.`)
      .addButton((b) => b.setButtonText(`Whole vault (${pending.length})`).setCta()
        .setDisabled(!pending.length)
        .onClick(() => this.plugin.bulkConvert(this.plugin.allImages())))
      .addButton((b) => b.setButtonText('This note')
        .onClick(() => {
          const file = this.app.workspace.getActiveFile();
          if (!file) return new Notice('No note is open.', 5000);
          this.plugin.bulkConvert(this.plugin.imagesLinkedFrom(file));
        }));

  }
}

module.exports = ArchImagesPlugin;
