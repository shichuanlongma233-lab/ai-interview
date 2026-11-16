// AI多言語インタビューツール — サーバー (Node.js 18以上, 外部ライブラリ不要)
// 起動: .env に GEMINI_API_KEY と ADMIN_PASSWORD を書いて `node server.js`
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

loadDotEnv(path.join(__dirname, '.env'));
const cloud = require('./cloud');

const PORT = Number(process.env.PORT || 3000);
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';
const MOCK_AI = process.env.MOCK_AI === '1' || !GEMINI_API_KEY;
const DAILY_AI_CALL_LIMIT = Number(process.env.DAILY_AI_CALL_LIMIT || 3000); // 1日のGemini呼び出し上限(全体)
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_BODY = 40 * 1024 * 1024;

for (const d of ['studies', 'files', 'sessions']) fs.mkdirSync(path.join(DATA_DIR, d), { recursive: true });

// ---------- 小さなユーティリティ ----------
function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
const newId = (n = 8) => crypto.randomBytes(n).toString('base64url');
const now = () => new Date().toISOString();
const safeId = (s) => /^[A-Za-z0-9_-]{4,40}$/.test(s || '');
const httpError = (status, msg) => Object.assign(new Error(msg), { status });

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + process.pid + '.' + newId(3) + '.tmp';
  const text = JSON.stringify(obj, null, 2);
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
  cloud.put(relPath(file), Buffer.from(text), false);
}
const relPath = (file) => path.relative(DATA_DIR, file).split(path.sep).join('/');
function removeFile(file) { fs.rmSync(file, { force: true }); cloud.remove(relPath(file)); }
const studyPath = (id) => path.join(DATA_DIR, 'studies', id + '.json');
const sessionPath = (studyId, sid) => path.join(DATA_DIR, 'sessions', studyId, sid + '.json');
const getStudy = (id) => (safeId(id) ? readJson(studyPath(id)) : null);
const saveStudy = (s) => writeJson(studyPath(s.id), s);
function listStudies() {
  return fs.readdirSync(path.join(DATA_DIR, 'studies')).filter((f) => f.endsWith('.json'))
    .map((f) => readJson(path.join(DATA_DIR, 'studies', f))).filter(Boolean)
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
}
function listSessions(studyId) {
  const dir = path.join(DATA_DIR, 'sessions', studyId);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => readJson(path.join(dir, f))).filter(Boolean)
    .sort((a, b) => (b.startedAt || '').localeCompare(a.startedAt || ''));
}
function findSession(sid) {
  if (!safeId(sid)) return null;
  const root = path.join(DATA_DIR, 'sessions');
  for (const studyId of fs.readdirSync(root)) {
    const p = path.join(root, studyId, sid + '.json');
    if (fs.existsSync(p)) return readJson(p);
  }
  return null;
}
const saveSession = (s) => writeJson(sessionPath(s.studyId, s.id), s);

function send(res, status, body, headers = {}) {
  const raw = Buffer.isBuffer(body) || typeof body === 'string';
  res.writeHead(status, {
    'Content-Type': raw ? headers['Content-Type'] || 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(raw ? body : JSON.stringify(body));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > MAX_BODY) { reject(httpError(413, 'ファイルが大きすぎます (合計30MBまで)')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(httpError(400, 'JSONが不正です')); } });
    req.on('error', reject);
  });
}

// ---------- 管理者認証 (メモリ上のトークン) ----------
const adminTokens = new Map(); // token -> expires
function isAdmin(req) {
  const t = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const exp = adminTokens.get(t);
  return !!exp && exp > Date.now();
}
function passwordOk(p) {
  const a = Buffer.from(String(p || '')); const b = Buffer.from(ADMIN_PASSWORD);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---------- AI利用回数の上限(費用対策) ----------
const usageFile = path.join(DATA_DIR, 'usage.json');
function countAiCall() {
  const today = new Date().toISOString().slice(0, 10);
  const u = readJson(usageFile, {});
  if (u.date !== today) { u.date = today; u.calls = 0; }
  if (u.calls >= DAILY_AI_CALL_LIMIT) throw httpError(429, '本日のAI利用回数の上限に達しました。明日もう一度お試しください。 / Daily limit reached. Please try again tomorrow.');
  u.calls++; writeJson(usageFile, u);
}
const usageToday = () => { const u = readJson(usageFile, {}); return u.date === new Date().toISOString().slice(0, 10) ? u.calls : 0; };

// ---------- Gemini ----------
const TEXT_TYPES = /^(text\/|application\/(json|csv|xml|x-markdown))/;
const INLINE_TYPES = /^(application\/pdf|image\/(png|jpeg|webp|heic|heif)|audio\/|video\/)/;

function materialParts(study) {
  const parts = [];
  for (const m of study.materials || []) {
    const file = path.join(DATA_DIR, 'files', m.fileId);
    if (!fs.existsSync(file)) continue;
    const head = `【資料 id=${m.id}】${m.name}` + (m.note ? `（説明: ${m.note}）` : '') + (m.showToRespondent ? ' ※回答者に提示可能' : '');
    if (TEXT_TYPES.test(m.mimeType) || /\.(txt|md|csv|json)$/i.test(m.name)) {
      parts.push({ text: `${head}\n${fs.readFileSync(file, 'utf8').slice(0, 200000)}` });
    } else if (INLINE_TYPES.test(m.mimeType)) {
      parts.push({ text: head });
      parts.push({ inlineData: { mimeType: m.mimeType, data: fs.readFileSync(file).toString('base64') } });
    }
  }
  return parts;
}

const FALLBACK_MODELS = (process.env.GEMINI_FALLBACK_MODELS || 'gemini-3.5-flash').split(',').map((m) => m.trim()).filter(Boolean);
async function callGemini({ system, parts, schema, temperature = 0.7 }) {
  countAiCall();
  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts }],
    generationConfig: { temperature, ...(schema ? { responseMimeType: 'application/json', responseSchema: schema } : {}) },
  });
  // 設定したモデルが使えない・応答しない場合は、予備のモデルに切り替える
  const models = [...new Set([GEMINI_MODEL, ...FALLBACK_MODELS])];
  let lastErr;
  for (const model of models) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    for (let attempt = 0; attempt < 2; attempt++) {
      const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY }, body, signal: AbortSignal.timeout(45000) })
        .catch((e) => ({ ok: false, status: 0, json: async () => ({ error: { message: e.name === 'TimeoutError' ? '45秒以内に応答がありませんでした' : e.message } }) }));
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        lastErr = new Error(`Gemini API エラー ${r.status} (${model}): ${j.error?.message || ''}`);
        console.error(lastErr.message);
        if (r.status === 429 || r.status >= 500) { await new Promise((ok) => setTimeout(ok, 1500 * (attempt + 1))); continue; }
        if (r.status === 0 || r.status === 404) break; // 応答なし・モデルなし → 次のモデルへ
        throw lastErr; // キーの誤りなど
      }
      const text = (j.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
      if (!text) { lastErr = new Error('Gemini から空の応答が返りました'); continue; }
      if (!schema) return text;
      try { return JSON.parse(text); } catch { lastErr = new Error('Gemini の応答を読み取れませんでした'); }
    }
  }
  throw lastErr;
}

