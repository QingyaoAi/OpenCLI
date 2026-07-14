/**
 * Google Scholar search via browser DOM parsing.
 * Extracts paper title, authors, year, citation count, and URL.
 * Adapted to Google Scholar's new DOM layout (2025+).
 */
import { cli, Strategy } from '@jackwener/opencli/registry';
import { CliError } from '@jackwener/opencli/errors';
import { unwrapEvaluateResult } from '../_shared/common.js';

cli({
    site: 'google-scholar',
    name: 'search',
    access: 'read',
    description: 'Search Google Scholar for academic papers',
    domain: 'scholar.google.com',
    strategy: Strategy.PUBLIC,
    browser: true,
    timeoutSeconds: 120,
    args: [
        { name: 'query', positional: true, required: true, help: 'Paper title or search query' },
        { name: 'limit', type: 'int', default: 10, help: 'Max results (max 25)' },
    ],
    columns: ['rank', 'title', 'authors', 'year', 'cited', 'url'],
    func: async (page, args) => {
        const limit = Math.max(1, Math.min(Number(args.limit), 25));
        const query = encodeURIComponent(args.query);
        const url = `https://scholar.google.com/scholar?q=${query}&hl=en`;

        await page.goto(url, { waitUntil: 'domcontentloaded' });
        await page.wait(5);

        // Check for CAPTCHA / bot block
        const blockCheck = await page.evaluate(`
        (() => {
            const text = document.body.textContent || '';
            return text.includes('unusual traffic') ||
                   text.includes('showing this page to prevent automated requests') ||
                   document.querySelector('form[action*="sorry"]') !== null ||
                   document.querySelector('#gs_captcha') !== null;
        })()
        `);

        if (unwrapEvaluateResult(blockCheck)) {
            throw new CliError(
                'CAPTCHA_REQUIRED',
                'Google Scholar blocked the request',
                'Please open https://scholar.google.com in your browser, solve the CAPTCHA, then try again'
            );
        }

        const evalResult = await page.evaluate(`
        (() => {
            const normalize = v => (v || '').replace(/\\s+/g, ' ').trim();
            const results = [];

            // GS layout: results in #gs_res_ccl_mid .gs_r
            const resultDivs = document.querySelectorAll('.gs_r.gs_or.gs_scl');

            for (const el of resultDivs) {
                // Title link in h3.gs_rt
                const titleEl = el.querySelector('h3.gs_rt a');
                if (!titleEl) continue;

                const title = normalize(titleEl.textContent);
                if (!title) continue;

                const paperUrl = titleEl.getAttribute('href') || '';

                // Author line in .gs_a (contains "Authors, Journal, Year, Publisher")
                const authorDiv = el.querySelector('.gs_a');
                let infoLine = authorDiv ? normalize(authorDiv.textContent) : '';

                // Extract year from info line
                const yearMatch = infoLine.match(/(19|20)\\d{2}/);
                const year = yearMatch ? yearMatch[0] : '';

                // Extract author names from links in .gs_a
                let authors = '';
                if (authorDiv) {
                    const authorLinks = authorDiv.querySelectorAll('a[href*="/citations?user="]');
                    if (authorLinks.length > 0) {
                        authors = Array.from(authorLinks).map(a => normalize(a.textContent)).slice(0, 3).join(', ');
                    } else {
                        // Fallback: extract text before first year or dash
                        const authorPart = infoLine.split(/\\s*-\\s*/)[0] || infoLine.split(year)[0];
                        authors = (authorPart || '').slice(0, 80);
                    }
                }

                // Extract citation count from "Cited by N" link
                let cited = '0';
                const citeLink = el.querySelector('a[href*="/scholar?cites="]');
                if (citeLink) {
                    const citeText = normalize(citeLink.textContent);
                    const numMatch = citeText.match(/(\\d+)/);
                    if (numMatch) {
                        cited = numMatch[1];
                    }
                }

                // Extract PDF URL if available (usually in .gs_or_ggsm a)
                let pdfUrl = '';
                const pdfLink = el.querySelector('.gs_or_ggsm a[href*=".pdf"]') || el.querySelector('a[href*=".pdf"]');
                if (pdfLink) {
                    pdfUrl = pdfLink.getAttribute('href') || '';
                }

                results.push({
                    rank: results.length + 1,
                    title,
                    authors: authors.slice(0, 80),
                    year,
                    cited,
                    url: pdfUrl || paperUrl,
                });

                if (results.length >= ${limit}) break;
            }
            return results;
        })()
        `);

        const data = unwrapEvaluateResult(evalResult);

        if (!Array.isArray(data) || data.length === 0) {
            throw new CliError('NOT_FOUND', 'No search results found on Google Scholar', 'If Google Scholar is blocking, open https://scholar.google.com in your browser, solve the CAPTCHA, then retry');
        }

        return data;
    },
});