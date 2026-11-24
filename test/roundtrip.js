'use strict';

/**
 * 왕복 검증: 차트 생성 → 가상 필름/스캔 왜곡 → 측정.
 *
 * measure.js 가 뽑아낸 실측값이, 시뮬레이터가 실제로 집어넣은 값과
 * 얼마나 일치하는지 본다. 여기서 안 맞으면 실물 필름에서도 안 맞는다.
 */

const fs = require('fs');
const path = require('path');
const { generate } = require('../lib/generate');
const { measure } = require('../lib/measure');
const { makeFakeScan, applyFilm } = require('./simulate');

const OUT = path.join(__dirname, '..', 'out', 'test');
const TOLERANCE = 4.0; // 채널당 허용 오차 (0-255 스케일)

async function run(mediaKey = 'mini') {
  fs.mkdirSync(OUT, { recursive: true });

  const { spec, pngPath } = await generate(mediaKey, OUT);
  const scanPath = path.join(OUT, `합성스캔_${mediaKey}.png`);
  await makeFakeScan(pngPath, scanPath, { rotate: 2.5, scale: 1.8 });

  const overlay = path.join(OUT, `검증_${mediaKey}.png`);
  const res = await measure(scanPath, spec, overlay);

  let worst = 0;
  let worstName = '';
  const failures = [];

  for (const s of res.samples) {
    const expected = applyFilm(s.reference);
    const err = Math.max(...s.measured.map((v, c) => Math.abs(v - expected[c])));
    if (err > worst) {
      worst = err;
      worstName = s.name;
    }
    if (err > TOLERANCE) {
      failures.push({
        name: s.name,
        expected: expected.map((v) => +v.toFixed(1)),
        measured: s.measured,
        err: +err.toFixed(2),
      });
    }
  }

  console.log(`\n[${mediaKey}] 패치 ${res.samples.length}개`);
  console.log(`  기준점 검출 : ${res.fiducials.map((f) => f.name).join(' ')}`);
  console.log(`  뒤집힘 보정 : ${res.flipped ? '적용' : '불필요'}`);
  console.log(`  최대 오차   : ${worst.toFixed(2)} (${worstName})  [허용 ${TOLERANCE}]`);

  if (failures.length) {
    console.log(`  실패 ${failures.length}개:`);
    for (const f of failures.slice(0, 10)) {
      console.log(`    ${f.name.padEnd(8)} 기대 ${JSON.stringify(f.expected).padEnd(22)} 실측 ${JSON.stringify(f.measured).padEnd(22)} 오차 ${f.err}`);
    }
  } else {
    console.log('  ✅ 전 패치 허용 오차 이내');
  }
  console.log(`  검증 이미지 : ${overlay}`);

  return failures.length === 0;
}

if (require.main === module) {
  const media = process.argv.slice(2);
  const list = media.length ? media : ['mini', 'square', 'wide', 'polaroid'];
  (async () => {
    let ok = true;
    for (const m of list) ok = (await run(m)) && ok;
    console.log(ok ? '\n전체 통과' : '\n실패 있음');
    process.exit(ok ? 0 : 1);
  })().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = { run };
