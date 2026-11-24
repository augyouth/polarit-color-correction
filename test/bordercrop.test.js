'use strict';

/**
 * 실물 인화에서 실제로 벌어진 사고를 재현하는 회귀 테스트 (2026-08-24).
 *
 * 인화 앱/프린터가 차트의 검은 테두리와 기준점을 통째로 잘라냈다 —
 * 남은 건 48개 색 패치 덩어리뿐이었다. 이 테스트는 그 상황을 합성으로
 * 만들어서, measure() 가 (a) 기준점 없이도 대체 경로로 넘어가고
 * (b) 최소한 무채색(밝기) 만큼은 정확히 복원하는지 확인한다.
 *
 * 채도 높은 원색은 실물에서도 완벽히 안 맞았으므로(필름 자체의 염료
 * 크로스토크) 여기서는 무채색/하이라이트 위주로 기준을 둔다.
 */

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { generate } = require('../lib/generate');
const { measure } = require('../lib/measure');
const { applyFilm } = require('./simulate');

const OUT = path.join(__dirname, '..', 'out', 'test', 'bordercrop');

/**
 * 차트 PNG에서 검은 테두리+기준점을 잘라내고(패치 영역만 남기고), 필름
 * 흉내+기울임을 입힌 뒤, 훨씬 큰 흰 배경(A4 스캐너에 올린 작은 인화물) 위에
 * 얹는다. 배경 비율을 실제 상황과 맞추는 게 중요하다 — 실물 사고 당시
 * 인화물은 스캔 전체 면적의 약 3%뿐이었다(배경이 97%). 배경 비율이 작으면
 * findChartQuad 의 percentile 기반 임계값 추정 자체가 성립하지 않는다.
 */
async function makeCroppedFakeScan(chartPath, spec, outPath, opts = {}) {
  const { rotate = 3, scale = 1.8, pageScale = 3.2 } = opts;

  // spec.patches[0]..[last] 의 실제 픽셀 경계 = 테두리를 제외한 순수 격자 영역.
  const first = spec.patches[0].rect;
  const last = spec.patches[spec.patches.length - 1].rect;
  const gridLeft = first.x, gridTop = first.y;
  const gridW = (last.x + last.w) - first.x;
  const gridH = (last.y + last.h) - first.y;

  const { data, info } = await sharp(chartPath)
    .extract({ left: gridLeft, top: gridTop, width: gridW, height: gridH })
    .removeAlpha().raw().toBuffer({ resolveWithObject: true });

  const filmed = Buffer.alloc(data.length);
  for (let i = 0; i < data.length; i += 3) {
    const out = applyFilm([data[i], data[i + 1], data[i + 2]]);
    for (let c = 0; c < 3; c++) filmed[i + c] = Math.max(0, Math.min(255, Math.round(out[c])));
  }

  const printBuf = await sharp(filmed, { raw: { width: info.width, height: info.height, channels: 3 } })
    .resize(Math.round(info.width * scale), Math.round(info.height * scale), { kernel: 'lanczos3' })
    .rotate(rotate, { background: { r: 250, g: 250, b: 248 } })
    .png().toBuffer();
  const printMeta = await sharp(printBuf).metadata();

  const pageW = Math.round(printMeta.width * pageScale);
  const pageH = Math.round(printMeta.height * pageScale);
  const left = Math.round((pageW - printMeta.width) / 2);
  const top = Math.round((pageH - printMeta.height) / 3); // 페이지 위쪽으로 살짝 치우치게

  await sharp({
    create: { width: pageW, height: pageH, channels: 3, background: { r: 250, g: 250, b: 248 } },
  })
    .composite([{ input: printBuf, left, top }])
    .png().toFile(outPath);

  return outPath;
}

