'use strict';

/**
 * 스캐너 소프트웨어가 결과를 PDF로 저장하는 경우가 흔하다 (한 페이지짜리
 * "스캔 문서"). 이런 PDF는 대개 JPEG 한 장을 그대로 컨테이너에 넣은
 * 것뿐이라, 전체 PDF 렌더링 엔진 없이도 그 JPEG 스트림만 꺼내면 된다.
 *
 * 지원 범위: 단일 이미지가 /Filter [/FlateDecode /DCTDecode] 또는
 * /Filter /DCTDecode 로 들어있는 흔한 "스캔 후 PDF 저장" 패턴.
 * 이 범위를 벗어나면(다중 페이지, 벡터 포함 등) 조용히 실패하는 대신
 * 이유를 알려주고 수동 변환을 안내한다 — 잘못된 이미지를 엉뚱하게
 * 뽑아내는 것보다 명확히 실패하는 게 낫다.
 */

const fs = require('fs');
const zlib = require('zlib');

/** 이미지 XObject 하나의 스트림 바이트를 뽑아 JPEG 파일로 만든다. */
function extractStream(buf, objStart, filters) {
  const streamKW = Buffer.from('stream');
  let streamIdx = buf.indexOf(streamKW, objStart);
  if (streamIdx < 0) return null;
  streamIdx += streamKW.length;
  if (buf[streamIdx] === 0x0d) streamIdx++;
  if (buf[streamIdx] === 0x0a) streamIdx++;

  const endIdx = buf.indexOf(Buffer.from('endstream'), streamIdx);
  if (endIdx < 0) return null;

  let raw = buf.slice(streamIdx, endIdx);
  if (filters.includes('FlateDecode')) {
    try {
      raw = zlib.inflateSync(raw);
    } catch {
      return null;
    }
  }
  // DCTDecode(JPEG)만 지원한다. 다른 필터(CCITTFax 등 흑백 팩스 압축)는
  // 흑백 문서 스캔 모드일 가능성이 높아 색 캘리브레이션에 못 쓴다.
  if (!filters.includes('DCTDecode')) return null;
  if (raw[0] !== 0xff || raw[1] !== 0xd8) return null; // JPEG 시그니처 확인
  return raw;
}

/**
 * PDF 안의 이미지들 중 가장 큰 것을 JPEG으로 추출한다.
 * (여러 오브젝트가 있으면 아이콘/워터마크 같은 작은 것들이 섞여있을 수 있어
 *  가로x세로가 가장 큰 것을 실제 스캔 이미지로 간주한다.)
 */
function extractLargestImage(pdfPath) {
  const buf = fs.readFileSync(pdfPath);
  const text = buf.toString('latin1');

  const objRe = /(\d+)\s+0\s+obj\s*<<([^]*?)>>\s*stream/g;
  let m;
  let best = null;

  while ((m = objRe.exec(text))) {
    const dict = m[2];
    if (!/\/Subtype\s*\/Image/.test(dict)) continue;

    const wMatch = /\/Width\s+(\d+)/.exec(dict);
    const hMatch = /\/Height\s+(\d+)/.exec(dict);
    if (!wMatch || !hMatch) continue;
    const width = parseInt(wMatch[1], 10);
    const height = parseInt(hMatch[1], 10);

    const filterMatch = /\/Filter\s*(\[[^\]]*\]|\/[A-Za-z0-9]+)/.exec(dict);
    const filters = filterMatch ? (filterMatch[1].match(/[A-Za-z0-9]+Decode/g) || []) : [];

    const area = width * height;
    if (best && area <= best.area) continue;

    const objStart = m.index;
    const jpeg = extractStream(buf, objStart, filters);
    if (jpeg) best = { area, width, height, jpeg };
  }

  if (!best) {
    throw new Error(
      'PDF 안에서 컬러 스캔 이미지를 찾지 못했습니다.\n' +
      '  · 스캔이 흑백/문서 모드로 되어있으면 색 정보가 없어 사용할 수 없습니다.\n' +
      '    스캐너 설정을 "컬러 사진"으로 바꿔 다시 스캔하세요.\n' +
      '  · 스캐너 앱에서 JPG/PNG로 직접 저장할 수 있다면 그쪽을 권장합니다.'
    );
  }
  return best;
}

/** PDF에서 이미지를 뽑아 옆에 .jpg로 저장하고 그 경로를 반환한다. */
function extractToJpeg(pdfPath, outPath) {
  const { jpeg, width, height } = extractLargestImage(pdfPath);
  fs.writeFileSync(outPath, jpeg);
  return { outPath, width, height };
}

module.exports = { extractLargestImage, extractToJpeg };
