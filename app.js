/**
 * Stickies Dashboard — Renderer Process
 * DEV_STANDARD_GUIDELINES_v1.0 PART 3/4 완전 준수
 *
 * 보안:  escHtml(), null 가드, 이벤트 위임, parseInt radix, async try-catch
 * 성능:  parts.push+join, requestAnimationFrame, 이벤트 중복 방지
 */

'use strict';

/* ============================================================
   PART 3 — 보안 헬퍼
   ============================================================ */
const escHtml = s =>
  String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const $  = id => document.getElementById(id);
const $s = (id, v) => { const el = $(id); if (el) el.textContent = v; };
const $h = (id, v) => { const el = $(id); if (el) el.innerHTML    = v; };

/* ============================================================
   State
   ============================================================ */
let _stickies    = [];
let _friends     = [];
let _parsedAt    = '';
let _filePath    = '';
let _currentCat  = 'all';
let _currentView = 'grid';
let _isLight     = false;
let _isMobile    = false;  // 모바일 모드
let _theme       = 'dark';  // 'dark' | 'light' | 'tulip'
let _rafId       = null;

/* ============================================================
   Flash 알림 (PART 3)
   ============================================================ */
function flash(msg, type = 'ok', ms = 3000) {
  const wrap = $('flashWrap');
  if (!wrap) return;
  const d = document.createElement('div');
  d.className = `flash ${escHtml(type)}`;
  d.textContent = (type === 'ok' ? '✓ ' : '✗ ') + msg;
  wrap.appendChild(d);
  setTimeout(() => {
    d.style.opacity = '0'; d.style.transition = 'opacity .28s';
    setTimeout(() => d.remove(), 300);
  }, ms);
}

/* ============================================================
   Status
   ============================================================ */
function setStatus(type, text) {
  const dot = $('tbDot'); const txt = $('tbStatusText');
  if (dot) dot.className = `dot ${escHtml(type)}`;
  if (txt) txt.textContent = text;
}

/* ============================================================
   Init
   ============================================================ */
async function init() {
  try {
    const ver = await window.stickyAPI.getVersion();
    $s('tbVer', `v${ver.version}`);
    if (!ver.chokidar) flash('chokidar 미설치 — 폴링 모드', 'warn', 5000);
    if (!ver.iconv)    flash('iconv-lite 미설치 — 한글 일부 깨질 수 있음', 'warn', 5000);
  } catch (e) { /* 무시 */ }

  // 설정 로드
  try {
    const cfg = await window.stickyAPI.getConfig();
    const ps = $('settingsPoll');
    if (ps) ps.value = String(cfg.pollInterval || 3);
    if (cfg.theme === 'light')  applyTheme('light');
    else if (cfg.theme === 'tulip') applyTheme('tulip');
    else applyTheme('dark');
  } catch (e) { /* 무시 */ }

  // 파일 변경 이벤트 등록
  window.stickyAPI.onFileChanged(() => {
    loadData();
    flash('파일 변경 감지 → 자동 새로고침', 'ok', 2500);
  });

  // 타이틀바 버튼 이벤트 위임
  bindTitlebarButtons();
  bindSidebarNav();
  bindSettingsUI();
  bindDetailModal();

  // 검색 이벤트
  const si = $('searchInput');
  if (si) si.addEventListener('input', scheduleRender);

  // 정렬 이벤트
  const ss = $('sortSel');
  if (ss) ss.addEventListener('change', scheduleRender);

  // 키보드 단축키
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') { closeSettings(); closeDetail(); }
    if ((e.ctrlKey || e.metaKey) && e.key === 'r') { e.preventDefault(); manualRefresh(); }
  });

  await loadData();

  // 메뉴 설정 + 모바일 모드 복원
  try {
    const cfg = await window.stickyAPI.getConfig();
    applyMenuConfig(cfg.menuConfig || {});
    if (cfg.mobileMode) applyMobileMode(true, false); // false = IPC 재호출 안함
  } catch(e) {}

  // 폰트 크기 조절 초기화
  initFontSize();
}

/* ============================================================
   타이틀바 버튼 (이벤트 위임, PART 3)
   ============================================================ */
function bindTitlebarButtons() {
  const tb = document.querySelector('.titlebar');
  if (!tb) return;
  tb.addEventListener('click', async e => {
    const btn = e.target.closest('.tb-btn');
    if (!btn) return;
    const id = btn.id;
    if (id === 'btnRefresh')  { await manualRefresh(); return; }
    if (id === 'btnSettings') { openSettings();  return; }
    if (id === 'btnTheme')    { toggleTheme();   return; }
  if (id === 'btnMobile')   { toggleMobile();  return; }
    if (id === 'btnMin')      { await window.stickyAPI.windowMinimize(); return; }
    if (id === 'btnMax')      { await window.stickyAPI.windowMaximize(); return; }
    if (id === 'btnClose')    { await window.stickyAPI.windowClose();    return; }
  });
}

/* ============================================================
   사이드바 내비게이션 (이벤트 위임)
   ============================================================ */
function bindSidebarNav() {
  const nav = document.querySelector('.sidebar-nav');
  if (!nav) return;
  nav.addEventListener('click', e => {
    const item = e.target.closest('[data-view]');
    if (!item) return;
    const view = item.dataset.view;
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    item.classList.add('active');
    switchView(view);
  });
}

/* ============================================================
   데이터 로드 (async try-catch, PART 3)
   ============================================================ */
async function loadData() {
  setStatus('warn', '로딩 중...');
  try {
    const data = await window.stickyAPI.getStickies();

    if (data.error) {
      setStatus('err', '경로 설정 필요');
      showSetup(findStickyPathsFromData(data));
      return;
    }

    _stickies  = data.stickies  || [];
    _friends   = data.friends   || [];
    _parsedAt  = data.parsedAt  || '';
    _filePath  = data.filePath  || '';

    if (_filePath) {
      // 파일 감시 시작 (오류 무시)
      window.stickyAPI.startWatch(_filePath).catch(() => {});
      // 사이드바 경로 표시
      const mini = $('pathMini');
      if (mini) mini.textContent = _filePath.replace(/\\/g, '/').split('/').slice(-2).join('/');
    }

    $s('parsedAt', _parsedAt ? `갱신: ${_parsedAt.slice(11, 16)}` : '');
    setStatus('ok', `${_stickies.length}개 · ${(_parsedAt||'').slice(11, 16)} 동기화`);

    hideSetup();
    renderStats();
    renderChips();
    scheduleRender();

  } catch (e) {
    setStatus('err', String(e));
    flash(String(e), 'err');
  }
}

function findStickyPathsFromData(data) {
  return Array.isArray(data.autoPaths) ? data.autoPaths : [];
}

async function manualRefresh() {
  setStatus('warn', '새로고침 중...');
  try {
    await window.stickyAPI.refresh();
    await loadData();
    flash('새로고침 완료');
  } catch (e) { flash(String(e), 'err'); }
}

/* ============================================================
   PART 4 — RAF 기반 렌더 스케줄링
   ============================================================ */
function scheduleRender() {
  if (_rafId) cancelAnimationFrame(_rafId);
  _rafId = requestAnimationFrame(() => {
    if (_currentView === 'grid')  renderCards();
    if (_currentView === 'chat')  renderChat();
    if (_currentView === 'manage') renderManage();
  });
}

/* ============================================================
   Stats (PART 4: parts.push + join)
   ============================================================ */
function renderStats() {
  const cats = {};
  _stickies.forEach(s => { cats[s.cat] = (cats[s.cat] || 0) + 1; });
  const net = _stickies.filter(s => s.src).length;

  const items = [
    { lbl:'전체',     val: _stickies.length,                         sub: '스티키 수',  sa: 'var(--accent)' },
    { lbl:'수신',     val: net,                                       sub: `로컬 ${_stickies.length - net}`, sa: 'var(--accent2)' },
    { lbl:'카테고리', val: Object.keys(cats).length,                  sub: Object.entries(cats).map(([k,v]) => `${k}:${v}`).join(' · '), sa: 'var(--accent-warn)' },
    { lbl:'팀원',     val: _friends.reduce((a, g) => a + g.members.length, 0), sub: `${_friends.length}그룹`, sa: 'var(--accent2)' },
  ];

  const el = $('statsRow');
  if (!el) return;
  const parts = [];
  items.forEach(i => {
    parts.push(`<div class="stat-card" style="--sa:${escHtml(i.sa)}">
      <div class="stat-lbl">${escHtml(i.lbl)}</div>
      <div class="stat-val">${escHtml(String(i.val))}</div>
      <div class="stat-sub">${escHtml(i.sub)}</div>
    </div>`);
  });
  el.innerHTML = parts.join('');
}

/* ============================================================
   Filter chips (이벤트 위임)
   ============================================================ */
function renderChips() {
  const cats = ['all', ...new Set(_stickies.map(s => s.cat))];
  const el = $('filterChips');
  if (!el) return;
  const CC = { all:'var(--accent)', 업무:'var(--accent)', 기술:'var(--accent2)', 보안:'var(--accent3)', 법률:'var(--accent-warn)', 기타:'var(--text-muted)' };

  const parts = [];
  cats.forEach(c => {
    const cnt = c === 'all' ? _stickies.length : _stickies.filter(s => s.cat === c).length;
    const ac  = _currentCat === c ? ' active' : '';
    const cc  = escHtml(CC[c] || 'var(--accent)');
    parts.push(`<button class="chip${ac}" data-cat="${escHtml(c)}" style="--cc:${cc}">${escHtml(c === 'all' ? `전체 (${cnt})` : `${c} (${cnt})`)}</button>`);
  });

  // 교체 후 이벤트 위임 재등록 (중복 방지)
  const newEl = el.cloneNode(false);
  newEl.innerHTML = parts.join('');
  el.parentNode.replaceChild(newEl, el);
  newEl.addEventListener('click', e => {
    const btn = e.target.closest('[data-cat]');
    if (!btn) return;
    _currentCat = btn.dataset.cat;
    renderChips();
    scheduleRender();
  });
}

/* ============================================================
   Cards (PART 4: parts.push + join)
   ============================================================ */
