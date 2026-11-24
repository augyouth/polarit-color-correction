'use strict';

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { solveHomography, applyHomography } = require('./geometry');

// 스캔본을 이 크기로 줄여서 처리한다. 600dpi 원본을 그대로 다룰 이유가 없고,
// 축소 과정의 평균화가 필름 그레인 노이즈를 자연스럽게 눌러준다.
const WORK_MAX = 1600;

// 패치 하나당 샘플링 격자 (N x N)
const SAMPLE_GRID = 13;

const lum = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/** 스캔 이미지를 작업 해상도의 원시 RGB로 읽어온다. */
async function loadScan(scanPath) {
  const img = sharp(scanPath).rotate(); // EXIF 방향 반영
  const meta = await img.metadata();
  const scale = Math.min(1, WORK_MAX / Math.max(meta.width, meta.height));
  const w = Math.max(1, Math.round(meta.width * scale));
  const h = Math.max(1, Math.round(meta.height * scale));

  const { data } = await img
    .resize(w, h, { fit: 'fill' })
    .removeAlpha()
    .toColourspace('srgb')
    .raw()
    .toBuffer({ resolveWithObject: true });

  return { data, width: w, height: h };
}

const sat = (r, g, b) => { const mx = Math.max(r, g, b); return mx === 0 ? 0 : (mx - Math.min(r, g, b)) / mx; };

/**
 * 밝기 배열과 전경(차트) 판정 마스크를 만든다.
 *
 * 어둡다는 것만으로 전경을 판정하면 밝지만 채도가 높은 패치(연두, 노랑 등)가
 * 배경(흰 종이)과 구분이 안 돼 차트 덩어리에 구멍이 뚫린다 — 실물 스캔에서
 * 실제로 이 때문에 차트가 여러 조각으로 쪼개지는 걸 확인했다(2026-08-24).
 * 그래서 "어둡다 OR 채도가 있다" 를 전경으로 본다.
 */
function buildLuminance(scan) {
  const { data, width, height } = scan;
  const lums = new Float32Array(width * height);
  const fg = new Uint8Array(width * height);
  for (let i = 0, p = 0; i < data.length; i += 3, p++) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    lums[p] = lum(r, g, b);
  }
  const sorted = Float32Array.from(lums).sort();
  const p95 = sorted[Math.floor(sorted.length * 0.95)];
  const threshold = p95 * 0.7;
  for (let i = 0, p = 0; i < data.length; i += 3, p++) {
    fg[p] = (lums[p] < threshold || sat(data[i], data[i + 1], data[i + 2]) > 0.12) ? 1 : 0;
  }
  closeGaps(fg, width, height);
  return { lums, fg, threshold };
}

/**
 * 전경 마스크의 작은 내부 틈을 메운다 (모폴로지 닫기, 1차원 근사).
 *
 * 근처리기가 배경으로 놓친 밝은 무채색 패치 한두 칸이 격자 한복판에 '홈'을
 * 만들면, 꼭짓점 추출(최댓값 x+y 등)이 그 홈의 모서리를 진짜 꼭짓점으로
 * 착각한다(2026-08-24, wide 매체 합성 테스트에서 재현). 같은 행/열에서
 * 양쪽에 전경이 있는 배경 픽셀은 진짜 배경(그 너머로 한참 이어짐)이 아니라
 * 격자 내부의 좁은 틈일 가능성이 높으므로 전경으로 승격한다.
 */
