'use strict';

const { Plugin, PluginSettingTab, Setting, Notice, Modal, TFile, TFolder, normalizePath } = require('obsidian');
const path = require('path');
const fs = require('fs');

const DEFAULT_SETTINGS = {
  // --- conversion ---
  format: 'webp',            // webp | jpeg | png | avif | keep
  quality: 0.82,             // 0.1 - 1.0, lossy formats only
  maxLongEdge: 0,            // 0 = never resize
  skipIfLarger: true,
  skipAnimated: true,
  skipSmallerThanKb: 0,      // leave tiny images alone entirely

  // --- naming ---
  nameTemplate: '{{noteName}} {{date}}-{{counter}}',
  askOnPaste: false,         // show the rename prompt before saving

  // --- where the file lands ---
  // Same choices as Obsidian's "Default location for new attachments", so the
  // setting reads the way Obsidian's own does.
  locationMode: 'obsidian',  // obsidian | vault | same | subfolder | specified
  subfolder: 'Materials',
  folder: 'Attachments',

  // --- bulk conversion of images already in the vault ---
  bulkFormat: 'webp',
  bulkSkipExtensions: 'svg, gif',
  bulkDryRun: true,

  // --- external encoder (AVIF only; canvas cannot write it) ---
  ffmpegPath: '',

  setupDone: false,
};

const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'webp', 'avif', 'bmp', 'gif', 'tif', 'tiff', 'heic', 'heif'];

class ArchImagesPlugin extends Plugin {
  async onload() {
    await this.loadSettings();
    this.batchCounter = 0;
    this.queue = Promise.resolve();

    this.registerEvent(this.app.workspace.on('editor-paste', (evt, editor, view) => this.onPaste(evt, editor, view)));
    this.registerEvent(this.app.workspace.on('editor-drop', (evt, editor, view) => this.onDrop(evt, editor, view)));

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
    this._lib = require(path.join(dir, 'index.js'));
    return this._lib;
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
    this.enqueue(() => this.handleFiles(files, editor, view));
  }

