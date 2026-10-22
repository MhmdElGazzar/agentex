#!/usr/bin/env node
// check-image.js — Pass 1 (STRUCTURAL) screenshot validation before a screenshot is
// attached to an Azure bug. Dependency-free (Node built-ins only). It answers "is this a
// real, non-blank image?" — NOT "does it show the bug?" (that is the vision pass done by
// Claude, per SKILL.md step 7). Structural + semantic together = evidence worth attaching.
//
// Checks per file:
//   - is it actually a PNG or JPEG (magic bytes)
//   - real dimensions (PNG IHDR / JPEG SOF); flags 0x0 (the classic 0x0 dialog capture)
//   - minimum byte size
//   - "likely blank" heuristic: for PNG, ratio of compressed IDAT bytes to raw pixel bytes.
//     A blank/near-uniform capture (white tab, empty page) compresses to almost nothing.
//
// Usage:
//   node check-image.js <file> [<file> ...]
//   node check-image.js --dir <folder>          # scan *.png/*.jpg in a folder
//   node check-image.js --json <files...>       # machine-readable JSON array
//   node check-image.js --strict <files...>     # exit 1 if any file is hard-invalid
//
// "hard-invalid" = not-found | unreadable | not-an-image | truncated-image |
// malformed-image | zero-dimension | too-small. "likely-blank" is a WARNING (the
// human/vision pass decides), not a hard failure.

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const MIN_BYTES = 2 * 1024;      // < 2 KB is almost never a real screenshot
const BLANK_RATIO = 0.0015;      // IDAT/rawPixels below this over a big canvas => suspect blank
const BLANK_MIN_AREA = 100_000;  // only apply the blank heuristic to reasonably large images

function readChunksPNG(buf) {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (buf.length < sig.length) return null;
  for (let i = 0; i < 8; i++) if (buf[i] !== sig[i]) return null;
  let off = 8, width = 0, height = 0, colorType = 0, idatBytes = 0;
  let sawIHDR = false, sawIEND = false;
  while (off < buf.length) {
    // Every chunk needs a length, type, payload and CRC. Validate its declared bounds
    // before any typed Buffer read so one corrupt screenshot cannot abort a batch.
    if (buf.length - off < 12) return { issue: 'truncated-image' };
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const dataOff = off + 8;
    const dataEnd = dataOff + len;
    const chunkEnd = dataEnd + 4;
    if (chunkEnd > buf.length) return { issue: 'truncated-image' };
    if (!sawIHDR && type !== 'IHDR') return { issue: 'malformed-image' };
    if (type === 'IHDR') {
      if (sawIHDR || len !== 13) return { issue: 'malformed-image' };
      width = buf.readUInt32BE(dataOff);
      height = buf.readUInt32BE(dataOff + 4);
      colorType = buf[dataOff + 9];
      sawIHDR = true;
    } else if (type === 'IDAT') {
      idatBytes += len;
    } else if (type === 'IEND') {
      if (len !== 0) return { issue: 'malformed-image' };
      sawIEND = true;
      break;
    }
    off = chunkEnd;
  }
  if (!sawIHDR) return { issue: 'malformed-image' };
  if (!sawIEND) return { issue: 'truncated-image' };
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType] ?? 3;
  return { width, height, channels, idatBytes };
}

