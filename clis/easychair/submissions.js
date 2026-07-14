/**
 * EasyChair — list submissions with review progress and scores (chair view).
 *
 * Joins two chair pages on the internal submission id:
 *   - review_bysubmission : # / title / assigned / reviews / missing
 *   - status              : # / scores (score(confidence)) / average score
 *
 * Usage:
 *   opencli easychair submissions --conf ccir2026                 # by acronym
 *   opencli easychair submissions --conf 36297290                 # by numeric a= id
 *   opencli easychair submissions --filter incomplete             # fewer than `required` in
 *   opencli easychair submissions --filter notstarted             # zero reviews submitted
 *   opencli easychair submissions --required 3                    # reviews-per-paper target
 *   EASYCHAIR_CONF=ccir2026 opencli easychair submissions         # default conf via env
 *
 * Requires you to be logged in to EasyChair as a chair in the browser session.
 */
import { cli, Strategy } from '@jackwener/opencli/registry';
import { CliError } from '@jackwener/opencli/errors';
import { resolveConf, checkLogin } from './_conf.js';
import { unwrapEvaluateResult } from '../_shared/common.js';

cli({
  site: 'easychair',
  name: 'submissions',
  access: 'read',
  description: 'List EasyChair submissions with assigned/received review counts and scores',
  domain: 'easychair.org',
  strategy: Strategy.COOKIE,
  browser: true,
  navigateBefore: false,
  timeoutSeconds: 120,
  args: [
    { name: 'conf', default: '', help: 'Conference: numeric a= id or acronym/slug. Defaults to $EASYCHAIR_CONF.' },
    { name: 'filter', default: '', help: 'all (default) | incomplete | notstarted' },
    { name: 'required', type: 'int', default: 3, help: 'Target reviews per paper (default 3)' },
    { name: 'limit', type: 'int', default: 500, help: 'Max rows' },
  ],
  columns: ['num', 'assigned', 'reviews', 'missing', 'avg', 'scores', 'status', 'title'],
  func: async (page, args) => {
    const conf = await resolveConf(page, args.conf);
    const required = Number(args.required) || 3;
    const base = 'https://easychair.org/conferences2';

    // --- Page 1: review_bysubmission (assigned / reviews / missing) ---
    await page.goto(`${base}/review_bysubmission?a=${conf}`, { waitUntil: 'domcontentloaded' });
    await checkLogin(page);
    const subRes = await page.evaluate(`
      (() => {
        const links = Array.from(document.querySelectorAll('a[href*="submission_reviews"]'));
        return links.map(a => {
          const tr = a.closest('tr');
          const tds = tr ? Array.from(tr.children).map(td => td.textContent.trim()) : [];
          const m = a.href.match(/submission=(\\d+)/);
          return { id: m ? m[1] : null, num: tds[0], title: tds[1], assigned: tds[2], reviews: tds[3], missing: tds[4] };
        });
      })()
    `);
    const subResData = unwrapEvaluateResult(subRes);
    const subs = Array.isArray(subResData) ? subResData : [];
    if (subs.length === 0) {
      throw new CliError('NOT_FOUND', 'No submissions found', 'Confirm the --conf value and that you are a chair on this conference');
    }

    // --- Page 2: status (scores / average) keyed by the same submission id ---
    await page.goto(`${base}/status?a=${conf}`, { waitUntil: 'domcontentloaded' });
    const statRes = await page.evaluate(`
      (() => {
        const links = Array.from(document.querySelectorAll('a[href*="submission_reviews"]'));
        return links.map(a => {
          const tr = a.closest('tr');
          const tds = tr ? Array.from(tr.children).map(td => td.textContent.trim()) : [];
          const m = a.href.match(/submission=(\\d+)/);
          // status cells: [num, authors+title, scores, avg, decision]
          return { id: m ? m[1] : null, scores: tds[2] || '', avg: tds[3] || '' };
        });
      })()
    `);
    const statById = {};
    const statResData = unwrapEvaluateResult(statRes);
    (Array.isArray(statResData) ? statResData : []).forEach(s => { if (s.id) statById[s.id] = s; });

    let rows = subs.map(s => {
      const st = statById[s.id] || {};
      const reviews = parseInt(s.reviews, 10) || 0;
      let status;
      if (reviews >= required) status = 'complete';
      else if (reviews === 0) status = 'notstarted';
      else status = `missing ${required - reviews}`;
      return {
        num: parseInt(s.num, 10) || s.num,
        assigned: parseInt(s.assigned, 10) || 0,
        reviews,
        missing: parseInt(s.missing, 10) || 0,
        avg: st.avg || '',
        scores: st.scores || '',
        status,
        title: s.title || '',
      };
    });

    const filter = (args.filter || '').toLowerCase();
    if (filter === 'incomplete') rows = rows.filter(r => r.reviews < required);
    else if (filter === 'notstarted') rows = rows.filter(r => r.reviews === 0);

    rows.sort((a, b) => (Number(a.num) || 0) - (Number(b.num) || 0));
    return rows.slice(0, Math.max(1, Number(args.limit)));
  },
});
