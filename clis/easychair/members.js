/**
 * EasyChair — PC member review workload (chair view of review_bymember).
 *
 * Columns: name / role / assigned / reviews / missing / pct / status
 *
 * Usage:
 *   opencli easychair members --conf ccir2026      # all PC members + chairs
 *   opencli easychair members --filter incomplete  # has reviews still missing
 *   opencli easychair members --filter notstarted  # assigned > 0 but 0 submitted
 *   opencli easychair members --filter idle        # assigned == 0 (no review duty)
 *
 * NOTE: PC member NAMES are not unique (e.g. two "Peiyu Liu"). This table is keyed
 * by row order, not identity. To act on a specific person (assign/email), resolve
 * their numeric member id via `opencli easychair missing` or the assignment page,
 * which expose pcmember_info?member=<id>. See NOTES.md.
 *
 * Requires you to be logged in to EasyChair as a chair in the browser session.
 */
import { cli, Strategy } from '@jackwener/opencli/registry';
import { CliError } from '@jackwener/opencli/errors';
import { resolveConf, checkLogin } from './_conf.js';
import { unwrapEvaluateResult } from '../_shared/common.js';

cli({
  site: 'easychair',
  name: 'members',
  access: 'read',
  description: 'List EasyChair PC members with assigned/completed/missing review counts',
  domain: 'easychair.org',
  strategy: Strategy.COOKIE,
  browser: true,
  navigateBefore: false,
  timeoutSeconds: 120,
  args: [
    { name: 'conf', default: '', help: 'Conference: numeric a= id or acronym/slug. Defaults to $EASYCHAIR_CONF.' },
    { name: 'filter', default: '', help: 'all (default) | incomplete | notstarted | idle | done' },
    { name: 'limit', type: 'int', default: 500, help: 'Max rows' },
  ],
  columns: ['name', 'role', 'assigned', 'reviews', 'missing', 'pct', 'status'],
  func: async (page, args) => {
    const conf = await resolveConf(page, args.conf);
    await page.goto(`https://easychair.org/conferences2/review_bymember?a=${conf}`, { waitUntil: 'domcontentloaded' });
    await checkLogin(page);

    // The by-member summary table renders as rows of 5 cells:
    //   [name, role(blank=PC member), assigned, reviews, missing]
    // Parse by matching that shape (last three cells all numeric) — robust to layout noise.
    const res = await page.evaluate(`
      (() => {
        const out = [];
        const trs = Array.from(document.querySelectorAll('tr'));
        for (const tr of trs) {
          const tds = Array.from(tr.querySelectorAll('td')).map(td => td.textContent.trim());
          if (tds.length !== 5) continue;
          const [name, role, a, r, m] = tds;
          if (!/^\\d+$/.test(a) || !/^\\d+$/.test(r) || !/^\\d+$/.test(m)) continue;
          if (!name) continue;
          out.push({ name, role: role || 'PC member', assigned: +a, reviews: +r, missing: +m });
        }
        return out;
      })()
    `);
    const resData = unwrapEvaluateResult(res);
    let rows = Array.isArray(resData) ? resData : [];
    if (rows.length === 0) {
      throw new CliError('NOT_FOUND', 'No PC members parsed', 'Confirm the --conf id and that you are a chair on this conference');
    }

    rows = rows.map(r => {
      let status;
      if (r.assigned === 0) status = 'idle';
      else if (r.missing === 0) status = 'done';
      else if (r.reviews === 0) status = 'notstarted';
      else status = `missing ${r.missing}`;
      return {
        name: r.name, role: r.role, assigned: r.assigned, reviews: r.reviews,
        missing: r.missing,
        pct: r.assigned ? Math.round((r.reviews / r.assigned) * 1000) / 10 : '',
        status,
      };
    });

    const filter = (args.filter || '').toLowerCase();
    if (filter === 'incomplete') rows = rows.filter(r => r.assigned > 0 && r.missing > 0);
    else if (filter === 'notstarted') rows = rows.filter(r => r.assigned > 0 && r.reviews === 0);
    else if (filter === 'idle') rows = rows.filter(r => r.assigned === 0);
    else if (filter === 'done') rows = rows.filter(r => r.assigned > 0 && r.missing === 0);

    return rows.slice(0, Math.max(1, Number(args.limit)));
  },
});
