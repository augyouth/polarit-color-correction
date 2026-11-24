// ==UserScript==
// @name         폴라릿 프레임 일괄 등록·삭제
// @namespace    seobuk.polarit
// @version      1.4
// @description  프레임 관리에서 사진 여러 장을 고르면 자동으로 채워 연달아 등록하고, 체크한 프레임을 연달아 삭제한다.
// @match        https://settlement.photoism.kr/Polarit/ProductManagement/ProductFrame/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(() => {
  'use strict';

  // ── 규칙 (정주혁, 2026-11-03) ────────────────────────────────────────
  // 제목 = 파일명(확장자 제외, "_보정" 꼬리 제거), 노출순서 = 이어서 번호,
  // 메모 비움, 가격 0(기존 항목과 동일·서버가 숫자 필수), 썸네일 = 출력원본과 같은 사진, 랜덤카드 N, 판매여부 Y.
  const RULES = { stripSuffix: '_보정', price: 0, randomCard: 'N', onSale: 'Y' };

  // 페이지가 한 건 처리하는 동안 기다리는 한도. S3 업로드가 느리면 늘린다.
  const WAIT = { form: 30000, upload: 180000, submit: 60000 };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const url = new URL(location.href);
  const pageId = url.searchParams.get('id'); // 목록·등록에서는 테마 번호, 수정에서는 프레임 번호
  const onSearch = /\/ProductFrame\/Search/i.test(url.pathname);
  const onCreate = /\/ProductFrame\/Create/i.test(url.pathname);
  const onUpdate = /\/ProductFrame\/Update/i.test(url.pathname);
  if (!pageId || (!onSearch && !onCreate && !onUpdate)) return;

  const searchUrl = (theme) => `/Polarit/ProductManagement/ProductFrame/Search?id=${theme}`;
  const createUrl = (theme) => `/Polarit/ProductManagement/ProductFrame/Create?id=${theme}`;
  const updateUrl = (frame) => `/Polarit/ProductManagement/ProductFrame/Update?id=${frame}`;

  // 화면에 떠 있는 알림/오류창 글자 — 멈췄을 때 사유로 보여준다.
  const visibleDialogs = () => Array.from(document.querySelectorAll('[class*=modal], [class*=dialog], [class*=alert], [class*=popup]'))
    .filter((e) => e.offsetParent !== null && e.textContent.trim())
    .map((e) => e.textContent.trim().replace(/\s+/g, ' ').slice(0, 160));
  const dialogText = () => { const d = visibleDialogs(); return d.length ? ' 화면 알림: "' + d[d.length - 1] + '"' : ''; };
  const errorDialog = () => visibleDialogs().filter((t) => /에러|오류|error|실패/i.test(t)).pop();

  // ── 작업 상태 저장 (새로고침·페이지 이동에도 살아남게 IndexedDB) ───────
  function db() {
    return new Promise((res, rej) => {
      const req = indexedDB.open('polarit-bulk', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('kv');
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
  }
  async function loadJob() {
    const d = await db();
    return new Promise((res, rej) => { const r = d.transaction('kv').objectStore('kv').get('job'); r.onsuccess = () => res(r.result || null); r.onerror = () => rej(r.error); });
  }
  async function saveJob(job) {
    const d = await db();
    return new Promise((res, rej) => { const t = d.transaction('kv', 'readwrite'); if (job) t.objectStore('kv').put(job, 'job'); else t.objectStore('kv').delete('job'); t.oncomplete = res; t.onerror = () => rej(t.error); });
  }
  const jobTotal = (job) => (job.type === 'delete' ? job.ids.length : job.items.length);
  const jobLabel = (job) => (job.type === 'delete' ? '일괄 삭제' : '일괄 등록');

  // ── 화면 요소 찾기 ─────────────────────────────────────────────────
  const field = (label) => Array.from(document.querySelectorAll('.form-field'))
    .find((ff) => (ff.querySelector('.field-label')?.textContent || '').replace('*', '').trim() === label);
  const buttonByText = (txt, cls) => Array.from(document.querySelectorAll('button'))
    .find((b) => b.textContent.trim() === txt && (!cls || b.className.includes(cls)));
  const hasBlazor = (el) => !!el && Array.from(el.attributes).some((a) => a.name.startsWith('_bl_'));

  async function waitFor(fn, timeout, every = 300) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      try { const v = fn(); if (v) return v; } catch { /* 아직 */ }
      await sleep(every);
    }
    return null;
  }

  // ── 상태 패널 ───────────────────────────────────────────────────────
  let panel = null;
  const BTN = 'font:inherit;padding:4px 10px;border-radius:6px;border:1px solid #9ca3af;background:#374151;color:#fff;cursor:pointer';
  const BTN_DANGER = 'font:inherit;padding:6px 12px;border-radius:6px;border:none;background:#b91c1c;color:#fff;cursor:pointer;font-weight:600';
  function ensurePanel() {
    if (!panel) {
      panel = document.createElement('div');
      panel.style.cssText = 'position:fixed;right:18px;bottom:18px;z-index:99999;background:#1f2937;color:#fff;padding:12px 14px;border-radius:10px;font:13px/1.5 "Malgun Gothic",sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.3);min-width:260px;max-width:420px;';
      document.body.appendChild(panel);
    }
    return panel;
  }
  function showPanel(html, { stop = true } = {}) {
    ensurePanel();
    panel.innerHTML = html + (stop ? ` <div style="margin-top:8px;text-align:right"><button id="pbStop" style="${BTN}">중지</button></div>` : '');
    const stopBtn = panel.querySelector('#pbStop');
    if (stopBtn) stopBtn.onclick = async () => { await saveJob(null); panel.innerHTML = '중지했어요. 목록에서 다시 시작할 수 있어요.'; setTimeout(() => { panel.remove(); panel = null; }, 3000); };
  }

  // ── 입력 도우미 (Blazor 바인딩이 받도록 input/change 둘 다 보낸다) ─────
  function setText(label, value) {
    const inp = field(label).querySelector('input');
    inp.focus();
    inp.value = value;
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    inp.dispatchEvent(new Event('change', { bubbles: true }));
    inp.blur();
  }

  // 3단 토글(N · 상관없음 · Y)은 컨테이너 클릭 위치로 상태를 정한다.
  // 결과 클래스: toggle-container false(N) / null(상관없음) / true(Y)
  async function setToggle(label, want) {
    const box = field(label).querySelector('.toggle-container');
    const target = want === 'Y' ? 'true' : want === 'N' ? 'false' : 'null';
    const xs = want === 'Y' ? [0.92, 0.8, 0.98] : want === 'N' ? [0.08, 0.2, 0.02] : [0.5];
    for (const fx of xs) {
      if (box.className.includes(target)) return true;
      const r = box.getBoundingClientRect();
      const init = { bubbles: true, cancelable: true, clientX: r.left + r.width * fx, clientY: r.top + r.height / 2 };
      for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) box.dispatchEvent(new MouseEvent(type, init));
      await sleep(400);
    }
    return box.className.includes(target);
  }

  function setFile(label, file) {
    const inp = field(label).querySelector('input[type=file]');
    const dt = new DataTransfer();
    dt.items.add(file);
    inp.files = dt.files;
    inp.dispatchEvent(new Event('change', { bubbles: true }));
  }

  const fileReady = (label) => !!field(label)?.querySelector('img');
  const titleOf = (name) => {
    let t = name.replace(/\.[^.]+$/, '').normalize('NFC');
    if (RULES.stripSuffix && t.endsWith(RULES.stripSuffix)) t = t.slice(0, -RULES.stripSuffix.length);
    return t;
  };

  // 화면은 먼저 그려지고 Blazor 동작은 잠시 뒤에 붙을 수 있다. 동작이 붙으면 요소에
  // `_bl_…` 속성이 생기므로, 그걸 보고 나서 값을 넣어야 입력이 허공에 날아가지 않는다.
  const formInteractive = () =>
    hasBlazor(field('출력원본')?.querySelector('input[type=file]')) && hasBlazor(field('랜덤카드')?.querySelector('.toggle-container'));

  // 등록/삭제 뒤 "확인"을 눌러야 하는 인페이지 모달 — 맨 마지막 보이는 "확인"이 모달의 것이다.
  async function confirmModal() {
    const btn = await waitFor(() => Array.from(document.querySelectorAll('button')).filter((b) => b.textContent.trim() === '확인' && b.offsetParent !== null).pop(), 8000, 200);
    if (btn) btn.click();
    return !!btn;
  }

  // ── 목록 페이지 ──────────────────────────────────────────────────────
  function readRows() {
    const heads = Array.from(document.querySelectorAll('table thead th')).map((th) => th.textContent.trim());
    const col = (name) => heads.indexOf(name);
    const ci = { id: col('번호'), order: col('노출순서'), title: col('제목') };
    return Array.from(document.querySelectorAll('table tbody tr')).map((tr) => ({
      id: tr.children[ci.id]?.textContent.trim(),
      order: tr.children[ci.order]?.textContent.trim(),
      title: tr.children[ci.title]?.textContent.trim(),
    })).filter((r) => r.id);
  }

  async function onSearchPage() {
    const job = await loadJob();
    if (job && job.themeId === pageId) {
      const total = jobTotal(job);
      if (job.status === 'running') {
        // 방금 처리한 건이 있으면 완료 처리
        if (Number.isInteger(job.submitting)) { job.index = job.submitting + 1; delete job.submitting; await saveJob(job); }
        if (job.index >= total) {
          await saveJob(null);
          showPanel(`<b>완료</b> · ${total}건 ${job.type === 'delete' ? '삭제' : '등록'}했어요. 목록을 새로고침해서 확인하세요.`, { stop: false });
          return;
        }
        const next = job.type === 'delete' ? `${job.ids[job.index].id} ${job.ids[job.index].title}` : job.items[job.index].name;
        showPanel(`${jobLabel(job)} 진행 중 · ${job.index}/${total} 완료<br>다음: ${next}`);
        await sleep(800);
        location.assign(job.type === 'delete' ? updateUrl(job.ids[job.index].id) : createUrl(pageId));
        return;
      }
      if (job.status === 'error') {
        showPanel(`<b>중단됨</b> · ${job.index}/${total}에서 멈췄어요.<br>${job.error || ''}<br>"재시도"는 멈춘 건부터 이어서 하고, "중지"는 작업을 지워요. <button id="pbRetry" style="${BTN}">재시도</button>`);
        panel.querySelector('#pbRetry').onclick = async () => {
          job.status = 'running'; delete job.error; delete job.submitting;
          await saveJob(job);
          location.assign(job.type === 'delete' ? updateUrl(job.ids[job.index].id) : createUrl(pageId));
        };
        return;
      }
    }

    const regBtn = await waitFor(() => buttonByText('등록', 'btn-primary'), WAIT.form);
    if (!regBtn || document.getElementById('pbBulkBtn')) return;

    // 여러 장 일괄 등록
    const btn = document.createElement('button');
    btn.id = 'pbBulkBtn';
    btn.type = 'button';
    btn.className = regBtn.className;
    btn.textContent = '여러 장 일괄 등록';
    btn.style.marginLeft = '8px';
    regBtn.insertAdjacentElement('afterend', btn);

    const picker = document.createElement('input');
    picker.type = 'file'; picker.multiple = true; picker.accept = 'image/png,image/jpeg'; picker.style.display = 'none';
    document.body.appendChild(picker);
    btn.addEventListener('click', () => picker.click());

    picker.addEventListener('change', async () => {
      const files = Array.from(picker.files);
      picker.value = '';
      if (!files.length) return;

      // 현재 목록의 노출순서 최대값 + 1 을 기본 시작 번호로 제안
      const orders = readRows().map((r) => parseInt(r.order, 10)).filter(Number.isFinite);
      const suggested = orders.length ? Math.max(...orders) + 1 : 1;
      const startRaw = prompt(`${files.length}장을 등록합니다.\n제목은 파일명("${RULES.stripSuffix}" 제외), 랜덤카드 ${RULES.randomCard}, 판매여부 ${RULES.onSale}.\n\n노출순서 시작 번호:`, String(suggested));
      if (startRaw === null) return;
      const startOrder = parseInt(startRaw, 10);
      if (!Number.isFinite(startOrder)) { alert('시작 번호가 숫자가 아니에요.'); return; }

      files.sort((a, b) => a.name.localeCompare(b.name, 'ko'));
      const items = files.map((f) => ({ name: f.name, type: f.type, blob: f }));
      await saveJob({ type: 'register', themeId: pageId, items, startOrder, index: 0, status: 'running', createdAt: Date.now() });
      location.assign(createUrl(pageId));
    });

    // 선택 삭제 — 표 안을 건드리면 Blazor 렌더링이 깨질 수 있어, 별도 패널에 목록을 띄워 고르게 한다.
    const delBtn = document.createElement('button');
    delBtn.id = 'pbDelBtn';
    delBtn.type = 'button';
    delBtn.className = regBtn.className.replace('btn-primary', 'btn-secondary');
    delBtn.textContent = '선택 삭제';
    delBtn.style.marginLeft = '8px';
    btn.insertAdjacentElement('afterend', delBtn);
    delBtn.addEventListener('click', openDeletePicker);
  }

  function openDeletePicker() {
    const rows = readRows();
    if (!rows.length) { alert('목록에 프레임이 없어요.'); return; }
    ensurePanel();
    panel.style.maxWidth = '460px';
    panel.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:6px">
        <b>선택 삭제</b>
        <label style="font-weight:400;cursor:pointer"><input type="checkbox" id="pbAll"> 이 페이지 전체 선택</label>
      </div>
      <div style="font-size:12px;color:#d1d5db;margin-bottom:6px">지금 화면에 보이는 ${rows.length}건이에요. 더 많이 지우려면 표시 개수를 늘리고 다시 여세요.</div>
      <div id="pbList" style="max-height:260px;overflow:auto;border:1px solid #374151;border-radius:6px;padding:6px 8px;background:#111827">
        ${rows.map((r) => `<label style="display:flex;gap:8px;align-items:center;padding:3px 0;cursor:pointer"><input type="checkbox" class="pbSel" data-id="${r.id}" data-title="${(r.title || '').replace(/"/g, '&quot;')}"><span style="color:#9ca3af;min-width:34px">${r.id}</span><span>${r.title || ''}</span><span style="color:#9ca3af;margin-left:auto">순서 ${r.order || ''}</span></label>`).join('')}
      </div>
      <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:10px">
        <button id="pbDelCancel" style="${BTN}">닫기</button>
        <button id="pbDelGo" style="${BTN_DANGER}">선택한 0건 삭제</button>
      </div>`;
    const boxes = () => Array.from(panel.querySelectorAll('.pbSel'));
    const refresh = () => { panel.querySelector('#pbDelGo').textContent = `선택한 ${boxes().filter((b) => b.checked).length}건 삭제`; };
    panel.querySelector('#pbAll').onchange = (e) => { boxes().forEach((b) => { b.checked = e.target.checked; }); refresh(); };
    boxes().forEach((b) => { b.onchange = refresh; });
    panel.querySelector('#pbDelCancel').onclick = () => { panel.remove(); panel = null; };
    panel.querySelector('#pbDelGo').onclick = async () => {
      const ids = boxes().filter((b) => b.checked).map((b) => ({ id: b.dataset.id, title: b.dataset.title }));
      if (!ids.length) return;
      const list = ids.map((x) => `${x.id} ${x.title}`).join('\n');
      if (!confirm(`아래 ${ids.length}건을 삭제합니다. 되돌리기 어려울 수 있어요.\n\n${list}`)) return;
      await saveJob({ type: 'delete', themeId: pageId, ids, index: 0, status: 'running', createdAt: Date.now() });
      location.assign(updateUrl(ids[0].id));
    };
  }

  // ── 등록 페이지: 한 건 채우고 등록 ───────────────────────────────────
  async function onCreatePage() {
    const job = await loadJob();
    if (!job || job.type !== 'register' || job.themeId !== pageId || job.status !== 'running') return;
    if (job.index >= job.items.length) { location.assign(searchUrl(pageId)); return; }

    const item = job.items[job.index];
    const order = job.startOrder + job.index;
    const title = titleOf(item.name);
    const head = () => `일괄 등록 · ${job.index + 1}/${job.items.length}<br><b>${title}</b> · 노출순서 ${order}<br>`;
    showPanel(head() + '페이지 준비 기다리는 중…');

    const fail = async (msg) => {
      job.status = 'error'; job.error = msg; await saveJob(job);
      showPanel(`<b>중단됨</b> · ${msg}<br>목록으로 돌아가면 "재시도"할 수 있어요. <button id="pbBack" style="${BTN}">목록으로</button>`);
      panel.querySelector('#pbBack').onclick = () => location.assign(searchUrl(job.themeId));
    };

    const ok = await waitFor(() => field('제목') && field('출력원본') && field('썸네일') && field('랜덤카드') && buttonByText('등록') && formInteractive(), WAIT.form);
    if (!ok) return fail('등록 폼이 준비되지 않았어요 (페이지 로딩 지연).' + dialogText());
    await sleep(500);

    showPanel(head() + '채우는 중…');
    setText('제목', title);
    setText('노출순서', String(order));
    setText('가격', String(RULES.price)); // 서버가 숫자를 요구한다 — 비우면 거부됨
    const file = new File([item.blob], item.name, { type: item.type || 'image/png' });
    if (!file.size) return fail(`"${item.name}" 파일 내용을 읽지 못했어요 (0바이트). 파일이 OneDrive 등에서 아직 내려받히지 않았을 수 있어요.`);
    setFile('썸네일', file);
    setFile('출력원본', file);
    await sleep(300);
    const put = (label) => field(label).querySelector('input[type=file]').files.length;
    if (put('썸네일') !== 1 || put('출력원본') !== 1) return fail('사진을 입력칸에 넣지 못했어요.' + dialogText());
    if (!(await setToggle('랜덤카드', RULES.randomCard))) return fail('랜덤카드 토글을 바꾸지 못했어요.');
    if (!(await setToggle('판매여부', RULES.onSale))) return fail('판매여부 토글을 바꾸지 못했어요.');

    showPanel(head() + '사진 올리는 중…');
    // 미리보기 두 개가 뜨면 업로드 완료. 그 전에 오류창이 뜨면 그 내용을 사유로 남기고 멈춘다.
    const uploaded = await waitFor(() => errorDialog() ? 'error' : (fileReady('썸네일') && fileReady('출력원본')), WAIT.upload, 500);
    const err = errorDialog();
    if (err) return fail('사진 올리는 중 오류창이 떴어요: "' + err + '"');
    if (!uploaded) return fail(`사진 업로드가 ${WAIT.upload / 1000}초 안에 끝나지 않았어요 (썸네일 ${fileReady('썸네일') ? '완료' : '미완'} · 출력원본 ${fileReady('출력원본') ? '완료' : '미완'}).` + dialogText());
    await sleep(600);

    // 되돌아왔을 때 "이 건은 보냈다"를 알 수 있게 먼저 기록하고 누른다.
    job.submitting = job.index;
    await saveJob(job);
    showPanel(head() + '등록 중…');
    buttonByText('등록').click();
    await confirmModal();

    const left = await waitFor(() => !/\/ProductFrame\/Create/i.test(location.pathname), WAIT.submit);
    if (!left) { delete job.submitting; return fail('등록 후 목록으로 돌아오지 않았어요.' + dialogText()); }
    onSearchPage();
  }

  // ── 수정 페이지: 한 건 삭제 ──────────────────────────────────────────
  async function onUpdatePage() {
    const job = await loadJob();
    if (!job || job.type !== 'delete' || job.status !== 'running') return;
    if (job.index >= job.ids.length) { location.assign(searchUrl(job.themeId)); return; }
    const target = job.ids[job.index];
    if (String(target.id) !== String(pageId)) return; // 다른 프레임 화면이면 손대지 않는다

    const head = () => `일괄 삭제 · ${job.index + 1}/${job.ids.length}<br><b>${target.id} ${target.title}</b><br>`;
    showPanel(head() + '삭제 중…');
    const fail = async (msg) => {
      job.status = 'error'; job.error = msg; await saveJob(job);
      showPanel(`<b>중단됨</b> · ${msg}<br>목록으로 돌아가면 "재시도"할 수 있어요. <button id="pbBack" style="${BTN}">목록으로</button>`);
      panel.querySelector('#pbBack').onclick = () => location.assign(searchUrl(job.themeId));
    };

    // 버튼에는 `_bl_` 표시가 안 붙는다 — 같은 화면의 파일 입력칸/토글에 붙었는지로 "동작이 붙었음"을 판단한다.
    const pageInteractive = () => hasBlazor(document.querySelector('input[type=file]')) || hasBlazor(document.querySelector('.toggle-container'));
    const delBtn = await waitFor(() => { const b = buttonByText('삭제', 'btn-danger'); return b && pageInteractive() ? b : null; }, WAIT.form);
    if (!delBtn) return fail('삭제 버튼을 찾지 못했어요.' + dialogText());
    await sleep(400);

    job.submitting = job.index;
    await saveJob(job);
    delBtn.click();
    const confirmed = await confirmModal(); // "삭제 하시겠습니까?"
    if (!confirmed) { delete job.submitting; await saveJob(job); return fail('삭제 확인창이 뜨지 않았어요.' + dialogText()); }

    const left = await waitFor(() => !/\/ProductFrame\/Update/i.test(location.pathname), WAIT.submit);
    if (!left) { delete job.submitting; return fail('삭제 후 목록으로 돌아오지 않았어요.' + dialogText()); }
    onSearchPage();
  }

  if (onSearch) onSearchPage();
  if (onCreate) onCreatePage();
  if (onUpdate) onUpdatePage();
})();
