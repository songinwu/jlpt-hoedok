import {
  WEAK_BOOK, WEAK_ENTER, WEAK_LEAVE, answer, bookSummary, bookWordIds, buildIndex, currentWord, newState,
  openBook, resetBook, restore, restoreState, snapshot, today,
} from './core.js';

const STORE_KEY = 'jlpt-hoedok-v1';
const HANGUL = /[가-힣]/;
const $app = document.getElementById('app');
const $modal = document.getElementById('modal');
const $toast = document.getElementById('toast');

let idx; // 단어장 색인
let state; // 진도 (localStorage)
let titles; // bookId → 책 이름
let undoStack = []; // 지금 책에서의 되돌리기
let revealed = false;
let saveFailed = false;

// ── 저장 ────────────────────────────────────────────────

function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    return restoreState(raw ? JSON.parse(raw) : null);
  } catch {
    return newState();
  }
}

function save() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
    saveFailed = false;
  } catch {
    if (!saveFailed) toast('저장에 실패했어요. 설정 → 백업 내보내기를 해 두세요.', 4000);
    saveFailed = true;
  }
}

// ── 공통 ────────────────────────────────────────────────

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function route() {
  const m = location.hash.match(/^#\/book\/(.+)$/);
  return m ? { view: 'study', bookId: decodeURIComponent(m[1]) } : { view: 'home' };
}

function render() {
  const r = route();
  if (r.view === 'study' && (r.bookId === WEAK_BOOK || idx.byBook.has(r.bookId))) renderStudy(r.bookId);
  else renderHome();
}

let toastTimer;
function toast(msg, ms = 1800) {
  $toast.textContent = msg;
  $toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $toast.classList.remove('show'), ms);
}

function dday() {
  const [y, m, d] = (state.settings.examDate || '2026-12-06').split('-').map(Number);
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const n = Math.round((new Date(y, m - 1, d) - start) / 86400000);
  return n > 0 ? `D-${n}` : n === 0 ? 'D-DAY' : `D+${-n}`;
}

function speak(text) {
  if (!('speechSynthesis' in window) || !text) return;
  const u = new SpeechSynthesisUtterance(text.replace(/[～〜]/g, ''));
  u.lang = 'ja-JP';
  u.rate = 0.9;
  const voice = speechSynthesis.getVoices().find((v) => v.lang?.startsWith('ja'));
  if (voice) u.voice = voice;
  speechSynthesis.cancel();
  speechSynthesis.speak(u);
}

// ── 목록 화면 ────────────────────────────────────────────

function bookRow(bookId, title, sub, extraClass = '') {
  const s = bookSummary(state, idx, bookId);
  const pct = s.total ? Math.round(((s.total - s.remaining) / s.total) * 100) : 0;
  const status = !s.total ? '비어 있음' : s.started ? `${s.round}회독째 · 남은 ${s.remaining}` : `${s.total}단어`;
  return `
    <button class="book ${extraClass}" data-book="${esc(bookId)}">
      <span class="book-title">${esc(title)}</span>
      <span class="book-sub">${sub}</span>
      <span class="book-status">${s.done ? `<span class="badge">${s.done}회독</span>` : ''}${status}</span>
      <span class="bar"><i style="width:${pct}%"></i></span>
    </button>`;
}