function closeGaps(fg, width, height) {
  const gap = Math.max(4, Math.round(Math.min(width, height) * 0.05));

  // 가로 방향: 각 행에서, gap 이내 왼쪽/오른쪽에 전경이 있으면 메운다.
  for (let y = 0; y < height; y++) {
    const row = y * width;
    let lastFg = -Infinity;
    for (let x = 0; x < width; x++) {
      if (fg[row + x]) { lastFg = x; continue; }
      if (x - lastFg <= gap) {
        // 오른쪽에도 gap 이내에 전경이 있는지 확인
        let x2 = x;
        while (x2 < width && x2 - x <= gap && !fg[row + x2]) x2++;
        if (x2 < width && fg[row + x2] && x2 - x <= gap) {
          for (let k = x; k < x2; k++) fg[row + k] = 1;
        }
      }
    }
  }
  // 세로 방향도 동일하게.
  for (let x = 0; x < width; x++) {
    let lastFg = -Infinity;
    for (let y = 0; y < height; y++) {
      const p = y * width + x;
      if (fg[p]) { lastFg = y; continue; }
      if (y - lastFg <= gap) {
        let y2 = y;
        while (y2 < height && y2 - y <= gap && !fg[y2 * width + x]) y2++;
        if (y2 < height && fg[y2 * width + x] && y2 - y <= gap) {
          for (let k = y; k < y2; k++) fg[k * width + x] = 1;
        }
      }
    }
  }
}

/**
 * 차트의 네 꼭짓점을 찾는다.
 *
 * 회전된 사각형에서는 축정렬 경계상자가 실제 꼭짓점보다 안쪽으로 잡히므로
 * 그걸 기준으로 삼으면 안 된다. 대신 전경 연결영역들의 (x+y), (x-y) 극값을
 * 취해 회전된 사각형의 진짜 꼭짓점을 얻는다.
 *
 * 차트가 하나의 연결된 덩어리로 안 잡힐 때가 있다 — 무채색 램프의 밝은 쪽
 * 끝(N244, N250, N255 등)이나 하이라이트 패치는 배경(흰 종이/필름 여백)과
 * 밝기·채도 차이가 거의 없어서, 그 부분만 전경 판정에서 빠지며 격자이 여러
 * 조각으로 쪼개진다(실제로 합성 테스트에서 재현됨, 2026-08-24). 무채색
 * 램프가 격자 전체 폭을 가로지르는 배치(wide 매체 등)에서는 이 끊긴 부분이
 * 격자를 위/아래로 완전히 갈라놓기도 한다.
 *
 * 그래서 "가장 큰 덩어리 하나"만 쓰지 않고, 최소 크기를 넘고 이미지
 * 가장자리에 안 닿는 조각을 전부 같은 차트의 일부로 보고 합친다. 스캐너
 * 덮개를 열고 찍어 생긴 검은 배경은 반드시 가장자리에 닿고, 스캐너 뚜껑
 * 그림자 같은 자잘한 노이즈는 최소 크기 기준에 못 미쳐 걸러진다.
 */
