/* 运镜分析：从视频本身算机位怎么动，不靠人眼读帧。
 *
 * 做法：按 10fps 把视频拆成 108×192 灰度帧，相邻帧做「三级金字塔 + 亚像素」的
 * 平移搜索得到每帧位移；镜头首末帧再对齐后估一次累计缩放。两组序列分四类机位：
 *
 *   固定机位   背景没动
 *   摇镜/横移   净位移显著、路径笔直
 *   推 / 拉     累计缩放超过 6%
 *   手持晃动   背景一直在小幅乱动，净位移却接近 0
 *
 * 代价函数用「截尾均值」（只统计匹配最好的 40% 像素），这是整个模块的关键。
 * 原因：真实素材几乎都是「机位不动、主体在动」（手在转手机、人在比划），
 * 逐像素平均差会被主体运动主导 —— 实测同一条静物展示视频，相邻帧整帧平均差
 * 就有 6.35，镜头首末帧能到 36~61，直接把「机位没动」算成「在晃」。
 * 换成截尾均值后同一批帧对降到 0.0~2.5，背景是否对齐一眼就能看出来。
 * 截顶均值（超过上限按上限算）也不行：大位移时代代会饱和，代价曲线变单调，找不到极小值。
 *
 * 其余几条约束都是踩过的坑：
 *   · 必须亚像素。慢摇每帧只有 0.2~0.3px，整数搜索会全判 0，累计位移直接丢光。
 *   · 缩放在镜头内首末帧直接比一次，绝不逐帧连乘（每帧 0.5% 偏差 × 60 帧 = 35%）。
 *   · 估缩放前必须先把已累计平移对齐，否则平移会被误读成拉镜（实测 -28% 假缩放）。
 *   · 搜索只比重叠区域并留最小重叠比例。早期版本「有一点越界就丢掉整个偏移」，
 *     结果 margin 成了位移上限，19.5px 的快摇永远搜不到。
 *   · 分析分辨率必须能被 4 整除。96×170 的 170 除不尽，四分之一帧下标整体错位，
 *     粗搜索变成比乱码，净位移从 17px 掉到 2px。
 *   · 匹配不上就说匹配不上（type=unknown），不硬给结论。
 */

const { execFile } = require('child_process');

const FPS = 10;
const W = 108, H = 192;
const W2 = 54, H2 = 96;
const W4 = 27, H4 = 48;
const STEP = 2;
const TRIM = 0.7;            /* 只统计匹配最好的 70% 像素 */
const BIN = 4;               /* 直方图分箱宽度（灰阶） */
const NBINS = 64;
const MARGIN = 6;
const MIN_OVERLAP = 0.45;    /* 重叠面积至少要这么多才参与比较 */
const MAX_FRAME_SHIFT = 0.05;/* 相邻帧位移可信上限（相对画幅），超过认为这一对不可比 */
const MIN_PAIRS = 4;

function grabFrames(ffmpeg, mp4) {
  return new Promise((resolve, reject) => {
    execFile(
      ffmpeg,
      ['-hide_banner', '-loglevel', 'error', '-i', mp4,
        '-vf', `fps=${FPS},scale=${W}:${H},format=gray`,
        '-f', 'rawvideo', '-'],
      { encoding: 'buffer', maxBuffer: 512 * 1024 * 1024, timeout: 180000 },
      (err, stdout) => {
        if (err) return reject(new Error('抽帧失败：' + String(err.message || err)));
        resolve(stdout);
      }
    );
  });
}

function downscale(f, factor) {
  if (W % factor || H % factor) throw new Error('分析分辨率无法被 ' + factor + ' 整除');
  const ow = W / factor, oh = H / factor;
  const out = new Uint8Array(ow * oh);
  const n = factor * factor;
  for (let y = 0; y < oh; y++) {
    for (let x = 0; x < ow; x++) {
      let s = 0;
      for (let j = 0; j < factor; j++) {
        const row = (y * factor + j) * W + x * factor;
        for (let i = 0; i < factor; i++) s += f[row + i];
      }
      out[y * ow + x] = s / n;
    }
  }
  return out;
}

