/* ---------------------------------------------------------------
 * 视频里的文案：画面烧录字幕（OCR） + 口播（ASR）
 *
 * 抖音接口给的 desc 是作者写的「标题/描述」，不是视频里说的话。
 * 之前把它当成「口播全文」是错的 —— 这个模块补上真正的内容提取。
 *
 * 分工：
 *   Python（text/extract.py）只做「媒体 -> 文字框」，不判断语义；
 *   本文件做全部业务判断，纯函数、可用假数据离线断言。
 * --------------------------------------------------------------- */

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BAND_BIN = 0.02;      /* 字幕带聚类粒度：画面高度的 2% */
const MIN_TEXT_H = 0.022;   /* 字高小于画面高度 2.2% 的，当界面小字，不算字幕 */
const MIN_CONF = 0.5;
const BAND_SUPPORT = 0.30;  /* 字幕带至少覆盖 30% 的帧，否则判「没有字幕」 */
const BAND_GROW = 0.30;     /* 向两侧扩展时，这一格票数要达到峰值的 30% */
const MERGE_GAP = 2.2;      /* 相邻两帧字幕间隔不超过 2.2 秒才当作同一句 */
const MAX_FRAMES = 180;     /* 长视频最多抽 180 帧（3 分钟 @1fps） */
const MAX_ASR_SEC = 180;    /* 口播最多转写前 3 分钟 */

/* ------------------------------------------------------------ 字幕带 */

/* 字幕有个别的特征：在同一条水平带上反复出现。手机屏幕里的界面字、
   水印、贴纸文字位置各不相同，聚不到一条带上 —— 靠这个把它们分开。
   返回 null 表示这一片里根本没有稳定的文字带。 */
function detectBand(items) {
  if (!Array.isArray(items) || !items.length) return null;
  const votes = new Map();
  for (const it of items) {
    const seen = new Set();
    for (const b of (it.boxes || [])) {
      if (!b || b.h < MIN_TEXT_H || b.conf < MIN_CONF) continue;
      if (!isFinite(b.cy) || b.cy < 0 || b.cy > 1) continue;
      const bin = Math.round(b.cy / BAND_BIN);
      if (seen.has(bin)) continue;   /* 同一帧同一格只投一票，防止一行多块刷票 */
      seen.add(bin);
      votes.set(bin, (votes.get(bin) || 0) + 1);
    }
  }
  if (!votes.size) return null;

  let peakBin = null;
  let peak = 0;
  for (const [bin, v] of votes) {
    if (v > peak || (v === peak && bin < peakBin)) { peak = v; peakBin = bin; }
  }
  if (!peak) return null;

  const floor = peak * BAND_GROW;
  let lo = peakBin;
  let hi = peakBin;
  while (votes.get(lo - 1) >= floor) lo--;
  while (votes.get(hi + 1) >= floor) hi++;

  return {
    lo: Math.max(0, (lo - 0.5) * BAND_BIN),
    hi: Math.min(1, (hi + 0.5) * BAND_BIN),
    peakFrames: peak,
    support: peak / items.length,
    frameCount: items.length
  };
}

/* 取字幕带内的高置信大字。同一帧里的多块（两行字幕）按 y 拼成一句。 */
function pickRawLines(items, band) {
  const out = [];
  for (const it of items) {
    const hit = (it.boxes || []).filter((b) =>
      b && b.h >= MIN_TEXT_H && b.conf >= MIN_CONF &&
      b.cy >= band.lo && b.cy <= band.hi);
    if (!hit.length) continue;
    hit.sort((a, b) => a.cy - b.cy);
    out.push({
      t: it.t,
      text: hit.map((b) => b.text).join(''),
      conf: hit.reduce((s, b) => s + b.conf, 0) / hit.length
    });
  }
  return out;
}

/* 相邻帧的同一句字幕要合并 —— 一句停 2 秒会抽出 2~3 帧 */
function mergeLines(raw) {
  const out = [];
  for (const r of raw) {
    const last = out[out.length - 1];
    if (last && r.t - last.t1 <= MERGE_GAP && similar(last.text, r.text)) {
      last.t1 = r.t;
      last.frames++;
      if (r.conf > last.conf) { last.text = r.text; last.conf = r.conf; }
      continue;
    }
    out.push({ t0: r.t, t1: r.t, text: r.text, conf: r.conf, frames: 1 });
  }
  return out;
}

