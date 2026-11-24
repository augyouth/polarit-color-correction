'use strict';

const fs = require('fs');
const path = require('path');
const { solveLinear } = require('./geometry');

/**
 * 측정 데이터로부터 필름의 색 재현 모델을 세우고, 그 역함수를 LUT으로 굽는다.
 *
 * 모델:  인화결과 = M · tone(원본)
 *   - tone : 채널별 1차원 톤 커브. 무채색 램프 20단계에서 뽑는다.
 *            "밝고 날아간다"는 증상의 본체가 여기 담긴다.
 *   - M    : 3x3 행렬. tone 으로 설명되지 않는 채널 간 간섭(색 틀어짐)을
 *            컬러 패치 전체에서 최소제곱으로 맞춘다.
 *
 * 이 형태를 고른 이유는 역함수가 해석적으로 떨어지기 때문이다:
 *   원본 = tone⁻¹(M⁻¹ · 목표)
 * 수치 반복 없이 정확히 뒤집히므로 LUT 격자 전체를 빠르고 안정적으로 채운다.
 */

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/* ---------------------------------------------------------------- 톤 커브 */

/**
 * 단조 3차 에르미트 보간 (Fritsch-Carlson).
 * 일반 스플라인은 측정 노이즈에서 출렁여 역함수가 깨지므로 단조성을 강제한다.
 */
function monotoneSpline(xs, ys) {
  const n = xs.length;
  const h = [];
  const delta = [];
  for (let i = 0; i < n - 1; i++) {
    h.push(xs[i + 1] - xs[i]);
    delta.push((ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]));
  }

  const m = new Array(n);
  m[0] = delta[0];
  m[n - 1] = delta[n - 2];
  for (let i = 1; i < n - 1; i++) {
    m[i] = delta[i - 1] * delta[i] <= 0 ? 0 : (delta[i - 1] + delta[i]) / 2;
  }
  for (let i = 0; i < n - 1; i++) {
    if (delta[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
    const a = m[i] / delta[i];
    const b = m[i + 1] / delta[i];
    const s = a * a + b * b;
    if (s > 9) {
      const t = 3 / Math.sqrt(s);
      m[i] = t * a * delta[i];
      m[i + 1] = t * b * delta[i];
    }
  }

  return (x) => {
    if (x <= xs[0]) return ys[0] + m[0] * (x - xs[0]);
    if (x >= xs[n - 1]) return ys[n - 1] + m[n - 1] * (x - xs[n - 1]);
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (xs[mid] <= x) lo = mid; else hi = mid;
    }
    const t = (x - xs[lo]) / h[lo];
    const t2 = t * t;
    const t3 = t2 * t;
    return (
      ys[lo] * (2 * t3 - 3 * t2 + 1) +
      m[lo] * h[lo] * (t3 - 2 * t2 + t) +
      ys[lo + 1] * (-2 * t3 + 3 * t2) +
      m[lo + 1] * h[lo] * (t3 - t2)
    );
  };
}

/** 함수를 촘촘히 샘플링해 역함수 룩업을 만든다. y 는 단조 증가여야 한다. */
function invertCurve(fn, steps = 1024) {
  const xs = [];
  const ys = [];
  for (let i = 0; i <= steps; i++) {
    const x = (i / steps) * 255;
    xs.push(x);
    ys.push(fn(x));
  }
  // 수치 오차로 인한 미세한 역행을 제거한다.
  for (let i = 1; i <= steps; i++) if (ys[i] <= ys[i - 1]) ys[i] = ys[i - 1] + 1e-6;

  const yMin = ys[0];
  const yMax = ys[steps];

  const inv = (y) => {
    if (y <= yMin) return 0;
    if (y >= yMax) return 255;
    let lo = 0;
    let hi = steps;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (ys[mid] <= y) lo = mid; else hi = mid;
    }
    const t = (y - ys[lo]) / (ys[lo + 1] - ys[lo]);
    return xs[lo] + t * (xs[lo + 1] - xs[lo]);
  };

  return { inv, yMin, yMax };
}

/* ------------------------------------------------------------------ 행렬 */

function matMul3(M, v) {
  return [
    M[0] * v[0] + M[1] * v[1] + M[2] * v[2],
    M[3] * v[0] + M[4] * v[1] + M[5] * v[2],
    M[6] * v[0] + M[7] * v[1] + M[8] * v[2],
  ];
}

function invert3(M) {
  const [a, b, c, d, e, f, g, h, i] = M;
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (Math.abs(det) < 1e-9) throw new Error('색 변환 행렬이 특이행렬입니다 — 측정 데이터를 확인하세요');
  return [
    (e * i - f * h) / det, (c * h - b * i) / det, (b * f - c * e) / det,
    (f * g - d * i) / det, (a * i - c * g) / det, (c * d - a * f) / det,
    (d * h - e * g) / det, (b * g - a * h) / det, (a * e - b * d) / det,
  ];
}