function getFiltered() {
  const si = $('searchInput');
  const q  = si ? si.value.toLowerCase() : '';
  const ss = $('sortSel');
  const sort = ss ? ss.value : 'date-desc';

  let list = _stickies.filter(s => {
    if (_currentCat !== 'all' && s.cat !== _currentCat) return false;
    if (q && !s.text.toLowerCase().includes(q) && !(s.senderName||'').toLowerCase().includes(q)) return false;
    return true;
  });

  if      (sort === 'date-desc') list.sort((a, b) => (b.created  || '').localeCompare(a.created  || ''));
  else if (sort === 'date-asc')  list.sort((a, b) => (a.created  || '').localeCompare(b.created  || ''));
  else if (sort === 'cat')       list.sort((a, b) =>  a.cat.localeCompare(b.cat));
  else if (sort === 'sender')    list.sort((a, b) => (a.senderName || '').localeCompare(b.senderName || ''));
  return list;
}

function hlText(text, q) {
  if (!q) return escHtml(text);
  const safe = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return escHtml(text).replace(new RegExp(safe, 'gi'), m => `<span class="hl">${m}</span>`);
}

function renderCards() {
  const el = $('cardGrid');
  if (!el) return;

  const si = $('searchInput');
  const q  = si ? si.value.toLowerCase() : '';
  const list = getFiltered();

  if (list.length === 0) {
    el.innerHTML = '<div class="empty">🔍 결과 없음</div>';
    return;
  }

  // PART 4: parts.push + join
  const parts = [];
  list.forEach((s, i) => {
    const preview = s.text.replace(/[\n\r]+/g, ' ').trim().slice(0, 160);
    const delay   = Math.min(i * 28, 280);
    // 타이틀: 직접 입력된 타이틀 > 본문 첫 줄 > 없음
    const firstLine = s.text.split('\n')[0].trim().slice(0, 50);
    const titleText = s.title || firstLine || '';
    const hasTitle  = !!s.title;  // 직접 입력 타이틀 여부

    parts.push(`
      <div class="card" data-cat="${escHtml(s.cat)}" data-id="${escHtml(s.id)}" style="animation-delay:${parseInt(delay, 10)}ms">
        <div class="card-hd">
          <div class="card-tags">
            <span class="tag tag-${escHtml(s.cat)}">${escHtml(s.cat)}</span>
            ${s.src && !s.isLocal ? '<span class="tag tag-net">수신</span>' : ''}
            ${s.isLocal ? '<span class="tag tag-local">내 메모</span>' : ''}
          </div>
          <div class="card-date">${escHtml(s.created ? s.created.slice(0, 10) : '')}</div>
        </div>
        ${titleText ? `<div class="card-title${hasTitle ? ' card-title-custom' : ''}">${escHtml(titleText)}</div>` : ''}
        <div class="card-body"><div class="card-excerpt">${hlText(preview, q)}</div></div>
        <div class="card-ft">
          <div class="card-sender">
            <svg viewBox="0 0 16 16" fill="currentColor"><circle cx="8" cy="5" r="3"/><path d="M2 14c0-3.3 2.7-6 6-6s6 2.7 6 6"/></svg>
            ${escHtml(s.senderName || '—')}
            ${s.senderGroup ? `<span class="card-group">${escHtml(s.senderGroup)}</span>` : ''}
          </div>
          <button class="expand-btn" data-id="${escHtml(s.id)}">전체보기 →</button>
          <button class="save-btn" data-save="${escHtml(s.id)}" title="보관함에 저장">☆</button>
          <button class="sticky-open-btn" data-open="${escHtml(s.id)}" title="Stickies 앱 실행">
            <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor"><path d="M3 2h10a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1zm1 2v8h8V4H4z"/><path d="M6 6h4v4H6z"/></svg>
          </button>
        </div>
      </div>`);
  });
  el.innerHTML = parts.join('');

  // 이벤트 위임 (PART 3)
  el.addEventListener('click', e => {
    const saveBtn = e.target.closest('[data-save]');
    if (saveBtn) { saveToVault(saveBtn.dataset.save); return; }
    const openBtn = e.target.closest('[data-open]');
    if (openBtn) { openStickyApp(openBtn.dataset.open); return; }
    const btn = e.target.closest('[data-id]');
    if (!btn) return;
    openDetail(btn.dataset.id);
  });
}

/* ============================================================
   Timeline
   ============================================================ */
function renderTimeline() {
  const el = $('timelineEl');
  if (!el) return;
  const list = _stickies.slice().sort((a, b) => (b.created || '').localeCompare(a.created || ''));
  const C = { 업무:'var(--accent)', 기술:'var(--accent2)', 보안:'var(--accent3)', 법률:'var(--accent-warn)', 기타:'var(--text-dim)' };

  const parts = [];
  list.forEach(s => {
    const col = escHtml(C[s.cat] || 'var(--text-dim)');
    parts.push(`<div class="tl-item" data-id="${escHtml(s.id)}">
      <div class="tl-dot" style="background:${col}"></div>
      <div class="tl-date">${escHtml(s.created || '')} · ${escHtml(s.senderName || '로컬')} <span style="color:${col};margin-left:5px">${escHtml(s.cat)}</span></div>
      <div class="tl-card">${escHtml(s.text.slice(0, 200))}${s.text.length > 200 ? '…' : ''}</div>
    </div>`);
  });
  el.innerHTML = parts.join('');

  el.addEventListener('click', e => {
    const item = e.target.closest('[data-id]');
    if (!item) return;
    openDetail(item.dataset.id);
  });
}

/* ============================================================
   Friends
   ============================================================ */
function renderFriends() {
  const el = $('friendsGrid');
  if (!el) return;
  if (!_friends.length) {
    el.innerHTML = '<p style="color:var(--text-dim);font-size:.8rem">팀원 데이터 없음</p>';
    return;
  }
  const parts = [];
  // 사용자 정의 전송 그룹 가져오기
  const _sendGroups = (_cfg_sendGroups || []);

  _friends.forEach(g => {
    const mp = g.members.map(m => `<div class="fi">
      <div class="fi-left"><div class="fi-name">${escHtml(m.name)}</div><div class="fi-role">${escHtml(m.role||'')}</div></div>
      <div class="fi-ip">${escHtml(m.ip||'')}</div>
      ${m.ip ? `<button class="fi-send-btn" data-ip="${escHtml(m.ip)}" data-name="${escHtml(m.name)}" title="스티키 전송">
        <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor"><path d="M15 8L1 15V1l14 7z"/></svg>
      </button>` : ''}
    </div>`).join('');

    // 이 그룹과 일치하는 전송그룹 찾기
    const matchedSndGrps = _sendGroups.filter(sg =>
      sg.members && sg.members.some(sm =>
        g.members.some(m => m.ip && m.ip === sm.ip)
      )
    );

    // 전송그룹 버튼들
    const sndGrpBtns = _sendGroups
      .filter(sg => sg.members && sg.members.length > 0)
      .map(sg => `<button class="fg-grpsend-btn" data-sgid="${escHtml(sg.id)}" title="${escHtml(sg.name)}에게 그룹 전송">
        <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor"><path d="M15 8L1 15V1l14 7z"/></svg>
        ${escHtml(sg.name)} (${parseInt(sg.members.length,10)}명)
      </button>`).join('');

    parts.push(`<div class="fg-card">
      <div class="fg-head">
        <div class="fg-name">${escHtml(g.group)}</div>
        ${sndGrpBtns ? `<div class="fg-grp-btns">${sndGrpBtns}</div>` : ''}
      </div>
      ${mp}
    </div>`);
  });
  el.innerHTML = parts.join('');

  // 이벤트 위임 (PART 3)
  el.addEventListener('click', e => {
    // 개별 전송
    const sendBtn = e.target.closest('.fi-send-btn');
    if (sendBtn) { openSendStickyModal(sendBtn.dataset.ip, sendBtn.dataset.name); return; }
    // 그룹 전송
    const grpBtn = e.target.closest('.fg-grpsend-btn');
    if (grpBtn) { openGrpSendModal(grpBtn.dataset.sgid); return; }
  });
}


/* ============================================================
   Manage View — Stickies 관리창 (상태별 필터 + 타이틀/카테고리 목록)
   ============================================================ */
const STATE_DEF = [
  { key:'all',       label:'전체',    icon:'◈' },
  { key:'desktop',   label:'바탕화면', icon:'🖥' },
  { key:'rolled',    label:'롤업',    icon:'↑' },
  { key:'sleeping',  label:'수면중',  icon:'💤' },
  { key:'closed',    label:'닫기',    icon:'✕' },
  { key:'preserved', label:'보존',    icon:'🔒' },
  { key:'vaulted',   label:'보관함',  icon:'★' },
];

let _manageState = 'all';
let _manageSearch = '';