  onDrop(evt, editor, view) {
    const files = this.imageFilesFrom(evt.dataTransfer);
    if (!files.length) return;
    evt.preventDefault();
    this.enqueue(() => this.handleFiles(files, editor, view));
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

  async handleFiles(files, editor, view) {
    const note = view && view.file ? view.file : this.app.workspace.getActiveFile();
    for (let i = 0; i < files.length; i++) {
      const saved = await this.saveOne(files[i], note, i);
      if (saved) editor.replaceSelection(this.embedFor(saved, note) + '\n');
    }
  }

  async saveOne(file, note, indexInBatch) {
    const { convertBlob, formatInfo, needsExternalEncoder, buildStem } = this.lib();
    const tooSmall = this.settings.skipSmallerThanKb > 0 && file.size < this.settings.skipSmallerThanKb * 1024;

    let bytes = new Uint8Array(await file.arrayBuffer());
    let ext = this.extFor(file);
    let result = null;

    if (!tooSmall && this.settings.format !== 'keep') {
      if (needsExternalEncoder(this.settings.format)) {
        result = await this.convertViaFfmpeg(bytes, this.extFor(file));
      } else {
        result = await convertBlob(file, {
          format: this.settings.format,
          quality: Number(this.settings.quality),
          maxLongEdge: Number(this.settings.maxLongEdge),
          skipIfLarger: this.settings.skipIfLarger,
          skipAnimated: this.settings.skipAnimated,
        });
      }
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
    await this.app.vault.createBinary(target, bytes);
    this.report(file, bytes, result, target);
    return this.app.vault.getAbstractFileByPath(target) || { path: target };
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
    if (!result || !result.data) return;
    const before = file.size;
    const pct = before ? Math.round((1 - bytes.length / before) * 100) : 0;
    new Notice(`${path.basename(target)} — ${kb(before)} → ${kb(bytes.length)} (${pct}% smaller)`, 4000);
  }

  /* ---------------- AVIF via ffmpeg ---------------- */

  // Chromium's canvas cannot encode AVIF -- it returns a PNG under the AVIF
  // mime type instead of failing. So AVIF goes out to ffmpeg through a pair of
  // temp files. Everything else stays in the renderer.
  async convertViaFfmpeg(bytes, sourceExt) {
    const bin = this.settings.ffmpegPath || 'ffmpeg';
    const tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'arch-images-'));
    const inPath = path.join(tmpDir, 'in' + (sourceExt || '.png'));
    const outPath = path.join(tmpDir, 'out.avif');
    try {
      fs.writeFileSync(inPath, bytes);
      const crf = Math.round(63 - Number(this.settings.quality) * 45); // 0.82 -> 26
      const args = ['-y', '-i', inPath];
      if (Number(this.settings.maxLongEdge) > 0) {
        const m = Number(this.settings.maxLongEdge);
        args.push('-vf', `scale='if(gt(iw,ih),min(${m},iw),-2)':'if(gt(iw,ih),-2,min(${m},ih))'`);
      }
      args.push('-c:v', 'libaom-av1', '-crf', String(crf), '-still-picture', '1', outPath);
      await this.run(bin, args, 120000);
      if (!fs.existsSync(outPath)) throw new Error('ffmpeg produced nothing');
      const data = new Uint8Array(fs.readFileSync(outPath));
      return { data, ext: '.avif', mime: 'image/avif', bytes: data.length };
    } finally {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) { /* temp dir */ }
    }
  }

  run(command, args, timeoutMs = 30000) {
    const { execFile } = require('child_process');
    return new Promise((resolve, reject) => {
      execFile(command, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024 * 8, windowsHide: true }, (err, stdout, stderr) => {
        if (err && err.code === 'ENOENT') return reject(new Error(`${command} not found`));
        // ffmpeg writes progress to stderr and still exits 0, so only a non-zero
        // exit is a failure. The last few stderr lines carry the actual reason.
        if (err) return reject(new Error(String(stderr || err.message).split('\n').filter(Boolean).slice(-3).join(' ')));
        resolve({ stdout: stdout || '', stderr: stderr || '' });
      });
    });
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

    const work = files.filter((f) => !skip.has(f.extension.toLowerCase()) && '.' + f.extension.toLowerCase() !== targetExt);
    if (!work.length) return new Notice('Nothing to convert.', 4000);

    if (this.settings.bulkDryRun) {
      new BulkPreviewModal(this.app, this, work, () => this.runBulk(work)).open();
      return;
    }
    await this.runBulk(work);
  }

  async runBulk(files) {
    const { convertBlob, formatInfo, needsExternalEncoder } = this.lib();
    const notice = new Notice('Converting...', 0);
    let done = 0, saved = 0, failed = 0, skipped = 0;

    for (const file of files) {
      try {
        notice.setMessage(`Converting ${done + 1}/${files.length}\n${file.name}`);
        const raw = await this.app.vault.readBinary(file);
        const before = raw.byteLength;
        const blob = new Blob([raw], { type: mimeForExt(file.extension) });

        let result;
        if (needsExternalEncoder(this.settings.bulkFormat)) {
          result = await this.convertViaFfmpeg(new Uint8Array(raw), '.' + file.extension);
        } else {
          result = await convertBlob(blob, {
            format: this.settings.bulkFormat,
            quality: Number(this.settings.quality),
            maxLongEdge: Number(this.settings.maxLongEdge),
            skipIfLarger: this.settings.skipIfLarger,
            skipAnimated: this.settings.skipAnimated,
          });
        }
        if (!result || !result.data) { skipped++; done++; continue; }

        await this.replaceInPlace(file, result.data, result.ext || formatInfo(this.settings.bulkFormat).ext);
        saved += before - result.data.length;
        done++;
      } catch (e) {
        failed++;
        done++;
        console.error('[arch-images]', file.path, e);
      }
    }
    notice.hide();
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
      .setDesc('AVIF is encoded by ffmpeg, not the browser — it needs ffmpeg installed and is much slower.')
      .addDropdown((d) => d
        .addOptions({ webp: 'WebP', jpeg: 'JPEG', png: 'PNG', avif: 'AVIF (ffmpeg)', keep: 'Keep original' })
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

    containerEl.createEl('h3', { text: 'Bulk conversion' });

    new Setting(containerEl)
      .setName('Bulk target format')
      .addDropdown((d) => d.addOptions({ webp: 'WebP', jpeg: 'JPEG', avif: 'AVIF (ffmpeg)' })
        .setValue(s.bulkFormat).onChange(async (v) => { s.bulkFormat = v; await save(); }));

    new Setting(containerEl)
      .setName('Never convert these extensions')
      .addText((t) => t.setValue(s.bulkSkipExtensions).onChange(async (v) => { s.bulkSkipExtensions = v; await save(); }));

    new Setting(containerEl)
      .setName('Show what will change first')
      .setDesc('Bulk conversion replaces files in place. Leave this on.')
      .addToggle((t) => t.setValue(s.bulkDryRun).onChange(async (v) => { s.bulkDryRun = v; await save(); }));

    containerEl.createEl('h3', { text: 'External tools' });
    new Setting(containerEl)
      .setName('ffmpeg path')
      .setDesc('Only needed for AVIF. Blank uses ffmpeg from PATH.')
      .addText((t) => t.setPlaceholder('/usr/local/bin/ffmpeg').setValue(s.ffmpegPath)
        .onChange(async (v) => { s.ffmpegPath = v.trim(); await save(); }));
  }
}

module.exports = ArchImagesPlugin;
