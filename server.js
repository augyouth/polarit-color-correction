'use strict';

/**
 * 로컬 웹 대시보드 — 슬라이더로 실시간 미리보기 보면서 보정 설정을 잡는 도구.
 *
 * CLI(node run.js 조정/모델)로 값 하나씩 바꿔가며 결과를 다시 인화해보는
 * 반복이 너무 느려서 만들었다. 여기서는 사진 한 장을 올려두고 슬라이더를
 * 움직이면 그 자리에서 "보정본이 이렇게 생겼다" / "인화하면 이렇게
 * 나온다"를 바로 보여준다. 실제 대량 보정(폴더 전체)은 여전히
 * 3_사진보정.bat 이 담당 — 여기서는 "어떤 설정으로 저장할지"만 정하고,
 * 저장(=LUT/조정 파일 갱신)하면 그 설정이 3단계에 그대로 반영된다.
 *
 * 의존성 추가 없이 Node 내장 http 모듈만 쓴다. 사진은 브라우저에서 원시
 * 바이트로 POST 하고(별도 라이브러리 없이 요청 스트림을 그대로 모은다),
 * 미리보기 결과는 PNG 바이너리로 그대로 응답한다.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const { buildModel, buildCorrectionGrid, buildSimulationGrid, build, readCube, writeCube } = require('./lib/lut');
const { makeLutSampler } = require('./lib/apply');
const finetune = require('./lib/finetune');
const { MEDIA } = require('./lib/chart');

const PORT = 4279;
const ROOT = __dirname;
const LUT_DIR = path.join(ROOT, 'LUT');

// 실시간 미리보기용 축소 크기와 LUT 격자 크기. 저장할 땐 lib/lut.js 의
// 기본값(33)으로 다시 정식으로 굽는다 — 여기는 어디까지나 "느낌만 빠르게".
const PREVIEW_MAX = 640;
const PREVIEW_GRID = 17;

// ── 매체(가장 최근 측정된 것) 자동 선택 ──────────────────────────────
function newestMediaKey() {
  const found = Object.keys(MEDIA)
    .map((k) => ({ key: k, file: path.join(LUT_DIR, `측정결과_${k}.json`) }))
    .filter((e) => fs.existsSync(e.file))
    .map((e) => ({ ...e, mtime: fs.statSync(e.file).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return found[0]?.key || null;
}

function settingsPath(key) { return path.join(LUT_DIR, `모델설정_${key}.json`); }

function loadSettings(key) {
  const p = settingsPath(key);
  if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  return { matrixStrength: 0, rangeStrength: 1 };
}
function saveSettings(key, s) {
  fs.writeFileSync(settingsPath(key), JSON.stringify(s, null, 2), 'utf8');
}

// ── 상태: 지금 웹페이지에 올라와 있는 사진(서버 프로세스 안에서만 유지) ──
let current = null; // { data(raw RGB Buffer), width, height }

// ── 측정 샘플 캐시 (매체별) ──────────────────────────────────────────
const sampleCache = new Map();
function getSamples(key) {
  if (!sampleCache.has(key)) {
    const meas = JSON.parse(fs.readFileSync(path.join(LUT_DIR, `측정결과_${key}.json`), 'utf8'));
    sampleCache.set(key, meas.samples);
  }
  return sampleCache.get(key);
}

/** 미리보기용 그리드를 즉석에서 만든다 (저장용 33단계보다 훨씬 작다). */
function buildPreviewGrids(key, matrixStrength, rangeStrength) {
  const model = buildModel(getSamples(key), { matrixStrength });
  const corrGrid = buildCorrectionGrid(model, PREVIEW_GRID, rangeStrength);
  const simGrid = buildSimulationGrid(model, PREVIEW_GRID);
  return { model, corrGrid, simGrid };
}

function clampByte(v) { return v < 0 ? 0 : v > 255 ? 255 : Math.round(v); }

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function sendError(res, status, message) {
  console.error('오류:', message);
  sendJson(res, status, { error: message });
}

