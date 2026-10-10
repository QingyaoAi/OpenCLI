import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vm from 'node:vm';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getRegistry } from '@jackwener/opencli/registry';
import { ArgumentError, CliError, CommandExecutionError, EmptyResultError } from '@jackwener/opencli/errors';
import { createPageMock } from '../test-utils.js';

const { mockHttpDownload } = vi.hoisted(() => ({ mockHttpDownload: vi.fn() }));
vi.mock('@jackwener/opencli/download', async (importOriginal) => ({
    ...(await importOriginal()),
    httpDownload: mockHttpDownload,
}));

const { IMAGE_EXTRACT_SCRIPT, buildImageTbs, downloadImageFile, imageBaseName, sniffImageFormat, splitImageUrls } = await import('./image-utils.js');
await import('./images.js');
await import('./image-download.js');

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 1)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 2)]);
const HTML = Buffer.from('<!doctype html><html><body>blocked</body></html>');

describe('buildImageTbs', () => {
    it('returns an empty string without filters', () => {
        expect(buildImageTbs({})).toBe('');
    });
    it('maps each filter to its tbs token', () => {
        expect(buildImageTbs({ size: 'large' })).toBe('isz:l');
        expect(buildImageTbs({ type: 'clipart' })).toBe('itp:clipart');
        expect(buildImageTbs({ license: 'creative-commons' })).toBe('sur:cl');
        expect(buildImageTbs({ license: 'commercial' })).toBe('sur:ol');
        expect(buildImageTbs({ color: 'bw' })).toBe('ic:gray');
        expect(buildImageTbs({ color: 'transparent' })).toBe('ic:trans');
        expect(buildImageTbs({ color: 'blue' })).toBe('ic:specific,isc:blue');
    });
    it('combines filters', () => {
        expect(buildImageTbs({ size: 'large', color: 'red', license: 'creative-commons' })).toBe('isz:l,sur:cl,ic:specific,isc:red');
    });
    it('rejects unknown values instead of silently dropping them', () => {
        expect(() => buildImageTbs({ size: 'huge' })).toThrow(ArgumentError);
        expect(() => buildImageTbs({ color: 'chartreuse' })).toThrow(ArgumentError);
        expect(() => buildImageTbs({ type: 'photo' })).toThrow(ArgumentError);
    });
});

describe('splitImageUrls', () => {
    it('splits on commas, spaces and newlines', () => {
        expect(splitImageUrls('https://a.com/1.jpg,https://b.com/2.png https://c.com/3.gif\nhttps://d.com/4.webp'))
            .toEqual(['https://a.com/1.jpg', 'https://b.com/2.png', 'https://c.com/3.gif', 'https://d.com/4.webp']);
    });
    it('keeps commas that belong to a URL', () => {
        expect(splitImageUrls('https://a.com/img,w_300,h_200/x.jpg,https://b.com/y.jpg'))
            .toEqual(['https://a.com/img,w_300,h_200/x.jpg', 'https://b.com/y.jpg']);
    });
    it('returns an empty list for blank input', () => {
        expect(splitImageUrls('  ')).toEqual([]);
        expect(splitImageUrls(undefined)).toEqual([]);
    });
});

