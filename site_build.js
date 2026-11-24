'use strict';

/**
 * 현장용 정적 사이트(site/)에 들어갈 보정 데이터를 준비한다.
 *
 * LUT/ 에 측정이 끝난 매체(보정_○.cube + 시뮬레이션_○.cube 둘 다 있는 것)를
 * 골라 site/lut/ 로 복사하고 presets.json 목록을 쓴다. 파일명은 ASCII로
 * 바꾼다 — 호스팅 URL에 한글이 들어가면 환경에 따라 깨지는 일이 있다.
 * site/ 폴더는 그대로 Cloudflare Pages 등에 올리면 된다.
 */

const fs = require('fs');
const path = require('path');
const { MEDIA } = require('./lib/chart');

const ROOT = __dirname;
const LUT_DIR = path.join(ROOT, 'LUT');
const SITE_LUT = path.join(ROOT, 'site', 'lut');

// 실물 필름 규격(mm): 전체 필름, 이미지 영역, 이미지 영역의 좌상단 위치.
// 미리보기에서 흰 테두리와 잘림을 실제 인화물처럼 보여주는 데만 쓴다.
// 가로 매체는 두꺼운 테두리가 오른쪽에 오도록 회전한 값.
const FILM = {
  mini:     { film: [86, 54],  image: [62, 46], offset: [4, 4] },
  mini_v:   { film: [54, 86],  image: [46, 62], offset: [4, 4] },
  square:   { film: [72, 86],  image: [62, 62], offset: [5, 6] },
  wide:     { film: [108, 86], image: [99, 62], offset: [4.5, 4] },
  wide_v:   { film: [86, 108], image: [62, 99], offset: [4, 4.5] },
  polaroid: { film: [88, 107], image: [79, 79], offset: [4.5, 6] },
};

function build() {
  const found = Object.keys(MEDIA)
    .map((key) => ({
      key,
      label: MEDIA[key].label,
      correction: path.join(LUT_DIR, `보정_${key}.cube`),
      simulation: path.join(LUT_DIR, `시뮬레이션_${key}.cube`),
    }))
    .filter((m) => fs.existsSync(m.correction) && fs.existsSync(m.simulation))
    .map((m) => ({ ...m, mtime: fs.statSync(m.correction).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);

  if (!found.length) {
    throw new Error('측정이 끝난 매체가 없습니다. 2_LUT만들기.bat 을 먼저 실행하세요.');
  }

  fs.mkdirSync(SITE_LUT, { recursive: true });

  const presets = found.map((m) => {
    const corrName = `${m.key}.correction.cube`;
    const simName = `${m.key}.simulation.cube`;
    fs.copyFileSync(m.correction, path.join(SITE_LUT, corrName));
    fs.copyFileSync(m.simulation, path.join(SITE_LUT, simName));
    return {
      key: m.key,
      label: m.label,
      correction: `lut/${corrName}`,
      simulation: `lut/${simName}`,
      frame: FILM[m.key] || null,
      output: [MEDIA[m.key].width, MEDIA[m.key].height],
      measuredAt: new Date(m.mtime).toISOString(),
    };
  });

  const manifest = { generated: new Date().toISOString(), presets };
  fs.writeFileSync(path.join(SITE_LUT, 'presets.json'), JSON.stringify(manifest, null, 2), 'utf8');
  return manifest;
}

if (require.main === module) {
  try {
    const { presets } = build();
    console.log(`사이트 보정 데이터 준비 완료 (${presets.length}개 매체)`);
    for (const p of presets) console.log(`  - ${p.label} (${p.key})`);
    console.log(`\n배포: ${path.join(ROOT, 'site')} 폴더를 통째로 올리면 됩니다.`);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

module.exports = { build };