/* OCR 每帧的结果会有抖动（多个空格、错一个字），不能只比严格相等。
   但短句要更严：「第1步」和「第2步」差一个字却是两句不同的话，
   拿长句的比例阈值去判会误合并。 */
function similar(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.length > 1 && b.length > 1 && (a.includes(b) || b.includes(a))) return true;
  const d = editDistance(a, b);
  const maxLen = Math.max(a.length, b.length);
  const allow = maxLen <= 6 ? 1 : Math.max(2, Math.floor(maxLen * 0.34));
  return d <= allow;
}

function editDistance(a, b) {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = new Array(n + 1);
  let cur = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    const tmp = prev; prev = cur; cur = tmp;
  }
  return prev[n];
}

/* ---------------------------------------------------------------- 口播 */

/* whisper 在纯音乐/静音段会脑补出固定句子，这些不是人说的话 */
const HALLUCINATION = [
  /^(请不吝|请大家|记得)?(点赞|订阅|转发|打赏)/,
  /字幕(由|by).{0,20}(提供|社区|制作)/i,
  /^(谢谢|感谢)(大家|您的|您)?(观看|收看|收听)/,
  /^(优优|明镜|点点)/,
  /^(音乐|纯音乐|背景音乐)$/,
  /^\[?(music|applause|laughter|silence)\]?$/i,
  /^(字幕|subtitle)/i
];

function cleanVoice(segs) {
  const kept = [];
  let dropped = 0;
  for (const s of (segs || [])) {
    const text = String(s.text || '').trim();
    if (!text) { dropped++; continue; }
    /* 静音段被脑补成文字：noSpeech 高且文本短，直接丢 */
    if (s.noSpeech > 0.6 && text.length <= 20) { dropped++; continue; }
    if (text.length <= 30 && HALLUCINATION.some((re) => re.test(text))) { dropped++; continue; }
    kept.push({ t0: s.t0, t1: s.t1, text, logprob: s.logprob, noSpeech: s.noSpeech });
  }
  return { kept, dropped };
}

/* ---------------------------------------------------------------- 汇总 */

