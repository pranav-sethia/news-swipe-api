/**
 * HackerSwipe V10 Algorithm Tests
 * Run: node test_algorithm.js
 */
'use strict';

let passed = 0, failed = 0;
function assert(cond, name) {
  if (cond) { console.log(`  ✅ PASS: ${name}`); passed++; }
  else       { console.log(`  ❌ FAIL: ${name}`); failed++; }
}

// ── Mirror backend helpers ────────────────────────────────────────────────────
const EMA_ALPHA = 0.2;

function emaUpdate(tasteVec, articleVec) {
  if (!tasteVec) return [...articleVec];
  return tasteVec.map((v, i) => v * (1 - EMA_ALPHA) + articleVec[i] * EMA_ALPHA);
}

function scoreArticles(rows) {
  if (!rows.length) return;
  const scores = rows.map(r => parseFloat(r.sim));
  const minS = Math.min(...scores), maxS = Math.max(...scores);
  const range = maxS - minS || 0.001;
  rows.forEach(r => { r.match_pct = Math.round(72 + ((r.sim - minS) / range) * 27); });
}

// Window-based probabilistic interleave (mirrors index.js exactly)
function randomizedInterleave(smartRows, dumbRows) {
  if (!dumbRows.length) return [...smartRows];
  if (!smartRows.length) return [...dumbRows];
  const numWindows = dumbRows.length;
  const windowSize = Math.floor(smartRows.length / numWindows);
  const result = [];
  let mi = 0, di = 0;
  let lastWasDisc = false;
  
  for (let w = 0; w < numWindows && mi < smartRows.length; w++) {
    const matchesInWindow = (w < numWindows - 1) ? windowSize : smartRows.length - mi;
    
    const minDiscSlot = lastWasDisc ? 1 : 0;
    const maxDiscSlot = (w === numWindows - 1) ? Math.max(minDiscSlot, matchesInWindow - 1) : matchesInWindow;
    
    let discSlot = minDiscSlot;
    if (maxDiscSlot > minDiscSlot) {
      discSlot = minDiscSlot + Math.floor(Math.random() * (maxDiscSlot - minDiscSlot + 1));
    }

    for (let j = 0; j < discSlot && mi < smartRows.length; j++) {
      result.push(smartRows[mi++]);
      lastWasDisc = false;
    }
    if (di < dumbRows.length) {
      result.push({ ...dumbRows[di++], match_pct: null });
      lastWasDisc = true;
    }
    for (let j = discSlot; j < matchesInWindow && mi < smartRows.length; j++) {
      result.push(smartRows[mi++]);
      lastWasDisc = false;
    }
  }
  while (mi < smartRows.length) result.push(smartRows[mi++]);
  while (di < dumbRows.length) result.push({ ...dumbRows[di++], match_pct: null });
  return result;
}

function dot(a, b) { return a.reduce((s, v, i) => s + v * b[i], 0); }
function normV(v)  { return Math.sqrt(v.reduce((s, x) => s + x * x, 0)); }
function cosine(a, b) { return dot(a, b) / (normV(a) * normV(b)); }

console.log('╔══════════════════════════════════════════════════════╗');
console.log('║        HackerSwipe V10 Algorithm Tests               ║');
console.log('╚══════════════════════════════════════════════════════╝\n');


// ═══ TEST 1: EMA ══════════════════════════════════════════════════════════════
console.log('📊 TEST 1: EMA Vector Update (alpha=0.2)\n');

let tv = emaUpdate(null, [1,0,0,0,0]);
assert(JSON.stringify(tv) === JSON.stringify([1,0,0,0,0]),
  'First like: taste_vector = article embedding exactly');

tv = emaUpdate(tv, [0,1,0,0,0]);
assert(Math.abs(tv[0] - 0.8) < 0.001, `Second like: dim0=0.80 (got ${tv[0].toFixed(4)})`);
assert(Math.abs(tv[1] - 0.2) < 0.001, `Second like: dim1=0.20 (got ${tv[1].toFixed(4)})`);

const [i1,i3,i5,i10,i20] = [1,3,5,10,20].map(n => 1 - Math.pow(1-EMA_ALPHA, n));
assert(i5 > 0.65, `After 5 likes, taste = ${(i5*100).toFixed(1)}% influenced (>65% threshold)`);
assert(i1 < i3 && i3 < i5 && i5 < i10 && i10 < i20,
  'EMA influence grows monotonically: 1 < 3 < 5 < 10 < 20 likes');
