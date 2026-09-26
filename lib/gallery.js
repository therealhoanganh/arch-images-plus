// The ARCH Image gallery, a view for Bases. Built to replace Bases Image Gallery
// 0.1.6 in CHAOS; why, and what each part answers, is in "Image Gallery Plan.md".
//
// The five things that made Bases Image Gallery freeze a vault, and the answer
// to each here:
//   1. every data update rebuilt every <img>   -> updates are gathered for a
//      moment, and nothing is touched unless the list of cards changed
//   2. every image loaded at full size at once -> an image loads only near the
//      screen, from a cached thumbnail (thumbs.js), and is let go far from it
//   3. the lightbox loaded them all again      -> ours loads one image and its
//      two neighbours
//   4. random() re-rolled on every update      -> the shuffle is the view's own
//      and holds until the view is opened again or Shuffle is clicked
//   5. nothing waited for the vault to open    -> the first draw waits for
//      plugin.galleryReady (layout ready and links resolved)
//
// Nothing in lib/ may require('obsidian'), so the module is handed to
// makeGalleryView by main.js.

const GALLERY_VIEW_TYPE = 'arch-image-gallery';

// What Chromium can show in an <img>. TIFF and HEIC are left out: they would
// only ever be broken cards.
const SHOWN_EXTS = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif', 'bmp'];

const DEFAULTS = {
  layout: 'vertical',
  height: 260,
  columns: 3,
  gutter: 8,
  radius: 0,
  imageOrder: 'shuffled',
  groupOrder: 'shuffled',
  groupDisplay: 'headings',
  listGroups: 'split',
};

// An image starts loading this far before it scrolls into sight, and is let go
// once it is this far away. The gap between the two stops a card at the edge
// from loading and unloading over and over.
const LOAD_MARGIN = '1200px 0px';
const UNLOAD_MARGIN = '5000px 0px';

// Updates arriving within this long of each other are handled once. While a
// vault opens, Bases sends them in bursts.
const UPDATE_DELAY_MS = 300;

// Options offered in the Bases view menu. The layout keys and their defaults are
// Bases Image Gallery's, so a base switches over by changing only `type:`.
function galleryOptions(config) {
  const isVertical = () => config.get('layout') !== 'horizontal';
  return [
    {
      type: 'dropdown', displayName: 'Layout', key: 'layout', default: DEFAULTS.layout,
      options: { vertical: 'Vertical masonry', horizontal: 'Horizontal masonry' },
    },
    { type: 'slider', displayName: 'Row height (px)', key: 'height', default: DEFAULTS.height, min: 50, max: 1000, shouldHide: () => isVertical() },
    { type: 'slider', displayName: 'Columns', key: 'columns', default: DEFAULTS.columns, min: 1, max: 10, shouldHide: () => !isVertical() },
    { type: 'slider', displayName: 'Gutter (px)', key: 'gutter', default: DEFAULTS.gutter, min: 0, max: 64 },
    { type: 'slider', displayName: 'Corner radius (px)', key: 'radius', default: DEFAULTS.radius, min: 0, max: 64 },
    {
      type: 'dropdown', displayName: 'Image order', key: 'imageOrder', default: DEFAULTS.imageOrder,
      options: { shuffled: 'Shuffled each time it opens', base: 'As the base sorts them' },
    },
    // "together" uses the groups only to keep their images next to each other,
    // in one grid with no headings: Bases has no sort by backlink, but its Group
    // by has, and headed groups leave gaps under every small one.
    {
      type: 'dropdown', displayName: 'Groups', key: 'groupDisplay', default: DEFAULTS.groupDisplay,
      options: { headings: 'Each under its own heading', together: 'Kept together in one grid' },
    },
    {
      type: 'dropdown', displayName: 'Group order', key: 'groupOrder', default: DEFAULTS.groupOrder,
      options: { shuffled: 'Shuffled each time it opens', base: 'As the base sorts them' },
    },
    // A dropdown rather than a toggle, so every option in the menu looks alike;
    // it was the `splitLists` toggle until 0.7.2, which old bases still carry.
    {
      type: 'dropdown', displayName: 'Grouped by a list (backlinks, tags)', key: 'listGroups', default: DEFAULTS.listGroups,
      options: { split: 'One group per link or tag', whole: 'One group per whole list' },
    },
  ];
}

