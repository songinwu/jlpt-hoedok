// 기기 간 진도 동기화 — 비공개 GitHub Gist 하나에 진도 JSON을 올리고 받는다.
// 토큰·gist 번호는 이 기기 localStorage에만 두고 백업 파일에도 넣지 않는다.
// 기출·집중 단어장 파일(책 내용)은 진도와 다른 비공개 gist에 둔다 — 크고(약 230KB) 자주 안 바뀌어서,
// 진도처럼 매번 받지 않고 gist 버전이 바뀌었을 때만 받는다. 새 기기는 토큰만 넣으면 단어장까지 받는다.

const SYNC_KEY = 'jlpt-hoedok-sync'; // { token, gistId, base, at }
const FILE = 'jlpt-hoedok-progress.json';
const API = 'https://api.github.com';

export function loadSyncCfg() {
  try {
    const c = JSON.parse(localStorage.getItem(SYNC_KEY) || 'null');
    return c?.token && c?.gistId ? c : null;
  } catch {
    return null;
  }
}

export function saveSyncCfg(cfg) {
  try {
    if (cfg) localStorage.setItem(SYNC_KEY, JSON.stringify(cfg));
    else localStorage.removeItem(SYNC_KEY);
  } catch { /* 저장 못 해도 이번 실행 동안은 쓴다 */ }
}

async function gh(token, path, opts = {}) {
  const res = await fetch(API + path, {
    ...opts,
    cache: 'no-store',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
    },
  });
  if (!res.ok) {
    const e = new Error(`GitHub ${res.status}`);
    e.status = res.status;
    throw e;
  }
  return res.status === 204 ? null : res.json();
}

const payload = (state) => JSON.stringify({ app: 'jlpt-hoedok', syncedAt: new Date().toISOString(), state });

/** 토큰 주인의 gist 중 진도 파일이 있는 것을 찾는다. 없으면 null. */
export async function findGist(token) {
  for (let page = 1; page <= 5; page++) {
    const list = await gh(token, `/gists?per_page=100&page=${page}`);
    const hit = list.find((g) => g.files?.[FILE]);
    if (hit) return hit.id;
    if (list.length < 100) break;
  }
  return null;
}

export async function createGist(token, state) {
  const g = await gh(token, '/gists', {
    method: 'POST',
    body: JSON.stringify({ description: 'JLPT 회독 진도 동기화 (앱이 자동으로 만듦)', public: false, files: { [FILE]: { content: payload(state) } } }),
  });
  return g.id;
}

/** 원격 진도. 파일이 없거나 형식이 다르면 null. */
export async function pullRemote(token, gistId) {
  const g = await gh(token, `/gists/${gistId}`);
  const f = g.files?.[FILE];
  if (!f) return null;
  // 1MB가 넘으면 content가 잘려 오므로 원본 주소에서 다시 받는다
  const text = f.truncated ? await (await fetch(f.raw_url, { cache: 'no-store' })).text() : f.content;
  const obj = JSON.parse(text);
  return obj?.app === 'jlpt-hoedok' && obj.state ? obj.state : null;
}

export async function pushRemote(token, gistId, state) {
  await gh(token, `/gists/${gistId}`, { method: 'PATCH', body: JSON.stringify({ files: { [FILE]: { content: payload(state) } } }) });
}

// ── 기출·집중 단어장 파일 ─────────────────────────────────

const GFILE = 'jlpt-hoedok-gichul.json';

export async function findGichulGist(token) {
  for (let page = 1; page <= 5; page++) {
    const list = await gh(token, `/gists?per_page=100&page=${page}`);
    const hit = list.find((g) => g.files?.[GFILE]);
    if (hit) return hit.id;
    if (list.length < 100) break;
  }
  return null;
}

export async function createGichulGist(token, text) {
  const g = await gh(token, '/gists', {
    method: 'POST',
    body: JSON.stringify({ description: 'JLPT 회독 기출·집중 단어장 (개인용, 앱이 자동으로 만듦)', public: false, files: { [GFILE]: { content: text } } }),
  });
  return { id: g.id, version: g.history?.[0]?.version ?? null };
}

/** 가장 최근 버전 번호만 (파일 내용 없이 가볍게) */
export async function gichulVersion(token, id) {
  const list = await gh(token, `/gists/${id}/commits?per_page=1`);
  return list?.[0]?.version ?? null;
}

export async function pullGichul(token, id) {
  const g = await gh(token, `/gists/${id}`);
  const f = g.files?.[GFILE];
  if (!f) return null;
  const text = f.truncated ? await (await fetch(f.raw_url, { cache: 'no-store' })).text() : f.content;
  return { text, version: g.history?.[0]?.version ?? null };
}

export async function pushGichul(token, id, text) {
  const g = await gh(token, `/gists/${id}`, { method: 'PATCH', body: JSON.stringify({ files: { [GFILE]: { content: text } } }) });
  return g.history?.[0]?.version ?? null;
}