const cnLen = (s) => (String(s).match(/[\u4e00-\u9fa5]/g) || []).length;
const stripPunct = (s) => String(s).replace(/[\s，。！？、,.!?；;：:"'「」『』（）()…—\-]/g, '');

/* 字幕和口播的用字重合度：高 = 字幕就是口播的逐字稿；
   低 = 字幕只是提炼的关键词。运营上这是两条不同的做法。 */
function overlapRatio(a, b) {
  const sa = new Set(stripPunct(a).split(''));
  const sb = new Set(stripPunct(b).split(''));
  if (!sa.size || !sb.size) return null;
  let hit = 0;
  for (const c of sa) if (sb.has(c)) hit++;
  return hit / Math.max(sa.size, sb.size);
}

function buildScript(ocr, asr, ctx) {
  const dur = (ctx && ctx.duration) || 0;
  const notes = [];

  /* --- 字幕 --- */
  let subtitle = null;
  const band = ocr && ocr.ok ? detectBand(ocr.items) : null;
  if (band && band.support >= BAND_SUPPORT) {
    const lines = mergeLines(pickRawLines(ocr.items, band));
    const text = lines.map((l) => l.text).join('，');
    const chars = cnLen(text);
    if (lines.length >= 2 && chars >= 8) {
      subtitle = {
        lines,
        text,
        chars,
        band: { lo: round3(band.lo), hi: round3(band.hi), support: round3(band.support) },
        frames: ocr.frames,
        ocrSeconds: ocr.seconds
      };
    } else {
      notes.push('画面里有条稳定的文字带，但成句的字太少（' + chars + ' 字），没当成字幕');
    }
  } else if (ocr && ocr.ok) {
    notes.push('画面里没有位置固定的文字带（' +
      (band ? Math.round(band.support * 100) + '% 的帧有稳定文字' : '一帧都没找到') +
      '），这条应该没有烧录字幕');
  }

  /* --- 口播 --- */
  let voice = null;
  if (asr && asr.ok) {
    const { kept, dropped } = cleanVoice(asr.segments);
    const text = kept.map((s) => s.text).join('');
    const chars = cnLen(text);
    if (kept.length && chars >= 6) {
      voice = {
        segments: kept,
        text,
        chars,
        duration: asr.duration,
        asrSeconds: asr.seconds,
        dropped
      };
      if (asr.duration > MAX_ASR_SEC + 1) {
        notes.push('口播只转了前 ' + MAX_ASR_SEC + ' 秒（全片 ' + Math.round(asr.duration) + ' 秒），后面没转');
      }
    } else if (dropped) {
      notes.push('音轨里没有人声（丢了 ' + dropped + ' 段模型脑补出来的假句子），这条是纯 BGM 视频');
    }
  }

  /* --- 主文案 --- */
  let source = 'none';
  let text = '';
  if (subtitle && voice) {
    source = 'both';
    text = subtitle.text;   /* 字幕是作者亲手打的字，比语音识别准，优先用 */
  } else if (subtitle) {
    source = 'subtitle';
    text = subtitle.text;
  } else if (voice) {
    source = 'voice';
    text = voice.text;
  }

  /* 字幕是不是口播的逐字稿 */
  let match = null;
  if (subtitle && voice) {
    const r = overlapRatio(subtitle.text, voice.text);
    if (r !== null) match = round3(r);
  }

  return {
    ok: source !== 'none',
    source,
    text,
    chars: cnLen(text),
    subtitle,
    voice,
    match,
    duration: dur,
    notes
  };
}

function round3(n) { return Math.round(n * 1000) / 1000; }

/* ============================================================ 编排层
 * 下面这些要调 ffmpeg 和 python，不属于纯逻辑，用真实媒体验证。
 * ============================================================ */

function runBin(bin, args, timeout) {
  return new Promise((resolve) => {
    execFile(bin, args, {
      maxBuffer: 64 * 1024 * 1024,
      timeout,
      encoding: 'utf8',
      env: Object.assign({}, process.env, {
        PYTHONIOENCODING: 'utf-8',
        OMP_NUM_THREADS: process.env.OCR_THREADS || '1',
        HF_ENDPOINT: process.env.HF_ENDPOINT || 'https://hf-mirror.com',
        HF_HUB_DISABLE_XET: '1'
      })
    }, (err, stdout, stderr) => {
      resolve({ err, stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

let pyCache;
/* python 解释器候选：先环境变量，再项目内 venv，最后系统命令。
   Windows 上 'python' 可能是应用商店占位符，所以 python3 放后面。 */
async function pickPython() {
  if (pyCache !== undefined) return pyCache;
  const isWin = process.platform === 'win32';
  const venv = isWin
    ? path.join(__dirname, 'text', '.venv', 'Scripts', 'python.exe')
    : path.join(__dirname, 'text', '.venv', 'bin', 'python');
  const cands = [process.env.PYTHON_BIN, venv,
    isWin ? 'python' : 'python3',
    isWin ? 'python3' : 'python'].filter(Boolean);

  for (const c of cands) {
    const r = await runBin(c, ['--version'], 8000);
    if (!r.err && /python/i.test(r.stdout + r.stderr)) { pyCache = c; return c; }
  }
  pyCache = null;
  return null;
}

/* 引擎是否就绪。没装依赖时不能崩，要能如实说「没装」。 */
async function probeEngines() {
  const py = await pickPython();
  if (!py) return { python: null, ocr: false, asr: false, reason: '本机没找到 python' };
  const script = path.join(__dirname, 'text', 'extract.py');
  const r = await runBin(py, [script, 'probe'], 120000);
  try {
    const j = JSON.parse(r.stdout.trim().split('\n').pop());
    return { python: py, ocr: !!j.ocr, asr: !!j.asr, reason: j.ocr_error || j.asr_error || null };
  } catch (e) {
    return { python: py, ocr: false, asr: false, reason: (r.stderr || r.err || '引擎探测失败').slice(0, 160) };
  }
}

async function readJson(file) {
  try { return JSON.parse(await fs.promises.readFile(file, 'utf8')); }
  catch (e) { return null; }
}

/* 主入口：从 mp4 里抠出「视频里的文案」。
   任何一个引擎失败都不影响另一个 —— 字幕挂了还能出口播，反之亦然。 */
async function analyzeScript(ffmpeg, mp4, ctx) {
  const opt = ctx || {};
  const started = Date.now();
  const info = { ok: false, subtitle: null, voice: null, source: 'none', text: '', chars: 0, notes: [] };

  const py = await pickPython();
  if (!py) {
    info.error = '本机没找到 python，视频里的文案提不了';
    return info;
  }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 've-script-'));
  const framesDir = path.join(work, 'frames');
  fs.mkdirSync(framesDir, { recursive: true });
  const wav = path.join(work, 'a.wav');
  const ocrOut = path.join(work, 'ocr.json');
  const asrOut = path.join(work, 'asr.json');
  const script = path.join(__dirname, 'text', 'extract.py');

  try {
    /* 抽帧：1fps，统一缩到宽 720。全分辨率 OCR 更准但慢 3 倍，
       720 宽下字幕字高仍有 40+ 像素，够认。 */
    const extractFrames = runBin(ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-i', mp4,
      '-vf', 'fps=1,scale=720:-2',
      '-frames:v', String(MAX_FRAMES),
      '-y', path.join(framesDir, '%d.png')
    ], 180000);

    /* 抽音频：16k 单声道 PCM，ASR 只认这个格式（也省掉模型内部的解码） */
    const extractAudio = runBin(ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-i', mp4,
      '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le',
      '-t', String(MAX_ASR_SEC),
      '-y', wav
    ], 120000);

    const [, au] = await Promise.all([extractFrames, extractAudio]);

    let ocr = null;
    let asr = null;
    let ocrErr = null;
    let asrErr = null;

    /* OCR 与 ASR 并发。2 核机器上两个进程各占 1 线程，
       总时长接近两者较慢的那个，而不是相加。 */
    const jobs = [];

    jobs.push(runBin(py, [script, 'ocr', '--frames', framesDir, '--out', ocrOut], 300000)
      .then(async (r) => {
        ocr = await readJson(ocrOut);
        if (!ocr && r.err) ocrErr = shortErr(r);
      }));

    if (au.err) {
      asrErr = '抽音频失败：' + shortErr(au);
    } else {
      const model = process.env.WHISPER_MODEL || 'base';
      jobs.push(runBin(py, [script, 'asr', '--audio', wav, '--out', asrOut, '--model', model], 420000)
        .then(async (r) => {
          asr = await readJson(asrOut);
          if (!asr && r.err) asrErr = shortErr(r);
        }));
    }

    await Promise.all(jobs);

    const built = buildScript(ocr, asr, { duration: opt.duration || 0 });
    Object.assign(info, built);
    info.ok = built.ok;
    info.secs = Math.round((Date.now() - started) / 1000);
    info.frames = ocr ? ocr.frames : 0;
    if (ocr && ocr.width) {
      info.frameW = ocr.width;
      info.frameH = ocr.height;
    }
    if (ocrErr) {
      info.ocrError = ocrErr;
      info.notes.push('画面字幕没提出来：' + ocrErr);
    }
    if (asrErr) {
      info.asrError = asrErr;
      info.notes.push('口播没转出来：' + asrErr);
    }
    return info;
  } finally {
    try { fs.rmSync(work, { recursive: true, force: true }); } catch (e) { /* 临时目录清不掉不影响结果 */ }
  }
}

function shortErr(r) {
  const s = (r.stderr || (r.err && r.err.message) || '').replace(/\s+/g, ' ').trim();
  const lines = s.split('|').pop().trim();
  return (lines || s || '未知错误').slice(-160);
}

module.exports = {
  detectBand,
  pickRawLines,
  mergeLines,
  similar,
  editDistance,
  cleanVoice,
  overlapRatio,
  buildScript,
  analyzeScript,
  probeEngines,
  pickPython,
  MAX_FRAMES,
  MAX_ASR_SEC,
  MIN_TEXT_H,
  BAND_SUPPORT
};
