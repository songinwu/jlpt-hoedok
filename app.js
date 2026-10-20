import {
  ASSUMED_MISS, REVIEW_SCOPES, SETS_PER_DAY, WEAK_ENTER, WEAK_LEAVE, answerReview, answerSet, answerWeak, buildIndex, ensureDeck,
  finishDate, newState, openWeak, planNextSet, restoreState, reviewCurrent, reviewIds, startReview, startSet, stats,
  today, weakIds,
} from './core.js';

const STORE_KEY = 'jlpt-hoedok-v1'; // 키는 그대로 두고 안의 version으로 형식을 구분한다 (v1 → v2 자동 이전)
const HANGUL = /[가-힣]/;
const SCOPE_LABEL = Object.fromEntries(REVIEW_SCOPES);
const TAG_LABEL = { carry: '지난 세트에서 넘어옴', confuse: '헷갈림 복습' };
const $app = document.getElementById('app');
const $modal = document.getElementById('modal');
const $toast = document.getElementById('toast');

let idx; // 단어장 색인
let state; // 진도 (localStorage)
let undoStack = []; // { hash, snap } — 답하기 직전 상태 전체
let revealed = false;
let saveFailed = false;
let afterNav = null; // 화면 이동이 끝난 뒤 띄울 창

// ── 저장 ────────────────────────────────────────────────

function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    // 책 방식(v1) 진도는 새 방식으로 옮길 때 사라지는 부분이 있어 원본을 따로 남겨 둔다
    if (parsed?.version === 1 && !localStorage.getItem(`${STORE_KEY}-old`)) localStorage.setItem(`${STORE_KEY}-old`, raw);
    return restoreState(parsed);
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
const num = (n) => n.toLocaleString('ko-KR');