async function renderManage() {
  const el = $('viewManage');
  if (!el) return;
  await loadVault();  // 보관함 상태 최신화

  const counts = {};
  STATE_DEF.forEach(s => { counts[s.key] = 0; });
  counts.all = _stickies.length;
  _stickies.forEach(s => { if (counts[s.displayState] !== undefined) counts[s.displayState]++; });
  // 보관함 카운트: vault에 저장된 originId 기준
  const _vaultedIds = new Set((_vault||[]).map(v => v.originId));
  counts.vaulted = _stickies.filter(s => _vaultedIds.has(s.id)).length;

  const filtered = _stickies.filter(s => {
    if (_manageState === 'vaulted') return _vaultedIds.has(s.id);
    if (_manageState !== 'all' && s.displayState !== _manageState) return false;
    if (_manageSearch) {
      const q = _manageSearch.toLowerCase();
      if (!s.text.toLowerCase().includes(q) &&
          !(s.title||'').toLowerCase().includes(q) &&
          !(s.senderName||'').toLowerCase().includes(q)) return false;
    }
    return true;
  });

  const parts = [];
  parts.push(`<div class="mgr-wrap">`);

  // ── 왼쪽 사이드: 상태 필터 ──
  parts.push(`<div class="mgr-side">`);
  parts.push(`<div class="mgr-side-hd">상태</div>`);
  STATE_DEF.forEach(s => {
    const active = _manageState === s.key ? ' mgr-active' : '';
    parts.push(`<div class="mgr-state-row${active}" data-state="${escHtml(s.key)}">
      <span class="mgr-icon">${escHtml(s.icon)}</span>
      <span class="mgr-label">${escHtml(s.label)}</span>
      <span class="mgr-cnt">${counts[s.key]||0}</span>
    </div>`);
  });
  parts.push(`</div>`);

  // ── 오른쪽: 목록 + 검색 ──
  parts.push(`<div class="mgr-main">`);

  // 검색바
  parts.push(`<div class="mgr-toolbar">
    <div class="mgr-search-wrap">
      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><circle cx="6.5" cy="6.5" r="5"/><path d="m11 11 3.5 3.5"/></svg>
      <input class="mgr-search" id="mgrSearch" type="text" placeholder="제목 · 내용 · 발신자 검색..." value="${escHtml(_manageSearch)}">
    </div>
  </div>`);

  // 컬럼 헤더
  parts.push(`<div class="mgr-col-hd">
    <span class="mgr-col mgr-col-state">상태</span>
    <span class="mgr-col mgr-col-title">타이틀 / 내용</span>
    <span class="mgr-col mgr-col-cat">카테고리</span>
    <span class="mgr-col mgr-col-sender">발신자</span>
    <span class="mgr-col mgr-col-date">날짜</span>
  </div>`);

  // 목록
  parts.push(`<div class="mgr-list">`);
  if (!filtered.length) {
    parts.push(`<div class="mgr-empty">해당하는 스티키가 없습니다.</div>`);
  } else {
    filtered.forEach(s => {
      const stateInfo = {
        desktop:   { label:'바탕화면', cls:'st-desktop'  },
        rolled:    { label:'롤업',     cls:'st-rolled'   },
        sleeping:  { label:'수면중',   cls:'st-sleeping' },
        closed:    { label:'닫기',     cls:'st-closed'   },
        preserved: { label:'보존',     cls:'st-preserved'},
      }[s.displayState] || { label:'알수없음', cls:'' };

      const preview = (s.title || s.text || '').replace(/[\n\r]+/g,' ').trim().slice(0, 60);
      const CAT_CLS = {업무:'ct-업무',기술:'ct-기술',보안:'ct-보안',법률:'ct-법률',기타:'ct-기타'};

      parts.push(`<div class="mgr-row" data-id="${escHtml(s.id)}">
        <span class="mgr-col mgr-col-state">
          <span class="st-badge ${escHtml(stateInfo.cls)}">${escHtml(stateInfo.label)}</span>
        </span>
        <span class="mgr-col mgr-col-title mgr-title-text">
          ${_vaultedIds.has(s.id) ? '<span class="mgr-vault-star">★</span>' : ''}${escHtml(preview || '(내용 없음)')}
        </span>
        <span class="mgr-col mgr-col-cat">
          <span class="ct-badge ${escHtml(CAT_CLS[s.cat]||'ct-기타')}">${escHtml(s.cat||'기타')}</span>
        </span>
        <span class="mgr-col mgr-col-sender">${escHtml(s.senderName||'—')}</span>
        <span class="mgr-col mgr-col-date">${escHtml((s.created||'').slice(0,10))}</span>
      </div>`);
    });
  }
  parts.push(`</div>`); // mgr-list

  // 하단 카운트
  parts.push(`<div class="mgr-footer">
    <span>Sticky의 합계 저장수: <strong>${_stickies.length}</strong></span>
    <span>${escHtml(STATE_DEF.find(s=>s.key===_manageState)?.label||'전체')} 안의 Sticky수: <strong>${filtered.length}</strong></span>
  </div>`);

  parts.push(`</div>`); // mgr-main
  parts.push(`</div>`); // mgr-wrap

  el.innerHTML = parts.join('');

  // ── 이벤트 위임 ──
  const side = el.querySelector('.mgr-side');
  if (side) {
    side.addEventListener('click', e => {
      const row = e.target.closest('[data-state]');
      if (!row) return;
      _manageState = row.dataset.state;
      renderManage();
    });
  }

  const list = el.querySelector('.mgr-list');
  if (list) {
    list.addEventListener('click', e => {
      const row = e.target.closest('[data-id]');
      if (!row) return;
      openDetail(row.dataset.id);
    });
  }

  const searchEl = $('mgrSearch');
  if (searchEl) {
    searchEl.addEventListener('input', e => {
      _manageSearch = e.target.value;
      renderManage();
    });
  }
}

/* ============================================================
   View 전환
   ============================================================ */
function switchView(view) {
  _currentView = view;
  ['viewGrid', 'viewTimeline', 'viewFriends', 'viewChat', 'viewManage', 'viewVault'].forEach(id => {
    const el = $(id);
    if (el) el.classList.add('hidden');
  });
  const target = $('view' + view.charAt(0).toUpperCase() + view.slice(1));
  if (target) target.classList.remove('hidden');
  if (view === 'timeline') renderTimeline();
  if (view === 'friends')  renderFriends();
  if (view === 'grid')     scheduleRender();
  if (view === 'chat')     renderChat();
  if (view === 'manage')   renderManage();  // async
  if (view === 'vault')    renderVault();
}

/* ============================================================
   Setup Screen
   ============================================================ */
function showSetup(autoPaths) {
  $('viewLoading')?.classList.add('hidden');
  ['viewGrid', 'viewTimeline', 'viewFriends'].forEach(id => $(id)?.classList.add('hidden'));

  const vs = $('viewSetup');
  if (vs) vs.classList.remove('hidden');

  const list = $('setupAutoList');
  if (!list) return;

  if (autoPaths && autoPaths.length > 0) {
    const parts = autoPaths.map(p =>
      `<div class="auto-item" data-path="${escHtml(p)}">
        <svg viewBox="0 0 16 16" fill="currentColor"><path d="M1 3.5A1.5 1.5 0 0 1 2.5 2h2.764c.958 0 1.76.56 2.062 1.35l.254.675H14.5A1.5 1.5 0 0 1 16 5.5v7a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 1 12.5v-9z"/></svg>
        <span>${escHtml(p)}</span>
      </div>`
    ).join('');
    list.innerHTML = parts;
    list.addEventListener('click', e => {
      const item = e.target.closest('[data-path]');
      if (!item) return;
      pickPath(item.dataset.path);
    });
  } else {
    list.innerHTML = '<p style="font-size:.72rem;color:var(--text-dim)">자동 감지 없음</p>';
  }

  // 설정 열기 버튼
  const openBtn = $('btnSetupOpen');
  if (openBtn) openBtn.onclick = openSettings;
}

function hideSetup() {
  $('viewLoading')?.classList.add('hidden');
  $('viewSetup')?.classList.add('hidden');
  $('view' + _currentView.charAt(0).toUpperCase() + _currentView.slice(1))?.classList.remove('hidden');
}

async function pickPath(p) {
  try {
    await window.stickyAPI.saveConfig({ stickiesPath: p });
    flash(`경로 설정: ${p.split(/[/\\]/).pop()}`, 'ok');
    await loadData();
  } catch (e) { flash(String(e), 'err'); }
}

/* ============================================================
   Settings UI
   ============================================================ */
function bindSettingsUI() {
  $('btnSettingsClose')?.addEventListener('click',  closeSettings);
  $('btnSettingsCancel')?.addEventListener('click', closeSettings);
  $('btnSettingsApply')?.addEventListener('click',  applySettings);
  $('settingsOv')?.addEventListener('click', e => {
    if (e.target === $('settingsOv')) closeSettings();
  });

  // 설정 탭 전환
  $('settingsOv')?.addEventListener('click', e => {
    const tab = e.target.closest('[data-stab]');
    if (!tab) return;
    document.querySelectorAll('.stab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.stab-panel').forEach(p => p.classList.add('hidden'));
    tab.classList.add('active');
    const panel = $('stab-' + tab.dataset.stab);
    if (panel) panel.classList.remove('hidden');
  });

  // 파일 찾아보기 (네이티브 다이얼로그)
  $('btnBrowse')?.addEventListener('click', async () => {
    try {
      const p = await window.stickyAPI.openFileDialog();
      if (p) {
        const el = $('settingsPath');
        if (el) { el.value = p; onPathInput(); }
      }
    } catch (e) { flash(String(e), 'err'); }
  });

  // 경로 입력 힌트
  $('settingsPath')?.addEventListener('input', onPathInput);
}

async function openSettings() {
  // 자동 경로 목록 갱신
  try {
    const paths = await window.stickyAPI.findPaths();
    const box = $('settingsAutoList');
    if (box) {
      if (paths.length > 0) {
        const parts = paths.map(p =>
          `<div class="auto-item" data-path="${escHtml(p)}">
            <svg viewBox="0 0 16 16" fill="currentColor"><path d="M1 3.5A1.5 1.5 0 0 1 2.5 2h2.764c.958 0 1.76.56 2.062 1.35l.254.675H14.5A1.5 1.5 0 0 1 16 5.5v7a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 1 12.5v-9z"/></svg>
            <span>${escHtml(p)}</span>
          </div>`
        ).join('');
        box.innerHTML = parts;
        // 이벤트 위임
        box.addEventListener('click', e => {
          const item = e.target.closest('[data-path]');
          if (!item) return;
          const pathEl = $('settingsPath');
          if (pathEl) { pathEl.value = item.dataset.path; onPathInput(); }
        });
      } else {
        box.innerHTML = '<p style="font-size:.7rem;color:var(--text-dim)">자동 감지 없음 — 직접 입력하거나 찾아보기</p>';
      }
    }
    // 현재 경로 표시
    const cfg = await window.stickyAPI.getConfig();
    const pe  = $('settingsPath');
    if (pe && cfg.stickiesPath) pe.value = cfg.stickiesPath;
    const mi = $('settingsMyIp');
    if (mi && cfg.myIp) mi.value = cfg.myIp;
    renderMenuMgr(cfg.menuConfig || {});
    renderCatMgr(cfg.categories || _defaultCats());
    renderSndGrpMgr(cfg.sendGroups || []);
    const portEl = $('settingsStickyPort');
    if (portEl && cfg.stickyPort) portEl.value = cfg.stickyPort;
  } catch (e) { /* 무시 */ }

  $('settingsOv')?.classList.remove('hidden');
}

function closeSettings() {
  $('settingsOv')?.classList.add('hidden');
}

function onPathInput() {
  const el   = $('settingsPath');
  const hint = $('settingsHint');
  if (!el || !hint) return;
  const v = el.value.trim();
  if (!v)                           { hint.className = 'form-hint';     hint.textContent = 'stickies.24h · .bak · .ini'; }
  else if (/\.(24h|bak|ini)$/i.test(v)) { hint.className = 'form-hint ok'; hint.textContent = '✓ 올바른 파일 형식'; }
  else                              { hint.className = 'form-hint err'; hint.textContent = '⚠ .24h / .bak / .ini 만 지원'; }
}