// ── HTTP 서버 ─────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);

    if (req.method === 'GET' && url.pathname === '/') {
      const html = fs.readFileSync(path.join(ROOT, 'web', 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    }

    if (req.method === 'GET' && url.pathname === '/api/status') {
      const key = newestMediaKey();
      if (!key) return sendJson(res, 200, { ready: false });
      const settings = loadSettings(key);
      const trim = finetune.loadState(LUT_DIR, key);
      return sendJson(res, 200, {
        ready: true,
        media: key,
        mediaLabel: MEDIA[key].label,
        ...settings,
        trim,
        hasPhoto: !!current,
      });
    }

    if (req.method === 'POST' && url.pathname === '/api/upload') {
      const key = newestMediaKey();
      if (!key) return sendError(res, 400, '아직 측정된 LUT이 없습니다. 2_LUT만들기.bat 을 먼저 실행하세요.');

      const raw = await readBody(req);
      if (!raw.length) return sendError(res, 400, '빈 파일입니다.');

      const img = sharp(raw).rotate();
      const meta = await img.metadata();
      const scale = Math.min(1, PREVIEW_MAX / Math.max(meta.width, meta.height));
      const w = Math.max(1, Math.round(meta.width * scale));
      const h = Math.max(1, Math.round(meta.height * scale));
      const { data } = await img.resize(w, h).removeAlpha().raw().toBuffer({ resolveWithObject: true });

      current = { data, width: w, height: h };
      return sendJson(res, 200, { width: w, height: h });
    }

    if (req.method === 'GET' && url.pathname === '/api/original.png') {
      if (!current) return sendError(res, 404, '올라온 사진이 없습니다.');
      const png = await sharp(current.data, { raw: { width: current.width, height: current.height, channels: 3 } }).png().toBuffer();
      res.writeHead(200, { 'Content-Type': 'image/png' });
      return res.end(png);
    }

    if (req.method === 'POST' && url.pathname === '/api/preview') {
      if (!current) return sendError(res, 400, '먼저 사진을 올려주세요.');
      const key = newestMediaKey();
      if (!key) return sendError(res, 400, '측정된 LUT이 없습니다.');

      const bodyBuf = await readBody(req);
      const params = JSON.parse(bodyBuf.toString('utf8') || '{}');
      const matrixStrength = clamp01(params.matrixStrength ?? 0);
      const rangeStrength = clamp01(params.rangeStrength ?? 1);
      const trim = {
        ev: numOr(params.ev, 0),
        warm: numOr(params.warm, 0),
        tint: numOr(params.tint, 0),
      };
      const mode = params.mode === 'predicted' ? 'predicted' : 'corrected';

      const { model, corrGrid, simGrid } = buildPreviewGrids(key, matrixStrength, rangeStrength);
      const trimmedCorr = finetune.applyTrimToGrid(corrGrid, trim);
      const sampleCorr = makeLutSampler({ size: PREVIEW_GRID, grid: trimmedCorr });

      const { data, width, height } = current;
      const out = Buffer.alloc(data.length);
      const tmp = [0, 0, 0];
      for (let i = 0; i < data.length; i += 3) {
        sampleCorr([data[i], data[i + 1], data[i + 2]], tmp);
        if (mode === 'predicted') {
          const printed = model.forward(tmp);
          out[i] = clampByte(printed[0]); out[i + 1] = clampByte(printed[1]); out[i + 2] = clampByte(printed[2]);
        } else {
          out[i] = clampByte(tmp[0]); out[i + 1] = clampByte(tmp[1]); out[i + 2] = clampByte(tmp[2]);
        }
      }

      const png = await sharp(out, { raw: { width, height, channels: 3 } }).png().toBuffer();
      res.writeHead(200, { 'Content-Type': 'image/png' });
      return res.end(png);
    }

    if (req.method === 'POST' && url.pathname === '/api/save') {
      const key = newestMediaKey();
      if (!key) return sendError(res, 400, '측정된 LUT이 없습니다.');

      const bodyBuf = await readBody(req);
      const params = JSON.parse(bodyBuf.toString('utf8') || '{}');
      const matrixStrength = clamp01(params.matrixStrength ?? 0);
      const rangeStrength = clamp01(params.rangeStrength ?? 1);
      const trim = {
        ev: numOr(params.ev, 0),
        warm: numOr(params.warm, 0),
        tint: numOr(params.tint, 0),
      };

      const measPath = path.join(LUT_DIR, `측정결과_${key}.json`);
      const { correction } = build(measPath, LUT_DIR, { label: key, matrixStrength, strength: rangeStrength });
      fs.copyFileSync(correction, finetune.baselinePath(LUT_DIR, key));

      const { size, grid } = readCube(finetune.baselinePath(LUT_DIR, key));
      const trimmed = finetune.applyTrimToGrid(grid, trim);
      writeCube(trimmed, size, `${key} 웹 저장`, finetune.activePath(LUT_DIR, key));
      fs.writeFileSync(finetune.statePath(LUT_DIR, key), JSON.stringify(trim, null, 2), 'utf8');

      saveSettings(key, { matrixStrength, rangeStrength });

      return sendJson(res, 200, { saved: true, media: key });
    }

    res.writeHead(404);
    res.end('Not Found');
  } catch (err) {
    sendError(res, 500, err.message);
  }
});

function clamp01(v) { const n = Number(v); return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0; }
function numOr(v, d) { const n = Number(v); return Number.isFinite(n) ? n : d; }

server.listen(PORT, () => {
  console.log(`필름 색보정 대시보드: http://localhost:${PORT}`);
});