/** 최소제곱으로 3x3 행렬을 맞춘다: M · src ≈ dst */
function fitMatrix(src, dst) {
  const M = [];
  for (let out = 0; out < 3; out++) {
    const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    const b = [0, 0, 0];
    for (let k = 0; k < src.length; k++) {
      const p = src[k];
      for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) A[i][j] += p[i] * p[j];
        b[i] += p[i] * dst[k][out];
      }
    }
    M.push(...solveLinear(A, b));
  }
  return M;
}

/* ------------------------------------------------------------------ 모델 */

/**
 * 측정 샘플에서 정방향 모델을 세운다.
 * 반환된 forward() 는 "화면 RGB → 이 필름으로 인화했을 때의 RGB".
 *
 * matrixStrength (0~1, 기본 1): 3x3 행렬(채널 간 크로스토크 보정)을 얼마나
 * 반영할지. 0이면 항등행렬 — 무채색 톤커브(밝기)만 보정하고 색상 간 간섭은
 * 안 건드린다. 톤커브는 무채색 20패치로 직접 검증되지만, 행렬은 원색
 * 패치에서 최소제곱으로 통계적으로 추정한 것이라 측정 노이즈(특히 테두리가
 * 잘려나가 정밀도가 떨어지는 대체 경로)에 더 민감하다. 실물 사진에서
 * "보정하니 오히려 너무 붉어진다"는 증상이 나오면, 크로스토크 행렬이
 * 노이즈를 학습해 흔한 색(피부톤 등)을 과도하게 밀어내는 경우가 실제로
 * 있었다(2026-08-24) — 이럴 때 matrixStrength 를 낮추면 "밝기는 고치되
 * 색상은 원래에 가깝게 두는" 더 안전한 보정이 된다.
 */
function buildModel(samples, opts = {}) {
  const matrixStrength = opts.matrixStrength ?? 1;

  const neutrals = samples
    .filter((s) => s.group === 'neutral')
    .sort((a, b) => a.reference[0] - b.reference[0]);

  if (neutrals.length < 6) {
    throw new Error(`무채색 패치가 ${neutrals.length}개뿐입니다 — 톤 커브를 만들 수 없습니다`);
  }

  const xs = neutrals.map((s) => s.reference[0]);
  const tone = [];
  for (let c = 0; c < 3; c++) {
    const ys = neutrals.map((s) => s.measured[c]);
    // 측정 노이즈로 인한 역행을 제거해 단조성을 확보한다.
    for (let i = 1; i < ys.length; i++) if (ys[i] < ys[i - 1]) ys[i] = ys[i - 1];
    tone.push(monotoneSpline(xs, ys));
  }

  const toned = samples.map((s) => s.reference.map((v, c) => tone[c](v)));
  const measured = samples.map((s) => s.measured);
  const fitted = fitMatrix(toned, measured);
  const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const M = fitted.map((v, i) => IDENTITY[i] * (1 - matrixStrength) + v * matrixStrength);
  const Minv = invert3(M);

  const forward = (rgb) => matMul3(M, [tone[0](rgb[0]), tone[1](rgb[1]), tone[2](rgb[2])]);

  const toneInv = tone.map((fn) => invertCurve(fn));
  const inverse = (target) => {
    const t = matMul3(Minv, target);
    return t.map((v, c) => clamp(toneInv[c].inv(v), 0, 255));
  };

  // 모델이 실제 측정을 얼마나 설명하는지 — 실물 데이터에서 이 값이 크면
  // 측정이 잘못됐거나 필름 거동이 이 모델로 표현되지 않는다는 뜻이다.
  //
  // 그룹별로 나눠 보는 게 중요하다: 무채색 오차는 톤 커브(밝기/명암) 품질을
  // 말해주고, 원색/피부톤 오차는 3x3 행렬(색상 간 간섭) 품질을 말해준다.
  // 실물 필름은 채도 높은 원색에서 염료층 간 비선형 간섭(크로스토크)이 커서
  // 선형 3x3 행렬로 다 못 잡는 경우가 흔하다 — 그렇다고 톤(밝기) 보정까지
  // 나쁘다는 뜻은 아니므로, 하나의 "최악값"으로 뭉뚱그리면 오해를 부른다.
  let sum = 0;
  let worst = 0;
  let worstName = '';
  const byGroup = {};
  for (const s of samples) {
    const pred = forward(s.reference);
    const err = Math.max(...pred.map((v, c) => Math.abs(v - s.measured[c])));
    sum += err;
    if (err > worst) { worst = err; worstName = s.name; }
    (byGroup[s.group] ||= []).push(err);
  }
  const groups = {};
  for (const [g, errs] of Object.entries(byGroup)) {
    groups[g] = {
      mean: errs.reduce((a, b) => a + b, 0) / errs.length,
      worst: Math.max(...errs),
      count: errs.length,
    };
  }

  return {
    forward,
    inverse,
    matrix: M,
    range: toneInv.map((t) => [t.yMin, t.yMax]),
    fit: { mean: sum / samples.length, worst, worstName, groups },
  };
}