async function applySettings() {
  const pe   = $('settingsPath');
  const poll = $('settingsPoll');
  const path = pe ? pe.value.trim() : '';
  const pollVal = parseInt(poll ? poll.value : '3', 10);

  try {
    const myIpEl = $('settingsMyIp');
  const myIp = myIpEl ? myIpEl.value.trim() : '';

  const res = await window.stickyAPI.saveConfig({
      stickiesPath: path,
      myIp,
      pollInterval: pollVal,
      theme: _theme,
      menuConfig: _menuConfig,
      stickyPort: parseInt($('settingsStickyPort')?.value || '52673', 10),
      categories: collectCatMgr(),
      sendGroups: collectSndGrpMgr(),
    });
    if (res.ok) {
      closeSettings();
      flash('설정 저장 완료');
      await loadData();
    }
  } catch (e) { flash(String(e), 'err'); }
}

/* ============================================================
   Detail Modal
   ============================================================ */
function bindDetailModal() {
  $('btnDetailClose')?.addEventListener('click', closeDetail);
  $('detailOv')?.addEventListener('click', e => {
    if (e.target === $('detailOv')) closeDetail();
  });
}

function openDetail(id) {
  const s = _stickies.find(x => x.id === id);
  if (!s) return;

  $h('detailBadge',
    `<span style="color:var(--accent)">${escHtml(s.cat)}</span>` +
    ` <span style="color:var(--text-dim);font-size:.72rem;font-family:var(--mono)">${escHtml(s.id)}</span>`
  );

  $h('detailBody', escHtml(s.text).replace(/\n/g, '<br>'));

  $h('detailMeta', [
    `<div class="meta-row"><span class="meta-key">생성일</span><span class="meta-val">${escHtml(s.created  || '—')}</span></div>`,
    `<div class="meta-row"><span class="meta-key">수정일</span><span class="meta-val">${escHtml(s.modified || '—')}</span></div>`,
    `<div class="meta-row"><span class="meta-key">발신자</span><span class="meta-val">${escHtml(s.senderName || '로컬')}${s.src ? ' (' + escHtml(s.src) + ')' : ''}</span></div>`,
    s.senderGroup ? `<div class="meta-row"><span class="meta-key">소속</span><span class="meta-val">${escHtml(s.senderGroup)}</span></div>` : '',
    `<div class="meta-row"><span class="meta-key">위치</span><span class="meta-val" style="font-family:var(--mono)">X:${escHtml(String(s.x))} Y:${escHtml(String(s.y))}</span></div>`,
  ].join(''));

  $('detailOv')?.classList.remove('hidden');
}

function closeDetail() {
  $('detailOv')?.classList.add('hidden');
}

/* ============================================================
   Theme
   ============================================================ */
function toggleTheme() {
  // dark → light → tulip → dark 순환
  const next = _theme === 'dark' ? 'light' : _theme === 'light' ? 'tulip' : 'dark';
  applyTheme(next);
  window.stickyAPI.saveConfig({ theme: _theme }).catch(() => {});
}