function renderHome() {
  document.title = 'JLPT 회독';
  const day = state.daily[today()] ?? { k: 0, s: 0 };
  const weakCount = bookWordIds(state, idx, WEAK_BOOK).length;

  const groups = [];
  for (const b of idx.books) {
    const name = b.kind === 'affix' ? `${b.level} 접사` : b.level;
    let g = groups.find((x) => x.name === name);
    if (!g) groups.push((g = { name, books: [] }));
    g.books.push(b);
  }

  $app.innerHTML = `
    <header class="home-head">
      <div>
        <h1>JLPT 회독</h1>
        <p class="sub">N3·N2 ${idx.byId.size.toLocaleString()}단어</p>
      </div>
      <span class="dday">${dday()}</span>
      <button class="icon" data-act="settings" aria-label="설정">⚙︎</button>
    </header>
    <p class="today">오늘 <b>${day.k + day.s}</b>장 · 알고있음 ${day.k} · 공부하겠음 ${day.s}</p>
    ${bookRow(WEAK_BOOK, '약점 책', weakCount ? `${weakCount}단어` : '아직 없음', 'weak')}
    ${groups.map((g) => `
      <h2>${esc(g.name)}</h2>
      <div class="books">${g.books.map((b) => bookRow(b.id, b.title, `<span lang="ja">${esc(b.range)}</span>`)).join('')}</div>
    `).join('')}
    <p class="credit">단어 tanos.co.uk (Jonathan Waller, CC BY) · 한국어 뜻 Claude 작성</p>`;
}

// ── 회독 화면 ────────────────────────────────────────────

function wordClass(word) {
  const n = [...word].length;
  return n <= 3 ? 'xl' : n <= 6 ? 'lg' : n <= 9 ? 'md' : 'sm';
}

function cardHtml(w, show, bookId) {
  const noteJa = w.note && !HANGUL.test(w.note) ? `<p class="note" lang="ja">${esc(w.note)}</p>` : '';
  const noteKo = w.note && HANGUL.test(w.note) ? ` · ${esc(w.note)}` : '';
  const origin = bookId === WEAK_BOOK ? `<p class="origin">${esc(titles.get(w.book))}</p>` : '';
  const back = show
    ? `<div class="back">
        ${w.reading !== w.word ? `<p class="reading" lang="ja">${esc(w.reading)}</p>` : ''}
        <p class="meaning">${esc(w.meaning)}</p>
        <p class="pos">${esc(w.pos)}${noteKo}</p>
      </div>`
    : '<p class="hint">탭하면 읽기·뜻</p>';
  return `
    <div class="card${show ? ' revealed' : ''}" data-act="flip" role="button" tabindex="0" aria-label="카드 뒤집기">
      ${origin}
      <p class="word ${wordClass(w.word)}" lang="ja">${esc(w.word)}</p>
      ${noteJa}
      ${back}
      <button class="speak" data-act="speak" aria-label="발음 듣기">🔊</button>
    </div>`;
}

function renderStudy(bookId) {
  const p = openBook(state, idx, bookId);
  save();
  const title = bookId === WEAK_BOOK ? '약점 책' : titles.get(bookId);
  document.title = `${title} — JLPT 회독`;
  const total = bookWordIds(state, idx, bookId).length;
  const id = currentWord(p);

  if (!id) {
    $app.innerHTML = `
      <header class="topbar"><button class="icon" data-act="home" aria-label="목록으로">‹</button>
        <div class="bar-title"><strong>${esc(title)}</strong></div></header>
      <section class="empty">
        <p>아직 약점 단어가 없어요.</p>
        <p class="help">본편 회독에서 <b>처음 봤을 때 「공부하겠음」</b>을 누른 회독이 ${WEAK_ENTER}번 쌓인 단어가 여기로 와요.
        여기서 처음 봤을 때 「알고있음」을 ${WEAK_LEAVE}회독 연속으로 누르면 빠져나가요.</p>
      </section>`;
    return;
  }

  const w = idx.byId.get(id);
  const remaining = p.pending.length + p.retry.length;
  const pct = total ? Math.round(((total - remaining) / total) * 100) : 0;
  const show = revealed || state.settings.glasses;
  const { glasses, random, autoSpeak } = state.settings;
  $app.innerHTML = `
    <div class="study">
      <header class="topbar">
        <button class="icon" data-act="home" aria-label="목록으로">‹</button>
        <div class="bar-title">
          <strong>${esc(title)}</strong>
          <span>${p.round}회독째${p.pass > 1 ? ` · ${p.pass}바퀴` : ''} · 남은 ${remaining}/${total}</span>
        </div>
        <button class="icon toggle" data-act="glasses" aria-pressed="${glasses}" aria-label="안경: 뜻 항상 보기">👓</button>
        <button class="icon toggle" data-act="random" aria-pressed="${random}" aria-label="랜덤 순서">🔀</button>
        <button class="icon" data-act="book-menu" aria-label="책 메뉴">⋯</button>
      </header>
      <div class="progress"><i style="width:${pct}%"></i></div>
      <section class="stage">${cardHtml(w, show, bookId)}</section>
      <footer class="actions">
        <button class="btn study-btn" data-act="study">공부하겠음</button>
        <button class="btn know-btn" data-act="know">알고있음</button>
      </footer>
      <div class="subactions">
        <button class="link" data-act="undo" ${undoStack.length ? '' : 'disabled'}>↶ 되돌리기</button>
        <button class="link toggle" data-act="autospeak" aria-pressed="${autoSpeak}">🔊 자동 발음 ${autoSpeak ? '켜짐' : '꺼짐'}</button>
      </div>
    </div>`;
}

