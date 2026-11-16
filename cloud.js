// 無料のSupabaseにデータを保存する仕組み。
// サーバーは今までどおり DATA_DIR のファイルを読み書きし、書き込むたびに同じ内容をSupabaseにも保存する。
// 起動時にSupabaseから全データを DATA_DIR に戻すので、Render無料プランの再起動でデータが消えても復元される。
'use strict';
const fs = require('fs');
const path = require('path');

const BASE = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const KEY = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const TABLE = 'app_files';
const enabled = !!(BASE && KEY);
const SAFE = /^(usage\.json|(studies|sessions|files)\/[A-Za-z0-9_\-./]+)$/;

function headers(extra = {}) {
  // 新形式の secret key (sb_secret_...) は apikey ヘッダーだけで使う。旧形式(JWT)は Authorization にも入れる
  return { apikey: KEY, ...(KEY.startsWith('sb_') ? {} : { Authorization: `Bearer ${KEY}` }), 'Content-Type': 'application/json', ...extra };
}
async function request(method, query, body, extra) {
  let lastErr;
  for (let i = 0; i < 4; i++) {
    try {
      const r = await fetch(`${BASE}/rest/v1/${TABLE}${query}`, { method, headers: headers(extra), body: body ? JSON.stringify(body) : undefined });
      if (r.ok) return r;
      const t = await r.text();
      lastErr = new Error(`Supabase ${r.status}: ${t.slice(0, 300)}`);
      if (r.status < 500 && r.status !== 429) break;
    } catch (e) { lastErr = e; }
    await new Promise((ok) => setTimeout(ok, 1000 * (i + 1)));
  }
  throw lastErr;
}

// 同じファイルへの書き込みは順番どおりに送る
const chains = new Map();
function enqueue(rel, job) {
  const prev = chains.get(rel) || Promise.resolve();
  const next = prev.then(job).catch((e) => console.error(`[保存エラー] ${rel}: ${e.message}`));
  chains.set(rel, next);
  next.then(() => { if (chains.get(rel) === next) chains.delete(rel); });
  return next;
}

function put(rel, buf, isBinary) {
  if (!enabled || !SAFE.test(rel)) return;
  const content = isBinary ? buf.toString('base64') : buf.toString('utf8');
  enqueue(rel, () => request('POST', '?on_conflict=path', [{ path: rel, content, is_base64: !!isBinary, updated_at: new Date().toISOString() }], { Prefer: 'resolution=merge-duplicates,return=minimal' }));
}
function remove(rel) {
  if (!enabled || !SAFE.test(rel)) return;
  enqueue(rel, () => request('DELETE', `?path=eq.${encodeURIComponent(rel)}`));
}
async function flush() { await Promise.all([...chains.values()]); }

async function restore(dataDir) {
  if (!enabled) return 0;
  let n = 0;
  for (let from = 0; ; from += 20) {
    const r = await request('GET', '?select=path,content,is_base64&order=path', null, { Range: `${from}-${from + 19}`, 'Range-Unit': 'items' });
    const rows = await r.json();
    for (const row of rows) {
      if (!SAFE.test(row.path) || row.path.includes('..')) continue;
      const file = path.join(dataDir, row.path);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, row.is_base64 ? Buffer.from(row.content, 'base64') : row.content);
      n++;
    }
    if (rows.length < 20) break;
  }
  return n;
}

module.exports = { enabled, put, remove, flush, restore };
