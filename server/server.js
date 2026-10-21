/**
 * 抖店爆款引擎 · 解析服务（常驻后端）
 * ---------------------------------------------------------------
 * 这个服务解决的问题：纯静态页面没法解析抖音视频。
 * 浏览器有跨域限制，也拿不到签名、下载不了视频 —— 所以必须有一个服务端。
 *
 * 微信小程序里那些「解析文案 / 无水印保存视频」的功能，用的就是同一个原理：
 * 用户贴链接 → 自己的服务器去请求抖音 → 把数据/视频转给前端。
 * 小程序前端本身没有特权，一样要过这一层。
 *
 * 启动：node server/server.js
 * 打开：http://127.0.0.1:7801/   ← 界面和服务同源，不需要任何配置
 *
 * 接口：
 *   GET  /api/health                 服务与浏览器就绪状态
 *   POST /api/parse   {url}          解析一条视频，返回文案/音乐/互动数/视频地址
 *   GET  /api/video?id=<awemeId>     下载无水印 mp4（服务端转发，带 Referer）
 *   GET  /api/frames?id=<awemeId>    九宫格关键帧（jpg，供人眼看构图）
 *   GET  /api/metrics?id=<awemeId>   ffmpeg 客观指标：切点/节奏/音量/有无口播
 *   GET  /api/analysis?id=<awemeId>  解析 + 指标 + 可量化爆款因素，一次给全
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { analyzeCamera } = require('./camera');
const { execFile } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const CACHE = path.join(__dirname, 'cache');
const PORT = Number(process.env.PORT) || 7801;
/* 云上部署时绑 127.0.0.1，让 Caddy / Nginx 反代进来；
   本机双击 bat 时保持 0.0.0.0 不变（局域网手机也能连） */
const HOST = process.env.HOST || '0.0.0.0';
/* 同时开几个浏览器页。云服务器内存小（2G 那台），开 2 个 1440x900 页面就接近 OOM，
   所以做成可配：本机默认 2，云上按内存给 1 */
const MAX_PAGES = Math.max(1, Number(process.env.MAX_PAGES) || 2);
/* 缓存的 mp4/jpg/json 多久清一次。云盘不清理会被视频吃满 —— 本机无所谓，云上必须清 */
const CACHE_TTL_DAYS = Number(process.env.CACHE_TTL_DAYS) || 3;
fs.mkdirSync(CACHE, { recursive: true });

/* ---------------------------------------------------------------- 工具 */

function findFfmpeg() {
  const cands = [
    process.env.FFMPEG,
    'ffmpeg',
    'C:/Users/Administrator/Tools/video-stack/ffmpeg/bin/ffmpeg.exe',
    '/usr/bin/ffmpeg',
    '/usr/local/bin/ffmpeg'
  ].filter(Boolean);
  for (const c of cands) {
    try {
      if (c === 'ffmpeg') {
        const r = require('child_process').spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' });
        if (r.status === 0) return 'ffmpeg';
      } else if (fs.existsSync(c)) {
        return c;
      }
    } catch (e) { /* 继续找下一个 */ }
  }
  return null;
}
const FFMPEG = findFfmpeg();

