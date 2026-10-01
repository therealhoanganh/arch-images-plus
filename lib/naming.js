// Filename building. Pure string work, no Obsidian API -- see CLAUDE.md on why
// nothing in lib/ may require('obsidian').

// Characters Obsidian and the three desktop filesystems disagree about. The
// list is deliberately the union of all three: a vault synced to Windows must
// not carry a name only macOS accepts.
const ILLEGAL = /[\\/:*?"<>|#^[\]]/g;

function sanitizeName(raw, fallback = 'image') {
  const cleaned = String(raw || '')
    .replace(ILLEGAL, '')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 120)
    .trim();
  return cleaned || fallback;
}

function pad(n, width = 2) {
  return String(n).padStart(width, '0');
}

// Deliberately not window.moment: lib/ is also loaded by plain Node in tests,
// where window does not exist.
function stamp(date = new Date()) {
  return {
    date: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    time: `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`,
    year: String(date.getFullYear()),
    month: pad(date.getMonth() + 1),
    day: pad(date.getDate()),
    ms: String(date.getTime()),
  };
}

// Tokens are {{name}}. An unknown token is left alone rather than blanked, so a
// typo is visible in the resulting filename instead of silently collapsing two
// images onto the same name.
function expandTemplate(template, vars) {
  return String(template || '').replace(/\{\{(\w+)\}\}/g, (whole, key) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key] ?? '') : whole
  );
}

// `counter` is resolved by the caller, which is the only part that needs to
// know what is already on disk.
function buildStem({ template, noteName, originalName, width, height, counter, now }) {
  const s = stamp(now || new Date());
  const original = String(originalName || '').replace(/\.[^.]+$/, '');
  return sanitizeName(
    expandTemplate(template, {
      ...s,
      noteName: noteName || '',
      notename: noteName || '',
      originalName: original,
      original,
      width: width || '',
      height: height || '',
      counter: counter == null ? '' : pad(counter),
      count: counter == null ? '' : pad(counter),
    })
  );
}

// True when a template numbers its images. expandTemplate is case-sensitive,
// so this is too.
function hasCounter(template) {
  return /\{\{(counter|count)\}\}/.test(String(template || ''));
}

// The names this template gives, as a pattern with the counter captured, so
// the next number can be read off the images already in the vault (0.8.0).
// Until then the counter ran for the whole session: A 01, A 02, then B 03 in a
// note that had no images yet. Null when the template has no counter, or when
// the 120-character cut took it off the end.
const COUNTER_MARK = 'ARCHCOUNTERMARK';
function counterPattern(vars) {
  if (!hasCounter(vars.template)) return null;
  const stem = buildStem({ ...vars, counter: COUNTER_MARK });
  if (!stem.includes(COUNTER_MARK)) return null;
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Case-insensitive, because the Mac's disk is: "a 03" there blocks "A 03".
  return new RegExp('^' + stem.split(COUNTER_MARK).map(esc).join('(\\d+)') + '$', 'i');
}

// One past the highest number among the names that fit the pattern, so a gap
// left by a deleted image is not filled and a later image never sorts before
// an earlier one.
function nextCounterFrom(names, pattern) {
  let max = 0;
  for (const name of names) {
    const m = pattern.exec(name);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return max + 1;
}

module.exports = { sanitizeName, expandTemplate, buildStem, stamp, pad, hasCounter, counterPattern, nextCounterFrom };