/* 单点代价：截尾均值。用直方图求 40% 分位，避免排序。 */
function costOne(prev, cur, w, h, dx, dy) {
  const hist = new Int32Array(NBINS);
  let n = 0;
  for (let y = MARGIN; y < h - MARGIN; y += STEP) {
    const yy = y + dy;
    if (yy < 0 || yy >= h) continue;
    const rp = y * w, rc = yy * w;
    for (let x = MARGIN; x < w - MARGIN; x += STEP) {
      const xx = x + dx;
      if (xx < 0 || xx >= w) continue;
      let d = prev[rp + x] - cur[rc + xx];
      if (d < 0) d = -d;
      hist[d >> 2]++;
      n++;
    }
  }
  if (n < 80) return Infinity;
  const keep = Math.max(1, Math.floor(n * TRIM));
  let seen = 0, sum = 0;
  for (let b = 0; b < NBINS; b++) {
    const c = hist[b];
    if (!c) continue;
    if (seen + c >= keep) {
      /* 这一箱只取一部分：按箱内线性估计补足 */
      const need = keep - seen;
      sum += (need / c) * c * (b * BIN + BIN / 2);
      seen = keep;
      break;
    }
    sum += c * (b * BIN + BIN / 2);
    seen += c;
  }
  return sum / keep;
}

/* 平移搜索：返回整数最优 + 抛物线插值出的亚像素位移。
   位移越大两帧重叠越少，只比重叠区，并要求重叠面积不低于中心的 45%。 */
function searchShift(prev, cur, w, h, range, cx, cy) {
  const size = 2 * range + 1;
  const costs = new Float64Array(size * size).fill(Infinity);
  let bestDx = 0, bestDy = 0, bestCost = Infinity;
  const areaFull = Math.max(1, (w - 2 * MARGIN) * (h - 2 * MARGIN));

  for (let dyi = 0; dyi < size; dyi++) {
    const dy = cy - range + dyi;
    for (let dxi = 0; dxi < size; dxi++) {
      const dx = cx - range + dxi;
      const ow = Math.min(w - MARGIN, w - MARGIN - dx) - Math.max(MARGIN, MARGIN - dx);
      const oh = Math.min(h - MARGIN, h - MARGIN - dy) - Math.max(MARGIN, MARGIN - dy);
      if (ow < 12 || oh < 12) continue;
      if (ow * oh < areaFull * MIN_OVERLAP) continue;
      const c = costOne(prev, cur, w, h, dx, dy);
      if (!isFinite(c)) continue;
      costs[dyi * size + dxi] = c;
      if (c < bestCost) { bestCost = c; bestDx = dx; bestDy = dy; }
    }
  }
  if (!isFinite(bestCost)) return { dx: 0, dy: 0, cost: Infinity };

  const get = (dxi, dyi) => (dxi < 0 || dxi >= size || dyi < 0 || dyi >= size)
    ? Infinity : costs[dyi * size + dxi];
  const bi = bestDx - (cx - range), bj = bestDy - (cy - range);
  const para = (c0, cm, cp) => {
    const den = cm - 2 * c0 + cp;
    if (!isFinite(den) || Math.abs(den) < 1e-6) return 0;
    const d = 0.5 * (cm - cp) / den;
    return Math.abs(d) <= 0.5 ? d : 0;
  };
  const sx = para(get(bi, bj), get(bi - 1, bj), get(bi + 1, bj));
  const sy = para(get(bi, bj), get(bi, bj - 1), get(bi, bj + 1));
  return { dx: bestDx + sx, dy: bestDy + sy, cost: bestCost };
}

/* 相邻帧位移：半分辨率粗搜（覆盖 ±6px 全分辨）→ 全分辨率精修到亚像素 */
function frameShift(fa, ha, fb, hb) {
  const m = searchShift(ha, hb, W2, H2, 3, 0, 0);
  if (!isFinite(m.cost)) return null;
  const f = searchShift(fa, fb, W, H, 2, Math.round(m.dx * 2), Math.round(m.dy * 2));
  return isFinite(f.cost) ? f : null;
}

