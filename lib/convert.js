// Image re-encoding, done in the renderer with the canvas encoder Electron
// already carries. No native dependency at all.
//
// WHAT CHROMIUM CAN AND CANNOT ENCODE -- this decides the whole design:
//   encode + decode : image/png, image/jpeg, image/webp
//   decode only     : image/avif, image/heic, image/heif
// canvas.convertToBlob({ type: 'image/avif' }) does not throw. It silently
// returns a PNG, so an "AVIF" file comes out several times LARGER than the
// source and is not AVIF.
//
// AVIF WAS OFFERED VIA ffmpeg AND HAS BEEN REMOVED -- see CLAUDE.md. Decoding
// AVIF still works, so an .avif already in the vault converts to WebP fine.

const CANVAS_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

const FORMATS = {
  webp: { mime: 'image/webp', ext: '.webp', lossy: true },
  jpeg: { mime: 'image/jpeg', ext: '.jpg', lossy: true },
  png: { mime: 'image/png', ext: '.png', lossy: false },
  keep: { mime: null, ext: null, lossy: false },
};

function formatInfo(name) {
  return FORMATS[name] || FORMATS.webp;
}

// Kept as a guard, not as a feature: every format still offered is one Chromium
// can encode, so this is always false. It exists so that adding a format the
// canvas cannot write fails loudly instead of writing a mislabelled PNG.
function needsExternalEncoder(name) {
  const info = formatInfo(name);
  return !!info.mime && !CANVAS_TYPES.has(info.mime);
}

// Longest-edge fit. Never enlarges: a 400px screenshot asked to fit 1920 keeps
// its own size rather than being upscaled into blur.
function fitDimensions(width, height, maxLongEdge) {
  const max = Number(maxLongEdge) || 0;
  if (!max || (width <= max && height <= max)) return { width, height, resized: false };
  const scale = max / Math.max(width, height);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    resized: true,
  };
}

async function decode(blob) {
  // createImageBitmap handles every format Chromium can decode, including the
  // AVIF and HEIC it cannot write back out.
  return await createImageBitmap(blob);
}

// Returns { data, ext, mime, width, height, from, to, skipped }.
// `skipped` is set when the result is not worth keeping -- see the size guard.
async function convertBlob(blob, opts = {}) {
  const {
    format = 'webp',
    quality = 0.82,
    maxLongEdge = 0,
    skipIfLarger = true,
    skipAnimated = true,
  } = opts;

  const info = formatInfo(format);
  const sourceType = blob.type || '';

  // An animated GIF or WebP survives decoding as its first frame only, so
  // "converting" one throws away the animation. Left alone by default.
  if (skipAnimated && /image\/(gif|apng)/.test(sourceType)) {
    return { skipped: 'animated', data: null, from: sourceType };
  }
  if (format === 'keep' || !info.mime) {
    return { skipped: 'keep', data: null, from: sourceType };
  }
  if (needsExternalEncoder(format)) {
    // Unreachable with the formats currently offered. It stops a silent PNG
    // being written under someone else's extension if that ever changes.
    throw new Error(`${format} cannot be encoded by this browser`);
  }

  const bitmap = await decode(blob);
  const fit = fitDimensions(bitmap.width, bitmap.height, maxLongEdge);

  const canvas = new OffscreenCanvas(fit.width, fit.height);
  const ctx = canvas.getContext('2d');
  // Transparency onto JPEG turns black without this; white matches what every
  // other tool does when flattening.
  if (info.mime === 'image/jpeg') {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, fit.width, fit.height);
  }
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, fit.width, fit.height);
  bitmap.close();

  const out = await canvas.convertToBlob(
    info.lossy ? { type: info.mime, quality } : { type: info.mime }
  );
  const data = new Uint8Array(await out.arrayBuffer());

  // Re-encoding an already-small JPEG at high quality routinely produces a
  // bigger file. Keeping that would be a conversion that costs bytes and
  // fidelity at once, so it is reported and the caller writes the original.
  if (skipIfLarger && !fit.resized && data.length >= blob.size) {
    return { skipped: 'larger', data: null, from: sourceType, to: info.mime, bytes: data.length };
  }

  return {
    data,
    ext: info.ext,
    mime: info.mime,
    width: fit.width,
    height: fit.height,
    resized: fit.resized,
    from: sourceType,
    to: info.mime,
    bytes: data.length,
    sourceBytes: blob.size,
  };
}

module.exports = { convertBlob, fitDimensions, formatInfo, needsExternalEncoder, FORMATS, CANVAS_TYPES };
