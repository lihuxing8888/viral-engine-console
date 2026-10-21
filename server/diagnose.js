/**
 * 云端解析诊断
 * ---------------------------------------------------------------
 * 本机（家用宽带）能拿到详情，云服务器（机房 IP）拿不到。
 * 这个脚本把「拿不到」拆成几种可能，逐条取证：
 *   ① 页面是否正常加载（title / 最终 URL）
 *   ② 是否被重定向到登录页或验证页
 *   ③ aweme/detail 接口到底有没有发出、返回什么状态码
 *   ④ 接口返回了但内容为空，还是压根没发请求
 *
 * 用法：node diagnose.js [视频链接]
 */
'use strict';

const { chromium } = require('playwright');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const LINK = process.argv[2] || 'https://www.douyin.com/video/7562511783883164979';

(async () => {
  const b = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-dev-shm-usage']
  });
  const ctx = await b.newContext({
    viewport: { width: 1440, height: 900 },
    userAgent: UA,
    locale: 'zh-CN'
  });
  const page = await ctx.newPage();

  const awemeHits = [];
  const allHits = [];
  page.on('response', async (res) => {
    const u = res.url();
    const st = res.status();
    if (allHits.length < 60) allHits.push(st + ' ' + u.slice(0, 120));
    if (u.includes('/aweme/') || u.includes('verify') || u.includes('captcha') || u.includes('/passport/')) {
      let preview = '';
      try {
        const t = await res.text();
        preview = t.slice(0, 160).replace(/\s+/g, ' ');
      } catch (e) { preview = '(读不到 body)'; }
      awemeHits.push({ status: st, url: u.slice(0, 150), body: preview });
    }
  });

  console.log('=== 目标 ===');
  console.log(LINK);

  try {
    await page.goto(LINK, { waitUntil: 'domcontentloaded', timeout: 45000 });
  } catch (e) {
    console.log('goto 失败:', e.message);
  }

  await page.waitForTimeout(9000);

  console.log('\n=== 落地页 ===');
  console.log('final url :', page.url());
  console.log('title     :', await page.title());

  console.log('\n=== 关键接口 ===');
  if (!awemeHits.length) {
    console.log('(一条 aweme / verify / passport 请求都没有发出去)');
  } else {
    for (const h of awemeHits) {
      console.log('[' + h.status + '] ' + h.url);
      console.log('    body: ' + h.body);
    }
  }

  console.log('\n=== 页面可见文字（前 300） ===');
  const txt = await page.evaluate(() => document.body ? document.body.innerText : '').catch(() => '');
  console.log(String(txt).replace(/\s+/g, ' ').slice(0, 300));

  console.log('\n=== 前 20 条响应 ===');
  console.log(allHits.slice(0, 20).join('\n'));

  await ctx.close().catch(() => {});
  await b.close().catch(() => {});
})();
