'use strict';

/**
 * 현장용 사이트를 로컬에서 확인하기 위한 정적 서버.
 * 배포 전에 PC와 같은 Wi-Fi의 휴대폰에서도 열어볼 수 있게 LAN 주소를 같이 보여준다.
 * 배포에는 이 서버가 필요 없다 — site/ 폴더만 올리면 된다.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { build } = require('./site_build');

const PORT = 4281;
const ROOT = __dirname;
const SITE = path.join(ROOT, 'site');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.cube': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

function resolveSafe(base, urlPath) {
  const decoded = decodeURIComponent(urlPath);
  const full = path.normalize(path.join(base, decoded));
  if (!full.startsWith(base)) return null;
  return full;
}

function serveFile(res, file) {
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); return res.end('Not Found');
  }
  res.writeHead(200, {
    'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'Cache-Control': 'no-store',
  });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  let p = url.pathname;

  // 로컬 테스트 전용: 프로젝트 폴더의 파일을 읽기 전용으로 노출 (배포본에는 없음)
  if (p.startsWith('/__dev/')) {
    const f = resolveSafe(ROOT, p.slice('/__dev/'.length));
    return f ? serveFile(res, f) : (res.writeHead(403), res.end());
  }

  if (p === '/') p = '/index.html';
  const f = resolveSafe(SITE, p);
  if (!f) { res.writeHead(403); return res.end(); }
  serveFile(res, f);
});

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list) if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
  }
  return out;
}

try {
  const { presets } = build();
  console.log(`보정 데이터: ${presets.map((p) => p.label).join(', ')}`);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n현장용 사이트 미리보기`);
  console.log(`  PC:      http://localhost:${PORT}`);
  for (const ip of lanAddresses()) console.log(`  휴대폰:  http://${ip}:${PORT}   (같은 Wi-Fi에서)`);
  console.log(`\n배포할 때는 ${SITE} 폴더를 올리면 됩니다.`);
});
