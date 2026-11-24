'use strict';

/**
 * 눈으로 보는 비교본 생성기.
 *   원본 / 보정없이 인화 / 보정후 인화  세 장을 나란히 붙인다.
 * 세 번째가 첫 번째와 비슷해 보이면 보정이 동작한 것이다.
 */

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { applyFilm } = require('./simulate');
const { readCube } = require('../lib/lut');
const { makeLutSampler } = require('../lib/apply');

const W = 420;
const H = 560;

/** 하이라이트가 날아가기 쉬운 요소들을 모아 만든 합성 장면. */
function makeScene() {
  const buf = Buffer.alloc(W * H * 3);
  const put = (x, y, r, g, b) => {
    const i = (y * W + x) * 3;
    buf[i] = Math.max(0, Math.min(255, Math.round(r)));
    buf[i + 1] = Math.max(0, Math.min(255, Math.round(g)));
    buf[i + 2] = Math.max(0, Math.min(255, Math.round(b)));
  };

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const band = Math.floor((y / H) * 4);

      if (band === 0) {
        // 창가 역광: 밝은 쪽이 필름에서 가장 먼저 날아간다
        const d = Math.hypot(x - W * 0.72, y - H * 0.10) / (W * 0.55);
        const v = 255 * Math.pow(Math.max(0, 1 - d), 0.6);
        put(x, y, 40 + v * 0.95, 44 + v * 0.90, 52 + v * 0.82);
      } else if (band === 1) {
        // 피부톤 그라데이션 — 인물 사진의 핵심 판정 구간
        const t = (x / W) * 0.75 + ((y - H * 0.25) / (H * 0.25)) * 0.25;
        put(x, y, 150 + t * 100, 110 + t * 100, 88 + t * 96);
      } else if (band === 2) {
        // 채도 높은 색 막대
        const bars = [[220, 40, 50], [235, 150, 40], [230, 215, 60],
          [70, 170, 90], [60, 120, 210], [140, 80, 190]];
        const c = bars[Math.min(bars.length - 1, Math.floor((x / W) * bars.length))];
        const shade = 0.55 + 0.45 * ((y - H * 0.5) / (H * 0.25));
        put(x, y, c[0] * shade, c[1] * shade, c[2] * shade);
      } else {
        // 무채색 계단 — 계조가 뭉치는지 확인용
        const step = Math.floor((x / W) * 12) / 11;
        const v = step * 255;
        put(x, y, v, v, v);
      }
    }
  }
  return buf;
}

function mapBuffer(src, fn) {
  const out = Buffer.alloc(src.length);
  const tmp = [0, 0, 0];
  for (let i = 0; i < src.length; i += 3) {
    const r = fn([src[i], src[i + 1], src[i + 2]], tmp);
    out[i] = Math.max(0, Math.min(255, Math.round(r[0])));
    out[i + 1] = Math.max(0, Math.min(255, Math.round(r[1])));
    out[i + 2] = Math.max(0, Math.min(255, Math.round(r[2])));
  }
  return out;
}

async function run(correctionCubePath, outPath) {
  const scene = makeScene();
  const sampleCorr = makeLutSampler(readCube(correctionCubePath));

  const uncorrected = mapBuffer(scene, (px) => applyFilm(px));
  const corrected = mapBuffer(scene, (px, tmp) => applyFilm(sampleCorr(px, tmp).slice()));

  const gap = 16;
  const panels = [scene, uncorrected, corrected];
  const totalW = W * 3 + gap * 4;
  const totalH = H + gap * 2;

  const canvas = Buffer.alloc(totalW * totalH * 3, 24);
  panels.forEach((p, idx) => {
    const ox = gap + idx * (W + gap);
    for (let y = 0; y < H; y++) {
      p.copy(canvas, ((y + gap) * totalW + ox) * 3, y * W * 3, (y + 1) * W * 3);
    }
  });

  await sharp(canvas, { raw: { width: totalW, height: totalH, channels: 3 } })
    .png()
    .toFile(outPath);

  return outPath;
}

if (require.main === module) {
  const cube = process.argv[2] || path.join(__dirname, '..', 'out', 'test', '보정_test.cube');
  const out = process.argv[3] || path.join(__dirname, '..', 'out', 'test', '비교_원본_무보정_보정.png');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  run(cube, out).then((p) => console.log(`비교본: ${p}`));
}

module.exports = { run, makeScene };