function currentEntry() {
  const r = route();
  if (r.view !== 'study') return null;
  const id = currentWord(state.books[r.bookId]);
  return id ? { bookId: r.bookId, w: idx.byId.get(id) } : null;
}

function flip() {
  const cur = currentEntry();
  if (!cur || state.settings.glasses) return;
  revealed = !revealed;
  render();
  if (revealed && state.settings.autoSpeak) speak(cur.w.reading);
}

function doAnswer(known) {
  const cur = currentEntry();
  if (!cur || !$modal.hidden) return;
  const snap = snapshot(state, cur.bookId);
  const res = answer(state, idx, cur.bookId, known);
  if (!res) return;
  undoStack.push(snap);
  if (undoStack.length > 50) undoStack.shift();
  save();
  for (const e of res.events) {
    const word = idx.byId.get(e.id).word;
    toast(e.type === 'weak-in' ? `약점 책에 추가: ${word}` : `약점 책 졸업 🎓 ${word}`);
  }
  revealed = false;
  render();
  if (res.complete) showComplete(cur.bookId, res.complete);
  else if (state.settings.autoSpeak && state.settings.glasses) speak(currentEntry()?.w.reading);
}

function undo() {
  const snap = undoStack.pop();
  if (!snap) return;
  restore(state, snap);
  save();
  closeModal();
  revealed = false;
  render();
  toast('되돌렸어요');
}

function toggleSetting(key) {
  state.settings[key] = !state.settings[key];
  save();
  render();
  const label = { glasses: '안경', random: '랜덤 순서', autoSpeak: '자동 발음' }[key];
  toast(`${label} ${state.settings[key] ? '켜짐' : '꺼짐'}${key === 'random' ? ' (다음 바퀴부터)' : ''}`);
}

// ── 모달 ────────────────────────────────────────────────

function openModal(html) {
  $modal.innerHTML = `<div class="sheet" role="dialog" aria-modal="true">${html}</div>`;
  $modal.hidden = false;
}

function closeModal() {
  $modal.hidden = true;
  $modal.innerHTML = '';
}

let pendingConfirm = null;
function confirmBox(message, okLabel, onOk) {
  pendingConfirm = onOk;
  openModal(`
    <p class="confirm-msg">${message}</p>
    <div class="row-btns">
      <button class="btn" data-act="close">취소</button>
      <button class="btn danger" data-act="confirm-ok">${esc(okLabel)}</button>
    </div>`);
}

function showComplete(bookId, c) {
  const title = bookId === WEAK_BOOK ? '약점 책' : titles.get(bookId);
  const seen = c.firstKnown + c.firstStudy;
  openModal(`
    <p class="big">🎉</p>
    <h2>${esc(title)} ${c.round}회독 완료</h2>
    <p>처음 봤을 때 바로 안 단어 <b>${c.firstKnown}</b> / ${seen}</p>
    ${c.weakIn ? `<p>약점 책에 들어간 단어 <b>${c.weakIn}</b>개</p>` : ''}
    <div class="row-btns">
      <button class="btn" data-act="home">목록으로</button>
      <button class="btn know-btn" data-act="close">${c.round + 1}회독 시작</button>
    </div>`);
}