const S = (description) => ({ type: 'STRING', ...(description ? { description } : {}) });
const TURN_SCHEMA = {
  type: 'OBJECT',
  properties: {
    answer_ja: S('直前の回答者の発言の日本語訳(最初のターンは空文字)'),
    message: S('回答者の言語で書いた、短い受け止め＋次の質問1つ (終了時はお礼の締めの言葉)'),
    message_ja: S('message の日本語訳'),
    quick_replies: { type: 'ARRAY', items: S(), description: '回答者の言語で、ボタンで選べる短い回答候補(0〜5個)。自由回答が望ましい質問では空配列' },
    question_id: S('この発言が扱っている質問リストのid。リスト外の深掘りや自由質問なら直近のid、なければ空文字'),
    show_material_id: S('回答者に提示する資料のid。提示しないなら空文字'),
    topic: S('この質問が扱うテーマ(日本語で短く)'),
    is_finished: { type: 'BOOLEAN' },
  },
  required: ['answer_ja', 'message', 'message_ja', 'quick_replies', 'question_id', 'show_material_id', 'topic', 'is_finished'],
};

const TECHNIQUES = `# インタビュー技法(必ず守る)
- ラポール形成: 最初は答えやすく評価を含まない安全な質問から始める(例: 日本や日本文化との接点)。
- ファネル構造: 「広い→狭い」「一般的な印象→具体的な体験・行動意向」の順に進める。
- 抽象と具体の往復: 抽象的な答えには具体的な場面や例を、細かすぎる答えには全体としてどう感じたかを聞く。
- 「なぜ?」を連発しない: 「どんなところから そう感じましたか」「きっかけは」など柔らかく背景を聞く。
- 感情の受け止め: 回答者の感情を具体的な言葉で受け止めてから次に進む(例: 「静けさに惹かれたのですね」)。
- 仮定の質問: 「もし京都でこの体験ができるとしたら」などで想像してもらう。
- 逆側の視点: 好意的な人には気になる点・ためらう点を、否定的な人には少しでも惹かれる点を聞く。
- 矛盾の穏やかな確認: 前後で食い違う発言は、責めずに「先ほどは〜とおっしゃいましたが」と確認する。
- 中間要約: 3〜4問ごとに、ここまでの話を一文で要約して認識が合っているか確認し、補足を促す。
- 段階的な選択肢: 好感度・関心度・支払意向などを聞くときは、quick_replies に中間を含む3〜5段階の選択肢を入れ、その後で理由を深掘りする。`;

