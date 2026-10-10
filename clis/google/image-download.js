/**
 * Google Images download — save images from the direct URLs that
 * `google images` returns in `image_url`.
 *
 * Plain HTTP (no browser). The saved extension comes from the file's real
 * format, non-image responses are rejected, and existing files are never
 * overwritten.
 */
import * as path from 'node:path';
import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError, CommandExecutionError } from '@jackwener/opencli/errors';
import { downloadImageFile, imageBaseName, splitImageUrls } from './image-utils.js';

cli({
    site: 'google',
    name: 'image-download',
    access: 'read',
    description: 'Download images from direct URLs (the image_url column of `google images`)',
    strategy: Strategy.PUBLIC,
    browser: false,
    args: [
        { name: 'url', positional: true, required: true, help: 'Image URL(s) from `google images` image_url; separate several with commas or spaces' },
        { name: 'output', default: './google-images', help: 'Output directory' },
        { name: 'referer', help: 'Referer header (default: the image host origin; pass the result page_url if the host blocks hotlinking)' },
    ],
    columns: ['index', 'status', 'file', 'bytes', 'format', 'url', 'error'],
    func: async (args) => {
        const urls = splitImageUrls(args.url);
        if (urls.length === 0) throw new ArgumentError('Provide at least one image URL');
        for (const url of urls) {
            let protocol;
            try {
                protocol = new URL(url).protocol;
            }
            catch {
                throw new ArgumentError(`Invalid image URL: ${url}`);
            }
            if (protocol !== 'http:' && protocol !== 'https:') {
                throw new ArgumentError(`Only http(s) image URLs can be downloaded, got: ${url}`);
            }
        }
        const output = path.resolve(String(args.output || './google-images'));
        const rows = [];
        for (let i = 0; i < urls.length; i++) {
            const url = urls[i];
            const result = await downloadImageFile(url, output, imageBaseName(url) || `image_${i + 1}`, { referer: args.referer || undefined });
            rows.push({
                index: i + 1,
                status: result.success ? 'success' : 'failed',
                file: result.success ? result.file : null,
                bytes: result.success ? result.bytes : null,
                format: result.success ? result.format : null,
                url,
                error: result.success ? null : result.error,
            });
        }
        if (rows.every((row) => row.status === 'failed')) {
            const reasons = [...new Set(rows.map((row) => row.error))].join('; ');
            throw new CommandExecutionError(`${rows.length === 1 ? 'Download' : `All ${rows.length} downloads`} failed: ${reasons}`, 'If the host blocks hotlinking, retry with --referer set to the result page_url, or pick another image');
        }
        return rows;
    },
});
