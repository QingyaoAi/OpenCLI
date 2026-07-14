/**
 * Baidu Search via browser DOM parsing.
 * Uses browser automation to extract search results from HTML.
 */
import { cli, Strategy } from '@jackwener/opencli/registry';
import { CliError } from '@jackwener/opencli/errors';
import { unwrapEvaluateResult } from '../_shared/common.js';

cli({
    site: 'baidu',
    name: 'search',
    access: 'read',
    description: 'Search Baidu',
    domain: 'www.baidu.com',
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
        const url = `https://www.baidu.com/s?wd=${query}`;

        await page.goto(url, { waitUntil: 'domcontentloaded' });
        await page.wait(5);

        // Extract search results from DOM
        const evalResult = await page.evaluate(`
        (() => {
            const results = document.querySelectorAll('.result.c-container');
            const data = [];
            for (const r of results) {
                const titleEl = r.querySelector('h3 a') || r.querySelector('.t a');
                if (!titleEl || !titleEl.href) continue;

                // Classic layout: dedicated abstract/snippet element.
                let snippet = (r.querySelector('.c-abstract') || r.querySelector('.c-color'))?.textContent || '';
                // Current "cosc-card" layout (2026+): no dedicated snippet class —
                // the description is the leftover text in .cosc-card-content once
                // title/source/footer are stripped out.
                if (!snippet.trim()) {
                    const content = r.querySelector('.cosc-card-content');
                    if (content) {
                        const clone = content.cloneNode(true);
                        clone.querySelectorAll('.cosc-title, .cosc-card-footer, .cosc-source, .cosc-feedback').forEach(e => e.remove());
                        snippet = clone.textContent || '';
                    }
                }

                data.push({
                    title: (titleEl.textContent || '').trim(),
                    baiduUrl: titleEl.href,
                    snippet: snippet.replace(/\\s+/g, ' ').trim()
                });
            }
            return data;
        })()
        `);

        const items = unwrapEvaluateResult(evalResult);

        if (!items || !items.length) {
            throw new CliError('NOT_FOUND', 'No search results found', 'Try a different query');
        }

        // Resolve real URLs by following redirects
        const resolvedItems = await Promise.all(
            items.slice(0, limit).map(async (item) => {
                let realUrl = item.baiduUrl;
                // If it's a Baidu redirect link, follow it to get real URL
                if (item.baiduUrl.includes('baidu.com/link?url=')) {
                    try {
                        const resp = await fetch(item.baiduUrl, { method: 'HEAD', redirect: 'follow' });
                        realUrl = resp.url;
                    } catch (e) {
                        // Keep original URL if resolve fails
                        realUrl = item.baiduUrl;
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