function interviewerSystem(study, session) {
  const asked = session.messages.filter((m) => m.role === 'ai').length;
  const max = Number(study.maxQuestions) || 10;
  const qs = []; // 質問リストは使わず、AIが目的と資料から質問を考える
  const covered = new Set(session.messages.map((m) => m.questionId).filter(Boolean));
  const qList = qs.length ? qs.map((q, i) => `${i + 1}. [id=${q.id}]${covered.has(q.id) ? ' (済)' : ''} ${q.text}` + (q.followUp ? `\n   深掘りの指示: ${q.followUp}` : '') + (q.quickReplies?.length ? `\n   選択肢(回答者の言語に訳して quick_replies に入れる): ${q.quickReplies.join(' / ')}` : '')).join('\n') : '(質問リストなし。調査目的と資料から自分で質問を組み立てる)';
  return `あなたは、日本の伝統文化に対する海外の人々の反応を調べる定性市場調査の、プロのインタビュアーです。
回答者と1対1のチャットで半構造化インタビューを行います。

# 調査の情報
- 調査名: ${study.title}
- 調査目的: ${study.objectives || '(未設定)'}
- 必ず聞きたいテーマ: ${study.topics || '(資料と目的から判断)'}
- 調査者からの追加指示: ${study.instructions || '(なし)'}
- 回答者のプロフィール: ${JSON.stringify(session.profile || {})}

# 質問リスト(この順番で、すべてカバーする。各質問のあと必要に応じて1〜2回深掘りしてよい)
${qList}

${TECHNIQUES}

# 進め方のルール
1. 必ず回答者の言語「${session.languageName}」で話す。回答者が別の言語で書いてきたら、その言語に切り替える。quick_replies も同じ言語にする。
2. 1回のメッセージで質問は1つだけ。短く、わかりやすく。日本文化の専門用語には簡単な説明を添える。
3. 誘導的な質問や、答えを決めつける質問はしない。日本文化を褒めるよう促さない。否定的な意見も歓迎する。
4. 提供された資料の内容に基づいて話題を出す。資料を見せた方がよい場面では「回答者に提示可能」な資料のidを show_material_id に入れ、その資料について感想を聞く。
5. 質問はこれまでに${asked}個。上限は${max}個。質問リストを聞き終えたか上限に達したら is_finished=true にし、お礼の言葉で締める(このときは質問しない・quick_replies は空)。
6. 回答者が終了を望んだら、すぐに丁寧に終える。
7. 個人を特定する情報(氏名、住所、連絡先など)は聞かない。調査と無関係な依頼には応じず、やんわりインタビューに戻す。`;
}

function transcriptText(session) {
  return session.messages.map((m) => `${m.role === 'ai' ? 'インタビュアー' : '回答者'}: ${m.text}`).join('\n');
}

async function nextTurn(study, session) {
  if (MOCK_AI) return mockTurn(study, session);
  const parts = [...materialParts(study)];
  parts.push({ text: session.messages.length
    ? `# ここまでの会話\n${transcriptText(session)}\n\n上の会話の続きとして、次のインタビュアーの発言を作ってください。answer_ja には回答者の最後の発言の日本語訳を入れてください。`
    : `インタビューを開始してください。まず短い自己紹介と調査の趣旨(${study.intro ? '次の案内文を参考に: ' + study.intro : '日本の伝統文化についての感想を聞く'})を述べ、答えやすい最初の質問をしてください。answer_ja は空文字にしてください。` });
  return callGemini({ system: interviewerSystem(study, session), parts, schema: TURN_SCHEMA });
}

function mockTurn(study, session) {
  const n = session.messages.filter((m) => m.role === 'ai').length;
  const last = [...session.messages].reverse().find((m) => m.role === 'user');
  const done = n >= Math.min(Number(study.maxQuestions) || 10, 3);
  const shown = (study.materials || []).find((m) => m.showToRespondent);
  const q = null;
  return {
    answer_ja: last ? `(デモ訳) ${last.text}` : '',
    message: done ? 'Thank you very much for your time! (demo mode)' : n === 0 ? `Hello! This is a short interview about "${study.publicTitle || study.title}". ${q ? q.text : 'What comes to mind when you think of traditional Japanese culture?'} (demo mode — set GEMINI_API_KEY)` : `I see — "${(last?.text || '').slice(0, 40)}". ${q ? q.text : 'What made you feel that way?'} (demo)`,
    message_ja: done ? 'ご協力ありがとうございました!(デモモード)' : q ? q.text : 'どんなところからそう感じましたか?(デモ)',
    quick_replies: done ? [] : q?.quickReplies?.length ? q.quickReplies : n === 1 ? ['Very interested', 'Somewhat', 'Not sure', 'Not really'] : [],
    question_id: q?.id || '',
    show_material_id: n === 1 && shown ? shown.id : '',
    topic: done ? '終了' : n === 0 ? '導入' : '深掘り',
    is_finished: done,
  };
}