function applyTheme(theme) {
  _theme  = theme || 'dark';
  _isLight = _theme === 'light';
  document.body.classList.remove('light', 'tulip');
  if (_theme !== 'dark') document.body.classList.add(_theme);
  // 테마별 아이콘 SVG (innerHTML 사용)
  const themeIcons = {
    dark:  `<svg viewBox="0 0 16 16" fill="currentColor" width="14" height="14">
              <path d="M8 3a5 5 0 1 0 5 5 5 5 0 0 0-3.9-4.9A4 4 0 1 1 8 3z"/>
            </svg>`,
    light: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" width="14" height="14">
              <circle cx="8" cy="8" r="3"/>
              <line x1="8" y1="1"   x2="8"  y2="2.5"/>
              <line x1="8" y1="13.5" x2="8"  y2="15"/>
              <line x1="1" y1="8"   x2="2.5" y2="8"/>
              <line x1="13.5" y1="8" x2="15" y2="8"/>
              <line x1="3.1" y1="3.1" x2="4.2" y2="4.2"/>
              <line x1="11.8" y1="11.8" x2="12.9" y2="12.9"/>
              <line x1="12.9" y1="3.1" x2="11.8" y2="4.2"/>
              <line x1="4.2" y1="11.8" x2="3.1" y2="12.9"/>
            </svg>`,
    tulip: `<svg viewBox="0 0 16 16" fill="currentColor" width="14" height="14">
              <path d="M8 13V7"/>
              <path d="M8 7C8 4 5 2 5 2s0 3 3 5z"/>
              <path d="M8 7C8 4 11 2 11 2s0 3-3 5z"/>
              <path d="M8 7C6 5 4 6 4 6s1 3 4 4z"/>
              <path d="M8 7C10 5 12 6 12 6s-1 3-4 4z"/>
              <line x1="8" y1="13" x2="8" y2="15" stroke="currentColor" stroke-width="1.5"/>
            </svg>`
  };
  const btn = $('btnTheme');
  if (btn) { btn.innerHTML = themeIcons[_theme] || themeIcons.dark; btn.title = {dark:'다크 모드', light:'라이트 모드', tulip:'튤립 모드'}[_theme]; }
}

/* ============================================================
   Start
   ============================================================ */
init();

/* ============================================================
   폰트 크기 조절 (PART 3: null 가드, 이벤트 위임)
   ============================================================ */
const FONT_SIZES = [11, 12, 13, 14, 15, 16, 18, 20];
let _fontIdx = 2;  // 기본값 13px

function initFontSize() {
  // 저장된 크기 불러오기
  try {
    const saved = parseInt(localStorage.getItem('fontSize') || '13', 10);
    const idx = FONT_SIZES.indexOf(saved);
    _fontIdx = idx >= 0 ? idx : 2;
  } catch (e) { _fontIdx = 2; }
  applyFontSize();
}

function applyFontSize() {
  const size = FONT_SIZES[_fontIdx];
  document.documentElement.style.setProperty('--fs-base', size + 'px');
  const el = $('fontSizeLabel');
  if (el) el.textContent = size + 'px';
  try { localStorage.setItem('fontSize', String(size)); } catch (e) {}
}

function fontSizeUp() {
  if (_fontIdx < FONT_SIZES.length - 1) { _fontIdx++; applyFontSize(); }
}

function fontSizeDown() {
  if (_fontIdx > 0) { _fontIdx--; applyFontSize(); }
}

function fontSizeReset() {
  _fontIdx = 2;
  applyFontSize();
}

/* ============================================================
   보관함 (Vault) — PART 3/4 준수
   ============================================================ */
let _vault       = [];   // 저장된 노트 배열
let _vaultCat    = 'all'; // 현재 선택 카테고리
let _vaultSearch = '';

const VAULT_CATS = [
  { key:'all',  label:'전체' },
  { key:'업무', label:'업무' },
  { key:'기술', label:'기술' },
  { key:'보안', label:'보안' },
  { key:'법률', label:'법률' },
  { key:'기타', label:'기타' },
  { key:'메모', label:'내 메모' },
];

/* ── 보관함 불러오기 ── */
async function loadVault() {
  try {
    _vault = await window.stickyAPI.getSavedNotes() || [];
  } catch(e) { _vault = []; }
}

/* ── 스티키 → 보관함 저장 ── */
async function saveToVault(stickyId) {
  const s = _stickies.find(x => x.id === stickyId);
  if (!s) return;

  await loadVault();

  // 중복 체크
  if (_vault.some(v => v.originId === stickyId)) {
    flash('이미 보관함에 저장되어 있습니다', 'warn', 2500);
    return;
  }

  const note = {
    id:        'v_' + Date.now() + '_' + Math.random().toString(36).slice(2,6),
    originId:  stickyId,
    title:     s.title || s.text.split('\n')[0].trim().slice(0, 50) || '(제목 없음)',
    text:      s.text,
    cat:       s.cat || '기타',
    sender:    s.senderName || '—',
    senderGrp: s.senderGroup || '',
    srcDate:   s.created || '',
    savedAt:   new Date().toLocaleString('ko-KR'),
    memo:      '',
  };

  _vault.push(note);
  try {
    await window.stickyAPI.saveNotes(_vault);
    flash(`보관함에 저장했습니다 — ${escHtml(note.title.slice(0,20))}`, 'ok');
    // 카드 버튼 시각 업데이트
    const btn = document.querySelector(`[data-save="${escHtml(stickyId)}"]`);
    if (btn) { btn.textContent = '★'; btn.style.color = 'var(--accent-warn)'; }
  } catch(e) {
    flash('저장 실패', 'err');
    _vault.pop();
  }
}

/* ── 보관함에서 삭제 ── */
async function deleteFromVault(noteId) {
  _vault = _vault.filter(v => v.id !== noteId);
  try {
    await window.stickyAPI.saveNotes(_vault);
    flash('삭제했습니다', 'ok', 2000);
    renderVault();
  } catch(e) { flash('삭제 실패', 'err'); }
}

/* ── 보관함 카테고리 변경 ── */
async function updateVaultCat(noteId, newCat) {
  const note = _vault.find(v => v.id === noteId);
  if (!note) return;
  note.cat = newCat;
  try {
    await window.stickyAPI.saveNotes(_vault);
    renderVault();
  } catch(e) { flash('저장 실패', 'err'); }
}

/* ── 보관함 메모 수정 ── */
async function updateVaultMemo(noteId, memo) {
  const note = _vault.find(v => v.id === noteId);
  if (!note) return;
  note.memo = memo;
  try { await window.stickyAPI.saveNotes(_vault); }
  catch(e) {}
}

/* ── 보관함 뷰 렌더링 ── */
async function renderVault() {
  const el = $('viewVault');
  if (!el) return;

  await loadVault();

  // 필터
  const filtered = _vault.filter(v => {
    if (_vaultCat !== 'all' && v.cat !== _vaultCat) return false;
    if (_vaultSearch) {
      const q = _vaultSearch.toLowerCase();
      if (!v.title.toLowerCase().includes(q) &&
          !v.text.toLowerCase().includes(q)  &&
          !(v.sender||'').toLowerCase().includes(q)) return false;
    }
    return true;
  });

  // 카테고리별 카운트
  const counts = {};
  VAULT_CATS.forEach(c => { counts[c.key] = 0; });
  counts.all = _vault.length;
  _vault.forEach(v => { if (counts[v.cat] !== undefined) counts[v.cat]++; });

  const CAT_COLOR = {
    업무:'var(--accent)',   기술:'var(--accent2)',
    보안:'var(--accent3)',  법률:'var(--accent-warn)',
    기타:'var(--text-muted)', 메모:'var(--accent2)',
  };
  const CAT_BG = {
    업무:'rgba(79,142,247,.12)',  기술:'rgba(52,201,126,.12)',
    보안:'rgba(240,90,90,.12)',   법률:'rgba(240,168,50,.12)',
    기타:'rgba(74,81,104,.18)',   메모:'rgba(52,201,126,.12)',
  };

  // PART 4: parts.push + join
  const parts = [];

  // ── 헤더 ──
  parts.push(`<div class="vt-header">
    <div class="vt-title-row">
      <span class="vt-title">보관함</span>
      <span class="vt-count">${_vault.length}개 저장됨</span>
    </div>
    <div class="vt-search-wrap">
      <svg class="vt-search-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><circle cx="6.5" cy="6.5" r="5"/><path d="m11 11 3.5 3.5"/></svg>
      <input class="vt-search" id="vaultSearch" type="text" placeholder="제목 · 내용 · 발신자 검색..." value="${escHtml(_vaultSearch)}">
    </div>
  </div>`);

  // ── 카테고리 탭 ──
  parts.push(`<div class="vt-cats">`);
  VAULT_CATS.forEach(c => {
    const isActive = _vaultCat === c.key;
    const cnt = counts[c.key] || 0;
    const color = c.key === 'all' ? 'var(--accent)' : (CAT_COLOR[c.key] || 'var(--text-muted)');
    parts.push(`<button class="vt-cat${isActive ? ' vt-cat-active' : ''}" data-cat="${escHtml(c.key)}"
      style="${isActive ? `background:${escHtml(color)};border-color:${escHtml(color)};color:#fff` : ''}">
      ${escHtml(c.label)} <span class="vt-cat-cnt">${cnt}</span>
    </button>`);
  });
  parts.push(`</div>`);

  // ── 카드 그리드 ──
  if (!filtered.length) {
    parts.push(`<div class="vt-empty">
      <div class="vt-empty-icon">📭</div>
      <p>${_vault.length === 0 ? '카드뷰에서 ☆ 버튼을 눌러 저장하세요' : '검색 결과 없음'}</p>
    </div>`);
  } else {
    parts.push(`<div class="vt-grid">`);
    filtered.forEach((note, i) => {
      const delay = Math.min(i * 25, 250);
      const color  = CAT_COLOR[note.cat]  || 'var(--text-muted)';
      const bgCol  = CAT_BG[note.cat]    || 'rgba(74,81,104,.18)';
      parts.push(`
        <div class="vt-card" data-vid="${escHtml(note.id)}" style="animation-delay:${parseInt(delay,10)}ms">
          <div class="vt-card-top" style="border-left:3px solid ${escHtml(color)}">
            <div class="vt-card-head">
              <span class="vt-tag" style="background:${escHtml(bgCol)};color:${escHtml(color)}">${escHtml(note.cat)}</span>
              <select class="vt-cat-sel" data-vid="${escHtml(note.id)}">
                ${['업무','기술','보안','법률','기타','메모'].map(c =>
                  `<option value="${escHtml(c)}"${note.cat===c?' selected':''}>${escHtml(c)}</option>`
                ).join('')}
              </select>
              <button class="vt-del-btn" data-del="${escHtml(note.id)}" title="삭제">✕</button>
            </div>
            <div class="vt-card-title">${escHtml(note.title)}</div>
            <div class="vt-card-body">${escHtml(note.text.slice(0, 120))}${note.text.length > 120 ? '…' : ''}</div>
          </div>
          <div class="vt-card-foot">
            <span class="vt-sender">
              <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor"><circle cx="8" cy="5" r="3"/><path d="M2 14c0-3.3 2.7-6 6-6s6 2.7 6 6"/></svg>
              ${escHtml(note.sender)}${note.senderGrp ? ' · '+escHtml(note.senderGrp) : ''}
            </span>
            <span class="vt-date">${escHtml((note.srcDate||'').slice(0,10))}</span>
          </div>
          <textarea class="vt-memo" data-vid="${escHtml(note.id)}" placeholder="메모 추가...">${escHtml(note.memo||'')}</textarea>
        </div>`);
    });
    parts.push(`</div>`);
  }

  el.innerHTML = parts.join('');

  // ── 이벤트 위임 (PART 3) ──
  // 카테고리 탭
  const catsEl = el.querySelector('.vt-cats');
  if (catsEl) catsEl.addEventListener('click', e => {
    const btn = e.target.closest('[data-cat]');
    if (!btn) return;
    _vaultCat = btn.dataset.cat;
    renderVault();
  });

  // 카드 클릭 → 상세보기 (삭제·select 제외)
  el.addEventListener('click', e => {
    const del = e.target.closest('[data-del]');
    if (del) { deleteFromVault(del.dataset.del); return; }
    const sel = e.target.closest('select');
    if (sel) return;
    const ta = e.target.closest('textarea');
    if (ta) return;
    const card = e.target.closest('[data-vid]');
    if (card) openVaultDetail(card.dataset.vid);
  });

  // 카테고리 변경 select
  el.addEventListener('change', e => {
    const sel = e.target.closest('[data-vid]');
    if (sel && sel.tagName === 'SELECT') {
      updateVaultCat(sel.dataset.vid, sel.value);
    }
  });

  // 메모 입력 (debounce)
  el.addEventListener('input', e => {
    const ta = e.target.closest('textarea[data-vid]');
    if (!ta) return;
    clearTimeout(ta._debounce);
    ta._debounce = setTimeout(() => updateVaultMemo(ta.dataset.vid, ta.value), 600);
  });

  // 검색
  const searchEl = $('vaultSearch');
  if (searchEl) searchEl.addEventListener('input', e => {
    _vaultSearch = e.target.value;
    renderVault();
  });
}

/* ============================================================
   보관함 상세보기 모달
   ============================================================ */
let _vdNoteId = null;  // 현재 열린 노트 ID
let _vdMemoTimer = null;

function openVaultDetail(noteId) {
  const note = _vault.find(v => v.id === noteId);
  if (!note) return;
  _vdNoteId = noteId;

  const CAT_COLOR = {
    업무:'var(--accent)',  기술:'var(--accent2)',
    보안:'var(--accent3)', 법률:'var(--accent-warn)',
    기타:'var(--text-muted)', 메모:'var(--accent2)',
  };
  const CAT_BG = {
    업무:'rgba(79,142,247,.13)',  기술:'rgba(52,201,126,.13)',
    보안:'rgba(240,90,90,.13)',   법률:'rgba(240,168,50,.13)',
    기타:'rgba(74,81,104,.18)',   메모:'rgba(52,201,126,.13)',
  };
  const color = CAT_COLOR[note.cat] || 'var(--text-muted)';
  const bgCol = CAT_BG[note.cat]   || 'rgba(74,81,104,.18)';

  // 뱃지
  $h('vdBadge', `<span style="background:${escHtml(bgCol)};color:${escHtml(color)};
    padding:3px 10px;border-radius:12px;font-size:.7rem;font-weight:600">
    ${escHtml(note.cat)}</span>`);

  // 저장 일시
  $s('vdSavedAt', `저장: ${note.savedAt || '—'}`);

  // 카테고리 select 동기화
  const catSel = $('vdCatSel');
  if (catSel) catSel.value = note.cat;

  // 제목
  $s('vdTitle', note.title || '(제목 없음)');

  // 본문 (줄바꿈 처리)
  $h('vdContent', escHtml(note.text).replace(/\n/g, '<br>'));

  // 메타 정보
  $h('vdMeta', [
    `<div class="vd-meta-item"><span class="vd-meta-key">발신자</span><span class="vd-meta-val">${escHtml(note.sender||'—')}${note.senderGrp ? ' · '+escHtml(note.senderGrp) : ''}</span></div>`,
    `<div class="vd-meta-item"><span class="vd-meta-key">원본 날짜</span><span class="vd-meta-val">${escHtml((note.srcDate||'').slice(0,10)||'—')}</span></div>`,
    note.originId ? `<div class="vd-meta-item"><span class="vd-meta-key">원본 ID</span><span class="vd-meta-val" style="font-family:var(--mono);font-size:.65rem">${escHtml(note.originId.slice(0,16))}…</span></div>` : '',
  ].join(''));

  // 메모
  const memoTa = $('vdMemoTa');
  if (memoTa) memoTa.value = note.memo || '';

  // 오버레이 열기
  $('vaultDetailOv')?.classList.remove('hidden');
}

function closeVaultDetail() {
  $('vaultDetailOv')?.classList.add('hidden');
  _vdNoteId = null;
}

// 모달 외부 클릭 / ESC 닫기 (bindDetailModal 이후에 등록)
document.addEventListener('DOMContentLoaded', () => {
  // 닫기 버튼
  $('btnVaultDetailClose')?.addEventListener('click', closeVaultDetail);

  // 오버레이 클릭
  $('vaultDetailOv')?.addEventListener('click', e => {
    if (e.target === $('vaultDetailOv')) closeVaultDetail();
  });

  // 카테고리 변경
  $('vdCatSel')?.addEventListener('change', async e => {
    if (!_vdNoteId) return;
    await updateVaultCat(_vdNoteId, e.target.value);
    // 뱃지 색상 즉시 반영
    const note = _vault.find(v => v.id === _vdNoteId);
    if (note) openVaultDetail(_vdNoteId);
  });

  // 메모 자동 저장 (debounce 600ms)
  $('vdMemoTa')?.addEventListener('input', e => {
    if (!_vdNoteId) return;
    clearTimeout(_vdMemoTimer);
    _vdMemoTimer = setTimeout(async () => {
      await updateVaultMemo(_vdNoteId, e.target.value);
      // 목록 카드 메모도 동기화
      const ta = document.querySelector(`.vt-memo[data-vid="${CSS.escape(_vdNoteId)}"]`);
      if (ta) ta.value = e.target.value;
    }, 600);
  });
});

// 기존 closeDetail에 ESC 처리 통합 (키보드 핸들러는 이미 등록됨)
const _origKeydown = document._vaultKeydown;
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeVaultDetail();
});

/* ============================================================
   메시지 뷰 — IP별 주고받은 스티키 대화 내역
   PART 3/4 준수
   ============================================================ */
let _chatSelIp = null;

function renderChat() {
  const el = $('viewChat');
  if (!el) return;

  // ── IP별 그룹화 ──
  const ipGroups = {};
  _stickies.forEach(s => {
    const key = s.src || '__local__';
    if (!ipGroups[key]) ipGroups[key] = [];
    ipGroups[key].push(s);
  });

  // ── IP → 이름 맵 ──
  const ipNameMap = {};
  _friends.forEach(g => g.members.forEach(m => {
    if (m.ip) ipNameMap[m.ip] = { name: m.name, group: g.group };
  }));

  const ipList = Object.entries(ipGroups)
    .sort((a, b) => b[1].length - a[1].length);

  if (!ipList.length) {
    el.innerHTML = '<div class="empty">데이터 없음</div>';
    return;
  }

  // 선택된 IP 유지 또는 첫 번째
  if (!_chatSelIp || !ipGroups[_chatSelIp]) {
    _chatSelIp = ipList[0][0];
  }

  const CAT_BG = { 업무:'#eff6ff', 기술:'#f0fdf4', 보안:'#fef2f2', 법률:'#fff7ed', 기타:'#f8fafc' };
  const CAT_TX = { 업무:'#1e40af', 기술:'#166534', 보안:'#991b1b', 법률:'#9a3412', 기타:'#475569' };
  const AVATAR_COLORS = ['#1d4ed8','#b91c1c','#15803d','#7c3aed','#c2410c','#0e7490','#4d7c0f','#be185d'];

  // ── 왼쪽: 팀원 목록 ──
  const listParts = [];
  ipList.forEach(([ip, items], idx) => {
    const info   = ipNameMap[ip] || {};
    const s0     = items[0] || {};
    const name   = info.name || s0.senderName || (ip === '__local__' ? '내 메모' : ip);
    const group  = info.group || s0.senderGroup || '';
    const last   = (items[0]?.created || '').slice(0, 10);
    const avCol  = AVATAR_COLORS[idx % AVATAR_COLORS.length];
    const init   = (name.replace(/[^가-힣a-zA-Z]/g, '').slice(0, 1) || '?').toUpperCase();
    const unread = items.filter(s => !s.isLocal).length;
    const isSel  = ip === _chatSelIp;

    listParts.push(`
      <div class="ch-contact${isSel ? ' ch-sel' : ''}" data-ip="${escHtml(ip)}">
        <div class="ch-av" style="background:${escHtml(avCol)}">${escHtml(init)}</div>
        <div class="ch-contact-info">
          <div class="ch-contact-name">${escHtml(name.replace(/\s*(부장|차장|과장|대리|사원|주임|팀장|그룹장)\([^)]*\).*/,'').replace(/\([^)]*\)/,'').trim())}</div>
          <div class="ch-contact-sub">${escHtml(group)}</div>
        </div>
        <div class="ch-contact-right">
          <div class="ch-contact-date">${escHtml(last)}</div>
          ${unread ? `<div class="ch-badge">${unread}</div>` : ''}
        </div>
      </div>`);
  });

  // ── 오른쪽: 선택된 IP 대화 내역 ──
  const selItems = ipGroups[_chatSelIp] || [];
  const selInfo  = ipNameMap[_chatSelIp] || {};
  const sel0     = selItems[0] || {};
  const selName  = selInfo.name || sel0.senderName || (_chatSelIp === '__local__' ? '내 메모' : _chatSelIp);
  const selGroup = selInfo.group || sel0.senderGroup || '';
  const selIdx   = ipList.findIndex(x => x[0] === _chatSelIp);
  const selCol   = AVATAR_COLORS[selIdx % AVATAR_COLORS.length];
  const selInit  = (selName.replace(/[^가-힣a-zA-Z]/g,'').slice(0,1)||'?').toUpperCase();
  const selShort = selName.replace(/\s*(부장|차장|과장|대리|사원|주임|팀장|그룹장)\([^)]*\).*/,'').replace(/\([^)]*\)/,'').trim();

  // 날짜별 그룹화 (최신순)
  const byDate = {};
  selItems.forEach(s => {
    const d = (s.created || '').slice(0, 10) || '날짜미상';
    if (!byDate[d]) byDate[d] = [];
    byDate[d].push(s);
  });

  const msgParts = [];
  Object.entries(byDate)
    .sort((a, b) => b[0].localeCompare(a[0]))
    .forEach(([date, msgs]) => {
      msgParts.push(`<div class="ch-date-sep"><span>${escHtml(date)}</span></div>`);
      msgs.forEach(s => {
        const time  = (s.created || '').slice(11, 16);
        const first = (s.text || '').split('\n')[0].trim().slice(0, 60);
        const title = s.title || first || '(내용 없음)';
        const body  = (s.text || '').trim();
        const cat   = s.cat || '기타';
        const isMe  = s.isLocal;

        msgParts.push(`
          <div class="ch-msg${isMe ? ' ch-msg-me' : ''}" data-id="${escHtml(s.id)}">
            ${!isMe ? `<div class="ch-msg-av" style="background:${escHtml(selCol)}">${escHtml(selInit)}</div>` : ''}
            <div class="ch-msg-body">
              <div class="ch-msg-top">
                ${!isMe ? `<span class="ch-msg-sender">${escHtml(selShort)}</span>` : ''}
                <span class="ch-msg-time">${escHtml(time)}</span>
                <span class="ch-msg-cat" style="background:${escHtml(CAT_BG[cat]||'#f8fafc')};color:${escHtml(CAT_TX[cat]||'#475569')}">${escHtml(cat)}</span>
              </div>
              <div class="ch-bubble">
                <div class="ch-bubble-title">${escHtml(title)}</div>
                ${body !== title ? `<div class="ch-bubble-body">${escHtml(body.slice(0, 200))}${body.length > 200 ? '…' : ''}</div>` : ''}
              </div>
            </div>
          </div>`);
      });
    });

  if (!msgParts.length) {
    msgParts.push('<div class="ch-empty">메시지 없음</div>');
  }

  // ── 전체 렌더링 ──
  el.innerHTML = `
    <div class="ch-layout">
      <div class="ch-sidebar">
        <div class="ch-sidebar-hd">
          <span class="ch-sidebar-title">메시지</span>
          <span class="ch-sidebar-cnt">${_stickies.filter(s=>s.src).length}개</span>
        </div>
        <div class="ch-contacts" id="chContacts">${listParts.join('')}</div>
      </div>
      <div class="ch-main">
        <div class="ch-main-hd">
          <div class="ch-av ch-av-lg" style="background:${escHtml(selCol)}">${escHtml(selInit)}</div>
          <div style="flex:1">
            <div class="ch-main-name">${escHtml(selShort)}</div>
            <div class="ch-main-sub">${escHtml(selGroup)}${_chatSelIp !== '__local__' ? ' · ' + escHtml(_chatSelIp) : ''} · ${selItems.length}개</div>
          </div>
          ${_chatSelIp !== '__local__' ? `<button class="btn primary ch-send-btn" data-ip="${escHtml(_chatSelIp)}" data-name="${escHtml(selShort)}">
            <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor" style="margin-right:4px"><path d="M15 8L1 15V1l14 7z"/></svg>
            스티키 전송
          </button>` : ''}
        </div>
        <div class="ch-messages" id="chMessages">${msgParts.join('')}</div>
      </div>
    </div>`;

  // ── 이벤트 위임 (PART 3) ──
  const contacts = el.querySelector('#chContacts');
  if (contacts) contacts.addEventListener('click', e => {
    const row = e.target.closest('[data-ip]');
    if (!row) return;
    _chatSelIp = row.dataset.ip;
    renderChat();
  });

  // 메시지 헤더 전송 버튼
  const sendBtn = el.querySelector('.ch-send-btn');
  if (sendBtn) sendBtn.addEventListener('click', e => {
    const btn = e.target.closest('[data-ip]');
    if (btn) openSendStickyModal(btn.dataset.ip, btn.dataset.name);
  });

  const messages = el.querySelector('#chMessages');
  if (messages) messages.addEventListener('click', e => {
    const msg = e.target.closest('[data-id]');
    if (!msg) return;
    openDetail(msg.dataset.id);
  });
}

/* ============================================================
   메뉴 관리 — ON/OFF 설정
   ============================================================ */

// 메뉴 정의 (순서 = 사이드바 순서)
const MENU_DEFS = [
  { id:'grid',     label:'카드 뷰',    desc:'스티키 전체 목록',         required: true  },
  { id:'timeline', label:'타임라인',   desc:'날짜순 흐름 보기',          required: false },
  { id:'friends',  label:'팀원',       desc:'그룹별 팀원 디렉토리',      required: false },
  { id:'chat',     label:'메시지',     desc:'팀원별 주고받은 대화 내역', required: false },
  { id:'pixel',    label:'오피스 맵',  desc:'픽셀 캐릭터 오피스 현황',   required: false },
  { id:'manage',   label:'스티키 관리',desc:'상태별 필터 (수정 예정)',    required: false },
  { id:'vault',    label:'보관함',     desc:'별도 저장 스티키 관리',     required: false },
];

let _menuConfig = {};  // { viewId: false } = 비활성

// 메뉴 설정 적용 (사이드바 show/hide)
function applyMenuConfig(cfg) {
  _menuConfig = cfg || {};
  MENU_DEFS.forEach(m => {
    const el = $('nav-' + m.id);
    if (!el) return;
    const isOn = m.required || (_menuConfig[m.id] !== false);
    el.style.display = isOn ? '' : 'none';
  });
}

// 메뉴 관리 탭 렌더링
function renderMenuMgr(cfg) {
  _menuConfig = cfg || {};
  const el = $('menuMgrList');
  if (!el) return;

  const parts = [];
  MENU_DEFS.forEach(m => {
    const isOn = m.required || (_menuConfig[m.id] !== false);
    parts.push(`
      <div class="mmgr-row">
        <div class="mmgr-info">
          <div class="mmgr-label">${escHtml(m.label)}</div>
          <div class="mmgr-desc">${escHtml(m.desc)}</div>
        </div>
        ${m.required
          ? '<span class="mmgr-locked">항상 표시</span>'
          : `<label class="mmgr-toggle">
              <input type="checkbox" data-menuid="${escHtml(m.id)}" ${isOn ? 'checked' : ''}>
              <span class="mmgr-slider"></span>
            </label>`
        }
      </div>`);
  });

  el.innerHTML = parts.join('');

  // 이벤트 위임 — 토글 즉시 반영
  el.addEventListener('change', e => {
    const cb = e.target.closest('input[data-menuid]');
    if (!cb) return;
    _menuConfig[cb.dataset.menuid] = cb.checked;
    applyMenuConfig(_menuConfig);
    // 현재 뷰가 비활성화되면 카드뷰로 이동
    const curNav = document.querySelector('.nav-item.active');
    const curView = curNav?.dataset?.view;
    if (curView && _menuConfig[curView] === false) switchView('grid');
  });
}

/* ============================================================
   스티키 앱 연동 — 새 스티키 / 열기
   ============================================================ */
let _stickiesExePath = null;

// stickies.exe 경로 확인 (최초 1회)
async function checkStickiesExe() {
  if (_stickiesExePath) return _stickiesExePath;
  try {
    _stickiesExePath = await window.stickyAPI.findStickiesExe();
  } catch(e) { _stickiesExePath = null; }
  return _stickiesExePath;
}

// ── 새 스티키 모달 열기 ──
async function openNewStickyModal() {
  const exePath = await checkStickiesExe();
  const hint = $('nsStickyHint');
  if (hint) {
    if (exePath) {
      hint.textContent = '✅ Stickies 앱 연결됨 — 보내기 클릭 시 클립보드 복사 후 스티키 생성';
      hint.style.color = 'var(--accent2)';
    } else {
      hint.textContent = '⚠️ Stickies.exe 를 찾지 못했습니다. 클립보드에만 복사됩니다.';
      hint.style.color = 'var(--accent-warn)';
    }
  }
  const ta = $('nsStickyText');
  if (ta) { ta.value = ''; ta.focus(); }
  $('newStickyOv')?.classList.remove('hidden');
}

function closeNewStickyModal() {
  $('newStickyOv')?.classList.add('hidden');
}

// ── 새 스티키 전송 ──
async function sendNewSticky() {
  const ta = $('nsStickyText');
  const text = ta?.value?.trim() || '';
  if (!text) { flash('내용을 입력하세요', 'warn', 2000); return; }

  try {
    const res = await window.stickyAPI.newSticky(text);
    if (res.ok) {
      flash('스티키 앱으로 보냈습니다', 'ok');
      closeNewStickyModal();
    } else {
      // 앱 못 찾으면 클립보드에라도 복사
      flash(`클립보드에 복사했습니다 (${res.error})`, 'warn');
      closeNewStickyModal();
    }
  } catch(e) {
    flash('오류: ' + e.message, 'err');
  }
}

// ── 기존 스티키 열기 ──
async function openStickyApp(stickyId) {
  const exePath = await checkStickiesExe();
  if (!exePath) {
    flash('Stickies.exe 를 찾지 못했습니다', 'warn', 3000);
    return;
  }
  try {
    const res = await window.stickyAPI.openSticky(stickyId);
    if (res.ok) flash('Stickies 앱을 실행했습니다', 'ok', 2000);
    else flash('열기 실패: ' + (res.error||''), 'warn');
  } catch(e) {
    flash('오류: ' + e.message, 'err');
  }
}

// ── 이벤트 등록 (DOMContentLoaded) ──
document.addEventListener('DOMContentLoaded', () => {
  $('btnNewSticky')?.addEventListener('click', openNewStickyModal);
  $('btnNewStickyClose')?.addEventListener('click', closeNewStickyModal);
  $('btnNewStickyCancel')?.addEventListener('click', closeNewStickyModal);
  $('btnNewStickySend')?.addEventListener('click', sendNewSticky);
  $('newStickyOv')?.addEventListener('click', e => {
    if (e.target === $('newStickyOv')) closeNewStickyModal();
  });
  // Ctrl+N 단축키
  document.addEventListener('keydown', e => {
    if (e.ctrlKey && e.key === 'n') { e.preventDefault(); openNewStickyModal(); }
    if (e.key === 'Escape') closeNewStickyModal();
  });
});

/* ============================================================
   스티키 전송 모달
   ============================================================ */
let _ssTargetIp   = '';
let _ssTargetName = '';

function openSendStickyModal(ip, name) {
  _ssTargetIp   = ip;
  _ssTargetName = name;

  $s('ssTarget',   name || ip);
  $s('ssTargetIp', ip);

  const ta   = $('ssStickyText');
  const hint = $('ssStickyHint');
  if (ta)   { ta.value = ''; ta.focus(); }
  if (hint) { hint.textContent = `→ ${ip}:52673 로 전송됩니다`; hint.style.color = 'var(--text-dim)'; }

  $('sendStickyOv')?.classList.remove('hidden');
}

function closeSendStickyModal() {
  $('sendStickyOv')?.classList.add('hidden');
}

async function doSendSticky() {
  const ta   = $('ssStickyText');
  const hint = $('ssStickyHint');
  const text = ta?.value?.trim() || '';

  if (!text) { flash('내용을 입력하세요', 'warn', 2000); return; }
  if (!_ssTargetIp) { flash('대상 IP 없음', 'warn'); return; }

  const btn = $('btnSendStickyGo');
  if (btn) { btn.disabled = true; btn.textContent = '전송 중...'; }
  const port = parseInt((await window.stickyAPI.getConfig().catch(()=>({stickyPort:52673}))).stickyPort || 52673, 10);
  if (hint) { hint.textContent = `${_ssTargetIp}:${port} 연결 중...`; hint.style.color = 'var(--accent-warn)'; }
  console.log('[doSendSticky] 전송 시작', _ssTargetIp, port, text);

  try {
    const res = await window.stickyAPI.sendStickyNet({
      ip:   _ssTargetIp,
      text: text,
      port: port,
    });
    console.log('[doSendSticky] 결과', res);

    if (res.ok) {
      flash(`${_ssTargetName || _ssTargetIp} 에게 전송했습니다 ✓`, 'ok', 3000);
      closeSendStickyModal();
    } else {
      if (hint) { hint.textContent = `전송 실패: ${res.msg}`; hint.style.color = 'var(--accent3)'; }
      flash(`전송 실패 — ${res.msg}`, 'err', 4000);
    }
  } catch(e) {
    if (hint) { hint.textContent = `오류: ${e.message}`; hint.style.color = 'var(--accent3)'; }
    flash('오류: ' + e.message, 'err');
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = '<svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor" style="margin-right:4px"><path d="M15 8L1 15V1l14 7z"/></svg>전송'; }
  }
}

// 이벤트 등록
document.addEventListener('DOMContentLoaded', () => {
  $('btnSendStickyClose')?.addEventListener('click', closeSendStickyModal);
  $('btnSendStickyCancel')?.addEventListener('click', closeSendStickyModal);
  $('btnSendStickyGo')?.addEventListener('click', doSendSticky);
  $('sendStickyOv')?.addEventListener('click', e => {
    if (e.target === $('sendStickyOv')) closeSendStickyModal();
  });
  // Ctrl+Enter로 전송
  $('ssStickyText')?.addEventListener('keydown', e => {
    if (e.ctrlKey && e.key === 'Enter') { e.preventDefault(); doSendSticky(); }
  });
});

/* ============================================================
   카테고리 관리 UI
   ============================================================ */

function _defaultCats() {
  return [
    { name:'보안', keywords:'ssl,인증서,보안,취약,방화벽' },
    { name:'기술', keywords:'powershell,api,http,www.,알고리즘' },
    { name:'법률', keywords:'법원,민사,소송,소유권,개정' },
    { name:'업무', keywords:'공지,공유,안내,문의,전달,감사합니다' },
    { name:'기타', keywords:'' },
  ];
}

function renderCatMgr(cats) {
  const el = $('catMgrList');
  if (!el) return;

  const parts = [];
  (cats || _defaultCats()).forEach((cat, idx) => {
    const isLast = idx === (cats||[]).length - 1;
    parts.push(`
      <div class="cat-row" data-idx="${parseInt(idx,10)}">
        <div class="cat-row-left">
          <input class="cat-name-input" type="text"
            placeholder="카테고리명" value="${escHtml(cat.name)}"
            data-field="name" data-idx="${parseInt(idx,10)}">
          <input class="cat-kw-input" type="text"
            placeholder="키워드 (쉼표 구분) — 비우면 기본값"
            value="${escHtml(cat.keywords)}"
            data-field="keywords" data-idx="${parseInt(idx,10)}">
        </div>
        <div class="cat-row-right">
          ${isLast
            ? '<span class="cat-default-tag">기본값</span>'
            : `<button class="cat-del-btn" data-delidx="${parseInt(idx,10)}" title="삭제">✕</button>`
          }
          ${idx > 0
            ? `<button class="cat-up-btn" data-upidx="${parseInt(idx,10)}" title="위로">↑</button>`
            : ''
          }
        </div>
      </div>`);
  });

  el.innerHTML = parts.join('');

  // 이벤트 위임 (PART 3)
  el.addEventListener('click', e => {
    // 삭제
    const del = e.target.closest('[data-delidx]');
    if (del) {
      const idx = parseInt(del.dataset.delidx, 10);
      const cur = collectCatMgr();
      cur.splice(idx, 1);
      renderCatMgr(cur);
      return;
    }
    // 위로
    const up = e.target.closest('[data-upidx]');
    if (up) {
      const idx = parseInt(up.dataset.upidx, 10);
      const cur = collectCatMgr();
      if (idx > 0) {
        [cur[idx-1], cur[idx]] = [cur[idx], cur[idx-1]];
        renderCatMgr(cur);
      }
      return;
    }
  });
}

// 현재 입력값 수집
function collectCatMgr() {
  const el = $('catMgrList');
  if (!el) return _defaultCats();

  const rows = el.querySelectorAll('.cat-row');
  const result = [];
  rows.forEach(row => {
    const name = row.querySelector('.cat-name-input')?.value?.trim() || '';
    const keywords = row.querySelector('.cat-kw-input')?.value?.trim() || '';
    if (name) result.push({ name, keywords });
  });
  return result.length ? result : _defaultCats();
}

// 카테고리 추가 버튼
document.addEventListener('DOMContentLoaded', () => {
  $('btnAddCat')?.addEventListener('click', () => {
    const cur = collectCatMgr();
    // 기본값 카테고리(마지막) 앞에 새 항목 삽입
    cur.splice(cur.length - 1, 0, { name: '', keywords: '' });
    renderCatMgr(cur);
    // 새로 추가된 입력창 포커스
    const inputs = $('catMgrList')?.querySelectorAll('.cat-name-input');
    if (inputs) inputs[inputs.length - 2]?.focus();
  });
});

/* ============================================================
   모바일 모드
   ============================================================ */
function toggleMobile() {
  applyMobileMode(!_isMobile, true);
}

async function applyMobileMode(enabled, callIpc) {
  _isMobile = enabled;
  document.body.classList.toggle('mobile', enabled);

  // 하단 탭바 표시/숨김
  const tabbar = $('mobileTabbar');
  if (tabbar) tabbar.style.display = enabled ? 'flex' : 'none';

  // 상단바 버튼 활성 표시
  const btn = $('btnMobile');
  if (btn) {
    btn.style.color    = enabled ? 'var(--accent)' : '';
    btn.style.background = enabled ? 'rgba(79,142,247,.15)' : '';
  }

  // IPC 창 크기 변경
  if (callIpc) {
    try { await window.stickyAPI.setMobileMode(enabled); } catch(e) {}
  }

  // 모바일 모드에서 현재 뷰 재렌더
  if (enabled) switchView(_currentView || 'grid');
}

// 하단 탭바 이벤트 (PART 3 이벤트 위임)
document.addEventListener('DOMContentLoaded', () => {
  const tabbar = $('mobileTabbar');
  if (!tabbar) return;

  tabbar.addEventListener('click', e => {
    const tab = e.target.closest('[data-view]');
    if (!tab) return;
    // 탭 활성
    tabbar.querySelectorAll('.mob-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    switchView(tab.dataset.view);
  });

  // 더보기 버튼 → 사이드바 메뉴 팝업 (임시: 타임라인으로 이동)
  const moreBtn = $('mobt-more');
  if (moreBtn) moreBtn.addEventListener('click', () => {
    switchView('timeline');
    tabbar.querySelectorAll('.mob-tab').forEach(t => t.classList.remove('active'));
  });
});

/* ============================================================
   전송그룹 관리 UI
   ============================================================ */
let _cfg_sendGroups = [];  // 전역 캐시

// 설정에서 전송그룹 렌더링
function renderSndGrpMgr(groups) {
  _cfg_sendGroups = groups || [];
  const el = $('sgrpList');
  if (!el) return;

  if (!_cfg_sendGroups.length) {
    el.innerHTML = '<div style="color:var(--text-dim);font-size:.75rem;padding:12px 4px">아직 그룹이 없습니다. 아래 버튼으로 추가하세요.</div>';
    return;
  }

  // 팀원 전체 목록
  const allMembers = [];
  _friends.forEach(g => g.members.forEach(m => {
    if (m.ip) allMembers.push({ name: m.name, ip: m.ip, group: g.group });
  }));

  const parts = [];
  _cfg_sendGroups.forEach((sg, idx) => {
    const memberIps = new Set((sg.members || []).map(m => m.ip));
    const memberCheckboxes = allMembers.map(m =>
      `<label class="sgrp-member-check">
        <input type="checkbox" data-sgidx="${parseInt(idx,10)}" data-ip="${escHtml(m.ip)}" data-name="${escHtml(m.name)}"
          ${memberIps.has(m.ip) ? 'checked' : ''}>
        <span>${escHtml(m.name)}</span>
        <span class="sgrp-member-ip">${escHtml(m.ip)}</span>
      </label>`
    ).join('');

    parts.push(`
      <div class="sgrp-row" data-sgidx="${parseInt(idx,10)}">
        <div class="sgrp-row-hd">
          <input class="sgrp-name-input" type="text" placeholder="그룹명"
            value="${escHtml(sg.name)}" data-sgidx="${parseInt(idx,10)}">
          <span class="sgrp-cnt">${(sg.members||[]).length}명</span>
          <button class="cat-del-btn" data-delsgidx="${parseInt(idx,10)}" title="그룹 삭제">✕</button>
        </div>
        <div class="sgrp-members">${memberCheckboxes}</div>
      </div>`);
  });

  el.innerHTML = parts.join('');

  // 이벤트 위임 (PART 3)
  el.addEventListener('click', e => {
    const del = e.target.closest('[data-delsgidx]');
    if (del) {
      const idx = parseInt(del.dataset.delsgidx, 10);
      _cfg_sendGroups.splice(idx, 1);
      renderSndGrpMgr(_cfg_sendGroups);
    }
  });

  el.addEventListener('change', e => {
    const cb = e.target.closest('input[type="checkbox"][data-sgidx]');
    if (cb) {
      const idx  = parseInt(cb.dataset.sgidx, 10);
      const ip   = cb.dataset.ip;
      const name = cb.dataset.name;
      const sg   = _cfg_sendGroups[idx];
      if (!sg) return;
      sg.members = sg.members || [];
      if (cb.checked) {
        if (!sg.members.some(m => m.ip === ip)) sg.members.push({ name, ip });
      } else {
        sg.members = sg.members.filter(m => m.ip !== ip);
      }
      // 카운트 업데이트
      const cntEl = cb.closest('.sgrp-row')?.querySelector('.sgrp-cnt');
      if (cntEl) cntEl.textContent = sg.members.length + '명';
    }
  });
}

// 현재 그룹 설정 수집
function collectSndGrpMgr() {
  const el = $('sgrpList');
  if (!el) return _cfg_sendGroups;

  // 그룹명 업데이트
  el.querySelectorAll('.sgrp-name-input').forEach(inp => {
    const idx = parseInt(inp.dataset.sgidx, 10);
    if (_cfg_sendGroups[idx]) _cfg_sendGroups[idx].name = inp.value.trim();
  });
  return _cfg_sendGroups.filter(sg => sg.name);
}

// 그룹 추가 버튼
document.addEventListener('DOMContentLoaded', () => {
  $('btnAddSndGrp')?.addEventListener('click', () => {
    _cfg_sendGroups.push({
      id:      'sg_' + Date.now(),
      name:    '',
      members: [],
    });
    renderSndGrpMgr(_cfg_sendGroups);
    // 새 그룹 이름 입력창 포커스
    const inputs = $('sgrpList')?.querySelectorAll('.sgrp-name-input');
    if (inputs?.length) inputs[inputs.length - 1].focus();
  });
});

/* ============================================================
   그룹 전송 모달
   ============================================================ */
let _grpSendId = '';

async function openGrpSendModal(sgId) {
  // config 최신화
  try {
    const cfg = await window.stickyAPI.getConfig();
    _cfg_sendGroups = cfg.sendGroups || [];
  } catch(e) {}

  const sg = _cfg_sendGroups.find(g => g.id === sgId);
  if (!sg) { flash('그룹을 찾을 수 없습니다', 'warn'); return; }

  _grpSendId = sgId;
  $s('grpSendName',  sg.name);
  $s('grpSendCount', `${(sg.members||[]).length}명`);

  // 멤버 목록 표시
  const el = $('grpSendMembers');
  if (el) {
    const parts = (sg.members || []).map(m =>
      `<div class="grp-member-item">
        <span class="grp-member-dot"></span>
        <span class="grp-member-name">${escHtml(m.name)}</span>
        <span class="grp-member-ip">${escHtml(m.ip)}</span>
        <span class="grp-member-status" id="gms_${escHtml(m.ip.replace(/\./g,'_'))}">대기</span>
      </div>`
    );
    el.innerHTML = parts.join('');
  }

  const ta = $('grpSendText');
  const hint = $('grpSendHint');
  if (ta) { ta.value = ''; ta.focus(); }
  if (hint) { hint.textContent = ''; }

  $('grpSendOv')?.classList.remove('hidden');
}

function closeGrpSendModal() {
  $('grpSendOv')?.classList.add('hidden');
}

async function doGrpSend() {
  const ta   = $('grpSendText');
  const hint = $('grpSendHint');
  const text = ta?.value?.trim() || '';

  if (!text) { flash('내용을 입력하세요', 'warn', 2000); return; }

  const sg = _cfg_sendGroups.find(g => g.id === _grpSendId);
  if (!sg || !sg.members?.length) { flash('전송할 멤버가 없습니다', 'warn'); return; }

  const btn = $('btnGrpSendGo');
  if (btn) { btn.disabled = true; btn.textContent = '전송 중...'; }
  if (hint) { hint.textContent = `0 / ${sg.members.length}명 전송 중...`; hint.style.color = 'var(--accent-warn)'; }

  try {
    const cfg  = await window.stickyAPI.getConfig().catch(() => ({ stickyPort: 52673 }));
    const port = parseInt(cfg.stickyPort || 52673, 10);

    let ok = 0, fail = 0;

    // 순차 전송 (PART 4: 배치 처리)
    for (const m of sg.members) {
      const statusId = `gms_${m.ip.replace(/\./g, '_')}`;
      const statusEl = $(statusId);
      if (statusEl) { statusEl.textContent = '전송 중...'; statusEl.className = 'grp-member-status sending'; }

      try {
        const res = await window.stickyAPI.sendStickyNet({ ip: m.ip, text, port });
        if (res.ok) {
          ok++;
          if (statusEl) { statusEl.textContent = '✓ 성공'; statusEl.className = 'grp-member-status success'; }
        } else {
          fail++;
          if (statusEl) { statusEl.textContent = '✗ 실패'; statusEl.className = 'grp-member-status fail'; }
        }
      } catch(e) {
        fail++;
        if (statusEl) { statusEl.textContent = '✗ 오류'; statusEl.className = 'grp-member-status fail'; }
      }

      if (hint) { hint.textContent = `${ok + fail} / ${sg.members.length}명 완료 (성공 ${ok} / 실패 ${fail})`; }
      // UI 업데이트 yield (PART 4)
      await new Promise(r => setTimeout(r, 100));
    }

    if (hint) {
      hint.textContent = `완료 — 성공 ${ok}명 / 실패 ${fail}명`;
      hint.style.color = fail === 0 ? 'var(--accent2)' : 'var(--accent3)';
    }
    flash(`${sg.name} 그룹 전송 완료 — 성공 ${ok} / 실패 ${fail}`, fail === 0 ? 'ok' : 'warn', 4000);

  } catch(e) {
    flash('오류: ' + e.message, 'err');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor" style="margin-right:4px"><path d="M15 8L1 15V1l14 7z"/></svg>그룹 전송';
    }
  }
}

// 이벤트 등록
document.addEventListener('DOMContentLoaded', () => {
  $('btnGrpSendClose')?.addEventListener('click',  closeGrpSendModal);
  $('btnGrpSendCancel')?.addEventListener('click', closeGrpSendModal);
  $('btnGrpSendGo')?.addEventListener('click',     doGrpSend);
  $('grpSendOv')?.addEventListener('click', e => {
    if (e.target === $('grpSendOv')) closeGrpSendModal();
  });
  $('grpSendText')?.addEventListener('keydown', e => {
    if (e.ctrlKey && e.key === 'Enter') { e.preventDefault(); doGrpSend(); }
  });
});
