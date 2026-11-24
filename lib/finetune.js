'use strict';

/**
 * 측정 기반 보정 LUT 위에 얹는 눈-검증용 미세조정.
 *
 * 왜 필요한가: 보정 LUT은 "화면→인화→스캔"을 하나로 묶어 뒤집은 것이라,
 * 스캐너 자체의 색 편차가 있으면 그 역방향이 인화물에 새겨진다. 이 오차는
 * 재스캔으로는 절대 검출되지 않는다 — 검증 루프 안에서 스캐너 편차가
 * 수학적으로 자동 상쇄되기 때문이다. 유일한 검출 수단은 사람 눈으로
 * "실제 인화물 vs 화면"을 비교하는 것이고, 거기서 본 미세한 편차를
 * 다시 물리 인화 사이클(인화→건조→스캔) 없이 바로 고칠 수 있어야 한다.
 * 이 모듈이 그 역할을 한다: 측정된 기준 LUT은 그대로 보존하고,
 * 그 위에 작은 보정치를 누적 적용해 실사용 LUT을 다시 만든다.
 */

const fs = require('fs');
const path = require('path');
const { readCube, writeCube } = require('./lut');

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

// 클릭 한 번당 증감 폭. 미세조정이 목적이므로 일부러 작게 잡았다.
const STEP = {
  ev: 0.1,     // 밝기: 2^0.1 ≈ 7% 밝기 변화
  warm: 0.012, // 색온도: R/B 를 반대 방향으로 이동 (0~1 스케일, 약 3/255)
  tint: 0.012, // 그린/마젠타: G 를 R,B 평균 대비 이동
};

// 여기 이상 누적되면 "미세조정으로 덮을 문제가 아니라 재측정이 필요하다"는 신호.
const LIMIT = { ev: 1.0, warm: 0.15, tint: 0.15 };

const ACTIONS = {
  밝게: { ev: STEP.ev },
  어둡게: { ev: -STEP.ev },
  따뜻하게: { warm: STEP.warm },   // 노란/붉은 쪽으로
  차갑게: { warm: -STEP.warm },    // 푸른 쪽으로
  마젠타줄이기: { tint: STEP.tint },   // 그린 쪽으로 이동 (마젠타 캐스트 완화)
  그린줄이기: { tint: -STEP.tint },    // 마젠타 쪽으로 이동
};

function emptyTrim() { return { ev: 0, warm: 0, tint: 0 }; }

function addTrim(base, delta) {
  return {
    ev: clampRange(base.ev + (delta.ev || 0), LIMIT.ev),
    warm: clampRange(base.warm + (delta.warm || 0), LIMIT.warm),
    tint: clampRange(base.tint + (delta.tint || 0), LIMIT.tint),
  };
}
function clampRange(v, limit) { return Math.max(-limit, Math.min(limit, v)); }
function hitLimit(trim) {
  return Math.abs(trim.ev) >= LIMIT.ev || Math.abs(trim.warm) >= LIMIT.warm || Math.abs(trim.tint) >= LIMIT.tint;
}

/**
 * LUT 격자의 출력값에 트림을 적용한다.
 * 순서: 노출(곱셈) → 색온도/틴트(덧셈). 사진 편집 도구의 일반적인 순서와 맞췄다.
 */
function applyTrimToGrid(grid, trim) {
  const evMul = Math.pow(2, trim.ev);
  const out = new Float32Array(grid.length);
  for (let i = 0; i < grid.length; i += 3) {
    let r = grid[i] * evMul;
    let g = grid[i + 1] * evMul;
    let b = grid[i + 2] * evMul;
    r += trim.warm;
    b -= trim.warm;
    g += trim.tint;
    out[i] = clamp01(r);
    out[i + 1] = clamp01(g);
    out[i + 2] = clamp01(b);
  }
  return out;
}

function baselinePath(lutDir, mediaKey) { return path.join(lutDir, `보정_${mediaKey}_기준.cube`); }
function activePath(lutDir, mediaKey) { return path.join(lutDir, `보정_${mediaKey}.cube`); }
function statePath(lutDir, mediaKey) { return path.join(lutDir, `조정_${mediaKey}.json`); }

function loadState(lutDir, mediaKey) {
  const p = statePath(lutDir, mediaKey);
  if (!fs.existsSync(p)) return emptyTrim();
  const s = JSON.parse(fs.readFileSync(p, 'utf8'));
  return { ev: s.ev || 0, warm: s.warm || 0, tint: s.tint || 0 };
}
function saveState(lutDir, mediaKey, trim) {
  fs.writeFileSync(statePath(lutDir, mediaKey), JSON.stringify(trim, null, 2), 'utf8');
}

/**
 * 트림을 한 스텝 적용한다. 항상 기준(측정 직후) LUT에서 다시 계산하므로
 * 여러 번 눌러도 반올림 오차가 누적되지 않는다.
 */
function nudge(lutDir, mediaKey, actionName) {
  const delta = ACTIONS[actionName];
  if (!delta) throw new Error(`알 수 없는 조정: ${actionName} (가능: ${Object.keys(ACTIONS).join(', ')})`);

  const base = baselinePath(lutDir, mediaKey);
  if (!fs.existsSync(base)) {
    throw new Error(`기준 LUT이 없습니다: ${base}\n먼저 2_LUT만들기.bat 으로 측정을 완료하세요.`);
  }

  const prevTrim = loadState(lutDir, mediaKey);
  const nextTrim = addTrim(prevTrim, delta);
  const capped = hitLimit(nextTrim);

  const { size, grid } = readCube(base);
  const adjusted = applyTrimToGrid(grid, nextTrim);
  writeCube(adjusted, size, `${mediaKey} 인화 보정 (미세조정)`, activePath(lutDir, mediaKey));
  saveState(lutDir, mediaKey, nextTrim);

  return { trim: nextTrim, capped };
}

/** 기준 상태로 되돌린다 (트림 전부 제거). */
function reset(lutDir, mediaKey) {
  const base = baselinePath(lutDir, mediaKey);
  if (!fs.existsSync(base)) throw new Error(`기준 LUT이 없습니다: ${base}`);
  const { size, grid } = readCube(base);
  writeCube(grid, size, `${mediaKey} 인화 보정`, activePath(lutDir, mediaKey));
  saveState(lutDir, mediaKey, emptyTrim());
  return emptyTrim();
}

function describeTrim(trim) {
  const parts = [];
  if (trim.ev !== 0) parts.push(`밝기 ${trim.ev > 0 ? '+' : ''}${(trim.ev * 100 / LIMIT.ev).toFixed(0)}%`);
  if (trim.warm !== 0) parts.push(trim.warm > 0 ? `따뜻하게 ${(trim.warm / STEP.warm).toFixed(1)}단계` : `차갑게 ${(-trim.warm / STEP.warm).toFixed(1)}단계`);
  if (trim.tint !== 0) parts.push(trim.tint > 0 ? `마젠타 완화 ${(trim.tint / STEP.tint).toFixed(1)}단계` : `그린 완화 ${(-trim.tint / STEP.tint).toFixed(1)}단계`);
  return parts.length ? parts.join(' · ') : '조정 없음 (기준 그대로)';
}

module.exports = {
  ACTIONS, nudge, reset, loadState, describeTrim,
  applyTrimToGrid, emptyTrim, baselinePath, activePath, statePath,
};
