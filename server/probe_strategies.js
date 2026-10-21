/**
 * 解析策略对照实验
 * ---------------------------------------------------------------
 * 背景：本机（住宅宽带）能拿到 aweme/detail，云服务器（IDC 机房 IP）拿到的是
 * 200 + 空 body，同时被拉起滑块验证。所以问题不在代码，在出口 IP 的可信度。
 *
 * 这个脚本把几个可能有效的策略串起来实测，每种策略都记录：
 *   · detail 接口有没有拿到非空 body
 *   · 是否被弹出验证码
 *   · 页面里能不能抠出视频信息
 *
 * 判定标准用「拿到非空 detail body」，不用「页面看起来正常」——
 * 后者在风控页上也会成立，很容易被误判成成功。
 *
 * 用法：node probe_strategies.js <awemeId>
 *       node probe_strategies.js 7562511783883164979
 */
'use strict';

const { chromium } = require('playwright');

const ID = process.argv[2] || '7562511783883164979';

/* 默认用「和运行环境一致」的 UA。UA_OVERRIDE 用来做变量分离实验：
   单改版本、单改平台，看究竟是哪一项在起作用。 */
const PC_UA = process.env.UA_OVERRIDE
  || (process.platform === 'win32'
    ? 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
    : 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');
const MB_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

/* 每个策略：先用它自己的 UA 和视口建 context，再按步骤走 */
const STRATEGIES = [
  {
    name: 'A 直接进视频页（当前线上做法）',
    ua: PC_UA,
    viewport: { width: 1440, height: 900 },
    steps: ['https://www.douyin.com/video/' + ID]
  },
  {
    name: 'B 首页预热后再进视频页（拿 ttwid cookie）',
    ua: PC_UA,
    viewport: { width: 1440, height: 900 },
    steps: ['https://www.douyin.com/', 'WAIT3000', 'https://www.douyin.com/video/' + ID]
  },
  {
    name: 'C 移动端 UA 进 m 站',
    ua: MB_UA,
    viewport: { width: 390, height: 844 },
    steps: ['https://m.douyin.com/share/video/' + ID]
  },
  {
    name: 'D 移动端 UA 进 iesdouyin 分享页',
    ua: MB_UA,
    viewport: { width: 390, height: 844 },
    steps: ['https://www.iesdouyin.com/share/video/' + ID + '/']
  }
];

function classify(body) {
  if (!body) return '空 body（被拦）';
  const t = body.trim();
  if (!t) return '空 body（被拦）';
  if (t.length < 60) return '极短 body: ' + t.slice(0, 60);
  return '长度 ' + t.length;
}

async function runOne(browser, s) {
  const ctx = await browser.newContext({ viewport: s.viewport, userAgent: s.ua, locale: 'zh-CN' });
  const page = await ctx.newPage();

  let detailBody = null;
  let detailStatus = 0;
  let captcha = false;
  let detailCount = 0;

  page.on('response', async (res) => {
    const u = res.url();
    if (u.includes('verifycenter') || u.includes('/captcha/')) captcha = true;
    if (u.includes('/aweme/v1/web/aweme/detail/')) {
      detailCount++;
      detailStatus = res.status();
      try {
        const t = await res.text();
        if (t && t.trim().length > (detailBody || '').length) detailBody = t;
      } catch (e) { /* 读不到就算了 */ }
    }
  });

  for (const step of s.steps) {
    if (step.startsWith('WAIT')) {
      await page.waitForTimeout(Number(step.slice(4)) || 1000);
      continue;
    }
    try {
      await page.goto(step, { waitUntil: 'domcontentloaded', timeout: 40000 });
    } catch (e) {
      /* 单步失败继续，结果里会体现出来 */
    }
    await page.waitForTimeout(6000);
  }

  const cookies = await ctx.cookies().catch(() => []);
  const ttwid = cookies.filter((c) => c.name === 'ttwid').length;
  const txt = await page.evaluate(() => (document.body ? document.body.innerText : '')).catch(() => '');
  const hasCaptchaText = /验证|滑块|拖动|安全/.test(txt || '');

  await ctx.close().catch(() => {});

  return {
    name: s.name,
    detailCount,
    detailStatus,
    detail: classify(detailBody),
    captcha,
    ttwid,
    pageHint: String(txt || '').replace(/\s+/g, ' ').slice(0, 90),
    hasCaptchaText
  };
}

(async () => {
  console.log('awemeId: ' + ID);
  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-dev-shm-usage']
  });

  const rows = [];
  for (const s of STRATEGIES) {
    let r;
    try {
      r = await runOne(browser, s);
    } catch (e) {
      r = { name: s.name, detail: '异常: ' + String(e.message || e).slice(0, 60), detailCount: 0, detailStatus: 0, captcha: false, ttwid: 0, pageHint: '', hasCaptchaText: false };
    }
    rows.push(r);
    console.log('\n--- ' + r.name);
    console.log('  detail 请求 ' + r.detailCount + ' 次，状态 ' + r.detailStatus + '，' + r.detail);
    console.log('  验证码 SDK 加载: ' + r.captcha + '   页面出现验证字样: ' + r.hasCaptchaText);
    console.log('  ttwid cookie: ' + r.ttwid);
    console.log('  页面提示: ' + r.pageHint);
  }

  await browser.close().catch(() => {});

  const ok = rows.filter((r) => /长度 \d+/.test(r.detail));
  console.log('\n=== 结论 ===');
  console.log(ok.length ? '拿到数据：' + ok.map((r) => r.name).join(' / ') : '四种策略全部拿不到详情数据');
})();