// ---- 回答ごとのレポート ----
const REPORT_SCHEMA = {
  type: 'OBJECT',
  properties: {
    summary: S('インタビュー全体の要約(日本語・3〜5文)'),
    sentiment: { type: 'STRING', format: 'enum', enum: ['positive', 'mixed', 'neutral', 'negative'], description: '調査対象の日本文化への全体的な反応' },
    interest_score: { type: 'INTEGER', description: '体験・購入・もっと知りたいなどの関心度 1(全くない)〜5(非常に高い)' },
    respondent_type: S('回答者のタイプを日本語で短く(例: 日本好きのリピーター候補、慎重な初心者)'),
    respondent_type_description: S('そのタイプだと判断した理由(日本語・1〜2文)'),
    opinions: { type: 'ARRAY', items: { type: 'OBJECT', properties: { title: S('意見の見出し(日本語)'), content: S('内容(日本語)'), polarity: { type: 'STRING', format: 'enum', enum: ['positive', 'negative', 'neutral'] } }, required: ['title', 'content', 'polarity'] } },
    quotes: { type: 'ARRAY', items: { type: 'OBJECT', properties: { original: S('回答者の原文そのまま'), ja: S('日本語訳') }, required: ['original', 'ja'] } },
  },
  required: ['summary', 'sentiment', 'interest_score', 'respondent_type', 'respondent_type_description', 'opinions', 'quotes'],
};
async function buildReport(study, session) {
  if (MOCK_AI) {
    return { summary: '(デモモード) GEMINI_API_KEY を設定すると、ここにAIによる要約が入ります。', sentiment: 'positive', interest_score: 4, respondent_type: 'デモ回答者', respondent_type_description: 'デモモードのため仮の値です。', opinions: [{ title: 'デモの意見', content: session.messages.find((m) => m.role === 'user')?.text || '', polarity: 'positive' }], quotes: [], at: now() };
  }
  const r = await callGemini({
    system: 'あなたは日本の伝統文化の海外マーケティングに詳しい定性調査アナリストです。インタビュー記録を読み、日本語で構造化レポートを作ります。推測ではなく発言に基づいて書いてください。',
    parts: [{ text: `調査名: ${study.title}\n調査目的: ${study.objectives}\n回答者プロフィール: ${JSON.stringify(session.profile)}\n回答言語: ${session.languageName}\n\n${transcriptText(session)}` }],
    schema: REPORT_SCHEMA, temperature: 0.2,
  });
  return { ...r, at: now() };
}
function finishSession(study, session) {
  session.status = 'completed'; session.finishedAt = now();
  saveSession(session);
  return buildReport(study, session).then((rep) => {
    const fresh = readJson(sessionPath(session.studyId, session.id)) || session;
    fresh.report = rep; saveSession(fresh); return rep;
  }).catch((e) => console.error('レポート作成エラー:', e.message));
}

// ---- 全体分析 ----
async function analyzeStudy(study) {
  const sessions = listSessions(study.id).filter((s) => !s.simulated && s.messages.some((m) => m.role === 'user'));
  if (!sessions.length) throw httpError(400, '分析できる回答がまだありません(模擬回答は対象外です)');
  if (MOCK_AI) return `(デモモード) ${sessions.length}件の回答があります。GEMINI_API_KEY を設定すると、ここに全体分析が入ります。`;
  const body = sessions.map((s, i) => `## 回答者${i + 1} (言語: ${s.languageName}, プロフィール: ${JSON.stringify(s.profile)}${s.rating ? `, 満足度: ${s.rating.score}/5` : ''})\n${transcriptText(s)}`).join('\n\n').slice(0, 900000);
  return callGemini({
    system: 'あなたは日本の伝統文化の海外マーケティングに詳しい定性調査アナリストです。複数のインタビューを横断して分析し、日本語でレポートを書きます。',
    parts: [{ text: `調査名: ${study.title}\n調査目的: ${study.objectives}\n回答数: ${sessions.length}\n\n${body}\n\n次の構成で日本語のレポートを書いてください。\n1. サマリー(3〜5行)\n2. 主な反応のパターン(テーマ別、何人が言及したか)\n3. 国・言語・属性による違い\n4. 魅力に感じられている点\n5. 障壁・誤解・懸念\n6. 印象的な発言(原文と日本語訳)\n7. マーケティングへの示唆と次の調査で確かめるべきこと` }],
    temperature: 0.3,
  });
}

// ---- 資料から設定を自動作成 ----
const CONFIG_SCHEMA = {
  type: 'OBJECT',
  properties: {
    objectives: S('調査目的(日本語・2〜3文)'),
    topics: S('必ず聞きたいテーマ(日本語・ / 区切り)'),
    publicTitle: S('回答者向けの表示タイトル(英語・短く)'),
    intro: S('回答者向けの案内文(英語・2〜3文。所要時間の目安と匿名である旨を含める)'),
    questions: { type: 'ARRAY', items: { type: 'OBJECT', properties: {
      text: S('質問文(日本語。AIが回答者の言語に訳して使う)'),
      followUp: S('深掘りの指示(日本語)'),
      quickReplies: { type: 'ARRAY', items: S(), description: '段階的な選択肢(日本語、0〜5個)。自由回答向けの質問なら空' },
    }, required: ['text', 'followUp', 'quickReplies'] } },
  },
  required: ['objectives', 'topics', 'publicTitle', 'intro', 'questions'],
};
async function generateConfig(study, hint) {
  if (MOCK_AI) {
    return { objectives: `(デモ) ${study.title} について、海外の人が感じる魅力と障壁を把握する。`, topics: '第一印象 / 魅力 / 不安な点 / 体験意向 / 価格感', publicTitle: 'Japanese Culture Interview', intro: 'This short interview (about 10 minutes) asks for your honest impressions of traditional Japanese culture. Your answers are anonymous.',
      questions: [{ text: '日本や日本文化と、これまでどんな接点がありましたか?', followUp: '具体的なきっかけを聞く', quickReplies: [] }, { text: 'この体験にどのくらい興味がありますか?', followUp: '理由を具体的に聞く', quickReplies: ['とても興味がある', 'やや興味がある', 'どちらとも言えない', 'あまり興味がない', '全く興味がない'] }, { text: '体験するとしたら、気になる点やためらう点はありますか?', followUp: '価格・時間・作法への不安などを深掘り', quickReplies: [] }] };
  }
  const parts = [...materialParts(study)];
  parts.push({ text: `調査名: ${study.title}\n${study.objectives ? '現在の調査目的: ' + study.objectives + '\n' : ''}${hint ? '調査者からの要望: ' + hint + '\n' : ''}\n上の資料を読み、海外の人に日本の伝統文化への反応を聞くAIインタビューの設定を作ってください。質問は6〜10個、ラポール形成から始めて「広い→狭い」の順(接点→第一印象→魅力→懸念・障壁→体験/購入意向・価格感→自国の文化との比較→提案)に並べます。関心度や支払意向は段階的な選択肢を付けます。資料の具体的な内容(名称・特徴)を質問に反映してください。` });
  return callGemini({ system: 'あなたは定性市場調査の設計に詳しいリサーチャーです。', parts, schema: CONFIG_SCHEMA, temperature: 0.5 });
}