/* 镜头级净位移：首末帧之间全局搜索。四分分辨率 ±20 → 全分辨率 ±80（约 74% 画幅） */
function netShift(fa, ha, qa, fb, hb, qb) {
  const c = searchShift(qa, qb, W4, H4, 20, 0, 0);
  if (!isFinite(c.cost)) return null;
  const m = searchShift(ha, hb, W2, H2, 4, Math.round(c.dx * 2), Math.round(c.dy * 2));
  if (!isFinite(m.cost)) return null;
  const f = searchShift(fa, fb, W, H, 3, Math.round(m.dx * 2), Math.round(m.dy * 2));
  return isFinite(f.cost) ? f : null;
}

/* 镜头级累计缩放：按已算出的净平移对齐后，找最贴合的缩放比。
   s > 1 = 画面被放大（推镜），s < 1 = 缩小（拉镜）。 */
function zoomDirect(prev, cur, alignX, alignY) {
  const cx = W / 2, cy = H / 2;
  const hw = W * 0.24, hh = H * 0.24;
  let bestS = 1, bestCost = Infinity;
  for (let s = 0.70; s <= 1.5001; s += 0.02) {
    const hist = new Int32Array(NBINS);
    let n = 0, sp = 0, sc = 0;
    const pairs = [];
    for (let y = -hh; y < hh; y += 2) {
      for (let x = -hw; x < hw; x += 2) {
        /* 推镜时 cur(x) = prev(cx + x/s) */
        const px = cx + x / s - alignX;
        const py = cy + y / s - alignY;
        if (px < 1 || px >= W - 2 || py < 1 || py >= H - 2) continue;
        const x0 = Math.floor(px), y0 = Math.floor(py);
        const fx = px - x0, fy = py - y0;
        const a = prev[y0 * W + x0] * (1 - fx) * (1 - fy) + prev[y0 * W + x0 + 1] * fx * (1 - fy)
          + prev[(y0 + 1) * W + x0] * (1 - fx) * fy + prev[(y0 + 1) * W + x0 + 1] * fx * fy;
        const b = cur[Math.floor(cy + y) * W + Math.floor(cx + x)];
        pairs.push([a, b, y0 * W + x0]);
        sp += a; sc += b;
        n++;
      }
    }
    if (n < 150) continue;
    /* 两帧整体亮度差先扣掉，再算截尾均值 */
    const ma = sp / n, mb = sc / n;
    for (const [a, b] of pairs) {
      let d = (a - ma) - (b - mb);
      if (d < 0) d = -d;
      hist[Math.min(NBINS - 1, d >> 2)]++;
    }
    const keep = Math.max(1, Math.floor(n * TRIM));
    let seen = 0, sum = 0;
    for (let b = 0; b < NBINS; b++) {
      const c = hist[b];
      if (!c) continue;
      if (seen + c >= keep) {
        sum += ((keep - seen) / c) * c * (b * BIN + BIN / 2);
        break;
      }
      sum += c * (b * BIN + BIN / 2);
      seen += c;
    }
    const cost = sum / keep;
    if (cost < bestCost) { bestCost = cost; bestS = +s.toFixed(2); }
  }
  return { s: bestS, cost: bestCost };
}

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const std = (a) => {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length);
};
const r2 = (v) => +v.toFixed(2);

