'use strict';

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { readCube } = require('./lut');

/** 3D LUT 삼선형 보간. rgb 는 0-255, 반환도 0-255. */
function makeLutSampler(lut) {
  const { size, grid } = lut;
  const last = size - 1;

  const at = (r, g, b, out) => {
    const i = ((b * size + g) * size + r) * 3;
    out[0] = grid[i];
    out[1] = grid[i + 1];
    out[2] = grid[i + 2];
  };

  const c000 = [0, 0, 0]; const c100 = [0, 0, 0];
  const c010 = [0, 0, 0]; const c110 = [0, 0, 0];
  const c001 = [0, 0, 0]; const c101 = [0, 0, 0];
  const c011 = [0, 0, 0]; const c111 = [0, 0, 0];

  return (rgb, out) => {
    const fr = (rgb[0] / 255) * last;
    const fg = (rgb[1] / 255) * last;
    const fb = (rgb[2] / 255) * last;

    const r0 = Math.min(last, Math.max(0, Math.floor(fr)));
    const g0 = Math.min(last, Math.max(0, Math.floor(fg)));
    const b0 = Math.min(last, Math.max(0, Math.floor(fb)));
    const r1 = Math.min(last, r0 + 1);
    const g1 = Math.min(last, g0 + 1);
    const b1 = Math.min(last, b0 + 1);

    const dr = fr - r0;
    const dg = fg - g0;
    const db = fb - b0;

    at(r0, g0, b0, c000); at(r1, g0, b0, c100);
    at(r0, g1, b0, c010); at(r1, g1, b0, c110);
    at(r0, g0, b1, c001); at(r1, g0, b1, c101);
    at(r0, g1, b1, c011); at(r1, g1, b1, c111);

    for (let c = 0; c < 3; c++) {
      const x00 = c000[c] + (c100[c] - c000[c]) * dr;
      const x10 = c010[c] + (c110[c] - c010[c]) * dr;
      const x01 = c001[c] + (c101[c] - c001[c]) * dr;
      const x11 = c011[c] + (c111[c] - c011[c]) * dr;
      const y0 = x00 + (x10 - x00) * dg;
      const y1 = x01 + (x11 - x01) * dg;
      out[c] = (y0 + (y1 - y0) * db) * 255;
    }
    return out;
  };
}

/** 이미지 하나에 LUT을 적용해 저장한다. */
async function applyToImage(inputPath, lut, outPath) {
  const img = sharp(inputPath).rotate();
  const { data, info } = await img.removeAlpha().toColourspace('srgb')
    .raw().toBuffer({ resolveWithObject: true });

  const sample = makeLutSampler(lut);
  const out = Buffer.alloc(data.length);
  const tmp = [0, 0, 0];
  const px = [0, 0, 0];

  for (let i = 0; i < data.length; i += 3) {
    px[0] = data[i]; px[1] = data[i + 1]; px[2] = data[i + 2];
    sample(px, tmp);
    out[i] = Math.max(0, Math.min(255, Math.round(tmp[0])));
    out[i + 1] = Math.max(0, Math.min(255, Math.round(tmp[1])));
    out[i + 2] = Math.max(0, Math.min(255, Math.round(tmp[2])));
  }

  const ext = path.extname(outPath).toLowerCase();
  const pipeline = sharp(out, { raw: { width: info.width, height: info.height, channels: 3 } });
  await (ext === '.jpg' || ext === '.jpeg'
    ? pipeline.jpeg({ quality: 95 })
    : pipeline.png()).toFile(outPath);

  return outPath;
}

/** 폴더 안의 이미지 전부에 LUT을 적용한다. */
async function applyToFolder(inDir, cubePath, outDir, suffix = '_보정') {
  const lut = readCube(cubePath);
  fs.mkdirSync(outDir, { recursive: true });

  const files = fs.readdirSync(inDir)
    .filter((f) => /\.(png|jpe?g|webp|tiff?)$/i.test(f));

  const done = [];
  for (const f of files) {
    const base = path.basename(f, path.extname(f));
    const ext = /\.(jpe?g)$/i.test(f) ? '.jpg' : '.png';
    const outPath = path.join(outDir, `${base}${suffix}${ext}`);
    await applyToImage(path.join(inDir, f), lut, outPath);
    done.push(outPath);
  }
  return done;
}

if (require.main === module) {
  const [inDir, cubePath, outDir] = process.argv.slice(2);
  if (!inDir || !cubePath) {
    console.error('사용법: node lib/apply.js <사진폴더> <LUT.cube> [출력폴더]');
    process.exit(1);
  }
  const target = outDir || path.join(inDir, '보정본');
  applyToFolder(inDir, cubePath, target)
    .then((done) => {
      console.log(`${done.length}장 처리 완료 → ${target}`);
    })
    .catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
}

module.exports = { applyToImage, applyToFolder, makeLutSampler };