function showBookMenu() {
  const r = route();
  const title = r.bookId === WEAK_BOOK ? '약점 책' : titles.get(r.bookId);
  openModal(`
    <h2>${esc(title)}</h2>
    <p class="help">회독 수와 이번 회독 진도를 지우고 1회독부터 다시 시작해요. 약점 책 기록은 그대로예요.</p>
    <div class="row-btns">
      <button class="btn" data-act="close">닫기</button>
      <button class="btn danger" data-act="reset-book">처음부터 다시</button>
    </div>`);
}

function showSettings() {
  const s = state.settings;
  const check = (key, label) => `
    <label class="row"><span>${label}</span><input type="checkbox" data-set="${key}" ${s[key] ? 'checked' : ''}></label>`;
  openModal(`
    <h2>설정</h2>
    ${check('random', '랜덤 순서')}
    ${check('glasses', '안경 — 뜻 항상 보기')}
    ${check('autoSpeak', '자동 발음 (뜻이 보일 때)')}
    <label class="row"><span>시험일</span><input type="date" data-set="examDate" value="${esc(s.examDate)}"></label>
    <h3>백업</h3>
    <p class="help">진도는 이 기기의 브라우저에만 저장돼요. 가끔 내보내 두세요.</p>
    <div class="row-btns">
      <button class="btn" data-act="export">내보내기</button>
      <label class="btn">불러오기<input type="file" accept="application/json,.json" data-act="import" hidden></label>
    </div>
    <h3>키보드</h3>
    <p class="help">Space 뒤집기 · → 알고있음 · ← 공부하겠음 · Z 되돌리기 · S 발음 · Esc 목록</p>
    <h3>초기화</h3>
    <button class="btn danger wide" data-act="reset-all">모든 진도 지우기</button>
    <button class="btn wide" data-act="close">닫기</button>`);
}

function exportBackup() {
  const body = JSON.stringify({ app: 'jlpt-hoedok', exportedAt: new Date().toISOString(), state });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([body], { type: 'application/json' }));
  a.download = `hoedok-backup-${today().replaceAll('-', '')}.json`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function importBackup(file) {
  try {
    const obj = JSON.parse(await file.text());
    if (obj?.app !== 'jlpt-hoedok' || !obj.state) throw new Error('형식');
    confirmBox('지금 진도를 백업 파일 내용으로 바꿀까요?', '바꾸기', () => {
      state = restoreState(obj.state);
      save();
      undoStack = [];
      render();
      toast('백업을 불러왔어요');
    });
  } catch {
    toast('백업 파일이 아니에요');
  }
}

// ── 입력 ────────────────────────────────────────────────

let suppressClick = false;

$app.addEventListener('click', (e) => {
  if (suppressClick) {
    suppressClick = false;
    return;
  }
  const book = e.target.closest('[data-book]');
  if (book) {
    location.hash = `#/book/${encodeURIComponent(book.dataset.book)}`;
    return;
  }
  const act = e.target.closest('[data-act]')?.dataset.act;
  switch (act) {
    case 'home': location.hash = '#/'; break;
    case 'settings': showSettings(); break;
    case 'flip': flip(); break;
    case 'speak': speak(currentEntry()?.w.reading); break;
    case 'know': doAnswer(true); break;
    case 'study': doAnswer(false); break;
    case 'undo': undo(); break;
    case 'glasses': toggleSetting('glasses'); break;
    case 'random': toggleSetting('random'); break;
    case 'autospeak': toggleSetting('autoSpeak'); break;
    case 'book-menu': showBookMenu(); break;
  }
});

