// 회독 로직 — DOM에 의존하지 않는다 (tests/core.test.js에서 node로 검증)
//
// 회독 한 번 = 책의 모든 단어가 '알고있음'이 될 때까지.
//   pass: 남은 단어를 한 바퀴 도는 것. '공부하겠음'을 누른 단어는 다음 pass로 넘어간다.
//   첫 등장: 그 회독에서 단어를 처음 본 순간의 답. 약점 책 판정은 이것만 본다.

export const STATE_VERSION = 1;
export const WEAK_BOOK = 'weak';
export const WEAK_ENTER = 2; // 본편 회독에서 첫 등장에 '공부하겠음'을 누른 회독 수가 이만큼 쌓이면 약점 책으로
export const WEAK_LEAVE = 2; // 약점 책 회독에서 첫 등장에 '알고있음'이 이만큼 연속이면 졸업

export function buildIndex(data) {
  const byId = new Map();
  const byBook = new Map(data.books.map((b) => [b.id, []]));
  for (const w of data.words) {
    byId.set(w.id, w);
    byBook.get(w.book)?.push(w.id);
  }
  return { books: data.books, byId, byBook, order: data.words.map((w) => w.id) };
}

export function newState() {
  return {
    version: STATE_VERSION,
    settings: { random: true, glasses: false, autoSpeak: false, examDate: '2026-12-06' },
    books: {}, // bookId → 회독 진행
    words: {}, // wordId → { miss, weak, streak }
    daily: {}, // 'YYYY-MM-DD' → { k, s }
  };
}

export function restoreState(raw) {
  const s = newState();
  if (!raw || typeof raw !== 'object' || raw.version !== STATE_VERSION) return s;
  return {
    ...s,
    ...raw,
    settings: { ...s.settings, ...raw.settings },
    books: raw.books ?? {},
    words: raw.words ?? {},
    daily: raw.daily ?? {},
  };
}

export function today(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

export function bookWordIds(state, idx, bookId) {
  if (bookId === WEAK_BOOK) return idx.order.filter((id) => state.words[id]?.weak);
  return idx.byBook.get(bookId) ?? [];
}

export function shuffle(list, rng = Math.random) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function arrange(ids, state, rng) {
  return state.settings.random ? shuffle(ids, rng) : ids.slice();
}

function freshRound(ids, state, rng, round, done) {
  return {
    round, // 지금 몇 회독째인지
    done, // 끝낸 회독 수
    pass: 1,
    pending: arrange(ids, state, rng), // 이번 pass에 남은 단어 (맨 앞이 지금 카드)
    retry: [], // 이번 pass에서 '공부하겠음' → 다음 pass로
    seen: {}, // 이번 회독에서 첫 등장 답: 'k' | 's'
    firstKnown: 0,
    firstStudy: 0,
    weakIn: 0, // 이번 회독 중 약점 책에 들어간 단어 수
  };
}

function nextPass(p, state, rng) {
  p.pass += 1;
  p.pending = arrange(p.retry, state, rng);
  p.retry = [];
}

// 진행 상태에 아직 자리가 없는 단어 (단어장이 바뀌었거나 약점 책에 새로 들어온 단어)
function unplaced(p, ids) {
  const placed = new Set([...p.pending, ...p.retry, ...Object.keys(p.seen)]);
  return ids.filter((id) => !placed.has(id));
}

/** 책을 열 때 진행 상태를 만들거나, 단어 목록이 바뀐 만큼 맞춘다. */
export function openBook(state, idx, bookId, rng = Math.random) {
  const ids = bookWordIds(state, idx, bookId);
  let p = state.books[bookId];
  if (!p) {
    p = state.books[bookId] = freshRound(ids, state, rng, 1, 0);
    return p;
  }
  const valid = new Set(ids);
  p.pending = p.pending.filter((id) => valid.has(id));
  p.retry = p.retry.filter((id) => valid.has(id));
  const added = unplaced(p, ids);
  if (added.length) p.pending.push(...arrange(added, state, rng));
  if (!p.pending.length && p.retry.length) nextPass(p, state, rng);
  return p;
}

export function currentWord(p) {
  return p?.pending[0] ?? null;
}

/** '알고있음'(known=true) / '공부하겠음'(known=false). 무슨 일이 있었는지 돌려준다. */
export function answer(state, idx, bookId, known, { rng = Math.random, now = new Date() } = {}) {
  const p = state.books[bookId];
  const id = p?.pending.shift();
  if (!id) return null;
  const events = [];
  const first = !(id in p.seen);
  if (first) {
    p.seen[id] = known ? 'k' : 's';
    if (known) p.firstKnown += 1;
    else p.firstStudy += 1;
    const w = (state.words[id] ??= { miss: 0, weak: false, streak: 0 });
    if (bookId === WEAK_BOOK) {
      w.streak = known ? w.streak + 1 : 0;
      if (w.streak >= WEAK_LEAVE) {
        Object.assign(w, { weak: false, streak: 0, miss: 0 });
        events.push({ type: 'weak-out', id });
      }
    } else if (!known) {
      w.miss += 1;
      if (!w.weak && w.miss >= WEAK_ENTER) {
        Object.assign(w, { weak: true, streak: 0 });
        p.weakIn += 1;
        events.push({ type: 'weak-in', id });
      }
    }
  }
  if (!known) p.retry.push(id);
  const day = (state.daily[today(now)] ??= { k: 0, s: 0 });
  if (known) day.k += 1;
  else day.s += 1;

  let complete = null;
  if (!p.pending.length) {
    if (p.retry.length) {
      nextPass(p, state, rng);
    } else {
      complete = { round: p.round, firstKnown: p.firstKnown, firstStudy: p.firstStudy, weakIn: p.weakIn };
      state.books[bookId] = freshRound(bookWordIds(state, idx, bookId), state, rng, p.round + 1, p.done + 1);
    }
  }
  return { id, first, known, events, complete };
}

/** 답하기 직전 상태를 문자열로 떠 둔다 — 되돌리기용. */
export function snapshot(state, bookId, now = new Date()) {
  const id = state.books[bookId]?.pending[0] ?? null;
  const key = today(now);
  return JSON.stringify({
    bookId,
    id,
    book: state.books[bookId] ?? null,
    word: (id && state.words[id]) ?? null,
    dayKey: key,
    day: state.daily[key] ?? null,
  });
}

export function restore(state, snap) {
  const s = JSON.parse(snap);
  if (s.book) state.books[s.bookId] = s.book;
  else delete state.books[s.bookId];
  if (s.id) {
    if (s.word) state.words[s.id] = s.word;
    else delete state.words[s.id];
  }
  if (s.day) state.daily[s.dayKey] = s.day;
  else delete state.daily[s.dayKey];
  return s;
}

export function resetBook(state, bookId) {
  delete state.books[bookId];
}

/** 목록 화면용 요약 — 상태를 바꾸지 않는다. */
export function bookSummary(state, idx, bookId) {
  const ids = bookWordIds(state, idx, bookId);
  const p = state.books[bookId];
  if (!p) return { total: ids.length, remaining: ids.length, round: 1, done: 0, started: false };
  const valid = new Set(ids);
  const queued = [...p.pending, ...p.retry].filter((id) => valid.has(id)).length;
  const remaining = queued + unplaced(p, ids).length;
  return { total: ids.length, remaining, round: p.round, done: p.done, started: remaining < ids.length || p.done > 0 };
}
