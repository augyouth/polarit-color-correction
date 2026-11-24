'use strict';

const fs = require('fs');
const path = require('path');
const { writeCube, readCube } = require('../lib/lut');
const finetune = require('../lib/finetune');

const DIR = path.join(__dirname, '..', 'out', 'test', 'finetune');
const MEDIA = 'unit';

let pass = 0;
let fail = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass++; } else { fail++; console.log(`  FAIL ${label}\n    기대: ${e}\n    실제: ${a}`); }
}
function checkClose(label, actual, expected, tol = 1e-4) {
  if (Math.abs(actual - expected) <= tol) { pass++; } else { fail++; console.log(`  FAIL ${label}  기대≈${expected} 실제=${actual}`); }
}

// 3x3x3 항등 LUT(입력=출력)을 기준으로 삼아 순수 함수 동작만 검증한다.
function makeIdentityGrid(size) {
  const g = new Float32Array(size * size * size * 3);
  let i = 0;
  for (let b = 0; b < size; b++) for (let g2 = 0; g2 < size; g2++) for (let r = 0; r < size; r++) {
    g[i++] = r / (size - 1); g[i++] = g2 / (size - 1); g[i++] = b / (size - 1);
  }
  return g;
}

fs.rmSync(DIR, { recursive: true, force: true });
fs.mkdirSync(DIR, { recursive: true });
const size = 3;
const idGrid = makeIdentityGrid(size);
writeCube(idGrid, size, 'test baseline', finetune.baselinePath(DIR, MEDIA));

console.log('\n[applyTrimToGrid 순수 함수]');
const noTrim = finetune.applyTrimToGrid(idGrid, finetune.emptyTrim());
check('트림 0이면 그대로', Array.from(noTrim), Array.from(idGrid));

const evUp = finetune.applyTrimToGrid(idGrid, { ev: 1, warm: 0, tint: 0 }); // 2배
checkClose('ev+1 은 값을 2배로 (클램프 전)', evUp[3 * 13], Math.min(1, idGrid[3 * 13] * 2)); // 중간 텍셀 R채널

const warmUp = finetune.applyTrimToGrid(idGrid, { ev: 0, warm: 0.1, tint: 0 });
checkClose('warm+ 는 R을 올림', warmUp[0], Math.min(1, idGrid[0] + 0.1));
checkClose('warm+ 는 B를 내림', warmUp[2], Math.max(0, idGrid[2] - 0.1));
check('warm+ 는 G에 영향 없음', warmUp[1], idGrid[1]);

const tintUp = finetune.applyTrimToGrid(idGrid, { ev: 0, warm: 0, tint: 0.1 });
checkClose('tint+ 는 G를 올림', tintUp[1], Math.min(1, idGrid[1] + 0.1));
check('tint+ 는 R,B에 영향 없음', [tintUp[0], tintUp[2]], [idGrid[0], idGrid[2]]);

console.log('\n[클램프]');
const extreme = finetune.applyTrimToGrid(Float32Array.from([1, 1, 1]), { ev: 2, warm: 0, tint: 0 });
check('상한 클램프', Array.from(extreme), [1, 1, 1]);
const extremeLow = finetune.applyTrimToGrid(Float32Array.from([0, 0, 0]), { ev: 0, warm: -0.5, tint: -0.5 });
check('하한 클램프', Array.from(extremeLow), [0, 0, 0.5]);

console.log('\n[nudge — 누적이 기준에서 재계산되는지]');
finetune.reset(DIR, MEDIA);
finetune.nudge(DIR, MEDIA, '밝게');
const r1 = finetune.nudge(DIR, MEDIA, '밝게'); // 두 번 누름
const twice = readCube(finetune.activePath(DIR, MEDIA));
finetune.reset(DIR, MEDIA);
const r2 = finetune.nudge(DIR, MEDIA, '밝게');
// 위에서 nudge 를 한 번 더 부르지 않고, ev를 직접 2배로 지정한 결과와 비교
const directDouble = finetune.applyTrimToGrid(idGrid, { ev: r1.trim.ev, warm: 0, tint: 0 });
// .cube 파일은 소수 6자리 텍스트로 저장되므로 그 왕복 오차(<1e-6)는 색상 단위
// (1/255≈0.0039)보다 한참 작다 — 허용오차 비교로 "누적 반올림 없음"만 확인한다.
{
  const a = Array.from(twice.grid), b = Array.from(directDouble);
  const maxDiff = a.reduce((m, v, i) => Math.max(m, Math.abs(v - b[i])), 0);
  check('두 번 누른 결과 = 기준에서 ev*2 를 한 번에 적용한 것과 동일 (반올림 누적 없음, 오차<1e-5)',
    maxDiff < 1e-5, true);
}

console.log('\n[한도(LIMIT) 캡]');
finetune.reset(DIR, MEDIA);
let capped = false;
for (let i = 0; i < 30; i++) { const r = finetune.nudge(DIR, MEDIA, '따뜻하게'); if (r.capped) capped = true; }
check('30번 눌러도 한도 안에서 캡됨', capped, true);
const st = finetune.loadState(DIR, MEDIA);
check('warm 값이 LIMIT을 넘지 않음', st.warm <= 0.15 + 1e-9, true);

console.log('\n[reset]');
finetune.reset(DIR, MEDIA);
const afterReset = finetune.loadState(DIR, MEDIA);
check('reset 후 트림 0', afterReset, { ev: 0, warm: 0, tint: 0 });
const activeAfterReset = readCube(finetune.activePath(DIR, MEDIA));
check('reset 후 활성 LUT = 기준 LUT', Array.from(activeAfterReset.grid), Array.from(idGrid));

console.log('\n[알 수 없는 조정 이름]');
let threw = false;
try { finetune.nudge(DIR, MEDIA, '보라색으로'); } catch (e) { threw = true; }
check('정의 안 된 조정명은 예외', threw, true);

console.log('\n[describeTrim 표시]');
check('조정 없음 표시', finetune.describeTrim({ ev: 0, warm: 0, tint: 0 }), '조정 없음 (기준 그대로)');
const desc = finetune.describeTrim({ ev: 0.2, warm: 0, tint: 0 });
check('밝기 조정 표시에 부호 포함', desc.includes('밝기 +'), true);

console.log(`\n통과 ${pass} / 실패 ${fail}`);
process.exit(fail ? 1 : 0);
