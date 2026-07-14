/**
 * WeChat official account articles — fetch latest articles from a specific official account.
 *
 * Data source: WeChat web reader panel (阅读功能).
 * Note: Returns articles you have recently viewed in the WeChat reader.
 * For full history, visit https://weixin.sogou.com and search the account name.
 *
 * Usage:
 *   opencli weixin articles --name "科奖中心"          # get articles by account name
 *   opencli weixin articles --name "量子位" --limit 10  # limit results
 *   opencli weixin articles --name "科奖中心" -f json   # JSON output
 */
import { cli, Strategy } from '@jackwener/opencli/registry';
import { CliError } from '@jackwener/opencli/errors';
import { unwrapEvaluateResult } from '../_shared/common.js';

const WEIXIN_DOMAIN = 'wx2.qq.com';

/**
 * Format a Unix timestamp as YYYY-MM-DD.
 */
function formatDate(ts) {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

cli({
  site: 'weixin',
  name: 'articles',
  access: 'read',
  description: '获取指定公众号的最新文章列表（通过微信网页版阅读功能）',
  domain: WEIXIN_DOMAIN,
  strategy: Strategy.COOKIE,
  browser: true,
  navigateBefore: false,
  timeoutSeconds: 60,
  args: [
    { name: 'name', required: true, help: '公众号名称，如"科奖中心"' },
    { name: 'limit', default: '20', help: '最多返回文章数（默认20）' },
  ],
  columns: ['Title', 'PublishDate', 'Url', 'Digest'],
  func: async (page, kwargs) => {
    const accountName = kwargs.name;
    const limit = parseInt(kwargs.limit, 10) || 20;

    // Navigate to WeChat web
    await page.goto('https://wx2.qq.com/');

    // Click the reading tab to load articles
    await page.evaluate(`
      (() => {
        var el = document.querySelector('a[title="阅读"]');
        if (el) el.click();
      })()
    `);

    // Wait for article data to load
    await page.evaluate(`
      (() => new Promise((resolve, reject) => {
        var deadline = Date.now() + 30000;
        function check() {
          if (Date.now() > deadline) { reject('reader_timeout'); return; }
          try {
            var scope = angular.element(document.querySelector("#J_NavReadScrollBody")).scope();
            if (scope && scope.articleList && scope.articleList.length > 0) {
              resolve('ok'); return;
            }
            setTimeout(check, 200);
          } catch(e) { setTimeout(check, 200); }
        }
        check();
      }))().catch(() => {})
    `);

    // Extract articles for the specified account
    const evalResult = await page.evaluate(`
      (() => {
        var scope = angular.element(document.querySelector("#J_NavReadScrollBody")).scope();
        if (!scope || !scope.articleList) {
          return null;
        }
        var name = ${JSON.stringify(accountName)};
        var allArticles = [];
        var seenUrls = {};

        function addArticle(article, time) {
          var url = article.Url || '';
          if (!url || seenUrls[url]) return;
          seenUrls[url] = true;
          allArticles.push({
            Title: article.Title || '',
            Digest: article.Digest || '',
            Url: url,
            Cover: article.Cover || '',
            PublishTime: time || 0,
            AppName: article.AppName || name,
            Idx: article.Idx || 1
          });
        }

        // articleList: grouped articles in reader timeline
        for (var i = 0; i < scope.articleList.length; i++) {
          var group = scope.articleList[i];
          if (group.NickName === name) {
            for (var j = 0; j < (group.MPArticleList || []).length; j++) {
              addArticle(group.MPArticleList[j], group.Time);
            }
          }
        }

        // subscribeMsgs: push subscription articles
        if (scope.subscribeMsgs) {
          for (var i = 0; i < scope.subscribeMsgs.length; i++) {
            var sub = scope.subscribeMsgs[i];
            if (sub.NickName === name) {
              for (var j = 0; j < (sub.MPArticleList || []).length; j++) {
                addArticle(sub.MPArticleList[j], sub.Time);
              }
            }
          }
        }

        return allArticles;
      })()
    `);

    const articles = unwrapEvaluateResult(evalResult);

    if (!articles) {
      throw new CliError('PAGE_CHANGED', 'articleList not loaded', 'Make sure the reading tab is loaded');
    }
    if (!Array.isArray(articles)) {
      throw new CliError('PAGE_CHANGED', 'Failed to extract articles', 'Make sure you are logged in on wx2.qq.com');
    }
    if (articles.length === 0) {
      throw new CliError('NOT_FOUND', `No articles found for "${accountName}"`, 'Browse this account in the WeChat reader first, or use sogou.com/weixin to search for articles');
    }

    // Sort by publish time (newest first) and limit
    articles.sort((a, b) => (b.PublishTime || 0) - (a.PublishTime || 0));
    const limited = articles.slice(0, limit);

    return limited.map((a) => ({
      Title: a.Title || '',
      PublishDate: formatDate(a.PublishTime),
      Url: a.Url || '',
      Digest: a.Digest || '',
    }));
  },
});
