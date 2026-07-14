/**
 * Bing Search via browser DOM parsing.
 * Uses browser automation to extract search results from HTML.
 * Decodes real URLs from Bing redirect links.
 */
import { cli, Strategy } from '@jackwener/opencli/registry';
import { CliError } from '@jackwener/opencli/errors';
import { unwrapEvaluateResult } from '../_shared/common.js';

// Decode real URL from Bing redirect link
// Format: https://www.bing.com/ck/a?!&&...&u=a1<base64_encoded_url>
function decodeBingUrl(bingUrl) {
    if (!bingUrl) return '';
    // Extract u parameter
    const match = bingUrl.match(/u=a1([a-zA-Z0-9+/=]+)/);
    if (match && match[1]) {
        try {
            // Bing uses a variant of base64 where a1 prefix indicates URL type
            // Decode the base64 part
            const base64 = match[1];
            // Use Buffer for Node.js compatibility (func runs in Node context)
            const decoded = Buffer.from(base64, 'base64').toString('utf-8');
            return decoded;
        } catch (e) {
            // If decode fails, return original URL
            return bingUrl;
        }
    }
    // If not a redirect link, return as-is
    return bingUrl;
}

cli({
    site: 'bing',
    name: 'search',
    access: 'read',
    description: 'Search Bing',
    domain: 'www.bing.com',
    strategy: Strategy.COOKIE,
    browser: true,
    timeoutSeconds: 60,
    args: [
        { name: 'query', positional: true, required: true, help: 'Search query' },
        { name: 'limit', type: 'int', default: 10, help: 'Max results (max 25)' },
    ],
    columns: ['title', 'snippet', 'url'],
    func: async (page, args) => {
        const limit = Math.max(1, Math.min(Number(args.limit), 25));
        const query = encodeURIComponent(args.query);
        const url = `https://www.bing.com/search?q=${query}`;

        await page.goto(url, { waitUntil: 'domcontentloaded' });
        await page.wait(5);

        // Extract search results from DOM
        const evalResult = await page.evaluate(`
        (() => {
            const results = document.querySelectorAll('#b_results > li');
            const data = [];
            for (const r of results) {
                if (r.querySelector('#inline_rs') || r.querySelector('nav') || r.id) continue;
                const h2 = r.querySelector('h2');
                if (!h2) continue;
                const titleEl = h2.querySelector('a');
                const snippetEl = r.querySelector('p');
                if (titleEl && titleEl.href) {
                    data.push({
                        title: (titleEl.textContent || '').trim(),
                        bingUrl: titleEl.href,
                        snippet: (snippetEl?.textContent || '').trim()
                    });
                }
            }
            return data;
        })()
        `);

        // Extract actual data from evaluate result
        const items = unwrapEvaluateResult(evalResult);

        if (!items || !items.length) {
            throw new CliError('NOT_FOUND', 'No search results found', 'Try a different query');
        }

        return items.slice(0, limit).map(item => ({
            title: item.title || '',
            snippet: item.snippet || '',
            url: decodeBingUrl(item.bingUrl),
        }));
    },
});