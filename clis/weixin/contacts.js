/**
 * WeChat contacts — export all WeChat contacts with remark names.
 *
 * Usage:
 *   opencli weixin contacts                     # all contacts
 *   opencli weixin contacts --type friend       # friends only
 *   opencli weixin contacts --type group        # groups only
 *   opencli weixin contacts --type star         # starred friends only
 *   opencli weixin contacts --keyword "老师"     # filter by keyword
 */
import { cli, Strategy } from '@jackwener/opencli/registry';
import { CliError } from '@jackwener/opencli/errors';
import { unwrapEvaluateResult } from '../_shared/common.js';

const WEIXIN_DOMAIN = 'wx2.qq.com';

const CONTACT_TYPE_MAP = {
  friend: 'getAllFriendContact',
  group: 'getAllChatroomContact',
  star: 'getAllStarContact',
  all: 'getAllContacts',
};

/**
 * Some WeChat contact lists are lazy-loaded (star contacts, etc.).
 * For those, we load ALL contacts and filter in JS.
 */
const NEEDS_ALL_CONTACTS = ['star'];

cli({
  site: 'weixin',
  name: 'contacts',
  access: 'read',
  description: '获取微信所有联系人及备注信息',
  domain: WEIXIN_DOMAIN,
  strategy: Strategy.COOKIE,
  browser: true,
  navigateBefore: false,
  timeoutSeconds: 120,
  args: [
    { name: 'type', default: 'all', help: '联系人类型: all/friend/group/star' },
    { name: 'keyword', default: '', help: '按昵称或备注名搜索过滤' },
  ],
  columns: ['DisplayName', 'NickName', 'RemarkName', 'Type', 'Sex', 'StarFriend', 'Signature', 'MemberCount'],
  func: async (page, kwargs) => {
    const type = kwargs.type || 'all';
    const keyword = kwargs.keyword || '';

    if (!CONTACT_TYPE_MAP[type]) {
      throw new CliError('ARGUMENT', `Unknown type: ${type}`, 'Use: all, friend, group, or star');
    }

    // Navigate to WeChat web
    await page.goto('https://wx2.qq.com/');

    // Click the contacts tab to trigger full contact list loading
    await page.evaluate(`
      (() => {
        var el = document.querySelector('a[title="通讯录"]');
        if (el) el.click();
      })()
    `);

    // Wait for contact data to be populated.
    // WeChat loads contacts incrementally — wait until the count stabilizes.
    var minContacts = NEEDS_ALL_CONTACTS.includes(type) || type === 'friend' ? 2000 : 100;
    await page.evaluate(`
      (() => new Promise((resolve, reject) => {
        var deadline = Date.now() + 30000;
        var lastCount = 0;
        var stableCount = 0;
        var minTarget = ${minContacts};
        function check() {
          if (Date.now() > deadline) { reject('contact_load_timeout'); return; }
          try {
            if (typeof angular === 'undefined') { setTimeout(check, 200); return; }
            var cf = angular.element(document.body).injector().get("contactFactory");
            if (!cf) { setTimeout(check, 200); return; }
            var all = cf.getAllContacts();
            var count = Object.keys(all).length;
            if (count === lastCount) {
              stableCount++;
              if (stableCount >= 5 && count >= minTarget) { resolve('ok'); return; }
            } else {
              stableCount = 0;
              lastCount = count;
            }
            setTimeout(check, 200);
          } catch(e) { setTimeout(check, 200); }
        }
        check();
      }))().catch(() => {})
    `);

    const method = CONTACT_TYPE_MAP[type];
    // Star contacts are lazy-loaded, so use getAllContacts + filter
    var sourceMethod = NEEDS_ALL_CONTACTS.includes(type) ? 'getAllContacts' : method;
    var filterStar = type === 'star';
    const rawEvalResult = await page.evaluate(`
      (() => {
        if (typeof angular === 'undefined') return null;
        var injector = angular.element(document.body).injector();
        if (!injector) return null;
        var cf = injector.get("contactFactory");
        if (!cf) return null;
        var raw = cf.${sourceMethod}();
        if (!raw) return null;
        var isArr = Array.isArray(raw);
        var len = isArr ? raw.length : Object.keys(raw).length;
        if (len === 0) return [];
        var results = [];
        var keys = isArr ? Array.from({length: raw.length}, (_, i) => i) : Object.keys(raw);
        for (var i = 0; i < keys.length; i++) {
          var c = raw[keys[i]];
          if (!c) continue;
          if (${filterStar ? 'true' : 'false'} && !c.StarFriend) continue;
          var isGroup = (c.UserName && c.UserName.startsWith("@@"));
          var isOfficial = (c.VerifyFlag && c.VerifyFlag > 0);
          var displayName = (c.RemarkName && c.RemarkName !== "") ? c.RemarkName : c.NickName;
          var sexText = c.Sex === 1 ? "男" : (c.Sex === 2 ? "女" : "");
          results.push({
            UserName: c.UserName || "",
            NickName: c.NickName || "",
            RemarkName: c.RemarkName || "",
            DisplayName: displayName,
            Sex: sexText,
            Signature: c.Signature || "",
            StarFriend: c.StarFriend ? "是" : "否",
            Type: isGroup ? "群组" : (isOfficial ? "公众号" : "好友"),
            MemberCount: isGroup ? (c.MemberCount || 0) : ""
          });
        }
        return results;
      })()
    `);

    const evalResult = unwrapEvaluateResult(rawEvalResult);
    if (evalResult === null || evalResult === undefined) {
      throw new CliError('PAGE_CHANGED', 'Failed to extract contacts', 'Make sure you are logged in on wx2.qq.com');
    }
    const results = Array.isArray(evalResult) ? evalResult : [];
    if (results.length === 0) {
      return [{ DisplayName: '-', NickName: '-', RemarkName: '-', Type: '-', Sex: '-', StarFriend: '-', Signature: '-', MemberCount: '-' }];
    }

    // Keyword filter
    let filtered = results;
    if (keyword) {
      const kw = keyword.toLowerCase();
      filtered = results.filter((c) =>
        (c.NickName || '').toLowerCase().includes(kw) ||
        (c.RemarkName || '').toLowerCase().includes(kw) ||
        (c.DisplayName || '').toLowerCase().includes(kw)
      );
    }

    return filtered.map((c) => ({
      DisplayName: c.DisplayName || '',
      NickName: c.NickName || '',
      RemarkName: c.RemarkName || '',
      Type: c.Type || '',
      Sex: c.Sex || '',
      StarFriend: c.StarFriend || '',
      Signature: c.Signature || '',
      MemberCount: c.MemberCount !== undefined ? c.MemberCount : '',
    }));
  },
});