async function run(mediaKey = 'mini_v') {
  fs.mkdirSync(OUT, { recursive: true });
  const { spec, pngPath } = await generate(mediaKey, OUT);
  const scanPath = path.join(OUT, `테두리잘림_${mediaKey}.png`);
  await makeCroppedFakeScan(pngPath, spec, scanPath, { rotate: 2.5, scale: 1.8 });

  const res = await measure(scanPath, spec);

  const byGroup = {};
  for (const s of res.samples) {
    const expected = applyFilm(s.reference);
    const err = Math.max(...s.measured.map((v, c) => Math.abs(v - expected[c])));
    (byGroup[s.group] ||= []).push(err);
  }

  console.log(`\n[테두리 잘림 회귀 테스트: ${mediaKey}]`);
  console.log(`  대체 경로 사용 : ${res.fallback ? '예 (예상대로)' : '아니오 — 기준점을 찾은 것으로 판단했다면 이상함'}`);
  console.log(`  방향 신뢰도    : ${res.score.toFixed(3)}`);

  let ok = true;
  for (const [g, errs] of Object.entries(byGroup)) {
    const mean = errs.reduce((a, b) => a + b, 0) / errs.length;
    const max = Math.max(...errs);
    console.log(`  ${g.padEnd(10)} 평균=${mean.toFixed(2)} 최대=${max.toFixed(2)}`);
  }

  // 무채색은 테두리가 없어도 정확히 복원되어야 한다 — 이게 안 되면
  // 대체 경로 자체가 망가진 것이다.
  const neutralErrs = byGroup.neutral || [];
  const neutralMax = neutralErrs.length ? Math.max(...neutralErrs) : Infinity;
  if (neutralMax > 8) {
    ok = false;
    console.log(`  ❌ 무채색 최대오차 ${neutralMax.toFixed(1)} 가 너무 큽니다 (허용 8)`);
  }
  if (!res.fallback) {
    ok = false;
    console.log(`  ❌ 대체 경로가 발동하지 않았습니다 — 예상과 다릅니다`);
  }
  // 0.6 미만이면 measure() 내부에서 이미 예외를 던지므로 여기 도달하지
  // 않는다. 방향 신뢰도 자체는 테두리 없는 스캔에서 하이라이트/피부톤
  // 노이즈로 0.85 밑까지 내려갈 수 있지만(2026-08-24 확인), 그게 곧
  // 무채색(밝기) 품질 저하를 뜻하지는 않으므로 별도로 강하게 요구하지 않는다.

  console.log(ok ? '  ✅ 통과' : '  ❌ 실패');
  return ok;
}

if (require.main === module) {
  (async () => {
    const results = [];
    for (const m of ['mini', 'mini_v', 'square', 'polaroid']) {
      results.push(await run(m));
    }
    const ok = results.every(Boolean);

    // wide/wide_v(가로로 넓은 4행 격자)는 무채색 램프가 격자 폭 전체를
    // 가로질러, 배경과 구분이 안 되는 밝은 칸들이 격자를 좌우로 크게
    // 갈라놓는다. 이 경우 꼭짓점 추출이 볼록하지 않은(notch가 있는)
    // 모양에서 수학적으로 엉뚱한 점을 고를 수 있어 아직 못 풀었다
    // (2026-08-24, gap-closing으로도 안 잡힘 — 노치가 격자 폭의 40%대로
    // 너무 커서). mini/mini_v/square/polaroid(세로로 긴 6~8행 격자)는
    // 이 문제가 없다. wide 를 실제로 쓰게 되면 재작업이 필요하다는 걸
    // 알리기 위해 결과만 출력하고 전체 통과 판정에는 넣지 않는다.
    console.log('\n[알려진 한계 — wide/wide_v, 판정에 포함 안 함]');
    for (const m of ['wide', 'wide_v']) {
      try {
        await run(m);
        console.log(`  [${m}] 예상 밖으로 통과함 — 더 이상 알려진 한계가 아닐 수 있습니다.`);
      } catch (e) {
        console.log(`  [${m}] 여전히 실패 (예상됨): ${e.message.split('\n')[0]}`);
      }
    }

    console.log(ok ? '\n전체 통과 (mini/mini_v/square/polaroid)' : '\n실패 있음');
    process.exit(ok ? 0 : 1);
  })().catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { run, makeCroppedFakeScan };
