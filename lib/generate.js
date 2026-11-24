'use strict';

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { buildChartSpec, MEDIA } = require('./chart');

/**
 * 차트 사양대로 원시 RGB 버퍼를 그린다.
 * 배경은 검정 — 테두리(border) 영역이 그대로 검은 프레임이 되어
 * 스캔본에서 이미지 영역 경계를 잡는 기준선 역할을 한다.
 */
function renderChart(spec) {
  const { width, height } = spec;
  const buf = Buffer.alloc(width * height * 3, 0);

  const fill = (rect, [r, g, b]) => {
    const x0 = Math.max(rect.x, 0);
    const y0 = Math.max(rect.y, 0);
    const x1 = Math.min(rect.x + rect.w, width);
    const y1 = Math.min(rect.y + rect.h, height);

    for (let py = y0; py < y1; py++) {
      let off = (py * width + x0) * 3;
      for (let px = x0; px < x1; px++) {
        buf[off] = r;
        buf[off + 1] = g;
        buf[off + 2] = b;
        off += 3;
      }
    }
  };

  for (const patch of spec.patches) fill(patch.rect, patch.rgb);

  // 기준점은 패치보다 나중에 그려야 한다 — 검은 테두리 위에 얹히는 마커이므로.
  for (const fid of spec.fiducials) fill(fid.rect, [255, 255, 255]);

  return buf;
}

/**
 * 차트 PNG + 사양 JSON을 함께 쓴다.
 * JSON은 측정 단계에서 패치 위치/기준값을 읽어오는 데 반드시 필요하므로
 * PNG와 항상 같이 다녀야 한다.
 */
async function generate(mediaKey, outDir) {
  const spec = buildChartSpec(mediaKey);
  const raw = renderChart(spec);

  fs.mkdirSync(outDir, { recursive: true });
  const pngPath = path.join(outDir, `차트_${mediaKey}.png`);
  const jsonPath = path.join(outDir, `차트_${mediaKey}.json`);

  await sharp(raw, { raw: { width: spec.width, height: spec.height, channels: 3 } })
    .png({ compressionLevel: 9 })
    .toFile(pngPath);

  fs.writeFileSync(jsonPath, JSON.stringify(spec, null, 2), 'utf8');

  return { spec, pngPath, jsonPath };
}

if (require.main === module) {
  const mediaKey = process.argv[2] || 'mini';
  const outDir = process.argv[3] || path.join(__dirname, '..', 'out');

  if (!MEDIA[mediaKey]) {
    console.error(`알 수 없는 매체: ${mediaKey}`);
    console.error(`가능한 값: ${Object.keys(MEDIA).join(', ')}`);
    process.exit(1);
  }

  generate(mediaKey, outDir)
    .then(({ spec, pngPath, jsonPath }) => {
      console.log(`매체    : ${spec.mediaLabel} (${spec.width}x${spec.height})`);
      console.log(`그리드  : ${spec.cols} x ${spec.rows} — 패치 ${spec.patchCount}개`);
      console.log(`차트    : ${pngPath}`);
      console.log(`사양    : ${jsonPath}`);
    })
    .catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
}

module.exports = { generate, renderChart };