function formatSize(bytes) {
  if (!Number.isFinite(bytes)) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let n = bytes, i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${i === 0 ? n : n.toFixed(1)} ${units[i]}`;
}

// A Bases list value (file.backlinks, tags, a list property). Checked by shape,
// because ListValue is not exported as something a plugin can instanceof.
function isListValue(v) {
  return v && typeof v.length === 'function' && typeof v.get === 'function';
}

function makeGalleryView(obsidian, plugin) {
  const { BasesView, TFile, Platform, setIcon } = obsidian;

  // Obsidian's own address for a file on disk; thumbnails live outside the
  // vault, so vault.getResourcePath cannot make one.
  function diskUrl(abs) {
    const rel = abs.replace(/\\/g, '/').replace(/^\/+/, '');
    return Platform.resourcePathPrefix + rel.split('/').map(encodeURIComponent).join('/');
  }

  class ArchGalleryView extends BasesView {
    constructor(controller, parentEl) {
      super(controller);
      this.type = GALLERY_VIEW_TYPE;
      this.hoverPopover = null;
      this.rootEl = parentEl.createDiv('arch-gallery');
      this.barEl = this.rootEl.createDiv('arch-gallery-bar');
      this.countEl = this.barEl.createSpan('arch-gallery-count');
      const shuffleBtn = this.barEl.createEl('button', { cls: 'arch-gallery-shuffle clickable-icon', attr: { 'aria-label': 'Shuffle' } });
      setIcon(shuffleBtn, 'shuffle');
      shuffleBtn.createSpan({ text: 'Shuffle' });
      shuffleBtn.addEventListener('click', () => this.shuffle());
      this.bodyEl = this.rootEl.createDiv('arch-gallery-body');
      this.bodyEl.createDiv({ cls: 'arch-gallery-note', text: 'Loading…' });

      this.cards = new Map();      // card key -> card
      this.groupEls = new Map();   // group label -> { el, headEl, gridEl }
      this.imageRank = new Map();  // image path -> random number, for the shuffle
      this.groupRank = new Map();  // group label -> random number
      this.flat = [];              // cards in the order shown, for the lightbox
      this.signature = '';
      this.timer = null;
      this.ready = false;
      this.dead = false;
      this.loadObserver = null;
      this.unloadObserver = null;

      plugin.galleryReady.then(() => {
        if (this.dead) return;
        this.ready = true;
        this.render();
      });
    }

    onDataUpdated() {
      if (!this.ready) return; // the first draw happens once galleryReady resolves
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => { this.timer = null; this.render(); }, UPDATE_DELAY_MS);
    }

    onunload() {
      this.dead = true;
      if (this.timer) clearTimeout(this.timer);
      for (const card of this.cards.values()) this.dropCard(card);
      this.cards.clear();
      if (this.loadObserver) this.loadObserver.disconnect();
      if (this.unloadObserver) this.unloadObserver.disconnect();
      if (this.lightbox) this.lightbox.close();
      this.rootEl.remove();
    }

    shuffle() {
      this.imageRank.clear();
      this.groupRank.clear();
      this.signature = '';
      this.render();
      const scroller = this.scroller();
      if (scroller) scroller.scrollTop = 0;
    }

    readSettings() {
      const s = {};
      for (const [key, fallback] of Object.entries(DEFAULTS)) {
        const v = this.config.get(key);
        if (typeof fallback === 'number') {
          const n = Number(v);
          s[key] = v == null || v === '' || !Number.isFinite(n) ? fallback : n;
        } else if (typeof fallback === 'boolean') {
          s[key] = typeof v === 'boolean' ? v : fallback;
        } else {
          s[key] = typeof v === 'string' && v ? v : fallback;
        }
      }
      const legacy = this.config.get('splitLists');
      if (this.config.get('listGroups') == null && typeof legacy === 'boolean') s.listGroups = legacy ? 'split' : 'whole';
      s.splitLists = s.listGroups !== 'whole';
      return s;
    }

    // The label of a group with no value. Bases does not publish which property
    // the view is grouped by, so this reads its own config and falls back.
    noValueLabel() {
      try {
        const g = this.config.groupBy;
        const prop = g && (g.property || g);
        if (typeof prop === 'string') return `No ${this.config.getDisplayName(prop).toLowerCase()}`;
      } catch (_) { /* fall through */ }
      return 'No value';
    }

    // A group label as a note, when it is a link to one.
    linkedFile(label) {
      let text = String(label).trim();
      const m = text.match(/^!?\[\[([^\]]+)\]\]$/);
      if (m) text = m[1];
      text = text.split('|')[0].split('#')[0].trim();
      if (!text) return null;
      const f = this.app.metadataCache.getFirstLinkpathDest(text, '');
      return f instanceof TFile ? f : null;
    }

    // Bases' groups, turned into the gallery's: split into one group per link
    // when the key is a list, merged by label, with images Chromium cannot show
    // left out.
    collectGroups(settings) {
      const groupedData = this.data.groupedData || [];
      const ungrouped = groupedData.length <= 1 && !(groupedData[0] && groupedData[0].hasKey());
      const buckets = new Map();
      const bucket = (label, file, isNone) => {
        let b = buckets.get(label);
        if (!b) {
          b = { label, file, isNone, files: [], seen: new Set(), baseIndex: buckets.size };
          buckets.set(label, b);
        }
        return b;
      };
      for (const group of groupedData) {
        let keys;
        if (ungrouped) keys = [{ label: '', file: null, isNone: false }];
        else if (!group.hasKey()) keys = [{ label: this.noValueLabel(), file: null, isNone: true }];
        else if (settings.splitLists && isListValue(group.key)) {
          keys = [];
          for (let i = 0; i < group.key.length(); i++) {
            const label = String(group.key.get(i));
            keys.push({ label, file: this.linkedFile(label), isNone: false });
          }
          if (!keys.length) keys = [{ label: this.noValueLabel(), file: null, isNone: true }];
        } else {
          const label = String(group.key);
          keys = [{ label, file: this.linkedFile(label), isNone: false }];
        }
        for (const entry of group.entries) {
          const file = entry.file;
          if (!(file instanceof TFile) || !SHOWN_EXTS.includes(file.extension.toLowerCase())) continue;
          for (const k of keys) {
            const b = bucket(k.label, k.file, k.isNone);
            if (b.seen.has(file.path)) continue;
            b.seen.add(file.path);
            b.files.push(file);
          }
        }
      }
      let list = [...buckets.values()].filter((b) => b.files.length);
      const rank = (map, key) => {
        let r = map.get(key);
        if (r === undefined) { r = Math.random(); map.set(key, r); }
        return r;
      };
      if (settings.imageOrder === 'shuffled') {
        for (const b of list) b.files.sort((a, c) => rank(this.imageRank, a.path) - rank(this.imageRank, c.path));
      }
      if (settings.groupOrder === 'shuffled') list.sort((a, c) => rank(this.groupRank, a.label) - rank(this.groupRank, c.label));
      // The group of images with no value goes last either way.
      list = list.filter((b) => !b.isNone).concat(list.filter((b) => b.isNone));
      // In one grid an image linked from two notes would show twice; it stays
      // with the first of its groups.
      if (!ungrouped && settings.groupDisplay === 'together') {
        const shown = new Set();
        for (const b of list) b.files = b.files.filter((f) => !shown.has(f.path) && shown.add(f.path));
        list = list.filter((b) => b.files.length);
      }
      return { list, ungrouped };
    }

    applyStyle(settings) {
      const st = this.rootEl.style;
      st.setProperty('--ag-columns', String(settings.columns));
      st.setProperty('--ag-gutter', `${settings.gutter}px`);
      st.setProperty('--ag-radius', `${settings.radius}px`);
      st.setProperty('--ag-row-height', `${settings.height}px`);
      this.rootEl.toggleClass('is-horizontal', settings.layout === 'horizontal');
      this.rootEl.toggleClass('is-vertical', settings.layout !== 'horizontal');
    }

    render() {
      if (this.dead || !this.data) return;
      const started = performance.now();
      const settings = this.readSettings();
      this.settings = settings;
      this.applyStyle(settings);
      const { list, ungrouped } = this.collectGroups(settings);

      const keys = [];
      for (const b of list) {
        keys.push(`#${b.label}`);
        for (const f of b.files) keys.push(`${f.path}\t${f.stat.mtime}`);
      }
      const signature = `${ungrouped}|${settings.layout}|${settings.columns}|${settings.imageOrder}|${settings.groupOrder}|${settings.splitLists}|${settings.groupDisplay}\n${keys.join('\n')}`;
      if (signature === this.signature) return; // nothing a viewer could see has changed
      this.signature = signature;

      this.ensureObservers();
      const total = list.reduce((n, b) => n + b.files.length, 0);
      const together = !ungrouped && settings.groupDisplay === 'together';
      this.countEl.setText(ungrouped
        ? `${total.toLocaleString()} images`
        : `${total.toLocaleString()} images in ${list.length.toLocaleString()} groups`);

      const liveCards = new Set();
      const liveGroups = new Set();
      const sections = [];
      this.flat = [];
      // Kept together, every group's cards go into one headless section.
      const shared = together ? { section: this.groupSection({ label: '\u0000together' }, true), cards: [] } : null;
      if (shared) { liveGroups.add('\u0000together'); sections.push(shared.section.el); }
      for (const b of list) {
        const g = shared ? null : this.groupSection(b, ungrouped);
        if (g) { liveGroups.add(b.label); sections.push(g.el); }
        const groupCards = shared ? shared.cards : [];
        for (const file of b.files) {
          const key = `${b.label}\n${file.path}`;
          liveCards.add(key);
          let card = this.cards.get(key);
          if (card && card.mtime !== file.stat.mtime) { this.dropCard(card); this.cards.delete(key); card = null; }
          if (!card) { card = this.makeCard(key, file, b); this.cards.set(key, card); }
          card.group = b;
          card.index = this.flat.length;
          this.flat.push(card);
          groupCards.push(card);
        }
        if (g) this.fillGrid(g, groupCards, settings);
      }
      if (shared) this.fillGrid(shared.section, shared.cards, settings);
      for (const [key, card] of this.cards) {
        if (!liveCards.has(key)) { this.dropCard(card); this.cards.delete(key); }
      }
      for (const label of [...this.groupEls.keys()]) {
        if (!liveGroups.has(label)) this.groupEls.delete(label);
      }
      if (!total) {
        this.bodyEl.replaceChildren();
        this.bodyEl.createDiv({ cls: 'arch-gallery-note', text: `No images match this view. It shows ${SHOWN_EXTS.join(', ')} files.` });
      } else {
        this.bodyEl.replaceChildren(...sections);
      }
      const ms = Math.round(performance.now() - started);
      plugin.log(`[gallery] drew ${total} images in ${list.length} groups (${this.cards.size} cards) in ${ms} ms`);
      // The last few draws, readable from the console: when each happened after
      // the window loaded, how long it took and how much it drew.
      plugin.galleryDraws = (plugin.galleryDraws || []).slice(-19);
      plugin.galleryDraws.push({ at: Math.round(started), ms, images: total, groups: list.length });
    }

    // Horizontal rows flow by themselves. Vertical masonry deals the cards out
    // left to right, each to the column that is shortest so far, so the order
    // reads across the page and a group's images sit side by side rather than
    // running down one CSS column. Heights come from the cached sizes; a card
    // whose size is not known yet counts as 4:3 upright, like its placeholder.
    fillGrid(g, cards, settings) {
      if (settings.layout === 'horizontal') {
        g.gridEl.replaceChildren(...cards.map((c) => c.el), g.spacerEl);
        return;
      }
      const n = Math.max(1, Math.min(cards.length || 1, Math.round(settings.columns) || 1));
      const cols = [];
      const heights = [];
      for (let i = 0; i < Math.max(1, Math.round(settings.columns) || 1); i++) {
        cols.push(createDiv('arch-gallery-col'));
        heights.push(0);
      }
      for (const card of cards) {
        let i = 0;
        for (let j = 1; j < n; j++) if (heights[j] < heights[i] - 1e-6) i = j;
        cols[i].appendChild(card.el);
        heights[i] += 1 / (card.aspect || 0.75);
      }
      g.gridEl.replaceChildren(...cols);
    }

    groupSection(b, ungrouped) {
      let g = this.groupEls.get(b.label);
      if (!g) {
        const el = createDiv('arch-gallery-group');
        const headEl = el.createDiv('arch-gallery-group-head');
        const gridEl = el.createDiv('arch-gallery-grid');
        const spacerEl = createDiv('arch-gallery-spacer');
        g = { el, headEl, gridEl, spacerEl };
        this.groupEls.set(b.label, g);
      }
      g.headEl.empty();
      g.headEl.toggle(!ungrouped);
      if (!ungrouped) {
        if (b.file) {
          const a = g.headEl.createEl('a', { cls: 'internal-link arch-gallery-group-title', text: b.file.basename, attr: { 'data-href': b.file.path, href: b.file.path } });
          a.addEventListener('click', (evt) => {
            evt.preventDefault();
            this.app.workspace.openLinkText(b.file.path, '', true);
          });
          a.addEventListener('mouseover', (evt) => {
            this.app.workspace.trigger('hover-link', { event: evt, source: 'bases', hoverParent: this, targetEl: a, linktext: b.file.path });
          });
        } else {
          g.headEl.createSpan({ cls: 'arch-gallery-group-title', text: b.label });
        }
        g.headEl.createSpan({ cls: 'arch-gallery-group-count', text: String(b.files.length) });
      }
      return g;
    }

    makeCard(key, file, group) {
      const el = createDiv('arch-gallery-card');
      const img = el.createEl('img', { attr: { alt: file.basename, decoding: 'async', draggable: 'false' } });
      const card = { key, file, group, el, img, mtime: file.stat.mtime, state: null, token: null, usingThumb: false };
      const dims = plugin.thumbs.dims(file);
      if (dims) this.setAspect(card, dims.w / dims.h);
      img.addEventListener('load', () => {
        if (card.state !== 'loading') return;
        card.state = 'loaded';
        el.addClass('is-loaded');
        if (img.naturalWidth && img.naturalHeight) {
          this.setAspect(card, img.naturalWidth / img.naturalHeight);
          if (!card.usingThumb) plugin.thumbs.noteDims(file, img.naturalWidth, img.naturalHeight);
        }
      });
      img.addEventListener('error', () => {
        if (card.state !== 'loading') return;
        if (card.usingThumb) { card.usingThumb = false; img.src = this.app.vault.getResourcePath(file); return; }
        card.state = 'broken';
        el.addClass('is-broken');
      });
      el.addEventListener('click', () => this.openLightbox(card.index));
      el.dataset.path = file.path;
      el.archCard = card;
      this.loadObserver.observe(el);
      this.unloadObserver.observe(el);
      return card;
    }

    setAspect(card, aspect) {
      if (!Number.isFinite(aspect) || aspect <= 0) return;
      card.aspect = aspect;
      card.el.style.setProperty('--ag-aspect', String(aspect));
    }

    // How wide, in device pixels, a thumbnail for this card needs to be.
    cardPixels(card) {
      const dpr = window.devicePixelRatio || 1;
      const s = this.settings || DEFAULTS;
      if (s.layout === 'horizontal') return Math.ceil(s.height * Math.max(card.aspect || 1.5, 0.5) * dpr);
      const width = this.rootEl.clientWidth || 800;
      return Math.ceil(((width - s.gutter * (s.columns - 1)) / s.columns) * dpr);
    }

    loadCard(card) {
      if (card.state || this.dead) return;
      card.state = 'loading';
      const file = card.file;
      if (plugin.thumbs.useOriginal(file)) {
        card.usingThumb = false;
        card.img.src = this.app.vault.getResourcePath(file);
        return;
      }
      const token = { cancelled: false };
      card.token = token;
      plugin.thumbs.get(file, this.cardPixels(card), token).then((thumbPath) => {
        if (token.cancelled || card.state !== 'loading') return;
        card.usingThumb = !!thumbPath;
        card.img.src = thumbPath ? diskUrl(thumbPath) : this.app.vault.getResourcePath(file);
      });
    }

    unloadCard(card) {
      if (card.token) { card.token.cancelled = true; card.token = null; }
      if (!card.state) return;
      card.state = null;
      card.el.removeClass('is-loaded');
      card.el.removeClass('is-broken');
      card.img.removeAttribute('src');
    }

    dropCard(card) {
      this.unloadCard(card);
      if (this.loadObserver) this.loadObserver.unobserve(card.el);
      if (this.unloadObserver) this.unloadObserver.unobserve(card.el);
      card.el.remove();
    }

    // The element that scrolls the view. Observing against it, rather than the
    // window, is what makes the load margin reach below the visible part.
    scroller() {
      let el = this.rootEl.parentElement;
      while (el && el !== document.body) {
        const oy = getComputedStyle(el).overflowY;
        if (oy === 'auto' || oy === 'scroll') return el;
        el = el.parentElement;
      }
      return null;
    }

    ensureObservers() {
      const root = this.scroller();
      if (this.loadObserver && this.observerRoot === root) return;
      if (this.loadObserver) this.loadObserver.disconnect();
      if (this.unloadObserver) this.unloadObserver.disconnect();
      this.observerRoot = root;
      this.loadObserver = new IntersectionObserver((items) => {
        for (const it of items) if (it.isIntersecting) this.loadCard(it.target.archCard);
      }, { root, rootMargin: LOAD_MARGIN });
      this.unloadObserver = new IntersectionObserver((items) => {
        for (const it of items) if (!it.isIntersecting) this.unloadCard(it.target.archCard);
      }, { root, rootMargin: UNLOAD_MARGIN });
      for (const card of this.cards.values()) {
        this.loadObserver.observe(card.el);
        this.unloadObserver.observe(card.el);
      }
    }

    openLightbox(index) {
      if (this.lightbox) this.lightbox.close();
      this.lightbox = new Lightbox(this, index);
    }

    // The note that links to an image: its group's note when grouped by link,
    // otherwise the first note found linking to it.
    noteFor(card) {
      if (card.group && card.group.file && card.group.file.extension === 'md') return card.group.file;
      const target = card.file.path;
      const links = this.app.metadataCache.resolvedLinks;
      for (const source in links) {
        if (links[source][target]) {
          const f = this.app.vault.getAbstractFileByPath(source);
          if (f instanceof TFile) return f;
        }
      }
      return null;
    }
  }

  // A plain lightbox: one full-size image and its two neighbours, arrow keys,
  // Escape, double-click or a click beside the image to close.
  class Lightbox {
    constructor(view, index) {
      this.view = view;
      this.app = view.app;
      this.index = index;
      const doc = view.rootEl.ownerDocument;
      this.el = doc.body.createDiv({ cls: 'arch-lightbox', attr: { tabindex: '-1' } });
      this.stageEl = this.el.createDiv('arch-lightbox-stage');
      this.imgEl = this.stageEl.createEl('img', { attr: { decoding: 'async', draggable: 'false' } });
      this.prevEl = this.button('chevron-left', 'Previous (←)', () => this.go(-1), 'arch-lightbox-prev');
      this.nextEl = this.button('chevron-right', 'Next (→)', () => this.go(1), 'arch-lightbox-next');
      // The image's details sit right beside the buttons, so reading them and
      // reaching Open note happen in the same corner.
      // Everything sits at the right, since the Mac's window buttons take the
      // top-left corner.
      const top = this.el.createDiv('arch-lightbox-top');
      this.infoEl = top.createDiv('arch-lightbox-info');
      this.counterEl = top.createSpan('arch-lightbox-counter');
      this.noteBtn = this.button('file-text', 'Open the note that links to it', () => this.openNote(), '', top);
      this.noteBtn.createSpan({ text: 'Open note' });
      const imgBtn = this.button('image', 'Open the image file', () => this.openImage(), '', top);
      imgBtn.createSpan({ text: 'Open image' });
      this.button('x', 'Close (Esc)', () => this.close(), '', top);
      this.preloads = [];

      this.stageEl.addEventListener('click', (evt) => { if (evt.target === this.stageEl) this.close(); });
      this.stageEl.addEventListener('dblclick', () => this.close());
      this.imgEl.addEventListener('load', () => this.showInfo());
      this.onKey = (evt) => {
        const handled = { ArrowLeft: () => this.go(-1), ArrowRight: () => this.go(1), Escape: () => this.close(), Home: () => this.show(0), End: () => this.show(this.view.flat.length - 1) }[evt.key];
        if (!handled) return;
        evt.preventDefault();
        evt.stopPropagation();
        handled();
      };
      this.el.addEventListener('keydown', this.onKey, true);
      this.show(index);
      this.el.focus();
    }

    button(icon, label, onClick, cls, parent) {
      const b = (parent || this.el).createEl('button', { cls: `clickable-icon ${cls || ''}`, attr: { 'aria-label': label } });
      setIcon(b, icon);
      b.addEventListener('click', (evt) => { evt.stopPropagation(); onClick(); });
      return b;
    }

    card() { return this.view.flat[this.index]; }

    go(step) { this.show(this.index + step); }

    show(index) {
      const flat = this.view.flat;
      if (!flat.length) return this.close();
      this.index = Math.max(0, Math.min(flat.length - 1, index));
      const card = this.card();
      this.imgEl.src = this.app.vault.getResourcePath(card.file);
      this.prevEl.toggleClass('is-hidden', this.index === 0);
      this.nextEl.toggleClass('is-hidden', this.index === flat.length - 1);
      this.counterEl.setText(`${this.index + 1} / ${flat.length}`);
      this.noteBtn.toggleClass('is-hidden', !this.view.noteFor(card));
      this.showInfo();
      // The two neighbours load ahead, and only they.
      this.preloads = [flat[this.index - 1], flat[this.index + 1]].filter(Boolean).map((c) => {
        const im = new Image();
        im.decoding = 'async';
        im.src = this.app.vault.getResourcePath(c.file);
        return im;
      });
    }

    showInfo() {
      const card = this.card();
      if (!card) return;
      const file = card.file;
      const note = this.view.noteFor(card);
      const rows = [
        this.imgEl.naturalWidth ? `${this.imgEl.naturalWidth} × ${this.imgEl.naturalHeight}` : '',
        formatSize(file.stat.size),
        new Date(file.stat.ctime).toLocaleDateString(),
      ].filter(Boolean);
      if (note) rows.unshift(note.basename);
      this.infoEl.empty();
      this.infoEl.createDiv({ cls: 'arch-lightbox-name', text: file.name });
      this.infoEl.createDiv({ cls: 'arch-lightbox-row', text: rows.join(' · ') });
    }

    openNote() {
      const note = this.view.noteFor(this.card());
      if (!note) return;
      this.close();
      this.app.workspace.openLinkText(note.path, '', true);
    }

    openImage() {
      const file = this.card().file;
      this.close();
      this.app.workspace.openLinkText(file.path, '', true);
    }

    close() {
      if (this.closed) return;
      this.closed = true;
      this.preloads = [];
      this.el.removeEventListener('keydown', this.onKey, true);
      this.el.remove();
      if (this.view.lightbox === this) this.view.lightbox = null;
    }
  }

  return ArchGalleryView;
}