function readDimsJPEG(buf) {
  if (buf.length < 2) return null;
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let off = 2;
  while (off < buf.length) {
    if (buf[off] !== 0xff) { off++; continue; }
    while (off < buf.length && buf[off] === 0xff) off++;
    if (off >= buf.length) return { issue: 'truncated-image' };
    const markerOff = off - 1;
    const marker = buf[off++];
    if (marker === 0x00) return { issue: 'malformed-image' };
    if (marker === 0xd9) return { issue: 'malformed-image' };
    // TEM and restart markers have no length-bearing segment.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (buf.length - off < 2) return { issue: 'truncated-image' };
    const segLen = buf.readUInt16BE(off);
    if (segLen < 2) return { issue: 'malformed-image' };
    const segEnd = off + segLen;
    if (segEnd > buf.length) return { issue: 'truncated-image' };
    if ((marker >= 0xc0 && marker <= 0xcf) && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (segLen < 8) return { issue: 'malformed-image' };
      const height = buf.readUInt16BE(markerOff + 5);
      const width = buf.readUInt16BE(markerOff + 7);
      return { width, height, channels: 3, idatBytes: 0 };
    }
    // A scan cannot validly start before a frame header supplied dimensions.
    if (marker === 0xda) return { issue: 'malformed-image' };
    off = segEnd;
  }
  return { issue: 'truncated-image' };
}

function checkFile(file) {
  const res = { file, ok: false, format: null, width: 0, height: 0, bytes: 0, blankScore: null, issues: [] };
  let buf;
  try {
    buf = fs.readFileSync(file);
  } catch (error) {
    res.issues.push(error && error.code === 'ENOENT' ? 'not-found' : 'unreadable');
    return res;
  }
  res.bytes = buf.length;
  let info = null, fmt = null;
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50) { info = readChunksPNG(buf); fmt = 'png'; }
  else if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8) { info = readDimsJPEG(buf); fmt = 'jpeg'; }

  if (!fmt || !info) { res.issues.push('not-an-image'); return res; }
  res.format = fmt;
  if (info.issue) { res.issues.push(info.issue); return res; }
  res.width = info.width; res.height = info.height;

  if (info.width === 0 || info.height === 0) res.issues.push('zero-dimension');
  if (buf.length < MIN_BYTES) res.issues.push('too-small');

  if (fmt === 'png' && info.width * info.height >= BLANK_MIN_AREA) {
    const raw = info.width * info.height * info.channels;
    const ratio = raw > 0 ? info.idatBytes / raw : 1;
    res.blankScore = Number(ratio.toFixed(5));
    if (ratio < BLANK_RATIO) res.issues.push('likely-blank');
  }

  const hardInvalid = res.issues.some((i) => [
    'not-found', 'unreadable', 'not-an-image', 'truncated-image', 'malformed-image',
    'zero-dimension', 'too-small',
  ].includes(i));
  res.ok = !hardInvalid; // likely-blank is a warning, still "ok" structurally
  return res;
}

function checkFiles(files) {
  return (files || []).map(checkFile);
}

// ---- CLI --------------------------------------------------------------------
function runCli(argv) {
  const json = argv.includes('--json');
  const strict = argv.includes('--strict');
  let files = argv.filter((a) => !a.startsWith('--'));
  const dirIdx = argv.indexOf('--dir');
  if (dirIdx !== -1 && argv[dirIdx + 1]) {
    const dir = argv[dirIdx + 1];
    files = fs.readdirSync(dir)
      .filter((f) => /\.(png|jpe?g)$/i.test(f))
      .map((f) => path.join(dir, f));
  }
  if (files.length === 0) {
    console.error('Usage: check-image.js <file...> | --dir <folder>');
    return 2;
  }

  const results = checkFiles(files);
  if (json) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    for (const r of results) {
      const tag = !r.ok ? 'INVALID' : r.issues.includes('likely-blank') ? 'WARN   ' : 'OK     ';
      const dims = r.width && r.height ? `${r.width}x${r.height}` : '?';
      const extra = r.issues.length ? `  [${r.issues.join(', ')}]` : '';
      const blank = r.blankScore !== null ? `  blank=${r.blankScore}` : '';
      console.log(`${tag}  ${dims.padEnd(11)} ${(r.bytes + 'b').padEnd(9)}${blank}  ${r.file}${extra}`);
    }
  }
  return strict && results.some((r) => !r.ok) ? 1 : 0;
}

module.exports = { checkFile, checkFiles, runCli };

if (require.main === module) process.exitCode = runCli(process.argv.slice(2));
