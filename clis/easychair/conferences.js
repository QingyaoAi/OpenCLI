/**
 * EasyChair — list the conferences your account is involved in.
 *
 * Use this to discover what to pass as --conf to the other commands. Any of the
 * other commands accept either the numeric a= id or the acronym/slug shown here;
 * acronyms are auto-resolved to your chair-role id.
 *
 * Usage:
 *   opencli easychair conferences                  # list all
 *   opencli easychair conferences --keyword sigir  # filter by acronym/name
 *
 * Requires you to be logged in to EasyChair in the browser session.
 */
import { cli, Strategy } from '@jackwener/opencli/registry';
import { CliError } from '@jackwener/opencli/errors';
import { checkLogin } from './_conf.js';
import { unwrapEvaluateResult } from '../_shared/common.js';

cli({
  site: 'easychair',
  name: 'conferences',
  access: 'read',
  description: 'List EasyChair conferences your account is involved in (acronym + slug)',
  domain: 'easychair.org',
  strategy: Strategy.COOKIE,
  browser: true,
  navigateBefore: false,
  timeoutSeconds: 120,
  args: [
    { name: 'keyword', default: '', help: 'Filter by acronym or name (substring, case-insensitive)' },
    { name: 'limit', type: 'int', default: 200, help: 'Max rows' },
  ],
  columns: ['num', 'acronym', 'slug', 'name'],
  func: async (page, args) => {
    await page.goto('https://easychair.org/my/conferences', { waitUntil: 'domcontentloaded' });
    await checkLogin(page);

    const res = await page.evaluate(`
      (() => {
        const out = [];
        const rows = Array.from(document.querySelectorAll('tr'));
        for (const tr of rows) {
          const a = tr.querySelector('a[href*="my/conference?conf="]');
          if (!a) continue;
          const tds = Array.from(tr.querySelectorAll('td')).map(td => td.textContent.trim());
          if (tds.length < 3 || !/^\\d+$/.test(tds[0])) continue;
          const m = a.href.match(/conf=([^&]+)/);
          out.push({ num: +tds[0], acronym: tds[1] || '', slug: m ? m[1] : '', name: tds[2] || '' });
        }
        return out;
      })()
    `);
    const resData = unwrapEvaluateResult(res);
    let rows = Array.isArray(resData) ? resData : [];
    if (rows.length === 0) {
      throw new CliError('NOT_FOUND', 'No conferences found', 'Confirm you are logged in to EasyChair');
    }

    const kw = (args.keyword || '').toLowerCase();
    if (kw) {
      rows = rows.filter(r =>
        r.acronym.toLowerCase().includes(kw) || r.name.toLowerCase().includes(kw) || r.slug.toLowerCase().includes(kw));
    }
    rows.sort((a, b) => b.num - a.num); // most recent first
    return rows.slice(0, Math.max(1, Number(args.limit)));
  },
});