// ---- AI模擬回答者 ----
async function personaAnswer(study, session, persona) {
  if (MOCK_AI) return ['I like it a lot, it looks peaceful.', 'Maybe the price, and I worry about etiquette.', 'Yes, if it is under 50 dollars.'][session.messages.filter((m) => m.role === 'user').length % 3];
  return callGemini({
    system: `あなたはインタビューを受ける回答者を演じます。設定: ${persona}\n${session.languageName}で、その人物らしく自然に1〜3文で答えてください。毎回好意的になる必要はありません。実在の個人情報は作らないでください。回答文だけを出力します。`,
    parts: [{ text: `# これまでの会話\n${transcriptText(session)}\n\nインタビュアーの最後の質問に答えてください。` }],
    temperature: 0.9,
  });
}
async function simulate(study, persona, language) {
  const session = newSession(study, language, { country: 'SIMULATION' });
  session.simulated = true; session.persona = persona;
  pushAi(session, await nextTurn(study, session));
  const limit = (Number(study.maxQuestions) || 10) + 3;
  for (let i = 0; i < limit && session.status === 'active'; i++) {
    const ans = String(await personaAnswer(study, session, persona)).trim();
    session.messages.push({ role: 'user', text: ans, at: now() });
    const t = await nextTurn(study, session);
    if (t.answer_ja) session.messages[session.messages.length - 1].ja = t.answer_ja;
    pushAi(session, t);
    if (t.is_finished) break;
  }
  saveSession(session);
  await finishSession(study, session);
  return readJson(sessionPath(study.id, session.id));
}

// ---------- 統計・検索 ----------
function computeStats(study) {
  const all = listSessions(study.id).filter((s) => !s.simulated);
  const count = (arr, f) => arr.reduce((o, x) => { const k = f(x) || '未回答'; o[k] = (o[k] || 0) + 1; return o; }, {});
  const completed = all.filter((s) => s.status === 'completed');
  const answers = all.map((s) => s.messages.filter((m) => m.role === 'user').length);
  const reports = all.map((s) => s.report).filter(Boolean);
  const ratings = all.map((s) => s.rating?.score).filter(Boolean);
  const avg = (a) => (a.length ? Math.round((a.reduce((x, y) => x + y, 0) / a.length) * 10) / 10 : null);
  const qCover = {};
  for (const s of all) for (const id of new Set(s.messages.map((m) => m.questionId).filter(Boolean))) if (qCover[id]) qCover[id].reached++;
  return {
    total: all.length, completed: completed.length, completionRate: all.length ? Math.round((completed.length / all.length) * 100) : 0,
    avgAnswers: avg(answers), avgInterest: avg(reports.map((r) => r.interest_score).filter(Boolean)), avgRating: avg(ratings), ratingCount: ratings.length,
    byLanguage: count(all, (s) => s.languageName), byCountry: count(all, (s) => s.profile?.country), byAge: count(all, (s) => s.profile?.age),
    byVisited: count(all, (s) => ({ yes: 'あり', no: 'なし', many: '複数回' }[s.profile?.visitedJapan])),
    bySentiment: count(reports, (r) => ({ positive: '好意的', mixed: '賛否混在', neutral: '中立', negative: '否定的' }[r.sentiment])),
    byType: count(reports, (r) => r.respondent_type),
    questionReach: Object.values(qCover),
    simulatedCount: listSessions(study.id).length - all.length,
  };
}
function searchMessages(study, q, includeSimulated) {
  const needle = String(q || '').trim().toLowerCase();
  if (!needle) return [];
  const out = [];
  for (const s of listSessions(study.id)) {
    if (s.simulated && !includeSimulated) continue;
    s.messages.forEach((m, i) => {
      if (m.role !== 'user') return;
      if ((m.text || '').toLowerCase().includes(needle) || (m.ja || '').toLowerCase().includes(needle)) {
        const prevAi = [...s.messages.slice(0, i)].reverse().find((x) => x.role === 'ai');
        out.push({ sessionId: s.id, languageName: s.languageName, country: s.profile?.country || '', index: i, text: m.text, ja: m.ja || '', question: prevAi?.ja || prevAi?.text || '', simulated: !!s.simulated });
      }
    });
  }
  return out.slice(0, 300);
}

