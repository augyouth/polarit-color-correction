'use strict';

/**
 * 가상 필름 시뮬레이터 + 가상 스캔본 생성기.
 *
 * 실제 필름을 쓰기 전에 측정 파이프라인이 맞는지 검증하기 위한 도구다.
 * "정답을 아는 왜곡"을 일부러 만들어 넣고, measure.js 가 그 정답을
 * 되찾아내는지 확인한다.
 */

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

/**
 * 인스탁스 필름의 전형적인 거동을 흉내낸 모델.
 * 사용자가 말한 증상("화면보다 밝고 날아감")을 그대로 반영했다:
 *  - 감마 < 1 → 중간톤이 전반적으로 들림
 *  - 상한 < 255 & 하한 > 0 → 다이내믹 레인지 압축, 진짜 검정/흰색이 안 나옴
 *  - 채널별 편차 → 청색이 덜 들려서 결과가 따뜻하게 치우침
 */
const FILM = {
  gamma: [0.72, 0.76, 0.80],
  floor: [28, 24, 22],
  ceil: [252, 250, 246],
};

function applyFilm(rgb) {
  return rgb.map((v, c) => {
    const t = Math.pow(v / 255, FILM.gamma[c]);
    return FILM.floor[c] + (FILM.ceil[c] - FILM.floor[c]) * t;
  });
}

/** 차트 PNG에 필름 거동을 입히고, 기울여서, 흰 테두리 위에 얹는다. */
async function makeFakeScan(chartPath, outPath, opts = {}) {
  const { rotate = 2.5, borderPx = 90, noise = 1.5, scale = 1.8 } = opts;

  const { data, info } = await sharp(chartPath).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const filmed = Buffer.alloc(data.length);

  for (let i = 0; i < data.length; i += 3) {
    const out = applyFilm([data[i], data[i + 1], data[i + 2]]);
    for (let c = 0; c < 3; c++) {
      const n = (Math.random() - 0.5) * 2 * noise;
      filmed[i + c] = Math.max(0, Math.min(255, Math.round(out[c] + n)));
    }
  }

  await sharp(filmed, { raw: { width: info.width, height: info.height, channels: 3 } })
    .resize(Math.round(info.width * scale), Math.round(info.height * scale), { kernel: 'lanczos3' })
    .extend({
      top: borderPx, bottom: borderPx, left: borderPx, right: borderPx,
      background: { r: 246, g: 245, b: 242 }, // 필름 플라스틱 테두리 (순백이 아님)
    })
    .rotate(rotate, { background: { r: 246, g: 245, b: 242 } })
    .png()
    .toFile(outPath);

  return outPath;
}

if (require.main === module) {
  const chartPath = process.argv[2] || path.join(__dirname, '..', 'out', '차트_mini.png');
  const outPath = process.argv[3] || path.join(__dirname, '..', 'out', '합성스캔_mini.png');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  makeFakeScan(chartPath, outPath).then((p) => console.log(`가상 스캔본: ${p}`));
}

module.exports = { makeFakeScan, applyFilm, FILM };
