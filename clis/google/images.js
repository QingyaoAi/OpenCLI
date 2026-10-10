/**
 * Google Images search via browser DOM + inline-script extraction.
 *
 * Returns the ORIGINAL image URL (not just the gstatic thumbnail) together with
 * pixel size, file size, source domain and page, so an agent can pick an image
 * and hand `image_url` to `google image-download`. With --preview, thumbnails are
 * saved locally (named by rank) so the agent can look at them before choosing.
 */
import * as path from 'node:path';
import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError, CliError, CommandExecutionError, EmptyResultError } from '@jackwener/opencli/errors';
import { unwrapEvaluateResult } from '../_shared/common.js';
import { IMAGE_EXTRACT_SCRIPT, IMAGE_FILTER_CHOICES, buildImageTbs, downloadImageFile } from './image-utils.js';

const MAX_LIMIT = 100;
const PREVIEW_CONCURRENCY = 6;

/** Save thumbnails as <dir>/<rank>.<ext>; returns the saved paths aligned with `items` (null on failure). */
async function savePreviews(items, dir) {
    const saved = new Array(items.length).fill(null);
    let next = 0;
    const worker = async () => {
        while (next < items.length) {
            const i = next++;
            if (!items[i].thumbnail_url) continue;
            const result = await downloadImageFile(items[i].thumbnail_url, dir, String(i + 1).padStart(2, '0'), { timeout: 20000, overwrite: true });
            if (result.success) saved[i] = result.file;
        }
    };
    await Promise.all(Array.from({ length: Math.min(PREVIEW_CONCURRENCY, items.length) }, worker));
    return saved;
}

cli({
    site: 'google',
    name: 'images',
    access: 'read',
    description: 'Search Google Images (original image URLs, sizes, sources; optional local thumbnails)',
    domain: 'google.com',
    strategy: Strategy.PUBLIC,
    browser: true,
    args: [
        { name: 'keyword', positional: true, required: true, help: 'Search query' },
        { name: 'limit', type: 'int', default: 10, help: `Number of results (1-${MAX_LIMIT})` },
        { name: 'lang', default: 'en', help: 'Language short code (e.g. en, zh)' },
        { name: 'size', choices: IMAGE_FILTER_CHOICES.size, help: 'Image size: large, medium or icon' },
        { name: 'type', choices: IMAGE_FILTER_CHOICES.type, help: 'Image type: clipart, lineart or animated (GIF)' },
        { name: 'color', choices: IMAGE_FILTER_CHOICES.color, help: 'Color filter: color, bw, transparent, or a swatch such as red / blue' },
        { name: 'license', choices: IMAGE_FILTER_CHOICES.license, help: 'Usage rights: creative-commons or commercial (commercial & other licenses)' },
        { name: 'preview', help: 'Directory to save thumbnails into, named by rank (01.jpg, 02.jpg, ...), so you can view them before choosing' },
    ],
    columns: ['rank', 'title', 'width', 'height', 'file_size', 'domain', 'image_url', 'page_url', 'preview'],
    func: async (page, args) => {
        const limit = Number(args.limit ?? 10);
        if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
            throw new ArgumentError(`--limit must be an integer between 1 and ${MAX_LIMIT}, got "${args.limit}"`);
        }
        const keyword = String(args.keyword ?? '').trim();
        if (!keyword) throw new ArgumentError('keyword is required');
        const tbs = buildImageTbs({ size: args.size, type: args.type, color: args.color, license: args.license });
        const params = new URLSearchParams({ q: keyword, udm: '2', hl: String(args.lang || 'en') });
        if (tbs) params.set('tbs', tbs);
        await page.goto(`https://www.google.com/search?${params}`);
        // The grid is server-rendered; wait for the first tile image so we do not
        // read the page mid-navigation.
        try {
            await page.wait({ selector: '[data-docid] img', timeout: 5 });
        }
        catch {
            await page.wait(2);
        }
        const data = unwrapEvaluateResult(await page.evaluate(IMAGE_EXTRACT_SCRIPT));
        if (data?.blocked === 'captcha') {
            throw new CliError('CAPTCHA_REQUIRED', 'Google blocked the request', 'Open https://www.google.com/search?q=test&udm=2 in your browser, solve the CAPTCHA, then try again');
        }
        if (data?.blocked === 'consent') {
            throw new CliError('CONSENT_REQUIRED', 'Google is showing a cookie consent page', 'Open https://www.google.com in your browser, accept the consent dialog, then try again');
        }
        if (!data || !Array.isArray(data.items)) {
            throw new CommandExecutionError('Google Images extraction returned an unexpected payload');
        }
        if (data.tiles === 0) {
            throw new EmptyResultError('google images', 'No image results. Try a different keyword or fewer filters; if Google is blocking, open https://www.google.com/imghp in your browser and retry');
        }
        if (data.items.length === 0) {
            throw new CommandExecutionError(`Google Images showed ${data.tiles} results but no original image URLs could be read from the page`, 'The page data layout may have changed; the extractor in clis/google/image-utils.js needs updating');
        }
        const items = data.items.slice(0, limit);
        let previews = items.map(() => null);
        if (args.preview) {
            previews = await savePreviews(items, path.resolve(String(args.preview)));
            if (previews.every((p) => p === null)) {
                throw new CommandExecutionError('Could not download any preview thumbnails', 'Check your network connection and that the --preview directory is writable');
            }
        }
        return items.map((item, i) => ({
            rank: i + 1,
            title: item.title,
            width: item.width,
            height: item.height,
            file_size: item.file_size,
            domain: item.domain,
            image_url: item.image_url,
            page_url: item.page_url,
            preview: previews[i],
        }));
    },
});