/* -------------------------------------------------------------------- LUT */

/**
 * 보정 LUT 격자를 만든다.
 *
 * strength 는 색역 압축 강도다. 필름은 진짜 검정도 진짜 흰색도 못 내므로
 * 화면의 0~255 를 그대로 재현하라고 요구하면 양 끝이 뭉개진다(계조 소실).
 * strength=1 이면 목표 범위를 필름이 실제로 낼 수 있는 범위로 먼저 압축한 뒤
 * 뒤집는다 — 검정이 살짝 뜨는 대신 하이라이트가 날아가지 않는다.
 */
function buildCorrectionGrid(model, size, strength) {
  const grid = new Float32Array(size * size * size * 3);
  const [rR, rG, rB] = model.range;
  const lo = [rR[0], rG[0], rB[0]];
  const hi = [rR[1], rG[1], rB[1]];

  let i = 0;
  for (let b = 0; b < size; b++) {
    for (let g = 0; g < size; g++) {
      for (let r = 0; r < size; r++) {
        const target = [r, g, b].map((v, c) => {
          const t = (v / (size - 1)) * 255;
          return t * (1 - strength) + (lo[c] + (hi[c] - lo[c]) * (t / 255)) * strength;
        });
        const src = model.inverse(target);
        grid[i++] = clamp(src[0] / 255, 0, 1);
        grid[i++] = clamp(src[1] / 255, 0, 1);
        grid[i++] = clamp(src[2] / 255, 0, 1);
      }
    }
  }
  return grid;
}

/** 시뮬레이션 LUT 격자 — 화면에서 "이렇게 인화되어 나옵니다"를 보여준다. */
function buildSimulationGrid(model, size) {
  const grid = new Float32Array(size * size * size * 3);
  let i = 0;
  for (let b = 0; b < size; b++) {
    for (let g = 0; g < size; g++) {
      for (let r = 0; r < size; r++) {
        const out = model.forward([r, g, b].map((v) => (v / (size - 1)) * 255));
        grid[i++] = clamp(out[0] / 255, 0, 1);
        grid[i++] = clamp(out[1] / 255, 0, 1);
        grid[i++] = clamp(out[2] / 255, 0, 1);
      }
    }
  }
  return grid;
}

/** Adobe .cube 3D LUT 파일로 쓴다. Photoshop/Lightroom/캡처원/ffmpeg 공용 포맷. */
function writeCube(grid, size, title, outPath) {
  const lines = [
    `TITLE "${title}"`,
    `LUT_3D_SIZE ${size}`,
    'DOMAIN_MIN 0.0 0.0 0.0',
    'DOMAIN_MAX 1.0 1.0 1.0',
    '',
  ];
  for (let i = 0; i < grid.length; i += 3) {
    lines.push(`${grid[i].toFixed(6)} ${grid[i + 1].toFixed(6)} ${grid[i + 2].toFixed(6)}`);
  }
  fs.writeFileSync(outPath, lines.join('\n') + '\n', 'utf8');
  return outPath;
}

/** .cube 파일을 읽어 격자로 되돌린다 (적용 단계에서 사용). */
function readCube(cubePath) {
  const text = fs.readFileSync(cubePath, 'utf8');
  let size = 0;
  const values = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^LUT_3D_SIZE\s+(\d+)/i.exec(line);
    if (m) { size = parseInt(m[1], 10); continue; }
    if (/^[A-Z_]/i.test(line)) continue;
    const parts = line.split(/\s+/).map(Number);
    if (parts.length === 3 && parts.every(Number.isFinite)) values.push(...parts);
  }
  if (!size || values.length !== size * size * size * 3) {
    throw new Error(`.cube 파일이 손상되었습니다: ${cubePath}`);
  }
  return { size, grid: Float32Array.from(values) };
}

/** 측정 결과 파일 → LUT 2종 생성. */
function build(measurementPath, outDir, opts = {}) {
  const { size = 33, strength = 1.0, label = '', matrixStrength = 1 } = opts;
  const meas = JSON.parse(fs.readFileSync(measurementPath, 'utf8'));
  const samples = meas.samples || meas;
  const model = buildModel(samples, { matrixStrength });

  fs.mkdirSync(outDir, { recursive: true });
  const tag = label || meas.media || 'film';

  const correction = writeCube(
    buildCorrectionGrid(model, size, strength), size,
    `${tag} 인화 보정`, path.join(outDir, `보정_${tag}.cube`)
  );
  const simulation = writeCube(
    buildSimulationGrid(model, size), size,
    `${tag} 인화 시뮬레이션`, path.join(outDir, `시뮬레이션_${tag}.cube`)
  );

  return { model, correction, simulation };
}

module.exports = {
  build, buildModel, buildCorrectionGrid, buildSimulationGrid,
  writeCube, readCube, monotoneSpline, invertCurve,
};