describe('sniffImageFormat', () => {
    it('detects common image formats from magic bytes', () => {
        expect(sniffImageFormat(JPEG)).toMatchObject({ format: 'jpeg', ext: '.jpg' });
        expect(sniffImageFormat(PNG)).toMatchObject({ format: 'png', ext: '.png' });
        expect(sniffImageFormat(Buffer.from('GIF89a' + '\0'.repeat(20), 'latin1'))).toMatchObject({ format: 'gif' });
        expect(sniffImageFormat(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')]))).toMatchObject({ format: 'webp' });
        expect(sniffImageFormat(Buffer.concat([Buffer.alloc(4), Buffer.from('ftypavif'), Buffer.alloc(8)]))).toMatchObject({ format: 'avif' });
        expect(sniffImageFormat(Buffer.from('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toMatchObject({ format: 'svg' });
    });
    it('rejects HTML, text and truncated data', () => {
        expect(sniffImageFormat(HTML)).toBeNull();
        expect(sniffImageFormat(Buffer.from('plain text file, not an image'))).toBeNull();
        expect(sniffImageFormat(Buffer.from([0xff, 0xd8]))).toBeNull();
    });
});

describe('imageBaseName', () => {
    it('uses the URL file name without its extension', () => {
        expect(imageBaseName('https://a.com/wp-content/dog%20photo.jpeg?x=1')).toBe('dog_photo');
    });
    it('is empty when the URL has no usable name', () => {
        expect(imageBaseName('https://a.com/')).toBe('');
        expect(imageBaseName('not a url')).toBe('');
    });
});

describe('IMAGE_EXTRACT_SCRIPT', () => {
    // Shapes copied from a real udm=2 page: escaped = / &, nested arrays, and
    // brackets / quotes inside the title string that a naive matcher would trip on.
    const record = (docid, thumb, orig, domain, size, page, title) => String.raw`[0,"${docid}",["${thumb}",452,678],["${orig}",1707,2560],null,0,"rgb(1,2,3)",null,0,{"2000":[null,"${domain}","${size}"],"2001":[],"2003":[null,"ref","${page}","${title}",null,0]}]`;
    const scriptText = 'AF_init({"k1":[1,' + record('docA', 'https://encrypted-tbn0.gstatic.com/images?q\\u003dtbn:AAA\\u0026s\\u003d10', 'https://site.example/a.jpg?x\\u003d1\\u0026y\\u003d2', 'site.example', '522KB', 'https://site.example/page', 'Dogs [best] \\"quoted\\" ] title') + '],"k2":' + record('docA', 'https://encrypted-tbn0.gstatic.com/images?q\\u003dtbn:AAA', 'https://site.example/a.jpg', 'site.example', '1KB', 'https://dup.example', 'dup')
        + ',"k3":' + record('docB', 'https://encrypted-tbn0.gstatic.com/images?q\\u003dtbn:BBB', 'data:image/png;base64,AAAA', 'inline', '1KB', 'https://inline.example', 'inline image') + '});';
    const tile = (docid, extra = {}) => ({ docid, lpage: `https://lpage.example/${docid}`, alt: `alt ${docid}`, ...extra });
    const run = ({ tiles, scripts = [scriptText], hostname = 'www.google.com', pathname = '/search' }) => {
        const context = {
            location: { hostname, pathname },
            document: {
                scripts: scripts.map((textContent) => ({ textContent })),
                querySelectorAll: () => tiles.map((t) => ({
                    getAttribute: (name) => ({ 'data-docid': t.docid, 'data-lpage': t.lpage })[name] ?? null,
                    querySelector: () => (t.alt ? { alt: t.alt } : null),
                })),
            },
        };
        return JSON.parse(JSON.stringify(vm.runInNewContext(IMAGE_EXTRACT_SCRIPT, context)));
    };

    it('extracts the original url, dimensions, size, source and title per tile', () => {
        const { blocked, items } = run({ tiles: [tile('docA')] });
        expect(blocked).toBeNull();
        expect(items).toEqual([{
            title: 'Dogs [best] "quoted" ] title',
            width: 2560,
            height: 1707,
            file_size: '522KB',
            domain: 'site.example',
            image_url: 'https://site.example/a.jpg?x=1&y=2',
            page_url: 'https://site.example/page',
            thumbnail_url: 'https://encrypted-tbn0.gstatic.com/images?q=tbn:AAA&s=10',
        }]);
    });
    it('keeps DOM order, dedupes docids, and skips tiles without a usable http original', () => {
        const result = run({ tiles: [tile('docMissing'), tile('docA'), tile('docA'), tile('docB')] });
        expect(result.tiles).toBe(3);
        expect(result.items.map((i) => i.image_url)).toEqual(['https://site.example/a.jpg?x=1&y=2']);
    });
    it('falls back to the tile alt text and data-lpage when the record lacks them', () => {
        const bare = String.raw`[0,"docC",["https://encrypted-tbn0.gstatic.com/images?q=tbn:CCC",10,20],["https://c.example/c.png",100,200],null,0,"rgb(1,1,1)",null,0,{}]`;
        const { items } = run({ tiles: [tile('docC')], scripts: [bare] });
        expect(items[0]).toMatchObject({ title: 'alt docC', page_url: 'https://lpage.example/docC', domain: null, file_size: null });
    });
    it('reports interstitials', () => {
        expect(run({ tiles: [], pathname: '/sorry/index' }).blocked).toBe('captcha');
        expect(run({ tiles: [], hostname: 'consent.google.com', pathname: '/m' }).blocked).toBe('consent');
    });
});

describe('downloadImageFile', () => {
    let dir;
    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'google-images-test-'));
        mockHttpDownload.mockReset();
    });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    const respondWith = (...bodies) => {
        for (const body of bodies) {
            mockHttpDownload.mockImplementationOnce(async (_url, dest) => {
                if (body instanceof Error) return { success: false, size: 0, error: body.message };
                fs.writeFileSync(dest, body);
                return { success: true, size: body.length };
            });
        }
    };

    it('names the file by its real format, not the URL extension', async () => {
        respondWith(PNG);
        const result = await downloadImageFile('https://a.example/pic.jpg', dir, 'pic');
        expect(result).toMatchObject({ success: true, format: 'png', bytes: PNG.length });
        expect(path.basename(result.file)).toBe('pic.png');
        expect(fs.readdirSync(dir)).toEqual(['pic.png']);
    });
    it('sends the host origin as Referer by default and honors --referer', async () => {
        respondWith(JPEG, JPEG);
        await downloadImageFile('https://a.example/x/pic.jpg', dir, 'one');
        await downloadImageFile('https://a.example/x/pic.jpg', dir, 'two', { referer: 'https://page.example/post' });
        expect(mockHttpDownload.mock.calls[0][2].headers.Referer).toBe('https://a.example/');
        expect(mockHttpDownload.mock.calls[1][2].headers.Referer).toBe('https://page.example/post');
    });
    it('retries without a Referer when the host answers 403 or serves a non-image page', async () => {
        respondWith(new Error('HTTP 403'), JPEG);
        const result = await downloadImageFile('https://a.example/pic.jpg', dir, 'pic');
        expect(result.success).toBe(true);
        expect(mockHttpDownload.mock.calls[1][2].headers.Referer).toBeUndefined();
    });
    it('rejects a 200 response that is not an image and leaves no files behind', async () => {
        respondWith(HTML, HTML);
        const result = await downloadImageFile('https://a.example/pic.jpg', dir, 'pic');
        expect(result).toMatchObject({ success: false });
        expect(result.error).toMatch(/not an image/);
        expect(fs.readdirSync(dir)).toEqual([]);
    });
    it('does not retry on other failures', async () => {
        respondWith(new Error('HTTP 404'));
        const result = await downloadImageFile('https://a.example/pic.jpg', dir, 'pic');
        expect(result).toEqual({ success: false, error: 'HTTP 404' });
        expect(mockHttpDownload).toHaveBeenCalledTimes(1);
    });
    it('never overwrites an existing file unless asked to', async () => {
        fs.writeFileSync(path.join(dir, 'pic.jpg'), 'precious');
        respondWith(JPEG, JPEG);
        const kept = await downloadImageFile('https://a.example/pic.jpg', dir, 'pic');
        expect(path.basename(kept.file)).toBe('pic_2.jpg');
        expect(fs.readFileSync(path.join(dir, 'pic.jpg'), 'utf8')).toBe('precious');
        const replaced = await downloadImageFile('https://a.example/pic.jpg', dir, 'pic', { overwrite: true });
        expect(path.basename(replaced.file)).toBe('pic.jpg');
        expect(fs.readFileSync(path.join(dir, 'pic.jpg')).equals(JPEG)).toBe(true);
    });
});

describe('google images', () => {
    let cmd;
    beforeAll(() => {
        cmd = getRegistry().get('google/images');
        expect(cmd?.func).toBeTypeOf('function');
    });
    const item = (n, extra = {}) => ({
        title: `Image ${n}`,
        width: 1000 + n,
        height: 500 + n,
        file_size: `${n}0KB`,
        domain: `site${n}.example`,
        image_url: `https://site${n}.example/${n}.jpg`,
        page_url: `https://site${n}.example/page`,
        thumbnail_url: `https://encrypted-tbn0.gstatic.com/images?q=tbn:${n}`,
        ...extra,
    });
    const payload = (n, extra = {}) => ({ blocked: null, tiles: n, items: Array.from({ length: n }, (_v, i) => item(i + 1)), ...extra });

    it('declares the output contract', () => {
        expect(cmd.columns).toEqual(['rank', 'title', 'width', 'height', 'file_size', 'domain', 'image_url', 'page_url', 'preview']);
        expect(cmd.access).toBe('read');
    });
    it('builds the udm=2 url with filters and maps rows (preview stays null)', async () => {
        const page = createPageMock([payload(3)]);
        const rows = await cmd.func(page, { keyword: 'golden retriever', limit: 2, lang: 'zh', size: 'large', color: 'red' });
        const url = new URL(page.goto.mock.calls[0][0]);
        expect(url.searchParams.get('q')).toBe('golden retriever');
        expect(url.searchParams.get('udm')).toBe('2');
        expect(url.searchParams.get('hl')).toBe('zh');
        expect(url.searchParams.get('tbs')).toBe('isz:l,ic:specific,isc:red');
        expect(rows).toHaveLength(2);
        expect(rows[0]).toEqual({
            rank: 1, title: 'Image 1', width: 1001, height: 501, file_size: '10KB', domain: 'site1.example',
            image_url: 'https://site1.example/1.jpg', page_url: 'https://site1.example/page', preview: null,
        });
        expect(Object.keys(rows[0])).toEqual(cmd.columns);
    });
    it('unwraps the evaluate envelope some execution paths return', async () => {
        const page = createPageMock([{ session: 's', data: payload(1) }]);
        const rows = await cmd.func(page, { keyword: 'cat', limit: 5 });
        expect(rows).toHaveLength(1);
    });
    it('omits tbs when no filter is given', async () => {
        const page = createPageMock([payload(1)]);
        await cmd.func(page, { keyword: 'cat', limit: 1 });
        expect(new URL(page.goto.mock.calls[0][0]).searchParams.has('tbs')).toBe(false);
    });
    it('rejects an out-of-range limit instead of clamping it', async () => {
        const page = createPageMock([]);
        await expect(cmd.func(page, { keyword: 'cat', limit: 0 })).rejects.toThrow(ArgumentError);
        await expect(cmd.func(page, { keyword: 'cat', limit: 101 })).rejects.toThrow(ArgumentError);
        expect(page.goto).not.toHaveBeenCalled();
    });
    it('surfaces CAPTCHA and consent interstitials as actionable errors', async () => {
        await expect(cmd.func(createPageMock([payload(0, { blocked: 'captcha' })]), { keyword: 'cat', limit: 5 }))
            .rejects.toMatchObject({ code: 'CAPTCHA_REQUIRED' });
        await expect(cmd.func(createPageMock([payload(0, { blocked: 'consent' })]), { keyword: 'cat', limit: 5 }))
            .rejects.toMatchObject({ code: 'CONSENT_REQUIRED' });
        await expect(cmd.func(createPageMock([payload(0, { blocked: 'captcha' })]), { keyword: 'cat', limit: 5 }))
            .rejects.toBeInstanceOf(CliError);
    });
    it('distinguishes "no results" from "page layout changed"', async () => {
        await expect(cmd.func(createPageMock([payload(0)]), { keyword: 'zzzz', limit: 5 })).rejects.toThrow(EmptyResultError);
        await expect(cmd.func(createPageMock([{ blocked: null, tiles: 40, items: [] }]), { keyword: 'cat', limit: 5 }))
            .rejects.toThrow(CommandExecutionError);
    });
    it('saves thumbnails named by rank when --preview is set', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'google-images-preview-'));
        try {
            mockHttpDownload.mockReset();
            mockHttpDownload.mockImplementation(async (url, dest) => {
                // Thumbnail 2 fails; the others succeed.
                if (url.endsWith(':2')) return { success: false, size: 0, error: 'HTTP 500' };
                fs.writeFileSync(dest, JPEG);
                return { success: true, size: JPEG.length };
            });
            const rows = await cmd.func(createPageMock([payload(3)]), { keyword: 'cat', limit: 3, preview: dir });
            expect(rows.map((r) => r.preview && path.basename(r.preview))).toEqual(['01.jpg', null, '03.jpg']);
            expect(fs.readdirSync(dir).sort()).toEqual(['01.jpg', '03.jpg']);
        }
        finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
    it('fails loudly when no preview could be saved', async () => {
        mockHttpDownload.mockReset();
        mockHttpDownload.mockResolvedValue({ success: false, size: 0, error: 'HTTP 500' });
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'google-images-preview-'));
        try {
            await expect(cmd.func(createPageMock([payload(2)]), { keyword: 'cat', limit: 2, preview: dir })).rejects.toThrow(CommandExecutionError);
        }
        finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe('google image-download', () => {
    let cmd;
    let dir;
    beforeAll(() => {
        cmd = getRegistry().get('google/image-download');
        expect(cmd?.func).toBeTypeOf('function');
    });
    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'google-image-download-'));
        mockHttpDownload.mockReset();
    });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    it('declares the output contract', () => {
        expect(cmd.columns).toEqual(['index', 'status', 'file', 'bytes', 'format', 'url', 'error']);
        expect(cmd.browser).toBe(false);
    });
    it('rejects missing, malformed and non-http URLs before downloading anything', async () => {
        await expect(cmd.func({ url: '  ', output: dir })).rejects.toThrow(ArgumentError);
        await expect(cmd.func({ url: 'not a url', output: dir })).rejects.toThrow(ArgumentError);
        await expect(cmd.func({ url: 'https://a.example/1.jpg,ftp://b.example/2.jpg', output: dir })).rejects.toThrow(ArgumentError);
        await expect(cmd.func({ url: 'file:///etc/passwd', output: dir })).rejects.toThrow(ArgumentError);
        expect(mockHttpDownload).not.toHaveBeenCalled();
    });
    it('reports per-URL results and keeps going after a failure', async () => {
        mockHttpDownload.mockImplementation(async (url, dest) => {
            if (url.includes('missing')) return { success: false, size: 0, error: 'HTTP 404' };
            fs.writeFileSync(dest, JPEG);
            return { success: true, size: JPEG.length };
        });
        const rows = await cmd.func({ url: 'https://a.example/one.jpg,https://a.example/missing.jpg https://b.example/three.png', output: dir });
        expect(rows.map((r) => [r.index, r.status])).toEqual([[1, 'success'], [2, 'failed'], [3, 'success']]);
        expect(rows[0]).toMatchObject({ format: 'jpeg', bytes: JPEG.length, error: null });
        expect(path.basename(rows[0].file)).toBe('one.jpg');
        expect(rows[1]).toMatchObject({ file: null, bytes: null, format: null, error: 'HTTP 404' });
        // Saved by real format even though the URL said .png
        expect(path.basename(rows[2].file)).toBe('three.jpg');
        expect(Object.keys(rows[0])).toEqual(cmd.columns);
    });
    it('throws when every download fails so the exit code is non-zero', async () => {
        mockHttpDownload.mockResolvedValue({ success: false, size: 0, error: 'HTTP 404' });
        await expect(cmd.func({ url: 'https://a.example/1.jpg,https://a.example/2.jpg', output: dir }))
            .rejects.toThrow(/All 2 downloads failed: HTTP 404/);
    });
    it('falls back to a numbered name when the URL has no file name', async () => {
        mockHttpDownload.mockImplementation(async (_url, dest) => {
            fs.writeFileSync(dest, PNG);
            return { success: true, size: PNG.length };
        });
        const rows = await cmd.func({ url: 'https://a.example/', output: dir });
        expect(path.basename(rows[0].file)).toBe('image_1.png');
    });
});
