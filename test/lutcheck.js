'use strict';

/**
 * LUT 검증: 보정 → 가상 인화 를 거친 결과가 원본 화면색과 맞는지 본다.
 *
 * 이게 이 프로젝트 전체의 성립 근거다. 여기서 통과하면
 * "보정 LUT을 씌워 인화하면 화면과 맞는다"가 수치로 증명된 것이다.
 */

const fs = require('fs');
const path = require('path');
const { generate } = require('../lib/generate');
const { measure } = require('../lib/measure');
const { makeFakeScan, applyFilm } = require('./simulate');
const { build, readCube } = require('../lib/lut');
const { makeLutSampler } = require('../lib/apply');

const OUT = path.join(__dirname, '..', 'out', 'test');

async function run() {
  fs.mkdirSync(OUT, { recursive: true });

  // 1) 차트 → 가상 인화/스캔 → 측정
  const { spec, pngPath } = await generate('mini', OUT);
  const scanPath = path.join(OUT, 'lut_합성스캔.png');
  await makeFakeScan(pngPath, scanPath, { rotate: 2.5, scale: 1.8 });
  const res = await measure(scanPath, spec);

  const measPath = path.join(OUT, 'lut_측정결과.json');
  fs.writeFileSync(measPath, JSON.stringify({ media: 'mini', samples: res.samples }, null, 2));

  // 2) 측정 → LUT
  const { model, correction, simulation } = build(measPath, OUT, { label: 'test' });
  console.log(`모델 적합도 : 평균오차 ${model.fit.mean.toFixed(2)}, 최대 ${model.fit.worst.toFixed(2)} (${model.fit.worstName})`);
  console.log(`필름 재현범위: R ${model.range[0].map((v) => v.toFixed(0)).join('~')}  G ${model.range[1].map((v) => v.toFixed(0)).join('~')}  B ${model.range[2].map((v) => v.toFixed(0)).join('~')}`);

  // 3) 보정 LUT 적용 → 가상 인화 → 원본과 비교
  const corrLut = readCube(correction);
  const sampleCorr = makeLutSampler(corrLut);
  const simLut = readCube(simulation);
  const sampleSim = makeLutSampler(simLut);

  const lo = model.range.map((r) => r[0]);
  const hi = model.range.map((r) => r[1]);
  const tmp = [0, 0, 0];

  let worstCorr = 0;
  let worstCorrAt = null;
  let worstSim = 0;
  let worstSimAt = null;
  let n = 0;

  for (let r = 0; r <= 255; r += 15) {
    for (let g = 0; g <= 255; g += 15) {
      for (let b = 0; b <= 255; b += 15) {
        const original = [r, g, b];

        // 보정 LUT 을 씌운 뒤 인화하면 나오는 색
        sampleCorr(original, tmp);
        const printed = applyFilm([tmp[0], tmp[1], tmp[2]]);
        // 목표: 필름이 낼 수 있는 범위로 압축된 원본 (strength=1 기준)
        const goal = original.map((v, c) => lo[c] + (hi[c] - lo[c]) * (v / 255));
        const eCorr = Math.max(...printed.map((v, c) => Math.abs(v - goal[c])));
        if (eCorr > worstCorr) { worstCorr = eCorr; worstCorrAt = original.slice(); }

        // 시뮬레이션 LUT 은 보정 없이 그냥 인화했을 때의 색을 예측해야 한다
        sampleSim(original, tmp);
        const truth = applyFilm(original);
        const eSim = Math.max(...truth.map((v, c) => Math.abs(v - tmp[c])));
        if (eSim > worstSim) { worstSim = eSim; worstSimAt = original.slice(); }

        n++;
      }
    }
  }

  console.log(`\n격자 ${n}점 검증`);
  console.log(`  보정 LUT   : 최대오차 ${worstCorr.toFixed(2)} @ rgb(${worstCorrAt})`);
  console.log(`  시뮬 LUT   : 최대오차 ${worstSim.toFixed(2)} @ rgb(${worstSimAt})`);

  // 보정 없이 그냥 인화했을 때의 오차 — 비교 기준선
  let worstRaw = 0;
  for (let r = 0; r <= 255; r += 15) {
    for (let g = 0; g <= 255; g += 15) {
      for (let b = 0; b <= 255; b += 15) {
        const original = [r, g, b];
        const printed = applyFilm(original);
        const goal = original.map((v, c) => lo[c] + (hi[c] - lo[c]) * (v / 255));
        worstRaw = Math.max(worstRaw, ...printed.map((v, c) => Math.abs(v - goal[c])));
      }
    }
  }
  console.log(`  (보정 안 함): 최대오차 ${worstRaw.toFixed(2)}  ← 개선 대상 기준선`);

  const ok = worstCorr < 4 && worstSim < 4;
  console.log(ok ? '\n✅ LUT 검증 통과' : '\n❌ LUT 검증 실패');
  return ok;
}

if (require.main === module) {
  run().then((ok) => process.exit(ok ? 0 : 1)).catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { run };