const GALLERY_CSS = `
.arch-gallery { width: 100%; padding: 0 var(--size-4-2, 8px) var(--size-4-4, 16px); }
.arch-gallery-bar { display: flex; align-items: center; gap: 8px; padding: 6px 0; color: var(--text-muted); font-size: var(--font-ui-small); }
.arch-gallery-count { flex: 1; }
.arch-gallery-shuffle { display: inline-flex; align-items: center; gap: 4px; }
.arch-gallery-note { color: var(--text-muted); padding: 16px 0; }
.arch-gallery-group + .arch-gallery-group { margin-top: 18px; }
.arch-gallery-group-head { display: flex; align-items: baseline; gap: 8px; margin: 4px 0 8px; font-weight: var(--font-semibold); }
.arch-gallery-group-count { color: var(--text-faint); font-weight: normal; font-size: var(--font-ui-smaller); }
.arch-gallery-card { position: relative; cursor: pointer; overflow: hidden; border-radius: var(--ag-radius, 0px); background: var(--background-secondary); }
.arch-gallery-card img { display: block; width: 100%; opacity: 0; transition: opacity 120ms ease-out; }
.arch-gallery-card.is-loaded img { opacity: 1; }
.arch-gallery-card.is-broken::after { content: '⚠'; position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; color: var(--text-faint); }

.arch-gallery.is-vertical .arch-gallery-grid { display: flex; align-items: flex-start; gap: var(--ag-gutter, 8px); line-height: 0; }
.arch-gallery.is-vertical .arch-gallery-col { flex: 1 1 0; min-width: 0; display: flex; flex-direction: column; gap: var(--ag-gutter, 8px); }
.arch-gallery.is-vertical .arch-gallery-card { aspect-ratio: var(--ag-aspect, 0.75); }
.arch-gallery.is-vertical .arch-gallery-card img { height: 100%; object-fit: cover; }

.arch-gallery.is-horizontal .arch-gallery-grid { display: flex; flex-wrap: wrap; margin-right: calc(-1 * var(--ag-gutter, 8px)); }
.arch-gallery.is-horizontal .arch-gallery-card { flex-grow: var(--ag-aspect, 1.5); flex-basis: calc(var(--ag-aspect, 1.5) * var(--ag-row-height, 260px)); height: var(--ag-row-height, 260px); margin: 0 var(--ag-gutter, 8px) var(--ag-gutter, 8px) 0; }
.arch-gallery.is-horizontal .arch-gallery-card img { height: 100%; object-fit: cover; }
.arch-gallery.is-horizontal .arch-gallery-spacer { flex-grow: 999999; flex-basis: 0; height: 0; margin: 0; }
.arch-gallery.is-vertical .arch-gallery-spacer { display: none; }

.arch-lightbox { position: fixed; inset: 0; z-index: var(--layer-modal, 50); background: rgba(0, 0, 0, 0.92); color: #eee; outline: none; }
/* The lightbox covers Obsidian's tab bar, which drags the window when the frame is
   hidden; without this, clicks near the top move the window instead. */
.arch-lightbox, .arch-lightbox * { -webkit-app-region: no-drag; }
.arch-lightbox-stage { position: absolute; inset: 56px 56px 24px; display: flex; align-items: center; justify-content: center; }
.arch-lightbox-stage img { max-width: 100%; max-height: 100%; object-fit: contain; user-select: none; }
.arch-lightbox button { color: #eee; background: transparent; box-shadow: none; }
.arch-lightbox button:hover { background: rgba(255, 255, 255, 0.12); }
.arch-lightbox button.is-hidden { visibility: hidden; }
.arch-lightbox-top { position: absolute; top: 10px; left: 90px; right: 12px; display: flex; align-items: center; justify-content: flex-end; gap: 6px; }
.arch-lightbox-top button { display: inline-flex; align-items: center; gap: 4px; }
.arch-lightbox-counter { margin-right: 8px; font-size: var(--font-ui-small); opacity: 0.8; white-space: nowrap; }
.arch-lightbox-prev, .arch-lightbox-next { position: absolute; top: 50%; transform: translateY(-50%); }
.arch-lightbox-prev { left: 8px; }
.arch-lightbox-next { right: 8px; }
.arch-lightbox-info { position: static; min-width: 0; margin-right: 4px; text-align: right; font-size: var(--font-ui-small); line-height: 1.35; opacity: 0.85; }
.arch-lightbox-info > div { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.arch-lightbox-name { font-weight: var(--font-semibold); }
`;

module.exports = { makeGalleryView, galleryOptions, GALLERY_VIEW_TYPE, GALLERY_CSS };
