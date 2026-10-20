// 회독 로직 — DOM에 의존하지 않는다 (tests/core.test.js에서 node로 검증)
//
// 세트: N3·N2를 섞은 고정 순서에서 새 단어를 꺼내고, 직전 세트에서 첫눈에 모른 단어(넘어온 단어)는
//       개수 제한 없이 전부, 옛 헷갈림 단어는 10장을 붙인다. 합이 100이 안 되면 새 단어를 더 꺼낸다.
//       세트 안에서는 '공부하겠음' 단어가 다 알 때까지 반복된다.
// 첫눈: 세트·약점 책 회독·전체 리뷰에서 그 단어를 처음 본 순간의 답. 약점·넘어옴 판정은 이것만 본다.

export const STATE_VERSION = 2;
export const SET_TARGET = 100; // 세트 목표 장수
export const SET_MIN_NEW = 50; // 새 단어 최소
export const SET_CONFUSE = 10; // 헷갈림 단어 고정 장수
export const WEAK_ENTER = 2; // 첫눈에 모른 횟수가 이만큼 쌓이면 약점 책으로
export const WEAK_LEAVE = 2; // 약점 단어를 첫눈에 연속 이만큼 맞히면 졸업
export const SETS_PER_DAY = 2; // 예상 완주일 계산용
export const ASSUMED_MISS = 30; // 세트 기록이 없을 때 예상 완주일에 쓰는 '세트당 넘어가는 단어 수'
export const REVIEW_SCOPES = [
  ['all', '전체'],
  ['seen', '지금까지 본 단어'],
  ['gichul', '기출'],
  ['N5', 'N5'],
  ['N4', 'N4'],
  ['N3', 'N3'],
  ['N2', 'N2'],
  ['weak', '약점'],
];

/**
 * data: words.json (tanos N5~N2, 공개).
 * gichul: 기출 파일 (개인용, 기기 안에만) — { tags: {id: [[급수, 유형]]}, words: [기출에만 있는 단어], pairs: {id: [id]} }
 */
export function buildIndex(data, gichul = null) {
  const level = new Map(data.books.map((b) => [b.id, b.level]));
  const byId = new Map();
  const levelOf = new Map();
  for (const w of data.words) {
    byId.set(w.id, w);
    levelOf.set(w.id, level.get(w.book));
  }
  const order = data.words.map((w) => w.id);
  for (const w of gichul?.words ?? []) {
    byId.set(w.id, w);
    levelOf.set(w.id, '기출');
    order.push(w.id);
  }
  const tags = new Map(Object.entries(gichul?.tags ?? {}).filter(([id]) => byId.has(id)));
  const pairs = new Map(Object.entries(gichul?.pairs ?? {}).filter(([id]) => byId.has(id)));
  return { byId, levelOf, order, tags, pairs, extra: gichul?.words?.length ?? 0 };
}

export function newState() {
  return {
    version: STATE_VERSION,
    settings: { glasses: false, autoSpeak: false, examDate: '2026-12-06' },
    deck: { order: [], next: 0 }, // 새 단어 순서(섞음)와 다음에 꺼낼 위치
    set: null, // 진행 중인 세트
    setsDone: 0,
    missLog: [], // 최근 세트들의 넘어간 단어 수 — 예상 완주일용
    carry: [], // 다음 세트로 넘어갈 단어
    prevSet: [], // 직전 세트 단어 — 헷갈림 단어에서 뺀다
    review: null, // 진행 중인 전체 리뷰
    weak: null, // 약점 책 회독
    words: {}, // id → { miss, weak, streak, last, reviewMiss }
    tick: 0, // 첫눈 답마다 1씩 — '오래 안 본' 순서용
    daily: {}, // 'YYYY-MM-DD' → { k, s, sets }
  };
}

export function restoreState(raw) {
  const s = newState();
  if (!raw || typeof raw !== 'object') return s;
  if (raw.version === 1) return migrateV1(raw);
  if (raw.version !== STATE_VERSION) return s;
  return { ...s, ...raw, settings: { ...s.settings, ...raw.settings } };
}

