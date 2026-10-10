/**
 * Google Images helpers shared by the `images` and `image-download` commands.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { httpDownload, sanitizeFilename } from '@jackwener/opencli/download';
import { ArgumentError } from '@jackwener/opencli/errors';

/**
 * `tbs` token tables for the Google Images tool filters. Only tokens the live
 * Tools menu still emits are listed: aspect (`iar:`) and the photo/face types are
 * silently ignored by Google now, so they are deliberately not exposed.
 */
const SIZE_TBS = { large: 'isz:l', medium: 'isz:m', icon: 'isz:i' };
const TYPE_TBS = { clipart: 'itp:clipart', lineart: 'itp:lineart', animated: 'itp:animated' };
const LICENSE_TBS = { 'creative-commons': 'sur:cl', commercial: 'sur:ol' };
const COLOR_TBS = { color: 'ic:color', bw: 'ic:gray', transparent: 'ic:trans' };
const COLOR_SWATCHES = ['red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'pink', 'white', 'gray', 'black', 'brown'];

export const IMAGE_FILTER_CHOICES = {
    size: Object.keys(SIZE_TBS),
    type: Object.keys(TYPE_TBS),
    license: Object.keys(LICENSE_TBS),
    color: [...Object.keys(COLOR_TBS), ...COLOR_SWATCHES],
};

function lookupFilter(label, table, value) {
    const token = table[value];
    if (!token) {
        throw new ArgumentError(`Invalid --${label} "${value}"`, `Valid values: ${Object.keys(table).join(', ')}`);
    }
    return token;
}

/** Build the `tbs=` query value for Google Images filters; '' when no filter is set. */
export function buildImageTbs({ size, type, color, license } = {}) {
    const tokens = [];
    if (size) tokens.push(lookupFilter('size', SIZE_TBS, size));
    if (type) tokens.push(lookupFilter('type', TYPE_TBS, type));
    if (license) tokens.push(lookupFilter('license', LICENSE_TBS, license));
    if (color) {
        if (COLOR_TBS[color]) tokens.push(COLOR_TBS[color]);
        else if (COLOR_SWATCHES.includes(color)) tokens.push(`ic:specific,isc:${color}`);
        else throw new ArgumentError(`Invalid --color "${color}"`, `Valid values: ${IMAGE_FILTER_CHOICES.color.join(', ')}`);
    }
    return tokens.join(',');
}

/**
 * In-page extractor for a Google Images results page (udm=2).
 *
 * The thumbnails in the DOM are only gstatic previews. The original image URL,
 * its pixel size, file size, source domain, page URL and title live in the
 * inline script that bootstraps the grid, as one array per tile:
 *   [0, docid, [thumbUrl, h, w], [originalUrl, h, w], ..., {"2000": [null, domain, size], "2003": [null, id, pageUrl, title]}]
 * Each tile in the DOM carries the same docid, which gives us the visible order.
 * Records are located by docid and parsed with a string-aware bracket matcher +
 * JSON.parse, so no regex has to survive Google's markup churn.
 *
 * Returns { blocked, tiles, items } — `blocked` is 'captcha' / 'consent' when
 * Google served an interstitial instead of results.
 */
export const IMAGE_EXTRACT_SCRIPT = String.raw`
(function () {
  var blocked = null;
  if (location.hostname.indexOf('consent.') === 0) blocked = 'consent';
  else if (location.pathname.indexOf('/sorry') === 0) blocked = 'captcha';

  var scriptText = '';
  var scripts = document.scripts;
  for (var s = 0; s < scripts.length; s++) {
    var t = scripts[s].textContent || '';
    if (t.indexOf('encrypted-tbn') !== -1) scriptText += t + '\n';
  }

  function sliceArray(text, start) {
    var depth = 0, inStr = false;
    for (var i = start; i < text.length; i++) {
      var c = text.charAt(i);
      if (inStr) {
        if (c === '\\') i++;
        else if (c === '"') inStr = false;
      } else if (c === '"') inStr = true;
      else if (c === '[' || c === '{') depth++;
      else if (c === ']' || c === '}') {
        depth--;
        if (depth === 0) return text.slice(start, i + 1);
      }
    }
    return '';
  }

  function recordFor(docid) {
    var needle = '[0,"' + docid + '",[';
    var at = scriptText.indexOf(needle);
    while (at !== -1) {
      try {
        var rec = JSON.parse(sliceArray(scriptText, at));
        if (rec[3] && typeof rec[3][0] === 'string') return rec;
      } catch (e) {}
      at = scriptText.indexOf(needle, at + 1);
    }
    return null;
  }

  var items = [], seen = {};
  var tiles = document.querySelectorAll('[data-docid]');
  for (var i = 0; i < tiles.length; i++) {
    var docid = tiles[i].getAttribute('data-docid');
    if (!docid || seen[docid]) continue;
    seen[docid] = true;
    var rec = recordFor(docid);
    if (!rec || !/^https?:\/\//.test(rec[3][0])) continue;
    var meta = rec[9] || {};
    var src = meta['2000'] || [];
    var page = meta['2003'] || [];
    var img = tiles[i].querySelector('img');
    items.push({
      title: page[3] || (img && img.alt) || null,
      width: rec[3][2],
      height: rec[3][1],
      file_size: src[2] || null,
      domain: src[1] || null,
      image_url: rec[3][0],
      page_url: page[2] || tiles[i].getAttribute('data-lpage') || null,
      thumbnail_url: rec[2] && /^https?:\/\//.test(rec[2][0]) ? rec[2][0] : null
    });
  }
  return { blocked: blocked, tiles: Object.keys(seen).length, items: items };
})()
`;

/** Split a user-supplied list of image URLs (comma / whitespace / newline separated). */
export function splitImageUrls(raw) {
    // Commas are legal inside URLs, so only split on a comma that starts a new
    // `scheme://` URL (any scheme, so a stray ftp:// entry is rejected, not merged).
    return String(raw ?? '')
        .split(/\s+|,(?=[a-z][a-z0-9+.-]*:\/\/)/i)
        .map((u) => u.trim().replace(/,$/, ''))
        .filter(Boolean);
}

/** Sniff the real image format from the first bytes; null when it is not a known image. */
export function sniffImageFormat(buf) {
    if (!buf || buf.length < 12) return null;
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { format: 'jpeg', ext: '.jpg' };
    if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { format: 'png', ext: '.png' };
    const head = buf.toString('latin1', 0, 12);
    if (head.startsWith('GIF87a') || head.startsWith('GIF89a')) return { format: 'gif', ext: '.gif' };
    if (head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP') return { format: 'webp', ext: '.webp' };
    if (head.slice(4, 8) === 'ftyp' && /avif|avis/.test(head.slice(8, 12))) return { format: 'avif', ext: '.avif' };
    if (head.startsWith('BM')) return { format: 'bmp', ext: '.bmp' };
    if (buf[0] === 0x00 && buf[1] === 0x00 && buf[2] === 0x01 && buf[3] === 0x00) return { format: 'ico', ext: '.ico' };
    const text = buf.toString('utf8', 0, Math.min(buf.length, 512)).trimStart();
    if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)?<svg[\s>]/i.test(text)) return { format: 'svg', ext: '.svg' };
    return null;
}