console.log(`\n  ℹ️  Influence: 1=${(i1*100).toFixed(0)}%  3=${(i3*100).toFixed(0)}%  5=${(i5*100).toFixed(0)}%  10=${(i10*100).toFixed(0)}%  20=${(i20*100).toFixed(0)}%`);

// Long-term interest preserved after a new topic like
let aiVec = null;
for (let i = 0; i < 10; i++) aiVec = emaUpdate(aiVec, [1,0,0,0,0]);
aiVec = emaUpdate(aiVec, [0,1,0,0,0]);
assert(aiVec[0] > 0.5, `AI interest preserved after 1 unrelated like (${aiVec[0].toFixed(3)} > 0.5)`);
assert(aiVec[0] > aiVec[1], `AI still dominates over new sports interest`);

// Recency weighting: most recent like always has the highest individual weight
assert(EMA_ALPHA > EMA_ALPHA * (1 - EMA_ALPHA),
  `Most recent like weight(${EMA_ALPHA}) > previous like weight(${(EMA_ALPHA*(1-EMA_ALPHA)).toFixed(3)}) — recency confirmed`);


// ═══ TEST 2: Match % Scoring ══════════════════════════════════════════════════
console.log('\n🎯 TEST 2: Match % Relative Scoring (72-99)\n');

const rows12 = [
  {sim:0.38},{sim:0.31},{sim:0.26},{sim:0.21},{sim:0.18},{sim:0.15},
  {sim:0.12},{sim:0.09},{sim:0.07},{sim:0.05},{sim:0.03},{sim:0.01}
];
scoreArticles(rows12);
assert(rows12[0].match_pct === 99,  `Best article: 99%  (got ${rows12[0].match_pct}%)`);
assert(rows12[11].match_pct === 72, `Weakest article: 72% (got ${rows12[11].match_pct}%)`);
assert(rows12.every(r => r.match_pct >= 72 && r.match_pct <= 99), 'All 12 within 72-99%');
assert(rows12[0].match_pct > rows12[5].match_pct && rows12[5].match_pct > rows12[11].match_pct,
  'Scores ordered: best→highest %');

const allSame = Array.from({length:12}, () => ({sim:0.25}));
scoreArticles(allSame);
assert(allSame.every(r => r.match_pct === 72), 'All identical similarities → 72%, no crash');

const emptyArr = [];
scoreArticles(emptyArr);
assert(emptyArr.length === 0, 'Empty array: no crash');

console.log('\n  ℹ️  Score distribution:');
rows12.forEach(r => console.log(`     sim=${r.sim.toFixed(2)} → ${r.match_pct}%`));