// ---------- ルーティング ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
function serveFile(res, file) {
  if (!fs.existsSync(file)) return send(res, 404, 'Not found');
  send(res, 200, fs.readFileSync(file), { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
}
function publicStudy(s) {
  return { id: s.id, title: s.publicTitle || s.title, intro: s.intro || '', languages: s.languages || [], active: s.active !== false, askProfile: s.askProfile !== false, maxQuestions: Number(s.maxQuestions) || 10 };
}
function publicSession(s, study) {
  const lastAi = [...s.messages].reverse().find((m) => m.role === 'ai');
  return {
    id: s.id, status: s.status, language: s.language, rated: !!s.rating,
    quickReplies: s.status === 'active' ? lastAi?.quickReplies || [] : [],
    messages: s.messages.map((m) => ({ role: m.role, text: m.text, material: m.materialId ? materialInfo(study, m.materialId) : null })),
  };
}
function materialInfo(study, mid) {
  const m = (study.materials || []).find((x) => x.id === mid && x.showToRespondent);
  return m ? { id: m.id, name: m.name, mimeType: m.mimeType, url: `/api/public/studies/${study.id}/materials/${m.id}` } : null;
}
function newSession(study, language, profile) {
  return { id: newId(), token: newId(16), studyId: study.id, language, languageName: LANGS[language] || language, profile, status: 'active', startedAt: now(), updatedAt: now(), messages: [] };
}

const LANGS = {
  en: 'English', ja: '日本語', 'zh-CN': '简体中文', 'zh-TW': '繁體中文', ko: '한국어', es: 'Español', fr: 'Français', de: 'Deutsch', it: 'Italiano', pt: 'Português', ru: 'Русский', ar: 'العربية', hi: 'हिन्दी', th: 'ไทย', vi: 'Tiếng Việt', id: 'Bahasa Indonesia', ms: 'Bahasa Melayu', tl: 'Filipino', tr: 'Türkçe', pl: 'Polski', nl: 'Nederlands', sv: 'Svenska',
};

async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  const seg = p.split('/').filter(Boolean);

  // ページ
  if (req.method === 'GET') {
    if (p === '/') return send(res, 302, '', { Location: '/admin' });
    if (p === '/admin') return serveFile(res, path.join(PUBLIC_DIR, 'admin.html'));
    if (seg[0] === 'i' && seg.length === 2) return serveFile(res, path.join(PUBLIC_DIR, 'interview.html'));
    if (seg[0] === 'static' && seg.length === 2 && /^[\w.-]+$/.test(seg[1])) return serveFile(res, path.join(PUBLIC_DIR, seg[1]));
    if (p === '/api/languages') return send(res, 200, LANGS);
  }

  // ---- 回答者向けAPI ----
  if (seg[0] === 'api' && seg[1] === 'public') {
    if (seg[2] === 'studies' && seg[3]) {
      const study = getStudy(seg[3]);
      if (!study) return send(res, 404, { error: 'この調査は見つかりません' });
      if (req.method === 'GET' && seg.length === 4) return send(res, 200, publicStudy(study));
      if (req.method === 'GET' && seg[4] === 'materials' && seg[5]) {
        const m = (study.materials || []).find((x) => x.id === seg[5] && x.showToRespondent);
        if (!m) return send(res, 404, 'Not found');
        return send(res, 200, fs.readFileSync(path.join(DATA_DIR, 'files', m.fileId)), { 'Content-Type': m.mimeType, 'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(m.name)}` });
      }
      if (req.method === 'POST' && seg[4] === 'sessions') {
        if (study.active === false) return send(res, 403, { error: 'This interview is closed.' });
        const b = await readBody(req);
        const language = LANGS[b.language] ? b.language : 'en';
        const profile = {};
        for (const k of ['country', 'age', 'gender', 'visitedJapan']) if (b.profile?.[k]) profile[k] = String(b.profile[k]).slice(0, 100);
        const session = newSession(study, language, profile);
        pushAi(session, await nextTurn(study, session));
        saveSession(session);
        return send(res, 200, { ...publicSession(session, study), token: session.token });
      }
    }
    if (seg[2] === 'sessions' && seg[3]) {
      const session = findSession(seg[3]);
      if (!session || req.headers['x-session-token'] !== session.token) return send(res, 404, { error: 'Session not found' });
      const study = getStudy(session.studyId);
      if (!study) return send(res, 404, { error: 'Interview not found' });
      if (req.method === 'GET' && seg.length === 4) return send(res, 200, publicSession(session, study));
      if (req.method === 'POST' && seg[4] === 'rating') {
        const b = await readBody(req);
        const score = Math.round(Number(b.score));
        if (!(score >= 1 && score <= 5)) return send(res, 400, { error: 'invalid score' });
        session.rating = { score, comment: String(b.comment || '').slice(0, 2000), at: now() };
        saveSession(session);
        return send(res, 200, publicSession(session, study));
      }
      if (req.method === 'POST' && (seg[4] === 'answer' || seg[4] === 'finish')) {
        if (session.status !== 'active') return send(res, 409, { error: 'Interview already finished' });
        const b = await readBody(req);
        const text = String(b.text || '').trim().slice(0, 4000);
        if (seg[4] === 'answer' && !text) return send(res, 400, { error: 'empty answer' });
        const userTurns = session.messages.filter((m) => m.role === 'user').length;
        const hardLimit = (Number(study.maxQuestions) || 10) * 2 + 5; // 1回答者あたりの上限(費用対策)
        session.messages.push({ role: 'user', text: seg[4] === 'finish' ? (text || '(回答者が終了を選択しました / I would like to end the interview now.)') : text, at: now() });
        const t = await nextTurn(study, session);
        if (seg[4] === 'finish' || userTurns + 1 >= hardLimit) t.is_finished = true;
        if (t.is_finished) t.quick_replies = [];
        const lastUser = session.messages[session.messages.length - 1];
        if (t.answer_ja) lastUser.ja = t.answer_ja;
        pushAi(session, t);
        if (t.is_finished) finishSession(study, session); else saveSession(session);
        return send(res, 200, publicSession(session, study));
      }
    }
    return send(res, 404, { error: 'Not found' });
  }

  // ---- 管理者API ----
  if (seg[0] === 'api' && seg[1] === 'admin') {
    if (seg[2] === 'login' && req.method === 'POST') {
      const b = await readBody(req);
      if (!passwordOk(b.password)) return send(res, 401, { error: 'パスワードが違います' });
      const token = newId(24); adminTokens.set(token, Date.now() + 12 * 3600e3);
      return send(res, 200, { token });
    }
    if (!isAdmin(req)) return send(res, 401, { error: 'ログインしてください' });

    if (seg[2] === 'status') return send(res, 200, { mock: MOCK_AI, model: GEMINI_MODEL, defaultPassword: ADMIN_PASSWORD === 'admin', usageToday: usageToday(), dailyLimit: DAILY_AI_CALL_LIMIT, cloud: cloud.enabled });
    if (seg[2] === 'studies' && !seg[3]) {
      if (req.method === 'GET') return send(res, 200, listStudies().map((s) => ({ ...s, sessionCount: listSessions(s.id).filter((x) => !x.simulated).length })));
      if (req.method === 'POST') {
        const b = await readBody(req);
        const study = { id: newId(6), createdAt: now(), materials: [], questions: [] };
        applyStudyFields(study, b);
        addMaterials(study, b.newMaterials);
        saveStudy(study);
        return send(res, 200, study);
      }
    }
    if (seg[2] === 'studies' && seg[3]) {
      const study = getStudy(seg[3]);
      if (!study) return send(res, 404, { error: '調査が見つかりません' });
      if (seg.length === 4) {
        if (req.method === 'GET') return send(res, 200, study);
        if (req.method === 'PUT') {
          const b = await readBody(req);
          applyStudyFields(study, b);
          if (Array.isArray(b.materials)) {
            const keep = new Map(b.materials.map((m) => [m.id, m]));
            study.materials = study.materials.filter((m) => keep.has(m.id)).map((m) => ({ ...m, note: String(keep.get(m.id).note || ''), showToRespondent: !!keep.get(m.id).showToRespondent }));
          }
          addMaterials(study, b.newMaterials);
          study.updatedAt = now();
          saveStudy(study);
          return send(res, 200, study);
        }
        if (req.method === 'DELETE') {
          removeFile(studyPath(study.id));
          return send(res, 200, { ok: true });
        }
      }
      if (seg[4] === 'materials' && seg[5] && req.method === 'GET') {
        const m = study.materials.find((x) => x.id === seg[5]);
        if (!m) return send(res, 404, 'Not found');
        return send(res, 200, fs.readFileSync(path.join(DATA_DIR, 'files', m.fileId)), { 'Content-Type': m.mimeType });
      }
      if (seg[4] === 'generate' && req.method === 'POST') {
        const b = await readBody(req);
        return send(res, 200, await generateConfig(study, String(b.hint || '').slice(0, 2000)));
      }
      if (seg[4] === 'simulate' && req.method === 'POST') {
        const b = await readBody(req);
        const persona = String(b.persona || '').slice(0, 1000) || '日本に行ったことがない30代のアメリカ人。日本文化には少し興味があるが、値段や作法に不安がある。';
        const s = await simulate(study, persona, LANGS[b.language] ? b.language : 'en');
        delete s.token; return send(res, 200, s);
      }
      if (seg[4] === 'stats' && req.method === 'GET') return send(res, 200, computeStats(study));
      if (seg[4] === 'search' && req.method === 'GET') return send(res, 200, searchMessages(study, url.searchParams.get('q'), url.searchParams.get('sim') === '1'));
      if (seg[4] === 'sessions' && req.method === 'GET' && !seg[5]) {
        return send(res, 200, listSessions(study.id).map(({ token, messages, ...s }) => ({ ...s, answerCount: messages.filter((m) => m.role === 'user').length })));
      }
      if (seg[4] === 'sessions' && seg[5]) {
        const s = safeId(seg[5]) ? readJson(sessionPath(study.id, seg[5])) : null;
        if (!s) return send(res, 404, { error: 'not found' });
        if (req.method === 'DELETE') { removeFile(sessionPath(study.id, s.id)); return send(res, 200, { ok: true }); }
        if (req.method === 'POST' && seg[6] === 'report') { s.report = await buildReport(study, s); saveSession(s); return send(res, 200, s.report); }
        delete s.token; return send(res, 200, s);
      }
      if (seg[4] === 'analyze' && req.method === 'POST') {
        study.analysis = { text: await analyzeStudy(study), at: now() };
        saveStudy(study);
        return send(res, 200, study.analysis);
      }
      if (seg[4] === 'export.csv' && req.method === 'GET') {
        return send(res, 200, '﻿' + exportCsv(study, url.searchParams.get('kind')), { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="interview-${study.id}-${url.searchParams.get('kind') === 'summary' ? 'summary' : 'messages'}.csv"` });
      }
      if (seg[4] === 'export.json' && req.method === 'GET') {
        const all = { study, sessions: listSessions(study.id).map(({ token, ...s }) => s) };
        return send(res, 200, JSON.stringify(all, null, 2), { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': `attachment; filename="interview-${study.id}.json"` });
      }
    }
  }
  send(res, 404, { error: 'Not found' });
}

function pushAi(session, t) {
  session.messages.push({
    role: 'ai', text: String(t.message || ''), ja: String(t.message_ja || ''), topic: String(t.topic || ''),
    materialId: t.show_material_id || '', questionId: t.question_id || '',
    quickReplies: (Array.isArray(t.quick_replies) ? t.quick_replies : []).map((x) => String(x).slice(0, 80)).filter(Boolean).slice(0, 6),
    at: now(),
  });
  session.updatedAt = now();
}
function applyStudyFields(study, b) {
  const str = (v, n = 20000) => String(v ?? '').slice(0, n);
  if ('title' in b) study.title = str(b.title, 200) || '無題の調査';
  for (const k of ['publicTitle', 'objectives', 'topics', 'instructions', 'intro']) if (k in b) study[k] = str(b[k]);
  if ('maxQuestions' in b) study.maxQuestions = Math.max(1, Math.min(40, Number(b.maxQuestions) || 10));
  if ('languages' in b) study.languages = (Array.isArray(b.languages) ? b.languages : []).filter((l) => LANGS[l]);
  if ('active' in b) study.active = !!b.active;
  if ('askProfile' in b) study.askProfile = !!b.askProfile;
  if (Array.isArray(b.questions)) {
    study.questions = b.questions.filter((q) => q && String(q.text || '').trim()).slice(0, 40).map((q) => ({
      id: safeId(q.id) ? q.id : newId(4), text: str(q.text, 1000).trim(), followUp: str(q.followUp, 1000),
      quickReplies: (Array.isArray(q.quickReplies) ? q.quickReplies : String(q.quickReplies || '').split(/[\/／\n]/)).map((x) => String(x).trim()).filter(Boolean).slice(0, 6),
    }));
  }
}
function addMaterials(study, list) {
  for (const f of Array.isArray(list) ? list : []) {
    if (!f || !f.data) continue;
    const fileId = newId(12);
    const buf = Buffer.from(String(f.data), 'base64');
    fs.writeFileSync(path.join(DATA_DIR, 'files', fileId), buf);
    cloud.put(`files/${fileId}`, buf, true);
    study.materials.push({ id: newId(4), fileId, name: String(f.name || 'file').slice(0, 200), mimeType: String(f.mimeType || 'application/octet-stream'), size: buf.length, note: String(f.note || ''), showToRespondent: !!f.showToRespondent, uploadedAt: now() });
  }
}
function exportCsv(study, kind) {
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const sessions = listSessions(study.id);
  let rows;
  if (kind === 'summary') {
    rows = [['session_id', 'simulated', 'started_at', 'status', 'language', 'country', 'age', 'gender', 'visited_japan', 'answers', 'sentiment', 'interest_score', 'respondent_type', 'summary', 'opinions', 'rating', 'rating_comment']];
    for (const s of sessions) {
      const r = s.report || {};
      rows.push([s.id, s.simulated ? 'yes' : '', s.startedAt, s.status, s.languageName, s.profile?.country, s.profile?.age, s.profile?.gender, s.profile?.visitedJapan, s.messages.filter((m) => m.role === 'user').length, r.sentiment, r.interest_score, r.respondent_type, r.summary, (r.opinions || []).map((o) => `[${o.polarity}] ${o.title}: ${o.content}`).join('\n'), s.rating?.score, s.rating?.comment]);
    }
  } else {
    const qText = Object.fromEntries((study.questions || []).map((q) => [q.id, q.text]));
    rows = [['session_id', 'simulated', 'started_at', 'status', 'language', 'country', 'age', 'gender', 'visited_japan', 'turn', 'speaker', 'question_guide', 'topic', 'original_text', 'japanese']];
    for (const s of sessions) {
      s.messages.forEach((m, i) => rows.push([s.id, s.simulated ? 'yes' : '', s.startedAt, s.status, s.languageName, s.profile?.country, s.profile?.age, s.profile?.gender, s.profile?.visitedJapan, i + 1, m.role === 'ai' ? 'AI' : '回答者', qText[m.questionId] || '', m.topic || '', m.text, m.ja || '']));
    }
  }
  return rows.map((r) => r.map(esc).join(',')).join('\r\n');
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    console.error(e);
    if (!res.headersSent) send(res, e.status || 500, { error: e.message || 'サーバーエラー' });
  });
});

(async () => {
  if (cloud.enabled) {
    const n = await cloud.restore(DATA_DIR);
    console.log(`Supabase から ${n} 件のデータを復元しました`);
  }
  server.listen(PORT, () => {
  console.log(`\nAIインタビューツール起動: http://localhost:${PORT}/admin`);
  console.log(cloud.enabled ? 'データ保存先: Supabase(+ローカル)' : `データ保存先: ${DATA_DIR}(ローカルのみ)`);
  console.log(MOCK_AI ? '⚠ GEMINI_API_KEY 未設定のため デモモード(AIなし)で動いています' : `Gemini モデル: ${GEMINI_MODEL}`);
  if (ADMIN_PASSWORD === 'admin') console.log('⚠ 管理者パスワードが初期値(admin)です。ADMIN_PASSWORD を設定してください');
  });
})().catch((e) => { console.error('起動に失敗しました:', e.message); process.exit(1); });

for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, async () => { server.close(); await cloud.flush(); process.exit(0); });
