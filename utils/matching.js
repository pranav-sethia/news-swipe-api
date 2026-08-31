// pgvector returns embedding columns as either a JSON-array string or an
// already-parsed array depending on the query shape - this normalizes both.
const parseVector = (v) => typeof v === 'string' ? JSON.parse(v) : v;

function normalize(vec) {
  let magnitude = Math.sqrt(vec.reduce((sum, val) => sum + val * val, 0));
  if (magnitude === 0) magnitude = 1;
  return vec.map(val => val / magnitude);
}

function cosineSimilarity(vecA, vecB) {
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

// "Confidently disliked" categories - a magnitude threshold (not a bare sign
// check). A bare `< 0` check never actually recovers: catBlend decays
// exponentially toward zero but never crosses it without a fresh positive
// swipe. Used for BOTH discovery/popular exclusion and the smart-slot
// portfolio cap (see feed.js) - one shared concept, not two.
function computeConfidentlyDislikedSet(catBlend, threshold) {
  const D = new Set();
  catBlend.forEach((value, category) => {
    if (value < -threshold) D.add(category);
  });
  return D;
}

// Deficit-scheduled, cap-respecting batch assembly.
//
// candidatesByType: { smart: [...], popular: [...], discovery: [...] }, each
//   already scored (final_score) and sorted best-first, each item carrying
//   { id, category, parsed_embedding, final_score, ... }.
// targetShares: { smart, popular, discovery } fractions summing to ~1.
// initialCategorySequence: categories of cards already on-screen (the
//   client's kept top-KEEP_TOP cards, most-recent-first - i.e. index 0 is
//   about to be seen). Used for run-length/portfolio window context so a
//   freshly-assembled batch doesn't produce a same-category run once
//   stitched onto what's already displayed.
// portfolioCapShareFn(category) -> share in [0,1]. Callers should return 0
//   for confidently-disliked categories, folding "D excludes outright" into
//   the same mechanism rather than a separate filter.
// isOnCooldown(category) -> bool, applies to the 'smart' type only.
//
// Returns picks in "shown-soonest-first" order - the caller reverses this
// before responding, to match the existing "weakest at index 0 (shown
// last), strongest at end (shown first)" frontend contract.
function assembleBatch({
  candidatesByType,
  targetShares,
  batchSize,
  initialCategorySequence,
  portfolioCapShareFn,
  runLengthCap,
  compositionWindow,
  nearTieMargin,
  isOnCooldown,
  dislikedSet,
  categoriesWithSignal,
}) {
  const picked = [];
  const usedIds = new Set();
  const typeCounts = { smart: 0, popular: 0, discovery: 0 };
  // Category-level deficit floor WITHIN the smart slot - see the
  // category-weighted selection in pickBestFromType below for why this
  // exists (heterogeneous-category fairness, not just type fairness).
  const smartCategoryCounts = new Map();
  let smartPickedCount = 0;

  function trailingCategoryWindow(n) {
    const combined = [...initialCategorySequence, ...picked.map(p => p.category)];
    return combined.slice(-n);
  }

  function violatesRunLength(category) {
    if (!category) return false;
    const win = trailingCategoryWindow(runLengthCap);
    return win.length >= runLengthCap && win.every(c => c === category);
  }

  function violatesPortfolioCap(category) {
    if (!category) return false;
    const win = trailingCategoryWindow(compositionWindow);
    const count = win.filter(c => c === category).length;
    const projected = (count + 1) / (win.length + 1);
    return projected > portfolioCapShareFn(category);
  }

  function pickBestFromType(type, { skipRunLength, skipPortfolio, skipMmr, skipCooldown } = {}) {
    const list = candidatesByType[type] || [];
    const eligible = [];
    for (const c of list) {
      if (usedIds.has(c.id)) continue;
      // D-set exclusion is unconditional, never relaxed - unlike the
      // portfolio cap's magnitude check (which CAN be relaxed as a last
      // resort under pool exhaustion), a confidently-disliked category must
      // never leak into the smart slot regardless of relaxation stage.
      if (type === 'smart' && dislikedSet && dislikedSet.has(c.category)) continue;
      if (type === 'smart' && !skipCooldown && isOnCooldown && isOnCooldown(c.category)) continue;
      if (!skipRunLength && violatesRunLength(c.category)) continue;
      if (type === 'smart' && !skipPortfolio && violatesPortfolioCap(c.category)) continue;
      if (!skipMmr) {
        let tooSimilar = false;
        for (const p of picked) {
          if (cosineSimilarity(c.parsed_embedding, p.parsed_embedding) > 0.90) { tooSimilar = true; break; }
        }
        if (tooSimilar) continue;
      }
      eligible.push(c);
    }
    if (!eligible.length) return null;

    if (type === 'smart') {
      // A flat score-sort here structurally favors whichever liked
      // category's embeddings happen to cluster tighter (higher raw cosine
      // similarity for a merely-decent match) over one that's genuinely
      // liked just as much but is more semantically spread out - live-
      // confirmed with "Other" (philosophy/world-events/personal-essay
      // articles the user explicitly said they loved) never once winning a
      // slot against Artificial Intelligence/Software Engineering, despite
      // a comparable like count, because AI/SWE embeddings simply sit
      // closer together in vector space. portfolioCapShareFn already
      // expresses "how much of the smart slot this category has earned" -
      // reusing it here as a target share (not just a ceiling) makes each
      // earned category compete for its own deficit-scheduled slot instead
      // of one global ranking, the same fix already applied one level up
      // for type selection.
      const byCategory = new Map();
      eligible.forEach(c => {
        const cat = c.category || null;
        if (!byCategory.has(cat)) byCategory.set(cat, []);
        byCategory.get(cat).push(c);
      });
      const categoryDeficits = [...byCategory.keys()].map(cat => {
        // Only a category the user has actually earned signal in gets an
        // active floor target - otherwise EVERY never-liked category
        // inherits portfolioCapShareFn's 0.35 baseline too (it's meant as a
        // ceiling floor for categories that already show up, not a promotion
        // target for ones the user has never once engaged with), which
        // live-testing showed washes out real personalization: unsignaled
        // categories matched exactly as often as genuinely-liked ones.
        const hasSignal = cat && categoriesWithSignal && categoriesWithSignal.has(cat);
        const target = hasSignal ? portfolioCapShareFn(cat) : 0;
        const count = smartCategoryCounts.get(cat) || 0;
        const totalSoFar = smartPickedCount || 1;
        return { type: cat, deficit: target - (count / totalSoFar) };
      });
      const chosenCat = pickWeightedType(categoryDeficits);
      const pool = byCategory.get(chosenCat); // already best-first, `eligible` preserves candidatesByType's incoming order
      const topScore = pool[0].final_score;
      const margin = Math.abs(topScore) * nearTieMargin;
      const nearTies = pool.filter(c => topScore - c.final_score <= margin);
      return nearTies[Math.floor(Math.random() * nearTies.length)];
    }

    // Near-tie randomization: among candidates within nearTieMargin of the
    // top score, pick at random rather than always the strict top-1 - fixes
    // a real cold-start fragility where the same single article was
    // provably the first card served to every persona/account.
    const topScore = eligible[0].final_score;
    const margin = Math.abs(topScore) * nearTieMargin;
    const nearTies = eligible.filter(c => topScore - c.final_score <= margin);
    return nearTies[Math.floor(Math.random() * nearTies.length)];
  }

  // Progressive relaxation, explicit order: run-length cap -> portfolio cap
  // -> near-duplicate/MMR filter -> cooldown exclusion. Try to satisfy all
  // four for the deficit-selected type's best candidate; relax one at a
  // time rather than fail to serve a card.
  const relaxationStages = [
    {},
    { skipRunLength: true },
    { skipRunLength: true, skipPortfolio: true },
    { skipRunLength: true, skipPortfolio: true, skipMmr: true },
    { skipRunLength: true, skipPortfolio: true, skipMmr: true, skipCooldown: true },
  ];

  // Weighted-random type selection, weight = max(deficit, TYPE_SELECTION_FLOOR)
  // instead of strict argmax. On pick #1 of any call, `smart` almost always
  // has the single largest target share, so a strict-max-deficit rule
  // deterministically hands it EVERY call's first slot - harmless in
  // isolation, but the frontend calls assembleBatch fresh on every single
  // swipe (replaceStale) and keeps only the top 2 on-screen cards each time,
  // so only that first pick ever reliably survives long enough to be shown.
  // Live-confirmed result: across an 80-swipe realistic session, only 1
  // popular-type and 1 discovery-type card were ever actually displayed,
  // despite both having a healthy ~20%+ target share. Weighting pick #1
  // (and every pick) by deficit rather than taking the strict max makes the
  // type that actually reaches the user probabilistically track the target
  // shares over many swipes, without changing the steady-state math for a
  // single large batch.
  const TYPE_SELECTION_FLOOR = 0.02;
  function pickWeightedType(deficits) {
    const weights = deficits.map(d => Math.max(d.deficit, TYPE_SELECTION_FLOOR));
    const total = weights.reduce((s, w) => s + w, 0);
    let r = Math.random() * total;
    for (let i = 0; i < deficits.length; i++) {
      r -= weights[i];
      if (r <= 0) return deficits[i].type;
    }
    return deficits[deficits.length - 1].type;
  }

  while (picked.length < batchSize) {
    const totalSoFar = picked.length || 1;
    const deficits = ['smart', 'popular', 'discovery']
      .map(type => ({ type, deficit: (targetShares[type] || 0) - (typeCounts[type] / totalSoFar) }));

    const primaryType = pickWeightedType(deficits);
    const orderedTypes = [primaryType, ...deficits
      .filter(d => d.type !== primaryType)
      .sort((a, b) => b.deficit - a.deficit)
      .map(d => d.type)];

    let chosen = null;
    let chosenType = null;
    outer:
    for (const stage of relaxationStages) {
      for (const type of orderedTypes) {
        const candidate = pickBestFromType(type, stage);
        if (candidate) { chosen = candidate; chosenType = type; break outer; }
      }
    }
    if (!chosen) break; // every candidate pool is genuinely exhausted - stop rather than loop forever

    usedIds.add(chosen.id);
    typeCounts[chosenType] += 1;
    if (chosenType === 'smart') {
      smartPickedCount += 1;
      smartCategoryCounts.set(chosen.category, (smartCategoryCounts.get(chosen.category) || 0) + 1);
    }
    picked.push({ ...chosen, __type: chosenType });
  }

  return picked;
}

module.exports = { cosineSimilarity, parseVector, normalize, computeConfidentlyDislikedSet, assembleBatch };
