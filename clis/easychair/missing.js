/**
 * EasyChair — authoritative "missing reviews" list (chair view of review_missing).
 *
 * Unlike `members`, this page exposes each reviewer's NUMERIC member id (via
 * pcmember_info?member=<id>), so duplicate names are disambiguated. It also gives
 * each member's last-login date and the exact submissions they still owe. This is
 * the right source when you need to chase reviewers or feed ids into `assign`.
 *
 * Columns: name / memberId / lastLogin / missing / subs / urgency
 *
 * Usage:
 *   opencli easychair missing --conf ccir2026
 *   opencli easychair missing --conf 36297290
 *
 * Requires you to be logged in to EasyChair as a chair in the browser session.
 */
import { cli, Strategy } from '@jackwener/opencli/registry';
import { CliError } from '@jackwener/opencli/errors';
import { resolveConf, checkLogin } from './_conf.js';
import { unwrapEvaluateResult } from '../_shared/common.js';

cli({
  site: 'easychair',
  name: 'missing',
  access: 'read',
  description: 'List EasyChair reviewers with outstanding reviews (with member ids + last login)',
  domain: 'easychair.org',
  strategy: Strategy.COOKIE,
  browser: true,
  navigateBefore: false,
  timeoutSeconds: 120,
  args: [
    { name: 'conf', default: '', help: 'Conference: numeric a= id or acronym/slug. Defaults to $EASYCHAIR_CONF.' },
    { name: 'limit', type: 'int', default: 500, help: 'Max rows' },
  ],
  columns: ['name', 'memberId', 'lastLogin', 'missing', 'urgency', 'subs'],
  func: async (page, args) => {
    const conf = await resolveConf(page, args.conf);
    await page.goto(`https://easychair.org/conferences2/review_missing?a=${conf}`, { waitUntil: 'domcontentloaded' });
    await checkLogin(page);

    const res = await page.evaluate(`
      (() => {
        const links = Array.from(document.querySelectorAll('a[href*="pcmember_info"]'));
        return links.map(a => {
          const tr = a.closest('tr');
          const tds = tr ? Array.from(tr.children) : [];
          const m = a.href.match(/member=(\\d+)/);
          const lastLogin = tds[2] ? tds[2].textContent.trim() : '';
          const subText = tds[4] ? tds[4].textContent : '';
          // submissions are listed as "12. <title>13. <title>..." — collect the leading numbers
          const subs = Array.from(subText.matchAll(/(\\d+)\\.\\s/g)).map(x => x[1]);
          return { name: a.textContent.trim(), memberId: m ? m[1] : '', lastLogin, subs };
        });
      })()
    `);
    const resData = unwrapEvaluateResult(res);
    let rows = Array.isArray(resData) ? resData : [];

    rows = rows.map(r => {
      const missing = r.subs.length;
      let urgency;
      if (r.lastLogin === 'never') urgency = 'CRITICAL never logged in';
      else if (missing >= 3) urgency = 'HIGH no reviews done';
      else urgency = `MEDIUM ${missing} missing`;
      return {
        name: r.name,
        memberId: r.memberId,
        lastLogin: r.lastLogin,
        missing,
        urgency,
        subs: r.subs.join(','),
      };
    });

    // never-logged-in first, then by most missing
    rows.sort((a, b) => {
      const an = a.lastLogin === 'never' ? 0 : 1;
      const bn = b.lastLogin === 'never' ? 0 : 1;
      if (an !== bn) return an - bn;
      return b.missing - a.missing;
    });

    return rows.slice(0, Math.max(1, Number(args.limit)));
  },
});