function run(bin, args, timeout = 120000) {
  return new Promise((resolve) => {
    execFile(bin, args, { maxBuffer: 32 * 1024 * 1024, timeout }, (err, stdout, stderr) => {
      resolve({ err, stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

/* 跨域头统一在这里。
   Allow-Private-Network 是必须的：线上 https 页面调用本机 127.0.0.1 属于
   「公网页面访问私有网络」，Chrome 会先发预检，服务端不回这个头就直接被拦。 */
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Private-Network': 'true'
};

const json = (res, code, obj) => {
  const body = Buffer.from(JSON.stringify(obj), 'utf-8');
  res.writeHead(code, Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store'
  }, CORS));
  res.end(body);
};

const readBody = (req) => new Promise((resolve) => {
  let buf = '';
  req.on('data', (c) => {
    buf += c;
    if (buf.length > 2e6) { req.destroy(); resolve(''); }
  });
  req.on('end', () => resolve(buf));
  req.on('error', () => resolve(''));
});

const log = (...a) => console.log('[' + new Date().toISOString().slice(11, 19) + ']', ...a);

/* 缓存清理。一台视频分析服务最容易被吃满的不是内存而是磁盘：
   每条片子落地一个 10~30MB 的 mp4，用几天就是几个 G。
   过期时间按文件 mtime 算，正在被读的文件 mtime 新，不会被误删。 */
function sweepCache() {
  const cutoff = Date.now() - CACHE_TTL_DAYS * 86400000;
  let n = 0, bytes = 0, names = [];
  try { names = fs.readdirSync(CACHE); } catch (e) { return; }
  for (const name of names) {
    const f = path.join(CACHE, name);
    try {
      const st = fs.statSync(f);
      if (st.isFile() && st.mtimeMs < cutoff) { bytes += st.size; fs.unlinkSync(f); n++; }
    } catch (e) { /* 单个删不掉不影响其它 */ }
  }
  if (n) log('清理缓存 ' + n + ' 个文件，释放 ' + (bytes / 1048576).toFixed(1) + ' MB');
}

/* 缓存用量，给 /api/health 用 —— 云上要能一眼看出磁盘快满了 */
function cacheUsage() {
  let files = 0, bytes = 0, names = [];
  try { names = fs.readdirSync(CACHE); } catch (e) { return { files: 0, mb: 0 }; }
  for (const name of names) {
    try {
      const st = fs.statSync(path.join(CACHE, name));
      if (st.isFile()) { files++; bytes += st.size; }
    } catch (e) { /* 忽略 */ }
  }
  return { files, mb: Number((bytes / 1048576).toFixed(1)) };
}

/* ------------------------------------------------------- 浏览器（复用） */

let browser = null;
let launching = null;

async function getBrowser() {
  if (browser && browser.isConnected && browser.isConnected()) return browser;
  if (launching) return launching;
  launching = (async () => {
    const { chromium } = require('playwright');
    browser = await chromium.launch({
      headless: true,
      args: ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-dev-shm-usage']
    });
    /* 记下真实版本，UA 要用它 —— 见 uaOf() 上面的说明 */
    try { UA_CHROME_VERSION.v = browser.version(); } catch (e) { /* 拿不到就退回兜底值 */ }
    log('浏览器已启动  Chrome/' + (UA_CHROME_VERSION.v || '?'));
    return browser;
  })();
  try { return await launching; } finally { launching = null; }
}

/* 并发闸门：同时最多 MAX_PAGES 个页面，避免一次贴 20 条把机器打满 */
let running = 0;
const queue = [];
function gate(fn) {
  return new Promise((resolve, reject) => {
    queue.push({ fn, resolve, reject });
    pump();
  });
}
function pump() {
  while (running < MAX_PAGES && queue.length) {
    const job = queue.shift();
    running++;
    job.fn().then(job.resolve, job.reject).finally(() => { running--; pump(); });
  }
}

/* -------------------------------------------------------------- 解析核心 */

/**
 * UA 必须和真实浏览器对得上。
 *
 * 踩过的坑（在云服务器上排查了很久）：原来 UA 硬编码成
 * 「Windows NT 10.0 / Chrome 131」，但服务器实际跑的是 Linux 上的 Chrome 156。
 * 抖音不会回 403，也不报错 —— 它让 aweme/detail 返回 200 加一个空 body。
 * 看起来像「IP 被封」或「视频被删」，把方向带偏了。
 *
 * 证据：同一份代码、同一个视频、同一台服务器，只把 UA 的系统和版本改成真实值，
 * detail 就从 0 字节变成 5 万多字节。反过来，移动端 UA 配桌面浏览器同样拿不到 ——
 * 拦的不是 IP，是「UA 自称的身份」和「浏览器实际指纹」矛盾。
 *
 * 所以不写死版本号，直接从 browser.version() 取真实版本，平台按 process.platform 走，
 * 浏览器一升级 UA 自动跟着变，不会再出现错位。
 */
const UA_CHROME_VERSION = { v: '' };

function uaOf() {
  /* 拿不到真实版本时退回一个保守值，但正常路径一定会拿到 */
  const ver = UA_CHROME_VERSION.v || '131.0.0.0';
  const base = 'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/' + ver + ' Safari/537.36';
  if (process.platform === 'win32') return 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' + base;
  if (process.platform === 'darwin') return 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' + base;
  return 'Mozilla/5.0 (X11; Linux x86_64) ' + base;
}

/**
 * 选播放源。
 * 两个踩过的坑：
 * ① 一开始只按 bit_rate 取最大，结果拿到 576x1024 的 low_540 那一路，而不是 720x1280。
 *    码率高不等于画面大 —— 必须分辨率优先。
 * ② 只靠 bit_rate 列表选，画质会抖：抖音每次返回的 bit_rate 集合不完全一样，
 *    有时里面最高码率那路是 adapt_lowest_720_1（同为 720p 但码率低得多）。
 *    所以 play_addr 只要是最大分辨率，就直接用它 —— 那是官方默认源，最稳。
 * 另外注意：detail.video.width/height 是封面/逻辑尺寸（常是 1080x1920），
 * 真正能下载到的通常只有 720p 级别，这两个数字不能混着说。
 */
function pickSource(v) {
  const cands = [];
  const push = (addr, tag, rate) => {
    const u = ((addr && addr.url_list) || [])[0];
    if (!u) return;
    const w = addr.width || 0;
    const h = addr.height || 0;
    cands.push({ url: u, w, h, area: w * h, rate: rate || 0, tag });
  };

  const main = ((v.play_addr && v.play_addr.url_list) || [])[0];
  push(v.play_addr, 'play_addr', 0);
  push(v.play_addr_h264, 'play_addr_h264', 0);
  (v.bit_rate || []).forEach((b) => push(b.play_addr, b.gear_name || 'bit_rate', b.bit_rate || 0));

  if (!cands.length) return { url: '', w: 0, h: 0, tag: '' };

  const maxArea = Math.max.apply(null, cands.map((c) => c.area));
  /* play_addr 已经是最大分辨率 → 用它，不要再去 bit_rate 里碰运气 */
  const canonical = cands.find((c) => c.tag === 'play_addr' && c.area === maxArea && c.url === main);
  if (canonical) return canonical;

  cands.sort((a, b) => (b.area - a.area) || (b.rate - a.rate));
  return cands[0];
}

/** 从抖音详情接口的原始对象里抽出我们需要的一切 */
function pick(detail, link) {
  const v = detail.video || {};
  const music = detail.music || {};
  const st = detail.statistics || {};

  /* play_addr 是播放源（无水印），download_addr 是分享下载源（带水印）—— 我们只用前者 */
  const src = pickSource(v);

  return {
    awemeId: String(detail.aweme_id || ''),
    link: link || '',
    desc: detail.desc || '',
    hashtags: (detail.text_extra || []).map((x) => x.hashtag_name).filter(Boolean),
    durationSec: +(((v.duration || 0) / 1000).toFixed(1)),
    /* 元数据尺寸（封面/逻辑尺寸），不等于能下载到的尺寸 */
    width: v.width || 0,
    height: v.height || 0,
    ratio: v.ratio || '',
    music: { title: music.title || '', author: music.author || '' },
    stats: {
      digg: st.digg_count || 0,
      comment: st.comment_count || 0,
      collect: st.collect_count || 0,
      share: st.share_count || 0
    },
    author: (detail.author && (detail.author.nickname || detail.author.unique_id)) || '',
    publishTime: detail.create_time ? new Date(detail.create_time * 1000).toISOString().slice(0, 10) : '',
    playUrl: src.url,
    /* 实际可下载到的最高画质 —— 这才是"无水印保存"真正落地的分辨率 */
    playWidth: src.w,
    playHeight: src.h,
    playGear: src.tag,
    cover: ((v.cover && v.cover.url_list) || [])[0] || '',
    fetchedAt: new Date().toISOString()
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 解析失败时说清楚是哪一种失败。
 * 「没拿到详情数据」这句话对用户没用 —— 可能是视频删了，也可能是这台机器的出口 IP
 * 被抖音当成爬虫。两种情况的处理办法完全不同，必须分开说，不能糊成一句。
 */
function explainBlocked(hits, empty, captcha, snap) {
  const s = String(snap || '');
  if (hits > 0 && empty >= hits) {
    return '抖音把接口数据吞了：详情接口请求了 ' + hits + ' 次，全部返回 200 但 body 是空的'
      + (captcha ? '，同时页面挂起了验证码' : '')
      + '。这是按出口 IP 判定的风控 —— 机房/云服务器 IP 会被当成爬虫，家用宽带不会。'
      + '这一步要在住宅网络下完成（把服务跑在自己电脑上就能过）。';
  }
  if (hits === 0 && /抱歉|出错/.test(s)) {
    return '抖音直接拒绝了这次访问，页面只回了「抱歉出错」。这同样是出口 IP 被风控，'
      + '不是链接有问题 —— 换成本机的家用宽带就能正常解析。';
  }
  if (hits === 0) {
    return '页面没触发详情接口，通常是要登录、视频已删、或者链接不是视频页。';
  }
  return '详情接口回来了但里面没有视频数据，可能是视频已删或设为私密。';
}

async function parseUrl(input) {
  let link = String(input || '').trim();
  if (!link) throw new Error('链接为空');
  if (!/^https?:\/\//i.test(link)) link = 'https://' + link;

  const b = await getBrowser();
  const ctx = await b.newContext({
    viewport: { width: 1440, height: 900 },
    userAgent: uaOf(),
    locale: 'zh-CN'
  });
  const page = await ctx.newPage();
  let detail = null;
  /* 风控取证：抖音拦人不是返回 403，而是「200 + 空 body」，光看状态码会误判成接口正常。
     所以要分别记：接口发了几次、几次是空的、有没有加载验证码。 */
  let detailHits = 0;
  let detailEmpty = 0;
  let captchaSeen = false;

  page.on('response', async (res) => {
    const u = res.url();
    if (u.includes('verifycenter') || u.includes('/captcha/')) captchaSeen = true;
    if (!detail && u.includes('/aweme/v1/web/aweme/detail/')) {
      detailHits++;
      try {
        const j = JSON.parse(await res.text());
        const d = j.aweme_detail || (j.aweme_details && j.aweme_details[0]);
        if (d) detail = d;
      } catch (e) {
        /* body 为空或不是 JSON —— 这恰恰是机房 IP 被拦的典型样子 */
        detailEmpty++;
      }
    }
  });

  try {
    await page.goto(link, { waitUntil: 'domcontentloaded', timeout: 45000 });
    /* 短链会跳转，等详情接口回来；最多 22 秒 */
    for (let i = 0; i < 44 && !detail; i++) await sleep(500);
    if (!detail) {
      const snap = await page.evaluate(() => document.body ? document.body.innerText.slice(0, 200) : '').catch(() => '');
      const tip = snap ? ' | 页面提示：' + snap.replace(/\s+/g, ' ').slice(0, 80) : '';
      throw new Error(explainBlocked(detailHits, detailEmpty, captchaSeen, snap) + tip);
    }
    const info = pick(detail, link);
    fs.writeFileSync(path.join(CACHE, info.awemeId + '.json'), JSON.stringify(info, null, 2), 'utf-8');
    return info;
  } finally {
    await page.close().catch(() => {});
    await ctx.close().catch(() => {});
  }
}

function cachedInfo(id) {
  const f = path.join(CACHE, id + '.json');
  if (!fs.existsSync(f)) return null;
  try { return JSON.parse(fs.readFileSync(f, 'utf-8')); } catch (e) { return null; }
}

/* ------------------------------------------------------------- mp4 落地 */

async function ensureMp4(id, info) {
  const f = path.join(CACHE, id + '.mp4');
  if (fs.existsSync(f) && fs.statSync(f).size > 10000) return f;
  const src = (info && info.playUrl) || (cachedInfo(id) || {}).playUrl;
  if (!src) throw new Error('没有可用的视频地址');
  const resp = await fetch(src, {
    headers: { 'User-Agent': uaOf(), Referer: 'https://www.douyin.com/' }
  });
  if (!resp.ok) throw new Error('视频源返回 ' + resp.status);
  const buf = Buffer.from(await resp.arrayBuffer());
  if (buf.length < 10000) throw new Error('视频内容异常，只有 ' + buf.length + ' 字节');
  fs.writeFileSync(f, buf);
  return f;
}

/* ------------------------------------------------- ffmpeg 客观指标计算 */

async function computeMetrics(id) {
  const info = cachedInfo(id);
  if (!info) throw new Error('还没解析过这条视频');
  if (!FFMPEG) throw new Error('本机没找到 ffmpeg，指标算不了（视频仍可解析）');

  const mp4 = await ensureMp4(id, info);

  /* ① 镜头切点：场景变化分数 > 0.28 记为一次切镜 */
  const cutRun = await run(FFMPEG, [
    '-hide_banner', '-i', mp4,
    '-filter:v', "select='gt(scene,0.28)',showinfo",
    '-f', 'null', '-'
  ]);
  const cuts = [];
  const reCut = /pts_time:([0-9.]+)/g;
  let m;
  while ((m = reCut.exec(cutRun.stderr))) {
    const t = parseFloat(m[1]);
    /* 丢掉片头 0.3 秒内的检测结果：那是「第一帧从空白/黑场进来」被当成切镜，
       不是真的换镜头。留着会把「首刀」算成 0.07 秒，结论直接跑偏。 */
    if (!isNaN(t) && t >= 0.3 && (cuts.length === 0 || t - cuts[cuts.length - 1] > 0.25)) {
      cuts.push(+t.toFixed(2));
    }
  }

  /* ② 音量包络：逐秒 RMS，用来判断有没有口播 */
  const volRun = await run(FFMPEG, [
    '-hide_banner', '-i', mp4,
    '-af', 'astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level',
    '-f', 'null', '-'
  ]);
  const rms = [];
  const reRms = /RMS_level=(-?[0-9.]+|-inf)/g;
  while ((m = reRms.exec(volRun.stderr))) {
    const v = m[1] === '-inf' ? -90 : parseFloat(m[1]);
    if (!isNaN(v)) rms.push(v);
  }

  /* ③ 静音段：超过 1 秒低于 -35dB */
  const silRun = await run(FFMPEG, [
    '-hide_banner', '-i', mp4,
    '-af', 'silencedetect=n=-35dB:d=1',
    '-f', 'null', '-'
  ]);
  const silences = [];
  const reSil = /silence_start: ([0-9.]+)[\s\S]*?silence_end: ([0-9.]+)/g;
  while ((m = reSil.exec(silRun.stderr))) {
    silences.push({ from: +m[1], to: +m[2], len: +(m[2] - m[1]).toFixed(2) });
  }

  /* ④ 运动量：帧间差异均值，粗估镜头/主体是否剧烈在动 */
  const motRun = await run(FFMPEG, [
    '-hide_banner', '-i', mp4,
    '-vf', "scale=160:-1,tblend=all_mode=difference,signalstats,metadata=print:key=lavfi.signalstats.YAVG",
    '-f', 'null', '-'
  ]);
  const motion = [];
  const reMot = /YAVG=([0-9.]+)/g;
  while ((m = reMot.exec(motRun.stderr))) motion.push(parseFloat(m[1]));

  const dur = info.durationSec || 0;
  const avgMotion = motion.length ? +(motion.reduce((a, b) => a + b, 0) / motion.length).toFixed(2) : null;

  /* ⑤ 运镜：看背景位移判断机位怎么动。单独一个模块，因为「主体在动」和「机位在动」
     必须分开 —— 逐像素平均差会把手上转手机当成机位在晃。 */
  let camera = null;
  let cameraError = null;
  try {
    camera = await analyzeCamera(FFMPEG, mp4, cuts, dur);
  } catch (e) {
    cameraError = String(e.message || e);
  }

  /* 音量判口播：口播有持续的音节起伏，BGM 铺底则比较平 */
  let hasVoice = null;
  let volStd = null;
  if (rms.length >= 4) {
    const use = rms.filter((v) => v > -60);
    if (use.length >= 4) {
      const mean = use.reduce((a, b) => a + b, 0) / use.length;
      volStd = +Math.sqrt(use.reduce((a, b) => a + (b - mean) ** 2, 0) / use.length).toFixed(2);
      /* 判据：波动明显（标准差大）+ 有音符级的静默间隙 → 有口播；否则视为 BGM 铺底 */
      hasVoice = volStd > 6.5 || silences.length >= 2;
    }
  }

  /* 节奏：切点间隔 */
  const gaps = [];
  for (let i = 1; i < cuts.length; i++) gaps.push(+(cuts[i] - cuts[i - 1]).toFixed(2));
  const avgGap = gaps.length ? +(gaps.reduce((a, b) => a + b, 0) / gaps.length).toFixed(2) : null;
  const firstCut = cuts.length ? cuts[0] : null;

  return {
    ok: true,
    awemeId: id,
    durationSec: dur,
    cuts,
    cutCount: cuts.length,
    avgShotSec: avgGap,
    firstCutAt: firstCut,
    shotsPerTenSec: dur ? +((cuts.length / dur) * 10).toFixed(2) : null,
    silences,
    volStd,
    hasVoice,
    rmsCurve: rms.slice(0, 200),
    avgMotion,
    camera,
    cameraError,
    computedAt: new Date().toISOString()
  };
}

/* ------------------------------------------------- 把指标翻成爆款因素 */

const DIMS = ['文案', '画面', '音乐', '运镜', '剪辑', '节奏'];

function buildFactors(info, mt) {
  const f = [];
  const desc = String(info.desc || '').replace(/\s+/g, ' ').trim();

  /* 文案：只描述能数出来的事实，不做语义猜测 */
  if (desc.length >= 8) {
    const cn = (desc.match(/[\u4e00-\u9fa5]/g) || []).length;
    const nums = (desc.match(/\d+/g) || []).length;
    f.push({
      dim: '文案', src: 'measured',
      claim: '口播/文案全文可提取，共 ' + desc.length + ' 字（中文 ' + cn + '，阿拉伯数字出现 ' + nums + ' 次）',
      evidence: desc.slice(0, 40) + (desc.length > 40 ? '…' : '')
    });
    if (info.hashtags && info.hashtags.length) {
      f.push({
        dim: '文案', src: 'measured',
        claim: '带 ' + info.hashtags.length + ' 个话题标签',
        evidence: info.hashtags.slice(0, 6).map((t) => '#' + t).join(' ')
      });
    }
  } else {
    f.push({
      dim: '文案', src: 'measured',
      claim: '没有文字文案，文案维度不构成爆款因素',
      evidence: 'desc 为空或过短 —— 这条靠画面和音乐打，不靠字'
    });
  }

  /* 音乐 */
  if (info.music && info.music.title) {
    f.push({
      dim: '音乐', src: 'measured',
      claim: 'BGM《' + info.music.title + '》' + (info.music.author ? ' · ' + info.music.author : ''),
      evidence: mt && mt.hasVoice === false
        ? '音量曲线平稳（标准差 ' + mt.volStd + ' dB），判定为纯 BGM 铺底、无口播'
        : (mt && mt.hasVoice === true ? '音量起伏明显（标准差 ' + mt.volStd + ' dB），判定有口播叠加' : '音乐信息来自视频页公开数据')
    });
  }

  /* 节奏 / 剪辑 */
  if (mt && mt.cutCount > 0) {
    f.push({
      dim: '剪辑', src: 'measured',
      claim: '全片 ' + mt.cutCount + ' 次硬切，平均每个镜头 ' + mt.avgShotSec + ' 秒',
      evidence: '切点：' + mt.cuts.slice(0, 10).join('s / ') + 's' + (mt.cuts.length > 10 ? ' …' : '')
    });
    f.push({
      dim: '节奏', src: 'measured',
      claim: '每 10 秒 ' + mt.shotsPerTenSec + ' 刀；首刀在 ' + mt.firstCutAt + ' 秒',
      evidence: mt.firstCutAt !== null && mt.firstCutAt <= 3
        ? '开场 3 秒内就换镜 —— 不留空等，直接给信息'
        : '开场停留较久，先立住画面再推进'
    });
  } else if (mt) {
    f.push({
      dim: '剪辑', src: 'measured',
      claim: '全片没有检测到硬切，是一镜到底',
      evidence: '场景变化分数始终低于阈值 —— 靠运镜和主体动作维持注意力'
    });
  }

  /* 画面：只给能算的（运动量），语义描述留空不编 */
  if (mt && mt.avgMotion !== null) {
    f.push({
      dim: '画面', src: 'measured',
      claim: '帧间平均差异 ' + mt.avgMotion + '（满分 255）',
      evidence: mt.avgMotion > 6
        ? '画面变化剧烈 —— 主体或镜头一直在快速移动'
        : '画面相对稳定 —— 靠固定机位展示细节，不是靠晃动抓眼'
    });
  }

  /* 运镜：从背景位移看机位，和主体运动分开算 */
  const cam = mt && mt.camera;
  if (cam && cam.summary && cam.summary.judged > 0) {
    const s = cam.summary;
    const bits = [];
    if (s.fixed) bits.push(s.fixed + ' 镜固定机位');
    if (s.pan) bits.push(s.pan + ' 镜摇镜');
    if (s.zoom) bits.push(s.zoom + ' 镜推拉');
    if (s.handheld) bits.push(s.handheld + ' 镜手持晃动');
    if (s.unknown) bits.push(s.unknown + ' 镜没算出来');
    f.push({
      dim: '运镜', src: 'measured',
      claim: '全片 ' + s.shotCount + ' 镜：' + bits.join(' / '),
      evidence: '按 10fps 逐帧看背景位移（只统计匹配最好的 70% 像素，主体运动已排除）'
    });

    /* 动得最明显的那一镜单独说，带方向和幅度 */
    const moving = cam.shots
      .filter((x) => x.type === 'pan' || x.type === 'zoom')
      .sort((a, b) => Math.abs(b.zoomPct || 0) + Math.abs(b.panXPct || 0) + Math.abs(b.panYPct || 0)
        - (Math.abs(a.zoomPct || 0) + Math.abs(a.panXPct || 0) + Math.abs(a.panYPct || 0)))[0];
    if (moving) {
      f.push({
        dim: '运镜', src: 'measured',
        claim: '第 ' + moving.index + ' 镜（' + moving.from + '-' + moving.to + ' 秒）' + moving.label
          + (moving.type === 'pan'
            ? '，位移 ' + Math.abs(moving.panXPct) + '%（横向）/ ' + Math.abs(moving.panYPct) + '%（纵向）画幅'
            : '，缩放 ' + (moving.zoomPct > 0 ? '+' : '') + moving.zoomPct + '%'),
        evidence: '镜头内首末帧对齐后测得，路径笔直度 ' + moving.straight + '，匹配改进 ' + (moving.gain * 100).toFixed(0) + '%'
      });
    }
  }

  /* 互动 */
  const s = info.stats || {};
  const total = (s.digg || 0) + (s.comment || 0) + (s.collect || 0) + (s.share || 0);
  f.push({
    dim: '其他', src: 'measured',
    claim: '公开互动合计 ' + total + '（赞 ' + (s.digg || 0) + ' / 评 ' + (s.comment || 0) + ' / 藏 ' + (s.collect || 0) + ' / 转 ' + (s.share || 0) + '）',
    evidence: '平台公开展示的数字，非推算。播放量和完播率平台不公开'
  });

  return f;
}

/* 没算出来的维度，明确标注缺什么 —— 不拿推断填空 */
function missingDims(factors, mt) {
  const have = new Set(factors.map((x) => x.dim));
  const out = [];
  if (!have.has('画面')) out.push('画面：需要抽帧看构图，已提供九宫格关键帧（/api/frames），语义描述要人眼或视觉模型');
  if (!have.has('运镜')) {
    const err = mt && mt.cameraError ? '（' + mt.cameraError + '）' : '';
    out.push('运镜：本次没算出来' + err + '。运镜靠逐帧比对背景位移，画面里没有稳定背景就没法拉，不猜');
  }
  /* 部分镜头算不出来的情况要如实说，不能因为整体有一条结论就把缺的盖掉 */
  const cam = mt && mt.camera;
  if (cam && cam.summary && cam.summary.unknown > 0) {
    out.push('运镜里的 ' + cam.summary.unknown + ' 个镜头没算出结论（可比帧对不足或首末帧对不上），这几镜的机位运动未知');
  }
  return out;
}

/* ---------------------------------------------------------------- 路由 */

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  const p = u.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    return res.end();
  }

  /* 界面：和服务同源，前端不用配置任何地址 */
  if (p === '/' || p === '/index.html') {
    const f = path.join(ROOT, 'index.html');
    if (!fs.existsSync(f)) return json(res, 404, { ok: false, error: 'index.html 不存在' });
    const html = fs.readFileSync(f);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': html.length });
    return res.end(html);
  }

  /* 静态资源：页面引用了 assets/echarts.min.js，不转发就会 404 然后回落到 CDN */
  if (p.startsWith('/assets/')) {
    const rel = decodeURIComponent(p.slice('/assets/'.length));
    const file = path.join(ROOT, 'assets', rel);
    const assetsRoot = path.join(ROOT, 'assets');
    /* 防目录穿越：解析后必须仍在 assets 目录内 */
    if (!path.resolve(file).startsWith(path.resolve(assetsRoot))) {
      return json(res, 403, { ok: false, error: '不允许的路径' });
    }
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
      return json(res, 404, { ok: false, error: '资源不存在：' + rel });
    }
    const ext = path.extname(file).toLowerCase();
    const mime = {
      '.js': 'application/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
      '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.ico': 'image/x-icon'
    }[ext] || 'application/octet-stream';
    const buf = fs.readFileSync(file);
    res.writeHead(200, { 'Content-Type': mime, 'Content-Length': buf.length, 'Cache-Control': 'public, max-age=600' });
    return res.end(buf);
  }

  /* 浏览器总会来要图标，给个空的就行，省得控制台一直报 404 */
  if (p === '/favicon.ico') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*' });
    return res.end();
  }

  if (p === '/api/health') {
    const cu = cacheUsage();
    return json(res, 200, {
      ok: true,
      service: 'douyin-resolver',
      version: '1.0.0',
      ffmpeg: !!FFMPEG,
      ffmpegPath: FFMPEG || null,
      browserReady: !!(browser && browser.isConnected && browser.isConnected()),
      queue: queue.length,
      running,
      maxPages: MAX_PAGES,
      cacheFiles: cu.files,
      cacheMb: cu.mb,
      uptimeSec: Math.round(process.uptime())
    });
  }

  if (p === '/api/parse') {
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: '请用 POST' });
    const raw = await readBody(req);
    let body = {};
    try { body = JSON.parse(raw || '{}'); } catch (e) { return json(res, 400, { ok: false, error: 'body 不是合法 JSON' }); }
    const urls = Array.isArray(body.urls) ? body.urls : [body.url];
    const list = urls.filter(Boolean).map((x) => String(x).trim()).filter(Boolean);
    if (!list.length) return json(res, 400, { ok: false, error: '缺少 url' });

    const results = [];
    for (const one of list.slice(0, 20)) {
      try {
        const info = await gate(() => parseUrl(one));
        log('解析成功', info.awemeId, info.durationSec + 's', info.desc.length + '字');
        results.push({ ok: true, ...info });
      } catch (e) {
        log('解析失败', one, String(e.message).slice(0, 80));
        results.push({ ok: false, link: one, error: String(e.message || e) });
      }
    }
    return json(res, 200, { ok: results.some((r) => r.ok), results });
  }

  if (p === '/api/metrics') {
    const id = u.searchParams.get('id');
    if (!id) return json(res, 400, { ok: false, error: '缺少 id' });
    try {
      const mt = await computeMetrics(id);
      return json(res, 200, mt);
    } catch (e) {
      return json(res, 200, { ok: false, error: String(e.message || e) });
    }
  }

  if (p === '/api/analysis') {
    const id = u.searchParams.get('id');
    if (!id) return json(res, 400, { ok: false, error: '缺少 id' });
    const info = cachedInfo(id);
    if (!info) return json(res, 404, { ok: false, error: '这条还没解析过，先调 /api/parse' });
    let mt = null;
    let mErr = null;
    try { mt = await computeMetrics(id); } catch (e) { mErr = String(e.message || e); }
    const factors = buildFactors(info, mt);
    const mp4Path = path.join(CACHE, id + '.mp4');
    const mp4Size = fs.existsSync(mp4Path) ? fs.statSync(mp4Path).size : 0;
    return json(res, 200, {
      ok: true,
      awemeId: id,
      desc: info.desc,
      music: info.music,
      stats: info.stats,
      video: {
        durationSec: info.durationSec,
        /* 元数据尺寸：平台标的封面/逻辑尺寸，别拿它当"能下到的画质" */
        metaWidth: info.width,
        metaHeight: info.height,
        ratio: info.ratio,
        /* 实际能下到的最优源 */
        playWidth: info.playWidth || 0,
        playHeight: info.playHeight || 0,
        playGear: info.playGear || '',
        playUrl: info.playUrl,
        download: '/api/video?id=' + id,
        downloadedBytes: mp4Size
      },
      author: info.author,
      publishTime: info.publishTime,
      hashtags: info.hashtags || [],
      metrics: mt,
      metricsError: mErr,
      factors,
      missing: missingDims(factors, mt),
      dims: DIMS
    });
  }

  if (p === '/api/video') {
    const id = u.searchParams.get('id');
    if (!id) return json(res, 400, { ok: false, error: '缺少 id' });
    try {
      const f = await ensureMp4(id, null);
      const size = fs.statSync(f).size;
      const info = cachedInfo(id) || {};
      const name = (info.desc || id).replace(/[\r\n\t/\\:*?"<>|]/g, ' ').trim().slice(0, 40) || id;
      res.writeHead(200, {
        'Content-Type': 'video/mp4',
        'Content-Length': size,
        'Content-Disposition': 'attachment; filename="' + encodeURIComponent(name) + '.mp4"',
        'Access-Control-Allow-Origin': '*'
      });
      fs.createReadStream(f).pipe(res);
    } catch (e) {
      return json(res, 500, { ok: false, error: String(e.message || e) });
    }
    return;
  }

  if (p === '/api/frames') {
    const id = u.searchParams.get('id');
    if (!id) return json(res, 400, { ok: false, error: '缺少 id' });
    if (!FFMPEG) return json(res, 500, { ok: false, error: '没找到 ffmpeg' });
    const out = path.join(CACHE, id + '-9.jpg');
    try {
      if (!fs.existsSync(out)) {
        const mp4 = await ensureMp4(id, null);
        const info = cachedInfo(id) || {};
        /* 均匀取 9 帧拼成 3x3，间隔按时长算，避免短片只抽到 2 张 */
        const every = Math.max(1, Math.round((info.durationSec || 30) / 9));
        const r = await run(FFMPEG, [
          '-hide_banner', '-y', '-i', mp4,
          '-vf', 'fps=1/' + every + ',scale=360:-1,tile=3x3',
          '-frames:v', '1', '-q:v', '3', out
        ]);
        if (!fs.existsSync(out)) throw new Error('抽帧失败：' + r.stderr.slice(-120));
      }
      const buf = fs.readFileSync(out);
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': buf.length, 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=3600' });
      return res.end(buf);
    } catch (e) {
      return json(res, 500, { ok: false, error: String(e.message || e) });
    }
  }

  json(res, 404, { ok: false, error: '没有这个接口：' + p });
});

server.listen(PORT, HOST, () => {
  log('解析服务已启动  http://' + (HOST === '0.0.0.0' ? '127.0.0.1' : HOST) + ':' + PORT + '/');
  log('ffmpeg: ' + (FFMPEG || '未找到（视频仍可解析，指标算不了）'));
  log('并发页数 ' + MAX_PAGES + '   缓存保留 ' + CACHE_TTL_DAYS + ' 天');
  sweepCache();
  setInterval(sweepCache, 6 * 3600 * 1000).unref();
  log('等待请求…');
});

process.on('SIGINT', async () => {
  log('正在退出…');
  if (browser) await browser.close().catch(() => {});
  process.exit(0);
});