function findChartQuad(scan) {
  const { width, height } = scan;
  const { lums, fg } = buildLuminance(scan);

  const labels = new Int32Array(width * height).fill(-1);
  const stack = new Int32Array(width * height);
  const comps = [];
  let label = 0;

  for (let start = 0; start < labels.length; start++) {
    if (labels[start] !== -1 || !fg[start]) continue;

    let sp = 0;
    stack[sp++] = start;
    labels[start] = label;

    let count = 0;
    let touchesEdge = false;
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    let minSum = Infinity; let maxSum = -Infinity;
    let minDiff = Infinity; let maxDiff = -Infinity;
    let cTL = null; let cBR = null; let cTR = null; let cBL = null;

    while (sp > 0) {
      const p = stack[--sp];
      const x = p % width;
      const y = (p - x) / width;
      count++;
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;

      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) touchesEdge = true;

      const sum = x + y;
      const diff = x - y;
      if (sum < minSum) { minSum = sum; cTL = { x, y }; }
      if (sum > maxSum) { maxSum = sum; cBR = { x, y }; }
      if (diff > maxDiff) { maxDiff = diff; cTR = { x, y }; }
      if (diff < minDiff) { minDiff = diff; cBL = { x, y }; }

      if (x > 0 && labels[p - 1] === -1 && fg[p - 1]) { labels[p - 1] = label; stack[sp++] = p - 1; }
      if (x < width - 1 && labels[p + 1] === -1 && fg[p + 1]) { labels[p + 1] = label; stack[sp++] = p + 1; }
      if (y > 0 && labels[p - width] === -1 && fg[p - width]) { labels[p - width] = label; stack[sp++] = p - width; }
      if (y < height - 1 && labels[p + width] === -1 && fg[p + width]) { labels[p + width] = label; stack[sp++] = p + width; }
    }

    label++;
    comps.push({ count, touchesEdge, x0, x1, y0, y1, corners: [cTL, cTR, cBR, cBL] });
  }

  const minArea = width * height * 0.005;
  const candidates = comps.filter((c) => !c.touchesEdge && c.count >= minArea);
  if (!candidates.length) {
    throw new Error(
      '스캔본에서 차트 영역을 찾지 못했습니다.\n' +
      '  · 스캐너 자동 노출/자동 색보정이 켜져 있으면 실패합니다 — 반드시 끄세요.\n' +
      '  · 프린트 한 장만 스캔했는지 확인하세요 (여러 장 동시 스캔은 미지원).'
    );
  }

  let cTL = null, cTR = null, cBR = null, cBL = null;
  let minSum = Infinity, maxSum = -Infinity, minDiff = Infinity, maxDiff = -Infinity;
  for (const c of candidates) {
    const [bTL, bTR, bBR, bBL] = c.corners;
    const sumTL = bTL.x + bTL.y; if (sumTL < minSum) { minSum = sumTL; cTL = bTL; }
    const sumBR = bBR.x + bBR.y; if (sumBR > maxSum) { maxSum = sumBR; cBR = bBR; }
    const diffTR = bTR.x - bTR.y; if (diffTR > maxDiff) { maxDiff = diffTR; cTR = bTR; }
    const diffBL = bBL.x - bBL.y; if (diffBL < minDiff) { minDiff = diffBL; cBL = bBL; }
  }

  return { corners: [cTL, cTR, cBR, cBL], lums, fg };
}

/**
 * 흰색 코너 기준점의 무게중심을 서브픽셀로 찾는다.
 *
 * 2단계로 나눈다. 먼저 꼭짓점 4개로 임시 변환을 만들어 기준점이 있어야 할
 * 위치를 예측하고, 그 예측점 주변의 좁은 창에서만 밝은 덩어리를 찾는다.
 * 창을 좁게 유지하는 게 핵심 — 넓히면 우하단의 하이라이트 패치(거의 흰색)를
 * 기준점으로 오인한다.
 */
function findFiducials(scan, quad, spec) {
  const { lums } = quad;
  const { width, height } = scan;

  const specCorners = [
    { x: 0, y: 0 }, { x: spec.width, y: 0 },
    { x: spec.width, y: spec.height }, { x: 0, y: spec.height },
  ];
  const roughH = solveHomography(specCorners, quad.corners);

  // 스캔본에서의 테두리 두께를 꼭짓점 간 실측 거리로부터 환산한다.
  const edge = Math.hypot(quad.corners[1].x - quad.corners[0].x, quad.corners[1].y - quad.corners[0].y);
  const borderPx = (edge * spec.border) / spec.width;
  const radius = Math.max(4, Math.round(borderPx * 0.9));

  return spec.fiducials.map((fid) => {
    const pred = applyHomography(roughH, fid.center.x * spec.width, fid.center.y * spec.height);

    const x0 = Math.max(0, Math.floor(pred.x - radius));
    const x1 = Math.min(width - 1, Math.ceil(pred.x + radius));
    const y0 = Math.max(0, Math.floor(pred.y - radius));
    const y1 = Math.min(height - 1, Math.ceil(pred.y + radius));

    let maxL = -Infinity;
    let minL = Infinity;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const l = lums[y * width + x];
        if (l > maxL) maxL = l;
        if (l < minL) minL = l;
      }
    }

    if (!Number.isFinite(maxL) || maxL - minL < 15) {
      throw new Error(
        `${fid.name} 모서리에서 기준점을 찾지 못했습니다 — 차트가 잘려 인화됐을 수 있습니다`
      );
    }

    const cut = minL + (maxL - minL) * 0.6;
    let sx = 0;
    let sy = 0;
    let sw = 0;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const l = lums[y * width + x];
        if (l < cut) continue;
        const w = l - cut;
        sx += x * w;
        sy += y * w;
        sw += w;
      }
    }

    if (sw <= 0) throw new Error(`${fid.name} 기준점 무게중심 계산 실패`);
    return { name: fid.name, x: sx / sw, y: sy / sw };
  });
}

