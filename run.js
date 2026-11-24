'use strict';

/**
 * 필름 색보정 파이프라인 진입점.
 *
 *   node run.js 차트 [mini|square|wide|polaroid]
 *   node run.js 측정 <스캔이미지> [매체]
 *   node run.js 보정 <사진폴더|사진파일> [매체]
 */

const fs = require('fs');
const path = require('path');
const { generate } = require('./lib/generate');
const { measure } = require('./lib/measure');
const { build, readCube } = require('./lib/lut');
const { applyToFolder, applyToImage } = require('./lib/apply');
const { MEDIA } = require('./lib/chart');
const finetune = require('./lib/finetune');
const { extractToJpeg } = require('./lib/pdfimage');

const ROOT = __dirname;
const CHART_DIR = path.join(ROOT, '차트');
const LUT_DIR = path.join(ROOT, 'LUT');

const MEDIA_KEYS = Object.keys(MEDIA);

/**
 * 매체가 여러 개 준비되어 있을 수 있으므로(미니/와이드 병행 등),
 * 명시하지 않으면 가장 최근에 만들어진 것을 쓴다.
 * 첫 번째로 발견된 것을 쓰면 예전 매체가 잘못 선택된다.
 */
function newestMedia(dir, pattern) {
  const found = MEDIA_KEYS
    .map((k) => ({ key: k, file: path.join(dir, pattern(k)) }))
    .filter((e) => fs.existsSync(e.file))
    .map((e) => ({ ...e, mtime: fs.statSync(e.file).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return found;
}

function resolveMedia(arg) {
  if (arg && MEDIA[arg]) return arg;
  if (arg) {
    console.error(`알 수 없는 매체 "${arg}". 가능한 값: ${MEDIA_KEYS.join(', ')}`);
    process.exit(1);
  }
  const found = newestMedia(LUT_DIR, (k) => `보정_${k}.cube`);
  if (!found.length) {
    console.error(`매체를 지정하세요: ${MEDIA_KEYS.join(', ')}`);
    process.exit(1);
  }
  if (found.length > 1) {
    console.log(`  LUT이 여러 개 있어 가장 최근 것을 씁니다: ${MEDIA[found[0].key].label}`);
    console.log(`  (다른 것을 쓰려면: node run.js 보정 <폴더> ${found[1].key})`);
  }
  return found[0].key;
}

async function cmdChart(mediaKey) {
  const key = mediaKey && MEDIA[mediaKey] ? mediaKey : 'mini';
  const { spec, pngPath } = await generate(key, CHART_DIR);
  console.log(`\n[1단계] 캘리브레이션 차트 생성 완료`);
  console.log(`  매체   : ${spec.mediaLabel} (${spec.width}x${spec.height})`);
  console.log(`  파일   : ${pngPath}`);
  console.log(`\n다음 할 일`);
  console.log(`  1. 이 PNG를 평소 인화하던 방법 그대로 필름에 인화하세요.`);
  console.log(`     (앱 자동보정/필터/밝기조절은 전부 끄고, 평소 설정 그대로)`);
  console.log(`  2. 인화물을 스캔하세요. 스캐너 자동 노출/자동 색보정은 반드시 끄세요.`);
  console.log(`  3. 스캔 파일을 2_LUT만들기.bat 에 끌어다 놓으세요.`);
}

async function cmdMeasure(scanPath, mediaArg) {
  if (!scanPath || !fs.existsSync(scanPath)) {
    console.error('스캔 이미지 경로가 필요합니다.');
    process.exit(1);
  }

  // 스캐너 앱이 결과를 PDF로 저장하는 경우가 흔하다. 안에 든 JPEG을
  // 자동으로 꺼내서 쓴다 — 사용자가 매번 수동 변환할 필요 없게.
  if (path.extname(scanPath).toLowerCase() === '.pdf') {
    const jpegPath = path.join(path.dirname(scanPath), `${path.basename(scanPath, path.extname(scanPath))}_추출.jpg`);
    const { width, height } = extractToJpeg(scanPath, jpegPath);
    console.log(`  PDF에서 이미지 추출 : ${jpegPath} (${width}x${height})`);
    scanPath = jpegPath;
  }

  let key = mediaArg && MEDIA[mediaArg] ? mediaArg : null;
  if (!key) {
    const found = newestMedia(CHART_DIR, (k) => `차트_${k}.json`);
    if (!found.length) {
      console.error('차트 사양 파일이 없습니다. 1_차트만들기.bat 을 먼저 실행하세요.');
      process.exit(1);
    }
    key = found[0].key;
    if (found.length > 1) {
      console.log(`  차트가 여러 개 있어 가장 최근 것을 씁니다: ${MEDIA[key].label}`);
    }
  }
  console.log(`  기준 차트 : ${MEDIA[key].label}`);

  const spec = JSON.parse(fs.readFileSync(path.join(CHART_DIR, `차트_${key}.json`), 'utf8'));
  fs.mkdirSync(LUT_DIR, { recursive: true });

  const overlay = path.join(LUT_DIR, `측정검증_${key}.png`);
  const res = await measure(scanPath, spec, overlay);

  const measPath = path.join(LUT_DIR, `측정결과_${key}.json`);
  fs.writeFileSync(measPath, JSON.stringify({ media: key, samples: res.samples }, null, 2), 'utf8');

  // 테두리가 잘려나가 대체 경로(res.fallback)로 측정한 경우, 3x3 행렬(색상
  // 간섭 보정)이 노이즈를 학습해 실제 사진에서 색이 과하게 튀는 걸 실사용
  // 중에 확인했다(2026-08-24, 피부톤이 심하게 붉어짐). 등록 정밀도가
  // 떨어지는 걸 아는 상태이므로, 이때는 처음부터 톤커브(밝기)만 쓰는 쪽을
  // 기본값으로 삼는다 — 무채색(밝기) 보정은 등록 정밀도와 무관하게 항상
  // 정확했다. 기준점이 온전한 정상 측정이면 행렬까지 그대로 신뢰한다.
  const matrixStrength = res.fallback ? 0 : 1;
  const { model, correction, simulation } = build(measPath, LUT_DIR, { label: key, matrixStrength });

  // 미세조정(4_미세조정.bat)이 항상 "측정 직후 상태"에서 다시 계산하도록
  // 손대지 않은 원본을 따로 보존해둔다. 새로 측정할 때마다 최신 것으로 갱신된다.
  fs.copyFileSync(correction, finetune.baselinePath(LUT_DIR, key));
  fs.writeFileSync(finetune.statePath(LUT_DIR, key), JSON.stringify(finetune.emptyTrim(), null, 2), 'utf8');

  console.log(`\n[2단계] 측정 및 LUT 생성 완료`);
  if (res.rotation) console.log(`  · ${res.rotation}도 돌아간 스캔으로 판단해 자동 보정했습니다.`);
  if (res.fallback) {
    console.log(`  · 인화 과정에서 테두리/기준점이 잘려나간 것으로 보여, 남은 패치 덩어리의`);
    console.log(`    꼭짓점을 대신 기준으로 썼습니다. 다음 인화부터는 여백을 넉넉히 두거나`);
    console.log(`    인화 앱의 "꽉 채우기/자동 크롭" 설정을 끄면 이 대체 경로를 안 타도 됩니다.`);
    console.log(`  · 이 경우 색상 간섭 보정(행렬)이 노이즈에 민감해, 기본으로 톤커브(밝기)만`);
    console.log(`    적용했습니다. 원색 보정까지 원하시면: node run.js 모델 ${key} 전체`);
  }
  console.log(`  방향 신뢰도 : ${res.score.toFixed(3)} (1에 가까울수록 좋음)`);

  const g = model.fit.groups;
  const fmtGroup = (name, label) => g[name] ? `${label} 평균${g[name].mean.toFixed(1)}/최대${g[name].worst.toFixed(1)}` : null;
  const groupLine = ['neutral', 'highlight', 'skin', 'hue']
    .map((k) => fmtGroup(k, { neutral: '무채색(밝기)', highlight: '하이라이트', skin: '피부톤', hue: '원색' }[k]))
    .filter(Boolean).join('  ·  ');
  console.log(`  모델 적합도 : ${groupLine}`);
  console.log(`  필름 재현범위 : R ${model.range[0].map((v) => v.toFixed(0)).join('~')}  ` +
              `G ${model.range[1].map((v) => v.toFixed(0)).join('~')}  ` +
              `B ${model.range[2].map((v) => v.toFixed(0)).join('~')}`);
  console.log(`\n  보정 LUT     : ${correction}`);
  console.log(`  시뮬레이션LUT : ${simulation}`);
  console.log(`  측정 검증본   : ${overlay}`);

  // "밝기 문제"(무채색)와 "색 자체가 틀어지는 문제"(원색)는 원인이 다르다.
  // 무채색이 나쁘면 정렬/측정 자체가 잘못된 것 — 재촬영해야 한다.
  // 무채색은 좋은데 원색만 나쁘면 정렬은 맞지만 필름의 염료 크로스토크가
  // 지금 모델(선형 3x3 행렬)로 다 안 잡힌다는 뜻 — 그래도 밝기 문제는
  // 정확히 해결되므로 실사용에는 크게 지장 없는 경우가 많다.
  const neutralBad = g.neutral && g.neutral.worst > 6;
  // 60 이상은 "필름 염료 간섭" 수준을 훌쩍 넘는다 — 패치 자체를 잘못 짚었을
  // 가능성이 높다(테두리가 잘려나간 스캔에서 하이라이트/피부톤 쪽 격자가
  // 살짝 밀리는 경우가 실제로 있었다, 2026-08-24). 이땐 원색 크로스토크
  // 메시지 대신 정렬 확인을 권한다. 'hue' 는 여기서 뺀다 — matrixStrength=0
  // (톤전용)일 땐 행렬을 일부러 껐으니 원색 오차가 크게 나오는 게 정상이고,
  // 그건 정렬 문제가 아니다.
  const misaligned = ['skin', 'highlight'].some((k) => g[k] && g[k].worst > 60);
  const hueBad = matrixStrength > 0 && g.hue && g.hue.worst > 20;

  if (neutralBad || misaligned) {
    console.log(`\n  ⚠ ${neutralBad ? '무채색(밝기)' : '일부 패치'} 적합도가 좋지 않습니다 — 정렬이 살짝 밀렸을 가능성이 있습니다.`);
    console.log(`    측정 검증본을 열어 초록 사각형이 각 패치 안에 제대로 들어갔는지 확인하세요.`);
    console.log(`    정렬이 맞는데도 나쁘다면 스캐너 자동보정이 켜져 있을 가능성이 높습니다.`);
    if (res.fallback) {
      console.log(`    테두리 대체 경로를 썼는데 이런 경우, 여백을 넉넉히 두고 다시 인화하면`);
      console.log(`    기준점 방식으로 측정되어 훨씬 정확해집니다.`);
    }
  } else if (hueBad) {
    console.log(`\n  ⚠ 채도 높은 원색에서 오차가 큽니다 — 무채색(밝기)은 정확해서 정렬 문제는 아니고,`);
    console.log(`    필름 자체의 염료 간 간섭이 지금 모델로 다 안 잡히는 것으로 보입니다.`);
    console.log(`    "화면보다 밝고 날아간다"는 원래 문제(밝기)는 정확히 보정됩니다.`);
    console.log(`    일단 3_사진보정.bat 으로 실사진에 적용해 눈으로 확인해보세요 —`);
    console.log(`    채도 높은 색이 많이 어긋나 보이면 알려주시면 모델을 더 손보겠습니다.`);
  } else if (matrixStrength === 0) {
    console.log(`\n  ✅ 밝기 보정 양호 (톤커브만 적용, 원색 보정은 끔). 3_사진보정.bat 으로 사진을 보정하세요.`);
  } else {
    console.log(`\n  ✅ 적합도 양호. 3_사진보정.bat 으로 사진을 보정하세요.`);
  }
  console.log(`\n  ※ 측정 검증본을 한 번 열어보고 초록 사각형 위치를 확인하는 걸 권장합니다.`);
}

async function cmdApply(target, mediaArg) {
  if (!target || !fs.existsSync(target)) {
    console.error('보정할 사진 폴더 또는 파일 경로가 필요합니다.');
    process.exit(1);
  }

  const key = resolveMedia(mediaArg);
  const cubePath = path.join(LUT_DIR, `보정_${key}.cube`);
  if (!fs.existsSync(cubePath)) {
    console.error(`보정 LUT이 없습니다: ${cubePath}`);
    console.error('2_LUT만들기.bat 을 먼저 실행하세요.');
    process.exit(1);
  }

  const stat = fs.statSync(target);
  if (stat.isDirectory()) {
    const outDir = path.join(target, '인화용_보정본');
    const done = await applyToFolder(target, cubePath, outDir);
    console.log(`\n[3단계] ${done.length}장 보정 완료`);
    console.log(`  출력: ${outDir}`);
  } else {
    const lut = readCube(cubePath);
    const dir = path.dirname(target);
    const base = path.basename(target, path.extname(target));
    const outDir = path.join(dir, '인화용_보정본');
    fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, `${base}_보정.png`);
    await applyToImage(target, lut, outPath);
    console.log(`\n[3단계] 보정 완료 → ${outPath}`);
  }
  console.log(`\n  이 폴더의 파일을 인화하세요. 인화 앱에서 추가 보정은 켜지 마세요.`);
}

/**
 * 보정을 적용하지 않은 원본 사진에 "시뮬레이션 LUT"(정방향 모델)을 씌워,
 * 이 사진을 그냥 그대로 인화하면 어떻게 나올지 미리 보여준다.
 * 3단계(보정 적용)와는 반대 방향 — 화면에서 인화 결과를 가늠해보는 용도.
 */
async function cmdPreview(target, mediaArg) {
  if (!target || !fs.existsSync(target)) {
    console.error('미리 볼 사진 폴더 또는 파일 경로가 필요합니다.');
    process.exit(1);
  }

  const key = resolveMedia(mediaArg);
  const cubePath = path.join(LUT_DIR, `시뮬레이션_${key}.cube`);
  if (!fs.existsSync(cubePath)) {
    console.error(`시뮬레이션 LUT이 없습니다: ${cubePath}`);
    console.error('2_LUT만들기.bat 을 먼저 실행하세요.');
    process.exit(1);
  }

  const stat = fs.statSync(target);
  if (stat.isDirectory()) {
    const outDir = path.join(target, '인화예상본');
    const done = await applyToFolder(target, cubePath, outDir, '_인화예상');
    console.log(`\n[미리보기] ${done.length}장 생성 완료`);
    console.log(`  출력: ${outDir}`);
  } else {
    const lut = readCube(cubePath);
    const dir = path.dirname(target);
    const base = path.basename(target, path.extname(target));
    const outDir = path.join(dir, '인화예상본');
    fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, `${base}_인화예상.png`);
    await applyToImage(target, lut, outPath);
    console.log(`\n[미리보기] 생성 완료 → ${outPath}`);
  }
  console.log(`\n  ※ 이건 보정용 파일이 아니라 미리보기용입니다 — 이걸 인화하지 마세요.`);
  console.log(`    인화하려면 원본을 3_사진보정.bat 에 넣어서 나온 "인화용_보정본"을 쓰세요.`);
}

/**
 * 이미 측정된 데이터에서 크로스토크 행렬 반영 정도 + 색역압축 강도를 바꿔
 * LUT을 다시 굽는다. 재측정(재인화·재스캔) 없이 즉시 적용 가능.
 *
 * 두 손잡이는 서로 다른 증상을 겨냥한다:
 *   행렬 강도(matrixStrength)  : 색이 과하게 튀는 문제. 3x3 행렬은 원색
 *     패치에서 통계적으로 추정한 것이라 측정 노이즈에 민감하다.
 *   색역압축 강도(rangeStrength): 대비가 눌리고 뿌옇게 보이는 문제. 필름이
 *     낼 수 있는 좁은 범위로 목표색을 미리 압축해두는 정도인데, 세게
 *     압축할수록(1에 가까울수록) 하이라이트/섀도우 뭉개짐은 막아주지만
 *     대신 전체 대비가 줄어든다 — 실사용에서 "뭘로 덮인 느낌"으로 나타난
 *     걸 확인했다(2026-09-09). 낮출수록 대비는 살지만 아주 밝거나 어두운
 *     색은 뭉개질 위험이 커진다.
 */
async function cmdModel(mediaArg, matrixArg, rangeArg) {
  if (!(mediaArg && MEDIA[mediaArg]) && !newestMedia(LUT_DIR, (k) => `측정결과_${k}.json`).length) {
    console.error('아직 측정 결과가 없습니다. 2_LUT만들기.bat 을 먼저 실행하세요.');
    process.exit(1);
  }
  const key = mediaArg && MEDIA[mediaArg]
    ? mediaArg
    : newestMedia(LUT_DIR, (k) => `측정결과_${k}.json`)[0].key;

  const presets = { 전체: 1, 톤전용: 0, 톤커브만: 0 };
  let matrixStrength = presets[matrixArg];
  if (matrixStrength === undefined) matrixStrength = parseFloat(matrixArg);
  if (!Number.isFinite(matrixStrength) || matrixStrength < 0 || matrixStrength > 1) {
    console.error('행렬 강도는 0(톤전용) ~ 1(전체) 사이 숫자이거나 "전체"/"톤전용" 이어야 합니다.');
    process.exit(1);
  }

  let rangeStrength = rangeArg === undefined ? 1 : parseFloat(rangeArg);
  if (!Number.isFinite(rangeStrength) || rangeStrength < 0 || rangeStrength > 1) {
    console.error('색역압축 강도는 0(압축 안 함, 대비 최대) ~ 1(최대 압축, 안전 최대) 사이여야 합니다.');
    process.exit(1);
  }

  const measPath = path.join(LUT_DIR, `측정결과_${key}.json`);
  if (!fs.existsSync(measPath)) {
    console.error(`측정 결과가 없습니다: ${measPath}`);
    process.exit(1);
  }

  const { model, correction } = build(measPath, LUT_DIR, { label: key, matrixStrength, strength: rangeStrength });
  fs.copyFileSync(correction, finetune.baselinePath(LUT_DIR, key));
  fs.writeFileSync(finetune.statePath(LUT_DIR, key), JSON.stringify(finetune.emptyTrim(), null, 2), 'utf8');

  console.log(`\n[${MEDIA[key].label}] 행렬강도=${matrixStrength} 색역압축강도=${rangeStrength} 로 재생성`);
  console.log(`  모델 적합도 : 무채색 평균${model.fit.groups.neutral.mean.toFixed(1)}  ` +
              `원색 평균${model.fit.groups.hue.mean.toFixed(1)}/최대${model.fit.groups.hue.worst.toFixed(1)}  ` +
              `피부톤 평균${model.fit.groups.skin.mean.toFixed(1)}/최대${model.fit.groups.skin.worst.toFixed(1)}`);
  console.log(`  적용된 LUT  : ${correction}`);
  console.log(`\n  ⚠ 3_사진보정.bat 을 다시 돌려야 이 변경이 사진에 반영됩니다.`);
}

async function cmdAdjust(mediaArg, actionArg) {
  if (!(mediaArg && MEDIA[mediaArg]) && !newestMedia(LUT_DIR, (k) => `보정_${k}.cube`).length) {
    console.error('아직 만들어진 LUT이 없습니다. 2_LUT만들기.bat 을 먼저 실행하세요.');
    process.exit(1);
  }
  const key = resolveMedia(mediaArg && MEDIA[mediaArg] ? mediaArg : null);

  if (!actionArg || actionArg === '상태') {
    const trim = finetune.loadState(LUT_DIR, key);
    console.log(`\n[${MEDIA[key].label}] 현재 조정 상태`);
    console.log(`  ${finetune.describeTrim(trim)}`);
    console.log(`\n  조정 가능: ${Object.keys(finetune.ACTIONS).join(' · ')} · 초기화`);
    return;
  }
  if (actionArg === '초기화') {
    finetune.reset(LUT_DIR, key);
    console.log(`\n[${MEDIA[key].label}] 기준 상태로 초기화했습니다.`);
    console.log(`  ⚠ 이미 내보낸 사진이 있다면 3_사진보정.bat 을 다시 돌려야 반영됩니다.`);
    return;
  }

  const { trim, capped } = finetune.nudge(LUT_DIR, key, actionArg);
  console.log(`\n[${MEDIA[key].label}] "${actionArg}" 적용`);
  console.log(`  현재 누적 조정 : ${finetune.describeTrim(trim)}`);
  if (capped) {
    console.log(`\n  ⚠ 조정 한도에 도달했습니다. 이 이상 필요하다면 미세조정으로는 부족하다는 뜻입니다.`);
    console.log(`    차트를 다시 인화·스캔해서 처음부터 재측정하는 걸 권합니다.`);
  }
  console.log(`\n  ⚠ 3_사진보정.bat 을 다시 돌려야 이 조정이 사진에 반영됩니다.`);
  console.log(`    (기존에 이미 만든 "인화용_보정본" 파일은 예전 상태 그대로입니다)`);
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd) {
    case '차트': return cmdChart(args[0]);
    case '측정': return cmdMeasure(args[0], args[1]);
    case '보정': return cmdApply(args[0], args[1]);
    case '조정': return cmdAdjust(args[0], args[1]);
    case '모델': return cmdModel(args[0], args[1], args[2]);
    case '미리보기': return cmdPreview(args[0], args[1]);
    default:
      console.log('사용법:');
      console.log(`  node run.js 차트 [${MEDIA_KEYS.join('|')}]   캘리브레이션 차트 생성`);
      console.log('  node run.js 측정 <스캔이미지>              측정 및 LUT 생성');
      console.log('  node run.js 보정 <사진폴더>                사진에 보정 적용');
      console.log('  node run.js 조정 <매체> <밝게|어둡게|...>  눈으로 본 미세한 편차 조정');
      console.log('  node run.js 모델 <매체> <전체|톤전용|0~1> [색역압축강도 0~1]  강도 재조정');
      console.log('  node run.js 미리보기 <사진폴더>            보정 없이 인화하면 어떨지 미리보기');
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(`\n오류: ${err.message}`);
  process.exit(1);
});
