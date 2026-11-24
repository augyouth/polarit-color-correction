'use strict';

/**
 * 캘리브레이션 차트 정의.
 *
 * 이 파일은 "차트에 무슨 색이, 어디에 있는가"에 대한 단일 진실 공급원이다.
 * 생성(generate.js)과 측정(measure.js)이 같은 함수를 호출하므로
 * 패치 순서/위치가 어긋날 일이 없다.
 */

// 인화 매체별 출력 픽셀 규격.
// cols/rows 는 48개 패치를 매체 비율에 맞게 배치한 값.
const MEDIA = {
  mini:      { label: '인스탁스 미니 (가로)',   width: 800,  height: 600,  cols: 8,  rows: 6 },
  mini_v:    { label: '인스탁스 미니 (세로)',   width: 600,  height: 800,  cols: 6,  rows: 8 },
  square:    { label: '인스탁스 스퀘어',        width: 800,  height: 800,  cols: 8,  rows: 6 },
  wide:      { label: '인스탁스 와이드 (가로)', width: 1600, height: 800,  cols: 12, rows: 4 },
  wide_v:    { label: '인스탁스 와이드 (세로)', width: 800,  height: 1600, cols: 4,  rows: 12 },
  polaroid:  { label: '폴라로이드',             width: 1080, height: 1080, cols: 8,  rows: 6 },
};

// 스캔본에서 이미지 영역 경계를 찾기 위한 검은 테두리 두께 (출력 폭 대비 비율)
const BORDER_RATIO = 0.025;

// 검은 테두리 안에 박아넣는 흰색 코너 기준점의 크기 (테두리 두께 대비 비율).
// 스캐너에 프린트를 손으로 올리면 항상 몇 도씩 기울어지므로, 네 모서리
// 기준점으로 회전각을 역산해서 패치 좌표를 보정한다.
const FIDUCIAL_RATIO = 0.6;

/** 무채색 램프 20단계. 하이라이트(밝고 날아가는 구간)를 촘촘하게 샘플링한다. */
const NEUTRAL_STEPS = [
  0, 16, 32, 48, 64, 80, 96, 112, 128, 144,
  160, 176, 192, 204, 216, 228, 236, 244, 250, 255,
];

/** 원색/보색 6종 × 3단계 = 18 */
const HUES = {
  R: [1, 0, 0], G: [0, 1, 0], B: [0, 0, 1],
  C: [0, 1, 1], M: [1, 0, 1], Y: [1, 1, 0],
};
const HUE_LEVELS = [255, 176, 96];

/** 피부톤 6종 (sRGB). 밝은 쪽부터 어두운 쪽으로. */
const SKIN_TONES = [
  [244, 214, 190], [232, 196, 168], [216, 176, 148],
  [198, 154, 126], [176, 132, 106], [150, 110, 86],
];

/** 하이라이트 임계 구간 4종. 필름에서 가장 먼저 날아가는 영역. */
const HIGHLIGHTS = [
  [255, 250, 245], [252, 246, 240], [250, 240, 232], [245, 234, 224],
];

/**
 * 차트에 들어갈 패치 목록을 고정된 순서로 반환한다.
 * 순서가 곧 그리드 배치 순서(좌→우, 상→하)이므로 절대 바꾸지 말 것.
 */
function buildPatches() {
  const patches = [];

  for (const v of NEUTRAL_STEPS) {
    patches.push({ group: 'neutral', name: `N${v}`, rgb: [v, v, v] });
  }

  for (const [hueName, mask] of Object.entries(HUES)) {
    for (const level of HUE_LEVELS) {
      patches.push({
        group: 'hue',
        name: `${hueName}${level}`,
        rgb: mask.map((m) => (m ? level : 0)),
      });
    }
  }

  SKIN_TONES.forEach((rgb, i) => {
    patches.push({ group: 'skin', name: `SKIN${i + 1}`, rgb });
  });

  HIGHLIGHTS.forEach((rgb, i) => {
    patches.push({ group: 'highlight', name: `HL${i + 1}`, rgb });
  });

  return patches;
}

/**
 * 매체 규격에 맞춰 각 패치의 실제 좌표를 계산한 차트 사양을 만든다.
 *
 * 좌표는 픽셀과 정규화값(0~1) 둘 다 담는다. 측정 단계에서는 스캔 해상도가
 * 원본과 다르므로 정규화 좌표만 사용한다 — 이게 스캔 DPI에 무관하게
 * 동작하는 핵심이다.
 */
function buildChartSpec(mediaKey) {
  const media = MEDIA[mediaKey];
  if (!media) {
    throw new Error(`알 수 없는 매체: ${mediaKey} (가능: ${Object.keys(MEDIA).join(', ')})`);
  }

  const { width, height, cols, rows } = media;
  const border = Math.round(width * BORDER_RATIO);
  const patches = buildPatches();

  const capacity = cols * rows;
  if (patches.length > capacity) {
    throw new Error(`패치 ${patches.length}개가 ${cols}x${rows} 그리드(${capacity}칸)에 안 들어감`);
  }

  const gridW = width - border * 2;
  const gridH = height - border * 2;
  const cellW = gridW / cols;
  const cellH = gridH / rows;

  const placed = patches.map((patch, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const x = border + col * cellW;
    const y = border + row * cellH;
    const cx = x + cellW / 2;
    const cy = y + cellH / 2;

    return {
      ...patch,
      index: i,
      col,
      row,
      rect: {
        x: Math.round(x), y: Math.round(y),
        w: Math.round(cellW), h: Math.round(cellH),
      },
      // 정규화 중심좌표 + 샘플 반경. 반경은 셀의 30%만 써서
      // 패치 경계의 번짐/정렬 오차가 측정값에 섞이지 않게 한다.
      center: { x: cx / width, y: cy / height },
      sampleRadius: {
        x: (cellW * 0.3) / width,
        y: (cellH * 0.3) / height,
      },
    };
  });

  // 네 모서리 기준점. 검은 테두리 한가운데에 흰 정사각형으로 박는다.
  // 순서 고정: 좌상 → 우상 → 우하 → 좌하
  const fidSize = Math.max(4, Math.round(border * FIDUCIAL_RATIO));
  const half = border / 2;
  const fiducials = [
    { name: 'TL', x: half, y: half },
    { name: 'TR', x: width - half, y: half },
    { name: 'BR', x: width - half, y: height - half },
    { name: 'BL', x: half, y: height - half },
  ].map((f) => ({
    ...f,
    size: fidSize,
    rect: {
      x: Math.round(f.x - fidSize / 2),
      y: Math.round(f.y - fidSize / 2),
      w: fidSize,
      h: fidSize,
    },
    center: { x: f.x / width, y: f.y / height },
  }));

  return {
    version: 2,
    media: mediaKey,
    mediaLabel: media.label,
    width,
    height,
    cols,
    rows,
    border,
    fiducials,
    patchCount: placed.length,
    patches: placed,
  };
}

module.exports = { MEDIA, buildChartSpec, buildPatches };