function classifyShot(seg, ctx) {
  const { net, transCost, zoomPct, zoomCost, baseCost } = ctx;
  const n = seg.length;
  if (n < MIN_PAIRS) {
    return { type: 'unknown', label: '素材不足', n, note: '可比帧对只有 ' + n + ' 个' };
  }
  if (!net || !isFinite(transCost)) {
    return { type: 'unknown', label: '对不上', n, note: '镜头首末帧怎么对都对不上，位移不下结论' };
  }

  /* 相对改进：加了这个运动模型后，背景比「完全不动」解释得好多少。
     不用绝对代价判断可信度 —— 画面纹理越细绝对代价天然越高。 */
  const gainOf = (c) => (baseCost > 0.3 && isFinite(c) ? Math.max(0, 1 - c / baseCost) : 0);
  const panGain = gainOf(transCost);
  const zoomGain = gainOf(zoomCost);

  const dx = seg.map((r) => r.dx), dy = seg.map((r) => r.dy);
  const absSum = dx.map(Math.abs).reduce((a, b) => a + b, 0) + dy.map(Math.abs).reduce((a, b) => a + b, 0);
  const meanAbs = absSum / (2 * n);
  const panXPct = r2(net.dx / W * 100);
  const panYPct = r2(net.dy / H * 100);
  const netPx = Math.sqrt(net.dx ** 2 + net.dy ** 2);
  const straight = absSum > 0.01 ? Math.min(1, netPx / (absSum / 2)) : 0;

  const base = {
    n,
    panXPct, panYPct,
    meanAbs: r2(meanAbs),
    straight: r2(straight),
    zoomPct: zoomPct === null ? null : zoomPct,
    panGain: r2(panGain),
    zoomGain: r2(zoomGain),
    gain: r2(Math.max(panGain, zoomGain)),
    cost: r2(Math.min(transCost, isFinite(zoomCost) ? zoomCost : Infinity)),
    baseCost: r2(baseCost)
  };

  /* ① 摇镜优先于推拉：摇镜会带来大而笔直的净位移，推拉不会。
     反过来，推拉偶尔会造出一点假位移，所以不能先判推拉。 */
  const bigEnough = Math.abs(panXPct) >= 3 || Math.abs(panYPct) >= 3;
  if (bigEnough && straight >= 0.55 && panGain >= 0.5) {
    const horiz = Math.abs(panXPct) >= Math.abs(panYPct);
    return Object.assign({}, base, {
      type: 'pan',
      label: horiz
        ? (panXPct > 0 ? '横向摇镜（镜头左摇）' : '横向摇镜（镜头右摇）')
        : (panYPct > 0 ? '纵向摇镜（镜头上摇）' : '纵向摇镜（镜头下摇）'),
      confidence: r2(Math.min(1, straight))
    });
  }

  /* ② 推拉：累计缩放超过 6%，且加上缩放后差异明显变小 */
  if (zoomPct !== null && Math.abs(zoomPct) >= 6 && zoomGain >= 0.35) {
    return Object.assign({}, base, {
      type: 'zoom',
      label: zoomPct > 0 ? '推镜（画面放大）' : '拉镜（画面缩小）',
      confidence: r2(Math.min(1, Math.abs(zoomPct) / 20))
    });
  }

  /* ③ 手持晃动：背景每帧都在动，但净位移小、路径不直
     —— 这是「来回晃」和「一路摇过去」的区别。 */
  if (meanAbs >= 0.4 && straight < 0.55) {
    return Object.assign({}, base, {
      type: 'handheld', label: '手持晃动',
      confidence: r2(Math.min(1, meanAbs / 1.5))
    });
  }

  /* ④ 其余：机位没动。主体在动不会被算成机位运动（截尾均值已把主体排除）。 */
  return Object.assign({}, base, {
    type: 'fixed', label: '固定机位',
    confidence: r2(Math.min(1, 1 / (1 + meanAbs)))
  });
}

