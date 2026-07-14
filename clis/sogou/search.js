/**
 * Sogou Search via browser DOM parsing.
 * Uses browser automation to extract search results from HTML.
 */
import { cli, Strategy } from '@jackwener/opencli/registry';
import { CliError } from '@jackwener/opencli/errors';
import { unwrapEvaluateResult } from '../_shared/common.js';

cli({
    site: 'sogou',
    name: 'search',
    access: 'read',
    description: 'Search Sogou',
    domain: 'www.sogou.com',
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
        const url = `https://www.sogou.com/web?query=${query}`;

        await page.goto(url, { waitUntil: 'domcontentloaded' });
        await page.wait(5);

        // Sogou routes suspected automation to an /antispider/ CAPTCHA challenge
        // instead of real results — detect it and say so, rather than a vague
        // "no results" that looks like a broken selector.
        const blockCheck = await page.evaluate(`
        (() => location.href.includes('/antispider/') || document.getElementById('seccodeInput') !== null)()
        `);
        if (unwrapEvaluateResult(blockCheck)) {
            throw new CliError(
                'CAPTCHA_REQUIRED',
                'Sogou blocked the request with an anti-bot CAPTCHA',
                'Open https://www.sogou.com in your browser, solve the CAPTCHA, then try again'
            );
        }

        // Extract search results from DOM
        const evalResult = await page.evaluate(`
        (() => {
            const results = document.querySelectorAll('.vrwrap, .rb');
            const data = [];
            for (const r of results) {
                const titleEl = r.querySelector('h3 a, .vr-title a');
                const snippetEl = r.querySelector('.space-txt, .star-wiki');
                if (titleEl && titleEl.href) {
                    data.push({
                        title: (titleEl.textContent || '').trim(),
                        sogouUrl: titleEl.href,
                        snippet: (snippetEl?.textContent || '').trim()
                    });
                }
            }
            return data;
        })()
        `);

        const items = unwrapEvaluateResult(evalResult);

        if (!items || !items.length) {
            throw new CliError('NOT_FOUND', 'No search results found', 'Try a different query');
        }

        // Resolve real URLs by fetching redirect page content
        const resolvedItems = await Promise.all(
            items.slice(0, limit).map(async (item) => {
                let realUrl = item.sogouUrl;
                // If it's a Sogou redirect link, fetch content to extract real URL
                if (item.sogouUrl.includes('sogou.com/link') || item.sogouUrl.startsWith('/link')) {
                    try {
                        const resp = await fetch(item.sogouUrl);
                        const html = await resp.text();
                        // Extract URL from JS redirect: window.location.replace("URL")
                        const match = html.match(/window\.location\.replace\("([^"]+)"\)/);
                        if (match && match[1]) {
                            realUrl = match[1];
                        } else {
                            // Try meta refresh: content="0;URL='URL'"
                            const metaMatch = html.match(/URL='([^']+)'/);
                            if (metaMatch && metaMatch[1]) {
                                realUrl = metaMatch[1];
                            }
                        }
                    } catch (e) {
                        // Keep original URL if resolve fails
                        realUrl = item.sogouUrl;
                    }
                }
                return {
                    title: item.title || '',
                    snippet: item.snippet || '',
                    url: realUrl,
                };
            })
        );

        return resolvedItems;
    },
});