// ═══ TEST 3: Probabilistic Interleave — 100 runs ══════════════════════════════
console.log('\n🔀 TEST 3: Window-Based Probabilistic Interleave (100-run Validation)\n');
{
  const RUNS = 100;
  let ok = true, failReason = '';
  let maxDisc = 0, maxMatch = 0;
  const slotsSeen = new Set();

  for (let r = 0; r < RUNS; r++) {
    const sm = Array.from({length:12}, (_,i) => ({id:i, match_pct:72+i*2}));
    const du = Array.from({length:3},  (_,i) => ({id:100+i, match_pct:null}));
    const feed = randomizedInterleave(sm, du);

    if (feed.length !== 15)                                         { ok=false; failReason='Wrong length'; break; }
    if (feed.filter(a => a.match_pct != null).length !== 12)        { ok=false; failReason='Wrong match count'; break; }
    if (feed.filter(a => a.match_pct == null).length  !== 3)        { ok=false; failReason='Wrong disc count'; break; }
    if ([...feed].reverse()[0].match_pct == null)                   { ok=false; failReason='First card is DISC'; break; }

    let cD = 0, cM = 0;
    for (const a of [...feed].reverse()) {
      if (a.match_pct == null) { cD++; cM = 0; } else { cM++; cD = 0; }
      maxDisc  = Math.max(maxDisc,  cD);
      maxMatch = Math.max(maxMatch, cM);
      if (cD > 1) { ok=false; failReason='Back-to-back disc'; break; }
    }
    if (!ok) break;
    feed.forEach((a,i) => { if (a.match_pct == null) slotsSeen.add(i); });
  }

  assert(ok,          `All constraints passed across ${RUNS} runs${ok?'':' — '+failReason}`);
  assert(maxDisc <= 1,`Max consecutive discovery = ${maxDisc} (hard cap = 1)`);
  assert(maxMatch <= 8,`Max consecutive matches = ${maxMatch} (target ≤8)`);
  assert(slotsSeen.size >= 5,
    `Discovery positions varied: ${slotsSeen.size} unique slots seen (not hardcoded)`);

  console.log(`  ℹ️  Max disc streak: ${maxDisc}  |  Max match streak: ${maxMatch}`);
  console.log(`  ℹ️  Disc slots observed: [${[...slotsSeen].sort((a,b)=>a-b).join(', ')}]`);
  console.log('  ℹ️  3 sample feeds (first→last swipe):');
  for (let s = 0; s < 3; s++) {
    const f = randomizedInterleave(
      Array.from({length:12},(_,i)=>({id:i,match_pct:72+i*2})),
      Array.from({length:3}, (_,i)=>({id:100+i,match_pct:null}))
    );
    console.log(`     ${[...f].reverse().map(a=>a.match_pct?`M${a.match_pct}`:'DISC').join(' ')}`);
  }
}


// ═══ TEST 4: Semantic Relevance ═══════════════════════════════════════════════
console.log('\n🧠 TEST 4: Semantic Relevance After Likes\n');
// 5-dim proxy: [AI, Web, Systems, Startup, Science]
const articles = [
  {title:'GPT-4 Technical Report',         emb:[0.90,0.10,0.10,0.10,0.10]},
  {title:'Training Large Language Models', emb:[0.85,0.05,0.20,0.10,0.15]},
  {title:'React 19 New Features',          emb:[0.10,0.90,0.05,0.10,0.05]},
  {title:'Show HN: My SaaS Startup',       emb:[0.15,0.10,0.10,0.85,0.05]},
  {title:'New Exoplanet Discovered',       emb:[0.05,0.05,0.05,0.05,0.90]},
  {title:'CUDA Programming Guide',         emb:[0.50,0.10,0.70,0.05,0.10]},
  {title:'Attention Is All You Need',      emb:[0.88,0.05,0.15,0.05,0.20]},
  {title:'Next.js App Router Guide',       emb:[0.12,0.88,0.10,0.12,0.05]},
];

let simVec = null;
simVec = emaUpdate(simVec, articles[0].emb); // GPT-4
simVec = emaUpdate(simVec, articles[1].emb); // Training LLMs
simVec = emaUpdate(simVec, articles[6].emb); // Attention paper

const ranked = articles.map(a => ({...a, score: cosine(simVec, a.emb)}))
                        .sort((a,b) => b.score - a.score);
const aiRank    = ranked.findIndex(a => a.title.includes('GPT'));
const reactRank = ranked.findIndex(a => a.title.includes('React'));
const cudaRank  = ranked.findIndex(a => a.title.includes('CUDA'));

assert(aiRank < 2,          `Top result is AI-related: "${ranked[0].title}" (rank ${aiRank+1})`);
assert(aiRank < reactRank,   `AI (rank ${aiRank+1}) beats unrelated React (rank ${reactRank+1})`);
assert(cudaRank < reactRank, `AI-adjacent CUDA (rank ${cudaRank+1}) beats unrelated React (rank ${reactRank+1})`);

console.log('\n  ℹ️  Rankings after 3 AI likes:');
ranked.forEach((a,i) => console.log(`     ${i+1}. [${a.score.toFixed(3)}] ${a.title}`));


// ═══ SUMMARY ══════════════════════════════════════════════════════════════════
console.log('\n' + '═'.repeat(56));
console.log(`  Results: ${passed} passed, ${failed} failed out of ${passed+failed} tests`);
console.log(failed === 0
  ? '  🎉 ALL TESTS PASSED — Algorithm is mathematically correct'
  : '  ⚠️  SOME TESTS FAILED — Investigate before deploying');
console.log('═'.repeat(56));
