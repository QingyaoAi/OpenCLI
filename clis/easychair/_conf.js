/**
 * Shared helpers for the EasyChair adapter. Not a command (does not call cli()).
 *
 * Conference selection is generic — no conference is hardcoded. A `--conf` value
 * (or the EASYCHAIR_CONF env var) may be either:
 *   - a numeric `a=` id (used directly, no lookup), or
 *   - a conference acronym / slug (e.g. "ccir2026", "SIGIR 2026"), which is
 *     resolved against your "My Conferences" list to the chair-role `a=` id.
 */
import { CliError } from '@jackwener/opencli/errors';
import { unwrapEvaluateResult } from '../_shared/common.js';

export async function checkLogin(page) {
  const t = unwrapEvaluateResult(await page.evaluate('document.title'));
  if (typeof t === 'string' && /log in to easychair/i.test(t)) {
    throw new CliError('AUTH_REQUIRED', 'EasyChair session is logged out',
      'Open https://easychair.org in the browser, log in, then retry');
  }
}

const norm = s => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Resolve a --conf argument to a numeric a= id.
 * @param {string} preferRole substring to prefer when a conference has several roles
 */
export async function resolveConf(page, confArg, preferRole = 'chair') {
  const raw = String(confArg || process.env.EASYCHAIR_CONF || '').trim();
  if (!raw) {
    throw new CliError('ARGUMENT', 'No conference specified',
      'Pass --conf <id|acronym> or set EASYCHAIR_CONF; run `opencli easychair conferences` to list yours');
  }
  if (/^\d+$/.test(raw)) return raw; // already a numeric a= id — use as-is

  const want = norm(raw);
  await page.goto('https://easychair.org/my/conferences', { waitUntil: 'domcontentloaded' });
  await checkLogin(page);

  // Pull the full list and match in Node. (Matching in-page is avoided: the
  // in-page evaluate returning a single object came back undefined in adapter
  // context, while returning an array — as below — is reliable.)
  const listRes = await page.evaluate(`
    (() => {
      const out = [];
      const rows = Array.from(document.querySelectorAll('tr'));
      for (const tr of rows) {
        const a = tr.querySelector('a[href*="my/conference?conf="]');
        if (!a) continue;
        const tds = Array.from(tr.querySelectorAll('td')).map(td => td.textContent.trim());
        const m = a.href.match(/conf=([^&]+)/);
        out.push({ acronym: tds[1] || '', slug: m ? m[1] : '' });
      }
      return out;
    })()
  `);
  const listData = unwrapEvaluateResult(listRes);
  const list = Array.isArray(listData) ? listData : [];
  const found = list.find(c => norm(c.acronym) === want || norm(c.slug) === want);
  if (!found || !found.slug) {
    throw new CliError('NOT_FOUND', `Conference "${raw}" not found among your conferences`,
      'Run `opencli easychair conferences` to see exact acronyms');
  }

  await page.goto(`https://easychair.org/my/conference?conf=${encodeURIComponent(found.slug)}`, { waitUntil: 'domcontentloaded' });
  const roleRes = await page.evaluate(`
    (() => {
      const links = Array.from(document.querySelectorAll('a[href]')).filter(a => /[?&]a=\\d+/.test(a.href));
      return links.map(a => ({ role: a.textContent.trim(), a: (a.href.match(/[?&]a=(\\d+)/) || [])[1] }));
    })()
  `);
  const roles = (unwrapEvaluateResult(roleRes) || []).filter(r => r.a);
  if (!roles.length) {
    throw new CliError('NOT_FOUND', `No active role found for "${raw}"`,
      'You may not currently hold a role on this conference');
  }
  const pick = roles.find(r => new RegExp(preferRole, 'i').test(r.role)) || roles[0];
  return pick.a;
}