function go(hash, then) {
  if (location.hash === hash || (hash === '#/' && !location.hash)) {
    closeModal();
    render();
    then?.();
  } else {
    afterNav = then ?? null;
    location.hash = hash;
  }
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

// ── 회독 방식별 연결 (세트 · 약점 책 · 전체 리뷰) ─────────────

const MODES = {
  set: {
    active: () => !!state.set,
    title: () => `세트 ${state.set.no}`,
    current: () => state.set.pending[0] ?? null,
    progress() {
      const s = state.set;
      const remaining = s.pending.length + s.retry.length;
      return { done: s.ids.length - remaining, total: s.ids.length, label: `${s.pass > 1 ? `${s.pass}바퀴 · ` : ''}남은 ${remaining}/${s.ids.length}` };
    },
    tag: (id) => TAG_LABEL[state.set.tags[id]] ?? '',
    answer: (known) => answerSet(state, idx, known),
  },
  weak: {
    active: () => true,
    open: () => openWeak(state, idx),
    title: () => '약점 책',
    current: () => state.weak?.pending[0] ?? null,
    progress() {
      const p = state.weak;
      const total = weakIds(state, idx).length;
      const remaining = p.pending.length + p.retry.length;
      return { done: total - remaining, total, label: `${p.round}회독째 · 남은 ${remaining}/${total}` };
    },
    tag: () => '',
    answer: (known) => answerWeak(state, idx, known),
  },
  review: {
    active: () => !!state.review,
    title: () => '전체 리뷰',
    current: () => reviewCurrent(state, idx),
    progress() {
      const r = state.review;
      return { done: r.pos, total: r.order.length, label: `${SCOPE_LABEL[r.scope]} · ${num(r.pos + 1)}/${num(r.order.length)}` };
    },
    tag: () => '',
    answer: (known) => answerReview(state, idx, known),
  },
};

function route() {
  const m = location.hash.match(/^#\/(set|weak|review)$/);
  return m ? m[1] : 'home';
}

function render() {
  const mode = route();
  if (mode !== 'home' && MODES[mode].active()) renderStudy(mode);
  else renderHome();
}

// ── 목록 화면 ────────────────────────────────────────────

function renderHome() {
  document.title = 'JLPT 회독';
  if (location.hash && location.hash !== '#/') history.replaceState(null, '', '#/');
  const st = stats(state, idx);
  const day = state.daily[today()] ?? { k: 0, s: 0, sets: 0 };
  const set = state.set;
  const comp = set ? set.comp : (({ carry, fresh, confuse }) => ({ carry: carry.length, fresh: fresh.length, confuse: confuse.length }))(planNextSet(state, idx));
  const setTotal = set ? set.ids.length : comp.carry + comp.fresh + comp.confuse;
  const remaining = set ? set.pending.length + set.retry.length : setTotal;
  const chips = [['넘어온', comp.carry], ['새', comp.fresh], ['헷갈림', comp.confuse]]
    .filter(([, n]) => n).map(([k, n]) => `<span class="chip">${k} ${n}</span>`).join('');
  const fin = finishDate(state, idx);
  const pace = fin
    ? `하루 ${SETS_PER_DAY}세트면 <b>${fin.date.getMonth() + 1}월 ${fin.date.getDate()}일</b>에 새 단어를 다 봐요 · 남은 새 단어 ${num(st.newLeft)}`
      + (fin.assumed ? ` · 세트마다 ${ASSUMED_MISS}개씩 넘어간다고 가정` : ` · 세트당 새 단어 약 ${fin.perSet}개`)
    : '새 단어를 모두 봤어요. 이제 세트는 넘어온·헷갈림 단어로 채워져요.';
  const r = state.review;
  const weakCount = weakIds(state, idx).length;

  $app.innerHTML = `
    <header class="home-head">
      <div>
        <h1>JLPT 회독</h1>
        <p class="sub">N3·N2 ${num(st.total)}단어</p>
      </div>
      <span class="dday">${dday()}</span>
      <button class="icon" data-act="settings" aria-label="설정">⚙︎</button>
    </header>
    <p class="today">오늘 <b>${day.sets}</b>세트 · <b>${num(day.k + day.s)}</b>장 · 처음 본 단어 <b>${num(st.seen)}</b>/${num(st.total)} · 약점 <b>${st.weak}</b></p>

    <button class="hero" data-act="go-set">
      <span class="hero-title">${set ? `세트 ${set.no} 이어하기` : `세트 ${state.setsDone + 1} 시작`}</span>
      <span class="hero-count">${set ? `남은 ${remaining}/${setTotal}` : `${setTotal}장`}</span>
      <span class="chips">${chips}</span>
      ${set ? `<span class="bar"><i style="width:${Math.round(((setTotal - remaining) / setTotal) * 100)}%"></i></span>` : ''}
    </button>
    <p class="pace">${pace}</p>

    <h2>복습</h2>
    <div class="tiles">
      <button class="tile" data-act="go-review">
        <span class="tile-title">전체 리뷰</span>
        <span class="tile-sub">${r ? `${SCOPE_LABEL[r.scope]} ${num(r.pos)}/${num(r.order.length)} · 이어하기` : '범위를 골라 한 바퀴'}</span>
        ${r ? `<span class="bar"><i style="width:${Math.round((r.pos / r.order.length) * 100)}%"></i></span>` : ''}
      </button>
      <button class="tile weak" data-act="go-weak">
        <span class="tile-title">약점 책</span>
        <span class="tile-sub">${weakCount ? `${weakCount}단어${state.weak ? ` · ${state.weak.round}회독째` : ''}` : '아직 없음'}</span>
      </button>
    </div>
    <p class="credit">단어 tanos.co.uk (Jonathan Waller, CC BY) · 한국어 뜻 Claude 작성</p>`;
}

// ── 카드 화면 ────────────────────────────────────────────

function wordClass(word) {
  const n = [...word].length;
  return n <= 3 ? 'xl' : n <= 6 ? 'lg' : n <= 9 ? 'md' : 'sm';
}

function cardHtml(w, show, tag) {
  const noteJa = w.note && !HANGUL.test(w.note) ? `<p class="note" lang="ja">${esc(w.note)}</p>` : '';
  const meta = [w.pos, idx.levelOf.get(w.id), w.note && HANGUL.test(w.note) ? w.note : '', tag].filter(Boolean).map(esc).join(' · ');
  const back = show
    ? `<div class="back">
        ${w.reading !== w.word ? `<p class="reading" lang="ja">${esc(w.reading)}</p>` : ''}
        <p class="meaning">${esc(w.meaning)}</p>
        <p class="pos">${meta}</p>
      </div>`
    : '<p class="hint">탭하면 읽기·뜻</p>';
  return `
    <div class="card${show ? ' revealed' : ''}" data-act="flip" role="button" tabindex="0" aria-label="카드 뒤집기">
      <p class="word ${wordClass(w.word)}" lang="ja">${esc(w.word)}</p>
      ${noteJa}
      ${back}
      <button class="speak" data-act="speak" aria-label="발음 듣기">🔊</button>
    </div>`;
}

function renderStudy(mode) {
  const M = MODES[mode];
  M.open?.();
  save();
  const title = M.title();
  document.title = `${title} — JLPT 회독`;
  const id = M.current();
  const back = '<button class="icon" data-act="home" aria-label="목록으로">‹</button>';

  if (!id) {
    $app.innerHTML = `
      <header class="topbar">${back}<div class="bar-title"><strong>${esc(title)}</strong></div></header>
      <section class="empty">
        <p>아직 약점 단어가 없어요.</p>
        <p class="help">세트·리뷰에서 <b>처음 봤을 때 「공부하겠음」</b>을 누른 횟수가 ${WEAK_ENTER}번 쌓인 단어가 여기로 와요.
        처음 봤을 때 「알고있음」을 ${WEAK_LEAVE}번 연속 누르면 빠져나가요.</p>
      </section>`;
    return;
  }

  const w = idx.byId.get(id);
  const prog = M.progress();
  const pct = prog.total ? Math.round((prog.done / prog.total) * 100) : 0;
  const show = revealed || state.settings.glasses;
  const { glasses, autoSpeak } = state.settings;
  const canUndo = undoStack.at(-1)?.hash === `#/${mode}`;
  $app.innerHTML = `
    <div class="study">
      <header class="topbar">
        ${back}
        <div class="bar-title"><strong>${esc(title)}</strong><span>${esc(prog.label)}</span></div>
        <button class="icon toggle" data-act="glasses" aria-pressed="${glasses}" aria-label="안경: 뜻 항상 보기">👓</button>
        <button class="icon" data-act="mode-menu" aria-label="메뉴">⋯</button>
      </header>
      <div class="progress"><i style="width:${pct}%"></i></div>
      <section class="stage">${cardHtml(w, show, M.tag(id))}</section>
      <footer class="actions">
        <button class="btn study-btn" data-act="study">공부하겠음</button>
        <button class="btn know-btn" data-act="know">알고있음</button>
      </footer>
      <div class="subactions">
        <button class="link" data-act="undo" ${canUndo ? '' : 'disabled'}>↶ 되돌리기</button>
        <button class="link toggle" data-act="autospeak" aria-pressed="${autoSpeak}">🔊 자동 발음 ${autoSpeak ? '켜짐' : '꺼짐'}</button>
      </div>
    </div>`;
}

function currentEntry() {
  const mode = route();
  if (mode === 'home' || !MODES[mode].active()) return null;
  const id = MODES[mode].current();
  return id ? { mode, w: idx.byId.get(id) } : null;
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
  const snap = JSON.stringify(state);
  const res = MODES[cur.mode].answer(known);
  if (!res) return;
  undoStack.push({ hash: `#/${cur.mode}`, snap });
  if (undoStack.length > 20) undoStack.shift();
  save();
  for (const e of res.events) {
    const word = idx.byId.get(e.id).word;
    toast(e.type === 'weak-in' ? `약점 책에 추가: ${word}` : `약점 책 졸업 🎓 ${word}`);
  }
  revealed = false;
  if (!res.complete) {
    render();
    if (state.settings.autoSpeak && state.settings.glasses) speak(currentEntry()?.w.reading);
  } else if (cur.mode === 'set') {
    go('#/', () => showSetComplete(res.complete));
  } else if (cur.mode === 'review') {
    go('#/', () => showReviewComplete(res.complete));
  } else {
    render();
    showWeakComplete(res.complete);
  }
}

function undo() {
  const last = undoStack.pop();
  if (!last) return;
  state = restoreState(JSON.parse(last.snap));
  save();
  revealed = false;
  go(last.hash);
  toast('되돌렸어요');
}

function toggleSetting(key) {
  state.settings[key] = !state.settings[key];
  save();
  render();
  toast(`${{ glasses: '안경', autoSpeak: '자동 발음' }[key]} ${state.settings[key] ? '켜짐' : '꺼짐'}`);
}

function beginSet() {
  if (!state.set) {
    startSet(state, idx);
    save();
  }
  go('#/set');
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

const undoLink = () => (undoStack.length ? '<button class="link center" data-act="undo">↶ 마지막 답 되돌리기</button>' : '');

function showSetComplete(c) {
  const seen = c.firstKnown + c.firstStudy;
  const list = c.missed.map((id) => idx.byId.get(id)).filter(Boolean).map((w) => `
    <li><span class="wl-word" lang="ja">${esc(w.word)}</span><span class="wl-reading" lang="ja">${esc(w.reading !== w.word ? w.reading : '')}</span><span class="wl-meaning">${esc(w.meaning)}</span></li>`).join('');
  openModal(`
    <p class="big">🎉</p>
    <h2 class="center">세트 ${c.no} 완료</h2>
    <p class="center">처음 봤을 때 바로 안 단어 <b>${c.firstKnown}</b> / ${seen}</p>
    ${c.missed.length
      ? `<details class="missed"><summary>다음 세트로 넘어가는 단어 <b>${c.missed.length}</b>개</summary><ul class="wordlist">${list}</ul></details>`
      : '<p class="center">다음 세트로 넘어가는 단어가 없어요 👏</p>'}
    <div class="row-btns">
      <button class="btn" data-act="close">목록으로</button>
      <button class="btn know-btn" data-act="go-set">세트 ${c.no + 1} 시작</button>
    </div>
    ${undoLink()}`);
}

function showWeakComplete(c) {
  openModal(`
    <p class="big">🎉</p>
    <h2 class="center">약점 책 ${c.round}회독 완료</h2>
    <p class="center">처음 봤을 때 바로 안 단어 <b>${c.firstKnown}</b> / ${c.firstKnown + c.firstStudy}</p>
    <div class="row-btns">
      <button class="btn" data-act="home">목록으로</button>
      <button class="btn know-btn" data-act="close">${c.round + 1}회독 시작</button>
    </div>`);
}

function showReviewComplete(c) {
  openModal(`
    <p class="big">🎉</p>
    <h2 class="center">전체 리뷰 완료 — ${esc(SCOPE_LABEL[c.scope])}</h2>
    <p class="center">알고있음 <b>${num(c.known)}</b> · 공부하겠음 <b>${num(c.study)}</b></p>
    <p class="help center">공부하겠음을 누른 단어는 다음 세트들의 헷갈림 단어로 먼저 나와요.</p>
    <button class="btn wide" data-act="close">확인</button>
    ${undoLink()}`);
}

function showReviewScopes() {
  const rows = REVIEW_SCOPES.map(([key, label]) => {
    const n = reviewIds(state, idx, key).length;
    return `<button class="scope" data-act="review-start" data-scope="${key}" ${n ? '' : 'disabled'}>
      <span>${label}</span><span class="scope-n">${num(n)}단어</span></button>`;
  }).join('');
  openModal(`
    <h2>전체 리뷰</h2>
    <p class="help">고른 범위를 섞어서 한 바퀴만 봐요. 어디까지 봤는지 저장돼서 이어 볼 수 있어요.
    여기서 모른 단어는 다음 세트들의 헷갈림 단어로 먼저 나와요.</p>
    <div class="scopes">${rows}</div>
    <button class="btn wide" data-act="close">닫기</button>`);
}

function showModeMenu() {
  const mode = route();
  if (mode === 'set') {
    const c = state.set.comp;
    openModal(`
      <h2>세트 ${state.set.no}</h2>
      <p>넘어온 단어 <b>${c.carry}</b> · 새 단어 <b>${c.fresh}</b> · 헷갈림 <b>${c.confuse}</b></p>
      <p class="help">세트를 끝까지 하면 처음 봤을 때 모른 단어가 전부 다음 세트로 넘어가요.
      나갔다 와도 이어서 할 수 있어요.</p>
      <button class="btn wide" data-act="close">닫기</button>`);
  } else if (mode === 'review') {
    openModal(`
      <h2>전체 리뷰 — ${esc(SCOPE_LABEL[state.review.scope])}</h2>
      <p class="help">그만두면 지금까지 답한 기록은 남고, 다음에 범위를 새로 골라 시작해요.</p>
      <div class="row-btns">
        <button class="btn" data-act="close">닫기</button>
        <button class="btn danger" data-act="review-stop">리뷰 그만두기</button>
      </div>`);
  } else {
    openModal(`
      <h2>약점 책</h2>
      <p class="help">이번 회독 진도를 지우고 1회독부터 다시 시작해요. 약점 단어 목록은 그대로예요.</p>
      <div class="row-btns">
        <button class="btn" data-act="close">닫기</button>
        <button class="btn danger" data-act="weak-reset">처음부터 다시</button>
      </div>`);
  }
}

function showSettings() {
  const s = state.settings;
  const check = (key, label) => `
    <label class="row"><span>${label}</span><input type="checkbox" data-set="${key}" ${s[key] ? 'checked' : ''}></label>`;
  openModal(`
    <h2>설정</h2>
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
      ensureDeck(state, idx);
      save();
      undoStack = [];
      go('#/');
      toast('백업을 불러왔어요');
    });
  } catch {
    toast('백업 파일이 아니에요');
  }
}

// ── 입력 ────────────────────────────────────────────────

function handleAct(act, el) {
  switch (act) {
    case 'home': go('#/'); break;
    case 'close': closeModal(); break;
    case 'settings': showSettings(); break;
    case 'go-set': closeModal(); beginSet(); break;
    case 'go-weak': go('#/weak'); break;
    case 'go-review':
      if (state.review) go('#/review');
      else showReviewScopes();
      break;
    case 'review-start':
      startReview(state, idx, el.dataset.scope);
      save();
      closeModal();
      go('#/review');
      break;
    case 'review-stop':
      state.review = null;
      save();
      go('#/');
      break;
    case 'weak-reset':
      state.weak = null;
      save();
      closeModal();
      render();
      break;
    case 'flip': flip(); break;
    case 'speak': speak(currentEntry()?.w.reading); break;
    case 'know': doAnswer(true); break;
    case 'study': doAnswer(false); break;
    case 'undo': closeModal(); undo(); break;
    case 'glasses': toggleSetting('glasses'); break;
    case 'autospeak': toggleSetting('autoSpeak'); break;
    case 'mode-menu': showModeMenu(); break;
    case 'export': exportBackup(); break;
    case 'confirm-ok': {
      const fn = pendingConfirm;
      pendingConfirm = null;
      closeModal();
      fn?.();
      break;
    }
    case 'reset-all':
      confirmBox('세트·리뷰·약점 책 기록을 모두 지울까요? 되돌릴 수 없어요.', '모두 지우기', () => {
        const settings = state.settings;
        state = newState();
        state.settings = settings;
        ensureDeck(state, idx);
        undoStack = [];
        save();
        go('#/');
        toast('모든 진도를 지웠어요');
      });
      break;
  }
}

let suppressClick = false;

$app.addEventListener('click', (e) => {
  if (suppressClick) {
    suppressClick = false;
    return;
  }
  const el = e.target.closest('[data-act]');
  if (el) handleAct(el.dataset.act, el);
});

$modal.addEventListener('click', (e) => {
  if (e.target === $modal) return closeModal();
  const el = e.target.closest('[data-act]');
  if (el && el.dataset.act !== 'import') handleAct(el.dataset.act, el);
});

$modal.addEventListener('change', (e) => {
  const key = e.target.dataset.set;
  if (key) {
    state.settings[key] = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    save();
    if (route() === 'home') renderHome();
  } else if (e.target.dataset.act === 'import' && e.target.files[0]) {
    importBackup(e.target.files[0]);
  }
});

document.addEventListener('keydown', (e) => {
  if (!$modal.hidden) {
    if (e.key === 'Escape') closeModal();
    return;
  }
  if (!currentEntry() || e.metaKey || e.ctrlKey || e.altKey) return;
  const k = e.key.toLowerCase();
  if (k === ' ' || k === 'enter') flip();
  else if (k === 'arrowright') doAnswer(true);
  else if (k === 'arrowleft') doAnswer(false);
  else if (k === 'z' || k === 'backspace') undo();
  else if (k === 's') speak(currentEntry()?.w.reading);
  else if (k === 'escape') go('#/');
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
  revealed = false;
  closeModal();
  render();
  window.scrollTo(0, 0);
  const then = afterNav;
  afterNav = null;
  then?.();
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
  ensureDeck(state, idx);
  save();
  render();
  navigator.storage?.persist?.();
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
}

init();
