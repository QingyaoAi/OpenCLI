/**
 * EasyChair — assign / unassign a reviewer to a submission (WRITE).
 *
 * On the assignment_submission page each PC member has an AJAX-bound checkbox
 * (id "m<memberId>", name "pc"). A plain DOM .click() is preventDefault-ed and does
 * NOT persist; EasyChair persists the toggle through its own XHR helper:
 *
 *     loadObject('/conferences2/assignment_submission_x', cb,
 *                {submission:'<sid>', checked:1|0, bid:'m<memberId>'})
 *
 * This adapter calls that helper directly, then reloads and verifies the checkbox
 * state. Assigning a reviewer does NOT email them — send notice separately
 * (see NOTES.md "Emailing PC members").
 *
 * Usage:
 *   opencli easychair assign --conf ccir2026 --submission 7653825 --member 3783916
 *   opencli easychair assign --conf ccir2026 --submission 7653825 --member 3783916 --action remove
 *
 * --submission is the internal submission id (from `easychair submissions`, the
 *   submission=<id> in its links), NOT the display number.
 * --member is the numeric PC member id (from `easychair missing` memberId column,
 *   or the m<id> checkbox on the assignment page).
 *
 * Requires you to be logged in to EasyChair as a chair in the browser session.
 */
import { cli, Strategy } from '@jackwener/opencli/registry';
import { CliError } from '@jackwener/opencli/errors';
import { resolveConf, checkLogin } from './_conf.js';
import { unwrapEvaluateResult } from '../_shared/common.js';

cli({
  site: 'easychair',
  name: 'assign',
  access: 'write',
  description: 'Assign or unassign a reviewer (PC member) to a submission on EasyChair',
  domain: 'easychair.org',
  strategy: Strategy.COOKIE,
  browser: true,
  navigateBefore: false,
  timeoutSeconds: 120,
  args: [
    { name: 'submission', required: true, help: 'Internal submission id (submission=<id>)' },
    { name: 'member', required: true, help: 'Numeric PC member id' },
    { name: 'action', default: 'add', help: 'add (default) | remove' },
    { name: 'conf', default: '', help: 'Conference: numeric a= id or acronym/slug. Defaults to $EASYCHAIR_CONF.' },
  ],
  columns: ['submission', 'member', 'reviewer', 'action', 'result'],
  func: async (page, args) => {
    const sid = String(args.submission).trim();
    const mid = String(args.member).trim();
    const action = (args.action || 'add').toLowerCase();
    if (!/^\d+$/.test(sid)) throw new CliError('ARGUMENT', `Bad --submission "${sid}"`, 'Use the numeric internal submission id');
    if (!/^\d+$/.test(mid)) throw new CliError('ARGUMENT', `Bad --member "${mid}"`, 'Use the numeric PC member id');
    if (action !== 'add' && action !== 'remove') throw new CliError('ARGUMENT', `Bad --action "${action}"`, 'Use add or remove');
    const checked = action === 'add' ? 1 : 0;
    const boxId = `m${mid}`;

    const conf = await resolveConf(page, args.conf);
    const url = `https://easychair.org/conferences2/assignment_submission?a=${conf}&submission=${sid}`;

    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await checkLogin(page);

    // Locate the checkbox + reviewer name; bail early if not present.
    const preRes = await page.evaluate(`
      (() => {
        const cb = document.getElementById('${boxId}');
        if (!cb) return { found: false };
        const tr = cb.closest('tr');
        const name = tr && tr.children[0] ? tr.children[0].textContent.trim() : '';
        return { found: true, name, checked: cb.checked, hasLoadObject: typeof loadObject === 'function' };
      })()
    `);
    const pre = unwrapEvaluateResult(preRes);
    if (!pre || !pre.found) {
      throw new CliError('NOT_FOUND', `Member ${mid} not on assignment page for submission ${sid}`,
        'Check the member id and that the submission is visible to you (not a conflict)');
    }
    if (!pre.hasLoadObject) {
      throw new CliError('PAGE_CHANGED', 'EasyChair loadObject helper not found',
        'The assignment page markup may have changed; re-derive the persist call');
    }

    const already = (action === 'add' && pre.checked) || (action === 'remove' && !pre.checked);
    if (!already) {
      // Fire the persist XHR exactly the way the bound checkbox would.
      await page.evaluate(`
        (() => {
          loadObject('/conferences2/assignment_submission_x', function(){}, {
            submission: '${sid}', checked: ${checked}, bid: '${boxId}'
          });
          return true;
        })()
      `);
      await page.wait(2);
    }

    // Reload and verify the persisted state.
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    const post = await page.evaluate(`
      (() => {
        const cb = document.getElementById('${boxId}');
        return cb ? cb.checked : null;
      })()
    `);
    const nowChecked = unwrapEvaluateResult(post) === true;
    const ok = action === 'add' ? nowChecked : !nowChecked;

    return [{
      submission: sid,
      member: mid,
      reviewer: pre.name || '',
      action,
      result: ok ? (already ? 'already ' + (action === 'add' ? 'assigned' : 'unassigned') : 'ok')
                 : 'FAILED (state not persisted)',
    }];
  },
});