// v1(책 41권)에서 약점·모른 횟수·설정·날짜별 기록만 옮긴다. 책별 진도는 새 방식에 대응하는 것이 없다.
function migrateV1(raw) {
  const s = newState();
  const { glasses, autoSpeak, examDate } = raw.settings ?? {};
  Object.assign(s.settings, { glasses: !!glasses, autoSpeak: !!autoSpeak, examDate: examDate || s.settings.examDate });
  for (const [id, w] of Object.entries(raw.words ?? {})) {
    s.words[id] = { miss: w.miss ?? 0, weak: !!w.weak, streak: w.streak ?? 0, last: 1, reviewMiss: false };
  }
  s.tick = 1;
  for (const [day, v] of Object.entries(raw.daily ?? {})) s.daily[day] = { k: v.k ?? 0, s: v.s ?? 0, sets: 0 };
  return s;
}

export function today(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

export function shuffle(list, rng = Math.random) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * 새 단어 순서를 만들거나, 단어장이 바뀐 만큼 맞춘다.
 * 없어진 단어는 빼고, 새로 생긴 단어는 아직 안 꺼낸 단어들과 함께 다시 섞는다 (N4·N5 추가가 뒤로 몰리지 않게).
 * 그다음 기출 단어를 안 꺼낸 구간의 맨 앞으로 모은다 — 순서는 그대로 두는 안정 분할이라 몇 번 불러도 같다.
 */
export function ensureDeck(state, idx, rng = Math.random) {
  const d = state.deck;
  if (!d.order.length) {
    d.order = shuffle(idx.order, rng);
    d.next = 0;
  } else {
    const used = d.order.slice(0, d.next).filter((id) => idx.byId.has(id));
    let rest = d.order.slice(d.next).filter((id) => idx.byId.has(id));
    const known = new Set(d.order);
    const added = idx.order.filter((id) => !known.has(id));
    if (added.length) rest = shuffle([...rest, ...added], rng);
    d.order = [...used, ...rest];
    d.next = used.length;
  }
  if (idx.tags?.size) {
    const rest = d.order.slice(d.next);
    const first = rest.filter((id) => idx.tags.has(id));
    d.order = [...d.order.slice(0, d.next), ...first, ...rest.filter((id) => !idx.tags.has(id))];
  }
}

/** 단어장에서 사라진 단어(기출 파일을 지운 경우 등)를 진행 중인 세트·넘어온 단어에서 뺀다. */
export function pruneState(state, idx, rng = Math.random) {
  const ok = (id) => idx.byId.has(id);
  state.carry = state.carry.filter(ok);
  const s = state.set;
  if (!s) return;
  for (const k of ['pending', 'retry', 'ids', 'missed']) s[k] = s[k].filter(ok);
  const n = (tag) => s.ids.filter((id) => s.tags[id] === tag).length;
  s.comp = { carry: n('carry'), fresh: n('new'), confuse: n('confuse') };
  if (!s.pending.length && advance(s, rng)) state.set = null;
}

// ── 첫눈 기록 ──────────────────────────────────────────

function wordStat(state, id) {
  return (state.words[id] ??= { miss: 0, weak: false, streak: 0, last: 0, reviewMiss: false });
}

function record(state, id, known, ctx) {
  const w = wordStat(state, id);
  state.tick += 1;
  w.last = state.tick;
  w.reviewMiss = ctx === 'review' && !known; // 리뷰에서 모르면 헷갈림 1순위, 다른 데서 다시 보면 푼다
  const events = [];
  if (known) {
    w.streak += 1;
    if (w.weak && w.streak >= WEAK_LEAVE) {
      Object.assign(w, { weak: false, streak: 0 });
      events.push({ type: 'weak-out', id });
    }
  } else {
    w.miss += 1;
    w.streak = 0;
    if (!w.weak && w.miss >= WEAK_ENTER) {
      w.weak = true;
      events.push({ type: 'weak-in', id });
    }
  }
  return events;
}

function countDay(state, known, now) {
  const day = (state.daily[today(now)] ??= { k: 0, s: 0, sets: 0 });
  if (known) day.k += 1;
  else day.s += 1;
  return day;
}

// ── 다 알 때까지 반복하는 묶음 (세트·약점 책 공용) ─────────────

function newLoop(ids, rng) {
  return { pending: shuffle(ids, rng), retry: [], seen: {}, pass: 1, firstKnown: 0, firstStudy: 0 };
}

function take(loop, known) {
  const id = loop.pending.shift();
  if (!id) return null;
  const first = !(id in loop.seen);
  if (first) {
    loop.seen[id] = known ? 'k' : 's';
    if (known) loop.firstKnown += 1;
    else loop.firstStudy += 1;
  }
  if (!known) loop.retry.push(id);
  return { id, first };
}

/** pass가 끝났으면 다음 pass로 넘긴다. 남은 단어가 없으면 true(묶음 끝). */
function advance(loop, rng) {
  if (loop.pending.length) return false;
  if (!loop.retry.length) return true;
  loop.pass += 1;
  loop.pending = shuffle(loop.retry, rng);
  loop.retry = [];
  return false;
}

// ── 세트 ────────────────────────────────────────────────

function confuseScore(state, w) {
  return (w.reviewMiss ? 1000 : 0) + (w.weak ? 100 : 0) + 10 * w.miss - 20 * w.streak + (state.tick - w.last) / 50;
}

/** 헷갈림 단어: 리뷰에서 모름 → 약점 → 모른 횟수 → 오래 안 본 순. 본 적 있는 단어만, 직전 세트는 뺀다. */
export function pickConfusing(state, idx, n, exclude = new Set()) {
  const prev = new Set(state.prevSet);
  const cands = Object.entries(state.words).filter(
    ([id, w]) => w.last && idx.byId.has(id) && !exclude.has(id) && !prev.has(id),
  );
  cands.sort((a, b) => confuseScore(state, b[1]) - confuseScore(state, a[1]) || a[0].localeCompare(b[0]));
  return cands.slice(0, n).map(([id]) => id);
}

/** 다음 세트 구성 미리보기 — 상태를 바꾸지 않는다. */
export function planNextSet(state, idx) {
  const carry = [...new Set(state.carry)].filter((id) => idx.byId.has(id));
  const left = state.deck.order.length - state.deck.next;
  const nConfuse = left > 0 ? SET_CONFUSE : Math.max(SET_CONFUSE, SET_TARGET - carry.length);
  // 전체 리뷰에서 먼저 본 단어가 곧 새 단어로 나올 수 있으니 그 구간도 뺀다 (한 세트에 두 번 들어가지 않게)
  const upcoming = state.deck.order.slice(state.deck.next, state.deck.next + SET_TARGET);
  const confuse = pickConfusing(state, idx, nConfuse, new Set([...carry, ...upcoming]));
  const nFresh = Math.min(left, Math.max(SET_MIN_NEW, SET_TARGET - carry.length - confuse.length));
  const fresh = state.deck.order.slice(state.deck.next, state.deck.next + nFresh);
  return { carry, fresh, confuse };
}

export function startSet(state, idx, rng = Math.random) {
  const plan = planNextSet(state, idx);
  const tags = {};
  for (const id of plan.fresh) tags[id] = 'new';
  for (const id of plan.confuse) tags[id] = 'confuse';
  for (const id of plan.carry) tags[id] = 'carry';
  const ids = Object.keys(tags);
  state.deck.next += plan.fresh.length;
  state.carry = [];
  state.set = {
    no: state.setsDone + 1,
    ids,
    tags,
    comp: { carry: plan.carry.length, fresh: plan.fresh.length, confuse: plan.confuse.length },
    missed: [], // 첫눈에 모른 단어 → 다음 세트로
    ...newLoop(ids, rng),
  };
  return state.set;
}

export function answerSet(state, idx, known, { rng = Math.random, now = new Date() } = {}) {
  const s = state.set;
  const got = s && take(s, known);
  if (!got) return null;
  let events = [];
  if (got.first) {
    events = record(state, got.id, known, 'set');
    if (!known) s.missed.push(got.id);
  }
  const day = countDay(state, known, now);
  let complete = null;
  if (advance(s, rng)) {
    complete = { no: s.no, firstKnown: s.firstKnown, firstStudy: s.firstStudy, missed: s.missed.slice(), comp: s.comp };
    state.carry = [...state.carry, ...s.missed];
    state.prevSet = s.ids;
    state.missLog = [...state.missLog, s.missed.length].slice(-5);
    state.setsDone += 1;
    state.set = null;
    day.sets += 1;
  }
  return { id: got.id, first: got.first, events, complete };
}

// ── 약점 책 ─────────────────────────────────────────────

export function weakIds(state, idx) {
  return idx.order.filter((id) => state.words[id]?.weak);
}

/** 약점 책을 열 때 진행 상태를 만들거나, 들어오고 나간 단어만큼 맞춘다. */
export function openWeak(state, idx, rng = Math.random) {
  const ids = weakIds(state, idx);
  let p = state.weak;
  if (!p) {
    p = state.weak = { round: 1, done: 0, ...newLoop(ids, rng) };
    return p;
  }
  const valid = new Set(ids);
  p.pending = p.pending.filter((id) => valid.has(id));
  p.retry = p.retry.filter((id) => valid.has(id));
  const placed = new Set([...p.pending, ...p.retry, ...Object.keys(p.seen)]);
  const added = ids.filter((id) => !placed.has(id));
  if (added.length) p.pending.push(...shuffle(added, rng));
  advance(p, rng);
  return p;
}

export function answerWeak(state, idx, known, { rng = Math.random, now = new Date() } = {}) {
  const p = state.weak;
  const got = p && take(p, known);
  if (!got) return null;
  const events = got.first ? record(state, got.id, known, 'weak') : [];
  countDay(state, known, now);
  let complete = null;
  if (advance(p, rng)) {
    complete = { round: p.round, firstKnown: p.firstKnown, firstStudy: p.firstStudy };
    state.weak = { round: p.round + 1, done: p.done + 1, ...newLoop(weakIds(state, idx), rng) };
  }
  return { id: got.id, first: got.first, events, complete };
}

// ── 전체 리뷰 (한 바퀴) ──────────────────────────────────

export function reviewIds(state, idx, scope) {
  if (scope === 'all') return idx.order;
  if (scope === 'seen') return idx.order.filter((id) => state.words[id]?.last);
  if (scope === 'weak') return weakIds(state, idx);
  if (scope === 'gichul') return idx.order.filter((id) => idx.tags.has(id));
  return idx.order.filter((id) => idx.levelOf.get(id) === scope);
}

export function startReview(state, idx, scope, rng = Math.random) {
  state.review = { scope, order: shuffle(reviewIds(state, idx, scope), rng), pos: 0, known: 0, study: 0 };
  return state.review;
}

/** 지금 볼 리뷰 단어. 단어장에서 사라진 단어는 건너뛴다. */
export function reviewCurrent(state, idx) {
  const r = state.review;
  if (!r) return null;
  while (r.pos < r.order.length && !idx.byId.has(r.order[r.pos])) r.pos += 1;
  return r.order[r.pos] ?? null;
}

export function answerReview(state, idx, known, { now = new Date() } = {}) {
  const r = state.review;
  const id = reviewCurrent(state, idx);
  if (!id) return null;
  r.pos += 1;
  if (known) r.known += 1;
  else r.study += 1;
  const events = record(state, id, known, 'review');
  countDay(state, known, now);
  let complete = null;
  if (!reviewCurrent(state, idx)) {
    complete = { scope: r.scope, known: r.known, study: r.study };
    state.review = null;
  }
  return { id, first: true, events, complete };
}

// ── 요약 ────────────────────────────────────────────────

export function stats(state, idx) {
  let seen = 0;
  let weak = 0;
  for (const [id, w] of Object.entries(state.words)) {
    if (!idx.byId.has(id)) continue;
    if (w.last) seen += 1;
    if (w.weak) weak += 1;
  }
  return { total: idx.byId.size, seen, weak, newLeft: state.deck.order.length - state.deck.next };
}

/**
 * 하루 SETS_PER_DAY세트씩 하면 새 단어를 언제 다 꺼내는지. 이미 다 꺼냈으면 null.
 * 세트당 새 단어 = 100 − 헷갈림 10 − 넘어오는 단어(최근 세트 평균, 기록이 없으면 ASSUMED_MISS로 가정).
 */
export function finishDate(state, idx, now = new Date()) {
  const left = state.deck.order.length - state.deck.next;
  if (left <= 0) return null;
  const log = state.missLog ?? [];
  const miss = log.length ? log.reduce((a, b) => a + b, 0) / log.length : ASSUMED_MISS;
  const perSet = Math.max(SET_MIN_NEW, Math.round(SET_TARGET - SET_CONFUSE - miss));
  const sets = Math.ceil(left / perSet);
  const doneToday = state.daily[today(now)]?.sets ?? 0;
  const todaySlots = Math.max(0, SETS_PER_DAY - doneToday - (state.set ? 1 : 0));
  const days = sets <= todaySlots ? 0 : Math.ceil((sets - todaySlots) / SETS_PER_DAY);
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + days);
  return { date: d, sets, perSet, assumed: !log.length };
}