async function analyzeCamera(ffmpeg, mp4, cuts, dur) {
  const raw = await grabFrames(ffmpeg, mp4);
  const fs_ = W * H;
  const n = Math.floor(raw.length / fs_);
  if (n < 4) throw new Error('抽到的帧太少，运镜算不了');

  const cutFrames = new Set();
  for (const c of cuts || []) {
    const idx = Math.round(c * FPS);
    cutFrames.add(idx - 1); cutFrames.add(idx); cutFrames.add(idx + 1);
  }

  const F = [], HF = [], QF = [];
  for (let i = 0; i < n; i++) {
    const f = raw.subarray(i * fs_, (i + 1) * fs_);
    F.push(f);
    HF.push(downscale(f, 2));
    QF.push(downscale(f, 4));
  }

  const rows = [];
  let droppedCut = 0, droppedCost = 0;
  for (let i = 0; i + 1 < n; i++) {
    if (cutFrames.has(i)) { droppedCut++; continue; }
    const sp = frameShift(F[i], HF[i], F[i + 1], HF[i + 1]);
    if (!sp) { droppedCost++; continue; }
    /* 单帧位移超过 5% 画幅，基本是遮挡/闪白，不是机位在动 */
    if (Math.abs(sp.dx) > W * MAX_FRAME_SHIFT || Math.abs(sp.dy) > H * MAX_FRAME_SHIFT) {
      droppedCost++; continue;
    }
    rows.push({ t: r2(i / FPS), fi: i, dx: sp.dx, dy: sp.dy, cost: sp.cost });
  }

  const totalDur = dur || r2(n / FPS);
  const bounds = [0].concat((cuts || []).slice(), [totalDur]);
  const shots = [];

  for (let k = 0; k + 1 < bounds.length; k++) {
    const lo = bounds[k], hi = bounds[k + 1];
    const seg = rows.filter((r) => r.t >= lo && r.t < hi);

    let net = null, zoomPct = null;
    let baseCost = Infinity, transCost = Infinity, zoomCost = Infinity;
    if (seg.length >= MIN_PAIRS) {
      const a = seg[0].fi, b = seg[seg.length - 1].fi + 1;

      /* 三个模型都算一遍，各自的代价单独留下 —— 判定要看「谁解释得好」，
         不能只留一个最好值，否则分不清是摇镜还是推拉。 */
      baseCost = searchShift(F[a], F[b], W, H, 0, 0, 0).cost;
      const n1 = netShift(F[a], HF[a], QF[a], F[b], HF[b], QF[b]);
      const z0 = zoomDirect(F[a], F[b], 0, 0);
      const z1 = n1 ? zoomDirect(F[a], F[b], n1.dx, n1.dy) : null;

      net = n1 || { dx: 0, dy: 0 };
      transCost = n1 ? n1.cost : Infinity;

      /* 缩放优先用「已按平移对齐」那一版：对齐之后仍要缩放，才是真的推拉。
         没对齐就估缩放，平移会被读成拉镜（实测能造出 -28% 的假拉镜）。 */
      const z = (z1 && z1.cost <= z0.cost) ? z1 : z0;
      zoomCost = z.cost;
      zoomPct = +(((z.s - 1) * 100).toFixed(1));
    }

    shots.push(Object.assign(
      { index: k + 1, from: r2(lo), to: r2(hi), sec: r2(hi - lo) },
      classifyShot(seg, { net, transCost, zoomPct, zoomCost, baseCost })
    ));
  }

  const count = (t) => shots.filter((s) => s.type === t).length;
  const judged = shots.filter((s) => s.type !== 'unknown');
  let mainType = 'unknown';
  if (judged.length) {
    const tally = { fixed: 0, pan: 0, zoom: 0, handheld: 0 };
    judged.forEach((s) => { if (tally[s.type] !== undefined) tally[s.type]++; });
    mainType = Object.keys(tally).sort((a, b) => tally[b] - tally[a])[0];
  }

  return {
    ok: true,
    fps: FPS,
    frames: n,
    pairsUsed: rows.length,
    droppedCut,
    droppedCost,
    shots,
    summary: {
      shotCount: shots.length,
      judged: judged.length,
      fixed: count('fixed'), pan: count('pan'), zoom: count('zoom'), handheld: count('handheld'),
      unknown: count('unknown'),
      mainType,
      fixedRatio: judged.length ? r2(count('fixed') / judged.length) : null,
      maxShotMovePct: judged.length
        ? r2(Math.max(...judged.map((s) => Math.max(Math.abs(s.panXPct || 0), Math.abs(s.panYPct || 0)))))
        : null,
      totalPanXPct: r2(shots.reduce((a, s) => a + (s.panXPct || 0), 0)),
      totalPanYPct: r2(shots.reduce((a, s) => a + (s.panYPct || 0), 0))
    },
    note: judged.length ? null : '全部镜头可比帧对不足，运镜不下结论',
    computedAt: new Date().toISOString()
  };
}

module.exports = { analyzeCamera, FPS, W, H };