/** 스캔본에서 (x,y) 근처 픽셀을 최근접으로 읽는다. */
function samplePixel(scan, x, y) {
  const px = Math.round(x);
  const py = Math.round(y);
  if (px < 0 || py < 0 || px >= scan.width || py >= scan.height) return null;
  const off = (py * scan.width + px) * 3;
  return [scan.data[off], scan.data[off + 1], scan.data[off + 2]];
}

const median = (arr) => {
  const s = [...arr].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** 호모그래피를 써서 모든 패치의 대표색을 뽑는다. */
function samplePatches(scan, spec, H) {
  return spec.patches.map((patch) => {
    const cx = patch.center.x * spec.width;
    const cy = patch.center.y * spec.height;
    const rx = patch.sampleRadius.x * spec.width;
    const ry = patch.sampleRadius.y * spec.height;

    const R = [];
    const G = [];
    const B = [];
    for (let i = 0; i < SAMPLE_GRID; i++) {
      const fy = SAMPLE_GRID === 1 ? 0 : (i / (SAMPLE_GRID - 1)) * 2 - 1;
      for (let j = 0; j < SAMPLE_GRID; j++) {
        const fx = SAMPLE_GRID === 1 ? 0 : (j / (SAMPLE_GRID - 1)) * 2 - 1;
        const p = applyHomography(H, cx + fx * rx, cy + fy * ry);
        const px = samplePixel(scan, p.x, p.y);
        if (!px) continue;
        R.push(px[0]);
        G.push(px[1]);
        B.push(px[2]);
      }
    }

    if (!R.length) throw new Error(`패치 ${patch.name} 샘플링 실패 — 변환이 스캔 범위를 벗어났습니다`);

    return {
      name: patch.name,
      group: patch.group,
      index: patch.index,
      reference: patch.rgb,
      measured: [median(R), median(G), median(B)].map((v) => Math.round(v * 100) / 100),
    };
  });
}

/**
 * 이 방향 가정이 얼마나 그럴듯한지 점수를 매긴다.
 *
 * 방향이 맞으면 실측색은 기준색의 단조 함수라서 둘의 상관계수가 1에 가깝다.
 * 방향이 틀리면 패치가 뒤섞여 읽히므로 상관이 무너진다. 채널별 피어슨
 * 상관계수의 평균을 쓴다.
 */
function orientationScore(samples) {
  let total = 0;
  for (let c = 0; c < 3; c++) {
    const xs = samples.map((s) => s.reference[c]);
    const ys = samples.map((s) => s.measured[c]);
    const n = xs.length;
    const mx = xs.reduce((a, b) => a + b, 0) / n;
    const my = ys.reduce((a, b) => a + b, 0) / n;
    let num = 0;
    let dx = 0;
    let dy = 0;
    for (let i = 0; i < n; i++) {
      const a = xs[i] - mx;
      const b = ys[i] - my;
      num += a * b;
      dx += a * a;
      dy += b * b;
    }
    total += dx > 0 && dy > 0 ? num / Math.sqrt(dx * dy) : 0;
  }
  return total / 3;
}

/**
 * 차트 격자(패치 전체) 자체의 네 꼭짓점을 스펙 좌표로 반환한다 (테두리 제외).
 * 인화 과정에서 테두리·기준점이 잘려나가 findFiducials 가 실패했을 때,
 * 남아있는 패치 덩어리의 실측 꼭짓점을 곧바로 등록점으로 쓰기 위한 대체 목표.
 * quad.corners 와 같은 순서(TL,TR,BR,BL)로 맞춘다.
 */
function gridCornersSpec(spec) {
  const first = spec.patches[0].rect;                    // (0,0) 패치 = 좌상단
  const last = spec.patches[spec.patches.length - 1].rect; // 마지막 패치 = 우하단
  const topRight = spec.patches.find((p) => p.col === spec.cols - 1 && p.row === 0).rect;
  const bottomLeft = spec.patches.find((p) => p.col === 0 && p.row === spec.rows - 1).rect;
  return [
    { x: first.x, y: first.y },
    { x: topRight.x + topRight.w, y: topRight.y },
    { x: last.x + last.w, y: last.y + last.h },
    { x: bottomLeft.x, y: bottomLeft.y + bottomLeft.h },
  ];
}

/**
 * 스캔본을 측정해서 기준색 → 실측색 매핑을 뽑는다.
 * overlayPath 를 주면 어디를 샘플링했는지 표시한 검증 이미지를 함께 쓴다.
 *
 * 프린트를 어느 방향으로 놓고 스캔했는지는 미리 알 수 없다. 세로 필름에
 * 가로 차트를 90도 돌려 인화하는 경우도 있고, 스캐너에 거꾸로 올리기도 한다.
 * 그래서 네 방향을 전부 시도해보고 가장 그럴듯한 것을 고른다.
 */
async function measure(scanPath, spec, overlayPath) {
  const scan = await loadScan(scanPath);
  const quad = findChartQuad(scan);

  const fiducialSrc = spec.fiducials.map((f) => ({
    x: f.center.x * spec.width,
    y: f.center.y * spec.height,
  }));
  const gridSrc = gridCornersSpec(spec);

  let best = null;
  const failures = [];

  for (let r = 0; r < 4; r++) {
    const corners = [0, 1, 2, 3].map((i) => quad.corners[(i + r) % 4]);

    // 두 방법을 항상 둘 다 시도하고 실제 상관계수가 더 좋은 쪽을 쓴다.
    // findFiducials 가 "성공"(예외 없음)해도 테두리가 잘려나간 스캔에서는
    // 엉뚱한 위치를 기준점으로 착각할 수 있다 — 예외 여부로는 못 걸러내고
    // 결과 점수로만 구분된다. 그래서 예외 유무가 아니라 점수로 승자를 가른다.
    try {
      const fids = findFiducials(scan, { ...quad, corners }, spec);
      const H = solveHomography(fiducialSrc, fids);
      const samples = samplePatches(scan, spec, H);
      const score = orientationScore(samples);
      if (!best || score > best.score) best = { rotation: r * 90, fids, H, samples, score, fallback: false };
    } catch (err) {
      failures.push(`  ${r * 90}도(기준점): ${err.message}`);
    }

    // 기준점(테두리 흰 점)을 못 찾았거나 잘못 찾은 경우의 대비책: 남은
    // 패치 덩어리의 꼭짓점을 그대로 등록점으로 쓴다. 서브픽셀 정밀도는
    // 떨어지지만, 테두리가 인화 과정에서 잘려나간 스캔에서는 이쪽이 맞다.
    try {
      const H = solveHomography(gridSrc, corners);
      const samples = samplePatches(scan, spec, H);
      const score = orientationScore(samples);
      if (!best || score > best.score) {
        best = { rotation: r * 90, fids: corners, H, samples, score, fallback: true };
      }
    } catch (err) {
      failures.push(`  ${r * 90}도(테두리 대체): ${err.message}`);
    }
  }

  if (!best) {
    throw new Error(`어느 방향으로도 차트를 읽지 못했습니다.\n${failures.join('\n')}`);
  }
  // 이 문턱은 "방향/정렬을 완전히 잘못 읽었다"만 걸러낸다 — 오답 방향들은
  // 실측에서 -0.2~0.15 사이인 반면 정답은 항상 0.6 이상으로, 여유가 크다.
  // 세부 품질(무채색은 괜찮은데 원색만 나쁜 경우 등)은 여기서 뭉뚱그려
  // 판단하지 않고 lib/lut.js 의 그룹별 적합도로 따로 보고한다 — 테두리가
  // 잘려나간 스캔에서는 하이라이트/피부톤 그룹만 유독 나빠도 전체 상관이
  // 0.85 밑으로 떨어지는데, 정작 사용자가 처음 호소한 밝기 문제(무채색)는
  // 멀쩡한 경우가 실물 데이터에서 확인됐다(2026-08-24).
  if (best.score < 0.6) {
    throw new Error(
      `차트를 읽었지만 색 대응이 성립하지 않습니다 (상관 ${best.score.toFixed(3)}).\n` +
      '  · 스캐너 자동 노출/자동 색보정이 켜져 있을 가능성이 가장 높습니다.\n' +
      '  · 차트가 잘리거나 일부가 가려지지 않았는지 확인하세요.'
    );
  }

  if (overlayPath) await writeOverlay(scan, spec, best.H, overlayPath);

  return {
    samples: best.samples,
    fiducials: best.fids,
    corners: quad.corners,
    rotation: best.rotation,
    score: best.score,
    fallback: best.fallback,
    H: best.H,
  };
}

/** 샘플링 영역을 초록 테두리로 그려넣은 검증 이미지를 만든다. */
async function writeOverlay(scan, spec, H, outPath) {
  const out = Buffer.from(scan.data);
  const put = (x, y, rgb) => {
    const px = Math.round(x);
    const py = Math.round(y);
    if (px < 0 || py < 0 || px >= scan.width || py >= scan.height) return;
    const off = (py * scan.width + px) * 3;
    out[off] = rgb[0];
    out[off + 1] = rgb[1];
    out[off + 2] = rgb[2];
  };

  for (const patch of spec.patches) {
    const cx = patch.center.x * spec.width;
    const cy = patch.center.y * spec.height;
    const rx = patch.sampleRadius.x * spec.width;
    const ry = patch.sampleRadius.y * spec.height;
    for (let t = 0; t <= 60; t++) {
      const f = (t / 60) * 2 - 1;
      for (const [dx, dy] of [[f, -1], [f, 1], [-1, f], [1, f]]) {
        const p = applyHomography(H, cx + dx * rx, cy + dy * ry);
        put(p.x, p.y, [0, 255, 0]);
      }
    }
  }

  for (const fid of spec.fiducials) {
    const p = applyHomography(H, fid.center.x * spec.width, fid.center.y * spec.height);
    for (let d = -5; d <= 5; d++) {
      put(p.x + d, p.y, [255, 0, 255]);
      put(p.x, p.y + d, [255, 0, 255]);
    }
  }

  await sharp(out, { raw: { width: scan.width, height: scan.height, channels: 3 } })
    .png()
    .toFile(outPath);
}

if (require.main === module) {
  const [scanPath, specPath] = process.argv.slice(2);
  if (!scanPath || !specPath) {
    console.error('사용법: node lib/measure.js <스캔이미지> <차트사양.json> [결과.json]');
    process.exit(1);
  }
  const outPath = process.argv[4] || path.join(path.dirname(specPath), '측정결과.json');
  const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
  const overlay = outPath.replace(/\.json$/, '_검증.png');

  measure(scanPath, spec, overlay)
    .then((res) => {
      fs.writeFileSync(outPath, JSON.stringify({ media: spec.media, ...res, H: undefined }, null, 2), 'utf8');
      console.log(`기준점  : ${res.fiducials.map((f) => `${f.name}(${f.x.toFixed(0)},${f.y.toFixed(0)})`).join(' ')}`);
      if (res.flipped) console.log('주의    : 180도 뒤집힌 스캔으로 판단하여 자동 보정했습니다');
      console.log(`측정    : ${outPath}`);
      console.log(`검증본  : ${overlay}  ← 초록 사각형이 패치와 맞는지 눈으로 확인하세요`);
    })
    .catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
}

module.exports = { measure, loadScan, findChartQuad, findFiducials, samplePatches, orientationScore, gridCornersSpec };