/** A readable base filename for an image URL (no extension); '' when the URL has none. */
export function imageBaseName(url) {
    try {
        const last = path.posix.basename(new URL(url).pathname);
        const stem = decodeURIComponent(last).replace(/\.[A-Za-z0-9]{2,5}$/, '');
        return sanitizeFilename(stem, 80);
    }
    catch {
        return '';
    }
}

function uniquePath(dir, base, ext) {
    let candidate = path.join(dir, base + ext);
    for (let n = 2; fs.existsSync(candidate); n++) {
        candidate = path.join(dir, `${base}_${n}${ext}`);
    }
    return candidate;
}

function readHead(file, length = 512) {
    const fd = fs.openSync(file, 'r');
    try {
        const buf = Buffer.alloc(length);
        const read = fs.readSync(fd, buf, 0, length, 0);
        return buf.subarray(0, read);
    }
    finally {
        fs.closeSync(fd);
    }
}

const RETRY_ON_ERROR = /^HTTP 40[13]\b|not an image/;

/**
 * Download one image into `dir` as `<baseName><real extension>`.
 *
 * The extension comes from the file's own magic bytes, never from the URL, and a
 * 200 response that is not actually an image (hotlink-protection HTML, error
 * page) is rejected instead of being saved as `.jpg`. Hosts that block hotlinking
 * are retried once without a Referer. Existing files are never overwritten unless
 * `overwrite` is set (used for search previews).
 *
 * @returns {{success: true, file: string, bytes: number, format: string} | {success: false, error: string}}
 */
export async function downloadImageFile(url, dir, baseName, { referer, timeout = 60000, overwrite = false } = {}) {
    fs.mkdirSync(dir, { recursive: true });
    const partFile = path.join(dir, `.${baseName}.part`);
    const referers = referer ? [referer] : [`${new URL(url).origin}/`, null];
    let lastError = 'download failed';
    try {
        for (const ref of referers) {
            const headers = { Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8' };
            if (ref) headers.Referer = ref;
            const result = await httpDownload(url, partFile, { headers, timeout });
            if (result.success) {
                const kind = sniffImageFormat(readHead(partFile));
                if (kind) {
                    const file = overwrite ? path.join(dir, baseName + kind.ext) : uniquePath(dir, baseName, kind.ext);
                    fs.renameSync(partFile, file);
                    return { success: true, file: path.resolve(file), bytes: result.size, format: kind.format };
                }
                lastError = 'Response is not an image (host may block hotlinking; try --referer <page_url>)';
            }
            else {
                lastError = result.error || lastError;
            }
            if (!RETRY_ON_ERROR.test(lastError)) break;
        }
        return { success: false, error: lastError };
    }
    finally {
        fs.rmSync(partFile, { force: true });
    }
}
