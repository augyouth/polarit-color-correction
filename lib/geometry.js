'use strict';

/**
 * 4점 대응으로 호모그래피(투영변환)를 구한다.
 *
 * 스캐너에 프린트를 손으로 올리면 회전이 생기고, 필름이 살짝 휘어 있으면
 * 미세한 사다리꼴 왜곡도 생긴다. 아핀변환(3점)으로는 후자를 못 잡으므로
 * 네 모서리 기준점을 모두 써서 호모그래피를 푼다.
 *
 * src/dst 는 각각 [{x,y} x4], 순서가 서로 대응해야 한다.
 * 반환값은 3x3 행렬을 행 우선으로 편 길이 9 배열.
 */
function solveHomography(src, dst) {
  if (src.length !== 4 || dst.length !== 4) {
    throw new Error('호모그래피는 정확히 4점 대응이 필요합니다');
  }

  // h33 = 1 로 고정하고 나머지 8개 미지수를 푼다.
  const A = [];
  const b = [];

  for (let i = 0; i < 4; i++) {
    const { x, y } = src[i];
    const { x: u, y: v } = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    b.push(v);
  }

  const h = solveLinear(A, b);
  return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
}

/** 부분 피벗팅 가우스 소거법. n x n 정방계 전용. */
function solveLinear(A, b) {
  const n = b.length;
  const m = A.map((row, i) => [...row, b[i]]);

  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(m[r][col]) > Math.abs(m[pivot][col])) pivot = r;
    }
    if (Math.abs(m[pivot][col]) < 1e-12) {
      throw new Error('기준점이 일직선상에 있거나 겹칩니다 — 변환을 풀 수 없습니다');
    }
    [m[col], m[pivot]] = [m[pivot], m[col]];

    const d = m[col][col];
    for (let c = col; c <= n; c++) m[col][c] /= d;

    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = m[r][col];
      if (f === 0) continue;
      for (let c = col; c <= n; c++) m[r][c] -= f * m[col][c];
    }
  }

  return m.map((row) => row[n]);
}

/** 호모그래피로 점 하나를 변환한다. */
function applyHomography(H, x, y) {
  const w = H[6] * x + H[7] * y + H[8];
  return {
    x: (H[0] * x + H[1] * y + H[2]) / w,
    y: (H[3] * x + H[4] * y + H[5]) / w,
  };
}

module.exports = { solveHomography, applyHomography, solveLinear };