$modal.addEventListener('click', (e) => {
  if (e.target === $modal) return closeModal();
  const act = e.target.closest('[data-act]')?.dataset.act;
  switch (act) {
    case 'close': closeModal(); break;
    case 'home': closeModal(); location.hash = '#/'; break;
    case 'export': exportBackup(); break;
    case 'confirm-ok': {
      const fn = pendingConfirm;
      pendingConfirm = null;
      closeModal();
      fn?.();
      break;
    }
    case 'reset-book':
      confirmBox('이 책의 회독 기록을 지울까요?', '지우기', () => {
        resetBook(state, route().bookId);
        undoStack = [];
        save();
        render();
        toast('1회독부터 다시 시작해요');
      });
      break;
    case 'reset-all':
      confirmBox('모든 책의 회독 기록과 약점 책을 지울까요? 되돌릴 수 없어요.', '모두 지우기', () => {
        const settings = state.settings;
        state = newState();
        state.settings = settings;
        undoStack = [];
        save();
        render();
        toast('모든 진도를 지웠어요');
      });
      break;
  }
});

$modal.addEventListener('change', (e) => {
  const key = e.target.dataset.set;
  if (key) {
    state.settings[key] = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    save();
    render();
  } else if (e.target.dataset.act === 'import' && e.target.files[0]) {
    importBackup(e.target.files[0]);
  }
});

document.addEventListener('keydown', (e) => {
  if (!$modal.hidden) {
    if (e.key === 'Escape') closeModal();
    return;
  }
  if (route().view !== 'study' || e.metaKey || e.ctrlKey || e.altKey) return;
  const k = e.key.toLowerCase();
  if (k === ' ' || k === 'enter') flip();
  else if (k === 'arrowright') doAnswer(true);
  else if (k === 'arrowleft') doAnswer(false);
  else if (k === 'z' || k === 'backspace') undo();
  else if (k === 's') speak(currentEntry()?.w.reading);
  else if (k === 'escape') location.hash = '#/';
  else return;
  e.preventDefault();
});

// 카드 스와이프: 오른쪽 = 알고있음, 왼쪽 = 공부하겠음
let touch = null;
$app.addEventListener('touchstart', (e) => {
  const card = e.target.closest('.card');
  if (!card || e.touches.length > 1) return;
  touch = { x: e.touches[0].clientX, y: e.touches[0].clientY, dx: 0, card };
}, { passive: true });

$app.addEventListener('touchmove', (e) => {
  if (!touch) return;
  const dx = e.touches[0].clientX - touch.x;
  const dy = e.touches[0].clientY - touch.y;
  if (Math.abs(dy) > Math.abs(dx) && Math.abs(touch.dx) < 10) return;
  touch.dx = dx;
  touch.card.style.transform = `translateX(${dx}px) rotate(${dx / 25}deg)`;
  touch.card.classList.toggle('lean-know', dx > 60);
  touch.card.classList.toggle('lean-study', dx < -60);
}, { passive: true });

$app.addEventListener('touchend', () => {
  if (!touch) return;
  const { dx, card } = touch;
  touch = null;
  if (Math.abs(dx) > 10) {
    // 끌었으면 뒤따라오는 click(뒤집기)을 한 번 무시한다. click이 안 올 수도 있어 시간으로도 푼다.
    suppressClick = true;
    setTimeout(() => (suppressClick = false), 400);
  }
  if (Math.abs(dx) > 90) {
    doAnswer(dx > 0);
  } else {
    card.style.transform = '';
    card.classList.remove('lean-know', 'lean-study');
  }
});

window.addEventListener('hashchange', () => {
  undoStack = [];
  revealed = false;
  closeModal();
  render();
  window.scrollTo(0, 0);
});

// ── 시작 ────────────────────────────────────────────────

async function init() {
  state = load();
  try {
    const res = await fetch('./words.json');
    idx = buildIndex(await res.json());
  } catch {
    $app.innerHTML = '<p class="loading">단어장을 불러오지 못했어요. 새로고침해 보세요.</p>';
    return;
  }
  titles = new Map(idx.books.map((b) => [b.id, b.title]));
  render();
  navigator.storage?.persist?.();
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
}

init();
