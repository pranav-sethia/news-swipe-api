const express = require('express');
const pool = require('../db');
const { cosineSimilarity, parseVector, normalize, computeConfidentlyDislikedSet, assembleBatch } = require('../utils/matching');
const { apiActionLimiter } = require('../middleware/rateLimiters');

const router = express.Router();

// The fixed 9 category labels this whole pipeline reasons about (see
// ingest.js's ALLOWED_CATEGORIES - kept in sync manually, there being no
// shared config module between the ingestion script and the API yet).
const ALL_CATEGORIES = [
  'Software Engineering', 'Hardware & Systems', 'Artificial Intelligence',
  'Startups & VC', 'Cybersecurity', 'Business & Finance',
  'Science & Space', 'Design & UI/UX', 'Other',
];

// --- Candidate-pool sizes (retrieval), unchanged from the prior design ---
const CANDIDATE_FETCH = 40;
const RECENT_CANDIDATE_FETCH = 20;
const POPULAR_POOL_FETCH = 15;
const DISCOVERY_POOL_FETCH = 20;
const STRATIFIED_FLOOR_PER_CATEGORY = 2;

// --- Delivery: a fixed total batch, ratio-scaled by confidence ---
const BATCH_SIZE = 17; // matches the original, already-validated 12/3/2 total

// --- Swipe history ---
// Split by type rather than one shared LIMIT across all swipe types
// (live-confirmed bug: a single 1000-row cap over likes+dislikes+skips
// combined let a heavy user's skips silently push their entire real like
// history out of the window, resetting likeCount to 0 and un-earning the
// match badge with no warning). Likes/dislikes need real depth (the core
// vector's 60-day half-life genuinely wants that much history); skips only
// feed a 4-hour-half-life signal and a 10-card cooldown check, so they never
// need more than a couple hundred rows regardless of how heavy a swiper is.
const LIKE_DISLIKE_HISTORY_LIMIT = 2000;
const SKIP_HISTORY_LIMIT = 300;

// --- The two-half-life taste vector, unchanged ---
const CORE_HALF_LIFE_HOURS = 60 * 24;   // 60 days - deliberately slower than any realistic session or product tenure
const RECENT_HALF_LIFE_HOURS = 60;      // 2.5 days - within-session responsive, faded within 1-2 weeks
const DISLIKE_DAMPENING = 0.15;         // dislikes only ever feed the recent channel (see accumulation loop) - "a user shouldn't regret a dislike"
const RECENT_MASS_PIVOT = 3;

// --- The confidence dial: like-count based, not total-swipe-based ---
// Composition-ramp speed only - NOT tied to badge timing, which is an
// independent, directly-specified hard rule below.
const TASTE_CONFIDENCE_M = 6;

// --- Badges: a literal, hard gate, specified directly by product decision ---
const LIKES_NEEDED_FOR_MATCHES = 3;

// --- Skip mechanic ---
const SKIP_HALF_LIFE_HOURS = 4;
const SKIP_DAMPENING = -0.08; // deliberately ~half of DISLIKE_DAMPENING - a skip is a genuinely weaker signal than a dislike
const SKIP_COOLDOWN_TRIGGER = 3;   // skips within the trailing window to trigger a mute
const SKIP_COOLDOWN_WINDOW = 10;   // trailing served-cards window checked for the trigger
const SKIP_COOLDOWN_CARDS = 25;    // mute duration in cards
const SKIP_COOLDOWN_HOURS = 6;     // mute duration in hours - whichever threshold is reached first releases it

// --- Disliked-category threshold, unified across both exclusion mechanisms ---
// Cross-validated against DISLIKE_DAMPENING: a single fresh dislike
// contributes catRecent ~= -0.15, so crossing -0.3 requires ~2 dislikes'
// worth of decayed weight - one dislike alone can never trigger this.
const CATEGORY_DISLIKE_FLOOR_THRESHOLD = 0.3;

// --- Popularity weight, confidence-scaled ---
const POPULARITY_WEIGHT_FLOOR = 0.05;       // at likeWeight=1 - never zero, a big story shouldn't vanish even for a power user
const POPULARITY_WEIGHT_COLD_BONUS = 0.10;  // ceiling = 0.15 at likeWeight=0

// --- Recency penalty ---
const SMART_DISCOVERY_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
const SMART_DISCOVERY_RECENCY_PENALTY = 0.15;
const POPULAR_RECENCY_HALF_LIFE_HOURS = 144; // ~6 days - HN's own news cycle makes a 90-day window meaningless for "trending"
const POPULAR_RECENCY_PENALTY_CEILING = 0.15;

// --- Composition shares ---
const SHARE_BASE = 0.15;
const SHARE_SWING = 0.15; // popularShare/discoveryShare = SHARE_BASE + SHARE_SWING*(1-likeWeight)

// --- Diversity mechanisms ---
const COMPOSITION_WINDOW = 15;
const RUN_LENGTH_CAP = 3;
const PORTFOLIO_CAP_MIN = 0.35;
const PORTFOLIO_CAP_MAX = 0.80;
const NEAR_TIE_MARGIN = 0.05;
// Extra near-tie margin at likeWeight=0, tapering to 0 as likeWeight->1 -
// live-confirmed cold-start bug: with no retrieval vector, ~70% of a fresh
// deck (smart+popular) was fully deterministic (pure recency/popularity
// ordering, zero randomization), and 3 independent zero-signal accounts got
// 71-82% identical first batches. There's no real personalization signal to
// protect yet at low likeWeight, so widening the "close enough to
// randomize" window here is low-risk and directly targets the measured gap.
const COLDSTART_NEAR_TIE_BONUS = 0.15;

// --- Per-category retrieval (multimodal taste fix) ---
// Root cause of "every match is about my biggest category, even though I
// genuinely liked several very different things": a SINGLE blended vector
// (of all liked articles, any category) drives both ANN retrieval and
// scoring. Live-confirmed on real data: a user who liked AI, Software
// Engineering, and stylistically-distinct "Other" articles got 8/10
// badge-eligible cards in AI, 2/10 in SWE, 0/10 in Other - the raw ANN pool
// itself was 26/40 AI, 0/40 Other, because averaging pulls the one blended
// vector toward whichever liked cluster is larger/tighter, and a
// heterogeneous category like "Other" (personal essays, philosophy, history
// - real measured pairwise similarity as low as 0.03-0.16 even within a
// hand-picked "same style") never resembles that average. The ONLY existing
// source of Other candidates was a recency-ordered fallback query, totally
// blind to relevance - those candidates ranked #56/#73 of 78 by score.
//
// Fix: for every category with real earned signal, run its OWN dedicated
// ANN query against that category's own decayed liked-embedding average
// (bounded to <=9 categories, all fired in parallel - no added round-trip
// latency, just more concurrent queries). For scoring, ALSO compute each
// candidate's max cosine similarity against its own category's individual
// liked-article embeddings (not just the per-category average) and take the
// max against the existing global-blend similarity - per-category
// averaging alone was empirically shown to not fully rescue a heterogeneous
// category (live-tested: even a philosophy-only or history-only average
// still scored held-out siblings in the low 50s-to-60s, not because the
// category-average idea is wrong but because the category itself scatters
// too much to average away) - preserving individual-article signal instead
// of compressing it further catches genuine matches that any averaging step
// would wash out. This ADDS to the existing global-vector signal rather
// than replacing it, so categories that already work well (tight clusters
// like AI/SWE) are unaffected - it only helps when the global vector was
// the bottleneck.
const PER_CATEGORY_CANDIDATE_FETCH = 15;
const MAX_LIKED_EMBEDDINGS_PER_CATEGORY = 30; // cap for the in-memory max-similarity scoring pass, biased to most-recent likes

function popularityRaw(score) {
  return Math.log1p(score || 0) / Math.log1p(1000);
}
function popularityWeight(likeWeight) {
  return POPULARITY_WEIGHT_FLOOR + POPULARITY_WEIGHT_COLD_BONUS * (1 - likeWeight);
}
function categoryAffinity(category, catBlend, catSkip) {
  if (!category) return 0;
  const combined = (catBlend.get(category) || 0) + (catSkip.get(category) || 0);
  if (!combined) return 0;
  return Math.sign(combined) * Math.min(Math.abs(combined), 5) * 0.01;
}
function smartOrDiscoveryRecencyPenalty(publishedAt, nowMs) {
  const ageMs = nowMs - new Date(publishedAt).getTime();
  const ageRatio = Math.max(0, Math.min(1, ageMs / SMART_DISCOVERY_MAX_AGE_MS));
  return ageRatio * SMART_DISCOVERY_RECENCY_PENALTY;
}
function popularRecencyPenalty(publishedAt, nowMs) {
  const hoursAgo = (nowMs - new Date(publishedAt).getTime()) / (60 * 60 * 1000);
  const decay = Math.pow(0.5, Math.max(0, hoursAgo) / POPULAR_RECENCY_HALF_LIFE_HOURS);
  return (1 - decay) * POPULAR_RECENCY_PENALTY_CEILING;
}
function blendRetrievalVector(likeWeight, coreVector, onboardingVector) {
  if (!coreVector && !onboardingVector) return null;
  if (!coreVector) return onboardingVector;
  if (!onboardingVector) return coreVector;
  const dim = coreVector.length;
  const blended = new Array(dim);
  for (let i = 0; i < dim; i++) blended[i] = likeWeight * coreVector[i] + (1 - likeWeight) * onboardingVector[i];
  return normalize(blended);
}

// GET /api/feed
router.get('/api/feed', apiActionLimiter, async (req, res) => {
  const userId = req.user.id;
  const excludeIds = (req.query.excludeIds ? String(req.query.excludeIds).split(',') : [])
    .map(Number).filter(n => Number.isFinite(n));

  try {
    pool.query('UPDATE users SET last_active = NOW() WHERE id = $1', [userId]).catch(err => console.error('Failed to update last_active:', err));

    // These three are independent - fire together rather than paying three
    // sequential round-trips. (An earlier version of this handler wrapped
    // the whole request in a transaction with a per-user advisory lock, to
    // guard against a rare, low-consequence race between near-simultaneous
    // requests for the same user - measured live, that cost 2.7-4.8s per
    // request by fully serializing ~9 round-trips onto one connection with
    // zero parallelism, for a self-correcting edge case. Not worth it;
    // reverted to plain pool.query with real parallelism instead.)
    const [userResult, excludeCategoriesResult, likeDislikeResult, skipResult] = await Promise.all([
      pool.query('SELECT taste_vector FROM users WHERE id = $1', [userId]),
      excludeIds.length
        ? pool.query('SELECT category FROM articles WHERE id = ANY($1::int[])', [excludeIds])
        : Promise.resolve({ rows: [] }),
      pool.query(`
        SELECT a.embedding, a.category, us.liked,
               EXTRACT(EPOCH FROM (NOW() - us.swipe_time)) / 3600.0 AS hours_ago
        FROM user_swipes us
        JOIN articles a ON a.id = us.article_id
        WHERE us.user_id = $1 AND a.embedding IS NOT NULL AND us.liked IS NOT NULL
        ORDER BY us.swipe_time DESC
        LIMIT ${LIKE_DISLIKE_HISTORY_LIMIT}
      `, [userId]),
      pool.query(`
        SELECT a.embedding, a.category, us.liked,
               EXTRACT(EPOCH FROM (NOW() - us.swipe_time)) / 3600.0 AS hours_ago
        FROM user_swipes us
        JOIN articles a ON a.id = us.article_id
        WHERE us.user_id = $1 AND a.embedding IS NOT NULL AND us.liked IS NULL
        ORDER BY us.swipe_time DESC
        LIMIT ${SKIP_HISTORY_LIMIT}
      `, [userId]),
    ]);
    const onboardingVector = userResult.rows[0]?.taste_vector ? parseVector(userResult.rows[0].taste_vector) : null;
    // Categories of the client's currently-kept, not-yet-swiped on-screen
    // cards - served but invisible to the swipe log. Needed so the
    // near-duplicate filter, portfolio cap, and run-length cap aren't blind
    // to what the user is about to see next.
    const excludeCategories = excludeCategoriesResult.rows.map(r => r.category).filter(Boolean);
    // The single source of truth for all taste modeling: every real swipe
    // (like/dislike/skip), how long ago it happened, its article's
    // embedding and category. Recomputed fresh every request - no
    // incrementally-maintained state anywhere. Two separate queries (see
    // LIKE_DISLIKE_HISTORY_LIMIT/SKIP_HISTORY_LIMIT above), merged and
    // re-sorted by recency so trailingCategories below still reflects the
    // true chronological order across both.
    const swipeRows = [...likeDislikeResult.rows, ...skipResult.rows]
      .sort((a, b) => parseFloat(a.hours_ago) - parseFloat(b.hours_ago));

    const dim = onboardingVector ? onboardingVector.length : (swipeRows[0] ? parseVector(swipeRows[0].embedding).length : 384);
    const sumCore = new Array(dim).fill(0);
    const sumRecent = new Array(dim).fill(0);
    let recentMass = 0;
    let likeCount = 0;
    const catCore = new Map();
    const catRecent = new Map();
    const catSkip = new Map();
    const catLikeCount = new Map();
    const catLikedEmbeddings = new Map(); // category -> [{vec, wCore, wRecent}], most-recent-first
    const trailingCategories = []; // DESC by recency - index 0 is the most recent real swipe (like/dislike/skip)

    swipeRows.forEach(row => {
      const hoursAgo = parseFloat(row.hours_ago);
      const category = row.category;

      if (row.liked === true) {
        const vec = parseVector(row.embedding);
        const wCore = Math.pow(0.5, hoursAgo / CORE_HALF_LIFE_HOURS);
        const wRecent = Math.pow(0.5, hoursAgo / RECENT_HALF_LIFE_HOURS);
        for (let i = 0; i < dim; i++) {
          sumCore[i] += wCore * vec[i];
          sumRecent[i] += wRecent * vec[i];
        }
        recentMass += wRecent;
        likeCount += 1;
        if (category) {
          catCore.set(category, (catCore.get(category) || 0) + wCore);
          catRecent.set(category, (catRecent.get(category) || 0) + wRecent);
          catLikeCount.set(category, (catLikeCount.get(category) || 0) + 1);
          if (!catLikedEmbeddings.has(category)) catLikedEmbeddings.set(category, []);
          const bucket = catLikedEmbeddings.get(category);
          if (bucket.length < MAX_LIKED_EMBEDDINGS_PER_CATEGORY) bucket.push({ vec, wCore, wRecent });
        }
      } else if (row.liked === false) {
        // Dislikes only ever affect CATEGORY-level signal (catRecent), never
        // the embedding vectors themselves - "a user shouldn't regret a
        // dislike" was originally also implemented at the vector level
        // (mixing a negative contribution into sumRecent), but sumRecent
        // gets normalize()'d, which is scale-invariant and keeps only
        // direction. With little else in the window, that made
        // recentVector become the literal ANTIPODE of the disliked
        // article's embedding - a semantically meaningless direction that
        // then drove a real ANN retrieval query and every candidate's
        // match_pct. recentMass intentionally does NOT count dislike mass
        // either, so recentWeight only reflects how much real (liked)
        // signal actually exists, not dislike volume.
        const wRecent = Math.pow(0.5, hoursAgo / RECENT_HALF_LIFE_HOURS);
        if (category) catRecent.set(category, (catRecent.get(category) || 0) - DISLIKE_DAMPENING * wRecent);
      } else {
        // Skip: never touches the embedding-level vector at all - only a
        // short-lived, category-only nudge.
        if (category) {
          const wSkip = Math.pow(0.5, hoursAgo / SKIP_HALF_LIFE_HOURS);
          catSkip.set(category, (catSkip.get(category) || 0) + SKIP_DAMPENING * wSkip);
        }
      }
      if (category) trailingCategories.push({ category, hoursAgo, liked: row.liked });
    });

    const coreMagnitude = Math.sqrt(sumCore.reduce((s, v) => s + v * v, 0));
    const recentMagnitude = Math.sqrt(sumRecent.reduce((s, v) => s + v * v, 0));
    const coreVector = coreMagnitude > 1e-6 ? normalize(sumCore) : null;
    const recentVector = recentMagnitude > 1e-6 ? normalize(sumRecent) : null;

    const recentWeight = recentMass / (recentMass + RECENT_MASS_PIVOT);

    const catBlend = new Map();
    new Set([...catCore.keys(), ...catRecent.keys()]).forEach(cat => {
      catBlend.set(cat, (1 - recentWeight) * (catCore.get(cat) || 0) + recentWeight * (catRecent.get(cat) || 0));
    });

    const likeWeight = likeCount / (likeCount + TASTE_CONFIDENCE_M);
    // Hoisted from the badge-labeling block further down - now also gates
    // onboarding card-type ordering (see pinnedType in the assembleBatch
    // call below). One hard, literal threshold (LIKES_NEEDED_FOR_MATCHES),
    // deliberately distinct from the continuous likeWeight confidence dial
    // directly above.
    const badgeEligible = likeCount >= LIKES_NEEDED_FOR_MATCHES;
    function categoryLikeWeight(cat) {
      const n = catLikeCount.get(cat) || 0;
      return n / (n + TASTE_CONFIDENCE_M);
    }

    // Confidently-disliked categories - one shared, magnitude-threshold
    // concept, used for both discovery/popular exclusion and the smart-slot
    // portfolio cap (via portfolioCapShareFor returning 0 for these).
    const D = computeConfidentlyDislikedSet(catBlend, CATEGORY_DISLIKE_FLOOR_THRESHOLD);

    // Skip-cooldown: 3+ skips on the same category within the trailing
    // window mutes it from the smart slot. Recomputed fresh from the log
    // every request (no persisted trigger timestamp) - this naturally,
    // self-limitingly ages out as more swipes of any kind push the
    // triggering skips out of the trailing window, approximating "25 cards
    // or 6 hours, whichever first" without needing separate stored state.
    function isCategoryOnSkipCooldown(category) {
      // The trailing window itself is 10 cards, well under the 25-card mute
      // duration, so the "cards" release condition is automatically
      // satisfied whenever the trigger still holds - only the "6 hours"
      // condition needs an explicit check. Once enough new swipes (of any
      // kind) push the triggering skips out of this trailing-10 window, the
      // mute self-releases with no persisted timer needed.
      const win = trailingCategories.slice(0, SKIP_COOLDOWN_WINDOW);
      const skipsInWindow = win.filter(r => r.liked === null && r.category === category);
      if (skipsInWindow.length < SKIP_COOLDOWN_TRIGGER) return false;
      // Anchor the time-based release to the oldest of the actually-
      // triggering skips, not the oldest entry of any kind in the window - an
      // older like/dislike of the same category sharing this trailing
      // window (very plausible: someone with a real, established preference
      // for a category who skips it 3x in a row today) must not falsely
      // expire an otherwise-fresh mute just because that unrelated older
      // swipe happens to be more than 6 hours old.
      const triggeringSkips = skipsInWindow.slice(0, SKIP_COOLDOWN_TRIGGER); // most-recent-first
      const oldestTriggeringSkip = triggeringSkips[triggeringSkips.length - 1];
      return oldestTriggeringSkip.hoursAgo < SKIP_COOLDOWN_HOURS;
    }

    const retrievalVector = blendRetrievalVector(likeWeight, coreVector, onboardingVector);

    // Per-category retrieval vector - same core/recent blend as the global
    // one, computed on-demand from this category's own liked-article
    // embeddings (already collected, capped at
    // MAX_LIKED_EMBEDDINGS_PER_CATEGORY, most-recent-first). See the
    // PER_CATEGORY_CANDIDATE_FETCH comment above for why this exists.
    function computeCategoryVector(category) {
      const entries = catLikedEmbeddings.get(category);
      if (!entries || entries.length === 0) return null;
      const catSum = new Array(dim).fill(0);
      entries.forEach(({ vec, wCore, wRecent }) => {
        const w = (1 - recentWeight) * wCore + recentWeight * wRecent;
        for (let i = 0; i < dim; i++) catSum[i] += w * vec[i];
      });
      const magnitude = Math.sqrt(catSum.reduce((s, v) => s + v * v, 0));
      return magnitude > 1e-6 ? normalize(catSum) : null;
    }

    // Max cosine similarity between a candidate and any INDIVIDUAL liked
    // article in the same category (not an average) - the fix for
    // heterogeneous categories where even a per-category average was
    // live-shown to not reliably surface genuine matches (see comment
    // above). Decay-weighted the same way as everything else (blended
    // core/recent), with a floor so a merely-older-but-still-relevant like
    // can't be fully zeroed out and mask an otherwise excellent match.
    function maxCategorySimilarity(candidateEmbedding, category) {
      const entries = catLikedEmbeddings.get(category);
      if (!entries || entries.length === 0) return 0;
      let max = 0;
      for (const { vec, wCore, wRecent } of entries) {
        const sim = cosineSimilarity(candidateEmbedding, vec);
        const decayWeight = Math.max((1 - recentWeight) * wCore + recentWeight * wRecent, 0.1);
        const weighted = sim * decayWeight;
        if (weighted > max) max = weighted;
      }
      return max;
    }

    // Categories with real earned signal get their own dedicated,
    // relevance-ranked ANN query instead of relying on the single global
    // blend (which structurally favors whichever liked category is
    // larger/tighter) or the recency-only stratified floor (which is blind
    // to relevance entirely).
    const categoriesWithSignal = ALL_CATEGORIES.filter(cat =>
      (catLikeCount.get(cat) || 0) > 0 && !D.has(cat) && !isCategoryOnSkipCooldown(cat));
    const perCategoryVectors = new Map();
    categoriesWithSignal.forEach(cat => {
      const v = computeCategoryVector(cat);
      if (v) perCategoryVectors.set(cat, v);
    });

    // --- Retrieval ---
    // The primary smart query, per-category queries, stratified floor,
    // popular pool, and discovery pool are all independent of each other's
    // row results (the discovery query no longer excludes popular's ids -
    // assembleBatch's shared `usedIds` set already prevents any cross-pool
    // duplicate selection, so that exclusion doesn't need to be a
    // query-level dependency) - fire them all together rather than paying
    // sequential round-trips. The stratified floor now only needs to cover
    // categories WITHOUT real signal (pure exploration/diversity for a
    // category the user hasn't shown any preference on yet) - categories
    // with signal get the dedicated per-category query instead, which is
    // strictly better than a recency-only fallback for them.
    const eligibleForFloor = ALL_CATEGORIES.filter(cat =>
      !D.has(cat) && !isCategoryOnSkipCooldown(cat) && !perCategoryVectors.has(cat));

    const smartPrimaryPromise = retrievalVector
      ? pool.query(`
          SELECT a.id, a.title, a.description, a.article_url, a.image_url, a.source_name, a.published_at,
                 a.score, a.num_comments, a.hn_id, a.embedding, a.read_time_minutes, a.category,
                 (1 - (a.embedding <=> $1))::float AS similarity_raw,
                 reason.title AS match_reason
          FROM articles a
          LEFT JOIN LATERAL (
            SELECT liked_article.title
            FROM user_swipes us
            JOIN articles liked_article ON us.article_id = liked_article.id
            WHERE us.user_id = $2 AND us.liked = true AND liked_article.embedding IS NOT NULL
            ORDER BY liked_article.embedding <=> a.embedding
            LIMIT 1
          ) reason ON true
          WHERE a.embedding IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM user_swipes us2 WHERE us2.user_id = $2 AND us2.article_id = a.id)
            AND NOT (a.id = ANY($4::int[]))
            AND a.published_at::timestamp > NOW() - INTERVAL '90 days'
          ORDER BY a.embedding <=> $1
          LIMIT $3
        `, [`[${retrievalVector.join(',')}]`, userId, CANDIDATE_FETCH, excludeIds])
      : pool.query(`
          SELECT id, title, description, article_url, image_url, source_name, published_at,
                 score, num_comments, hn_id, embedding, read_time_minutes, category,
                 NULL::float AS similarity_raw, NULL::text AS match_reason
          FROM articles
          WHERE embedding IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM user_swipes us2 WHERE us2.user_id = $1 AND us2.article_id = articles.id)
            AND NOT (id = ANY($3::int[]))
          ORDER BY published_at DESC
          LIMIT $2
        `, [userId, CANDIDATE_FETCH, excludeIds]);

    const stratifiedPromise = eligibleForFloor.length
      ? pool.query(`
          SELECT * FROM (
            SELECT id, title, description, article_url, image_url, source_name, published_at,
                   score, num_comments, hn_id, embedding, read_time_minutes, category,
                   NULL::float AS similarity_raw, NULL::text AS match_reason,
                   ROW_NUMBER() OVER (PARTITION BY category ORDER BY published_at DESC) AS rn
            FROM articles
            WHERE embedding IS NOT NULL
              AND category = ANY($1::text[])
              AND NOT EXISTS (SELECT 1 FROM user_swipes us2 WHERE us2.user_id = $2 AND us2.article_id = articles.id)
              AND NOT (id = ANY($3::int[]))
          ) ranked
          WHERE rn <= ${STRATIFIED_FLOOR_PER_CATEGORY}
        `, [eligibleForFloor, userId, excludeIds])
      : Promise.resolve({ rows: [] });

    // One dedicated ANN query per category with real signal (bounded to
    // <=9, the whole taxonomy) - see the PER_CATEGORY_CANDIDATE_FETCH
    // comment above. All fired in parallel alongside everything else.
    const perCategoryPromises = [...perCategoryVectors.entries()].map(([cat, vec]) =>
      pool.query(`
        SELECT id, title, description, article_url, image_url, source_name, published_at,
               score, num_comments, hn_id, embedding, read_time_minutes, category,
               NULL::float AS similarity_raw, NULL::text AS match_reason
        FROM articles
        WHERE embedding IS NOT NULL
          AND category = $2
          AND NOT EXISTS (SELECT 1 FROM user_swipes us2 WHERE us2.user_id = $3 AND us2.article_id = articles.id)
          AND NOT (id = ANY($4::int[]))
          AND published_at::timestamp > NOW() - INTERVAL '90 days'
        ORDER BY embedding <=> $1
        LIMIT $5
      `, [`[${vec.join(',')}]`, cat, userId, excludeIds, PER_CATEGORY_CANDIDATE_FETCH])
    );

    const popularPromise = pool.query(`
      SELECT id, title, description, article_url, image_url, source_name, published_at,
             score, num_comments, hn_id, embedding, read_time_minutes, category,
             NULL::float AS similarity_raw, NULL::text AS match_reason
      FROM articles
      WHERE NOT EXISTS (SELECT 1 FROM user_swipes us2 WHERE us2.user_id = $1 AND us2.article_id = articles.id)
        AND NOT (id = ANY($2::int[]))
        AND embedding IS NOT NULL
        AND published_at::timestamp > NOW() - INTERVAL '7 days'
        AND (category IS NULL OR NOT (category = ANY($3::text[])))
      ORDER BY score DESC, num_comments DESC
      LIMIT ${POPULAR_POOL_FETCH}
    `, [userId, excludeIds, [...D]]);

    const discoveryPromise = pool.query(`
      SELECT id, title, description, article_url, image_url, source_name, published_at,
             score, num_comments, hn_id, embedding, read_time_minutes, category,
             NULL::float AS similarity_raw, NULL::text AS match_reason
      FROM articles
      WHERE NOT EXISTS (SELECT 1 FROM user_swipes us2 WHERE us2.user_id = $1 AND us2.article_id = articles.id)
        AND NOT (id = ANY($2::int[]))
        AND embedding IS NOT NULL
        AND published_at::timestamp > NOW() - INTERVAL '7 days'
        AND (category IS NULL OR NOT (category = ANY($3::text[])))
      ORDER BY RANDOM()
      LIMIT ${DISCOVERY_POOL_FETCH}
    `, [userId, excludeIds, [...D]]);

    const [smartPrimaryResult, stratifiedResult, popularResult, discoveryResult, perCategoryResults] = await Promise.all([
      smartPrimaryPromise, stratifiedPromise, popularPromise, discoveryPromise, Promise.all(perCategoryPromises),
    ]);

    let smartCandidates = smartPrimaryResult.rows;

    // Supplemental ANN pool near the recent-phase vector - kept sequential
    // after the primary query since it needs the primary's ids to exclude
    // (a genuine dependency, unlike the four pools above).
    if (retrievalVector && recentVector && recentWeight > 0.05) {
      const existingIds = smartCandidates.map(r => r.id);
      const { rows: recentRows } = await pool.query(`
        SELECT a.id, a.title, a.description, a.article_url, a.image_url, a.source_name, a.published_at,
               a.score, a.num_comments, a.hn_id, a.embedding, a.read_time_minutes, a.category,
               (1 - (a.embedding <=> $1))::float AS recent_similarity_raw
        FROM articles a
        WHERE a.embedding IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM user_swipes us2 WHERE us2.user_id = $2 AND us2.article_id = a.id)
          AND NOT (a.id = ANY($5::int[]))
          AND a.published_at::timestamp > NOW() - INTERVAL '90 days'
          AND NOT (a.id = ANY($3::int[]))
        ORDER BY a.embedding <=> $1
        LIMIT $4
      `, [`[${recentVector.join(',')}]`, userId, existingIds, RECENT_CANDIDATE_FETCH, excludeIds]);
      smartCandidates = smartCandidates.concat(recentRows);
    }

    // Stratified category floor: for every category not on cooldown or in
    // D, pull at least a couple of recent candidates directly - this is
    // what makes the portfolio/run-length caps below enforceable at all.
    const seenSmartIds = new Set(smartCandidates.map(r => r.id));
    stratifiedResult.rows.forEach(r => { if (!seenSmartIds.has(r.id)) { smartCandidates.push(r); seenSmartIds.add(r.id); } });
    perCategoryResults.forEach(({ rows }) => {
      rows.forEach(r => { if (!seenSmartIds.has(r.id)) { smartCandidates.push(r); seenSmartIds.add(r.id); } });
    });

    const popularCandidates = popularResult.rows;
    const discoveryCandidates = discoveryResult.rows;

    // --- Scoring ---
    const nowMs = Date.now();
    function scoreRows(rows, recencyFn) {
      rows.forEach(r => {
        r.parsed_embedding = typeof r.embedding === 'string' ? JSON.parse(r.embedding) : r.embedding;
        const simCore = r.similarity_raw != null
          ? parseFloat(r.similarity_raw)
          : (retrievalVector ? cosineSimilarity(r.parsed_embedding, retrievalVector) : 0);
        const simRecent = recentVector
          ? (r.recent_similarity_raw != null ? parseFloat(r.recent_similarity_raw) : cosineSimilarity(r.parsed_embedding, recentVector))
          : simCore;
        const simGlobalBlended = (1 - recentWeight) * simCore + recentWeight * simRecent;
        // A candidate that isn't a great match for the user's OVERALL blended
        // taste can still be an excellent match for one specific liked
        // article within its own category (the heterogeneous-category fix -
        // see maxCategorySimilarity above). Take whichever signal is
        // stronger; this is additive and never scores a genuinely-global
        // match any lower than before.
        const simCategory = r.category && perCategoryVectors.has(r.category)
          ? maxCategorySimilarity(r.parsed_embedding, r.category)
          : 0;
        const simBlended = Math.max(simGlobalBlended, simCategory);
        r.similarity_raw = simBlended; // downstream badge logic reads this field unchanged
        r.final_score = (likeWeight * simBlended)
          + categoryAffinity(r.category, catBlend, catSkip)
          + (popularityRaw(r.score) * popularityWeight(likeWeight))
          - recencyFn(r.published_at, nowMs);
      });
      return rows;
    }
    scoreRows(smartCandidates, smartOrDiscoveryRecencyPenalty);
    scoreRows(discoveryCandidates, smartOrDiscoveryRecencyPenalty);
    scoreRows(popularCandidates, popularRecencyPenalty);

    // De-dupe within each pool
    function dedupe(rows) {
      const seen = new Set();
      return rows.filter(r => (seen.has(r.id) ? false : (seen.add(r.id), true)));
    }
    const candidatesByType = {
      smart: dedupe(smartCandidates).sort((a, b) => b.final_score - a.final_score),
      popular: dedupe(popularCandidates).sort((a, b) => b.final_score - a.final_score),
      discovery: dedupe(discoveryCandidates).sort((a, b) => b.final_score - a.final_score),
    };

    // --- Composition ---
    const popularShare = SHARE_BASE + SHARE_SWING * (1 - likeWeight);
    const discoveryShare = SHARE_BASE + SHARE_SWING * (1 - likeWeight);
    const smartShare = 1 - popularShare - discoveryShare;

    function portfolioCapShareFor(category) {
      if (!category || D.has(category)) return 0;
      return PORTFOLIO_CAP_MIN + (PORTFOLIO_CAP_MAX - PORTFOLIO_CAP_MIN) * categoryLikeWeight(category);
    }

    // Real cross-fetch context for the run-length/portfolio-cap window.
    // replaceStale now refetches on nearly every swipe, keeping only the
    // KEEP_TOP=2 on-screen cards - seeding assembleBatch's window with just
    // those 2 loses visibility into what was actually shown moments ago in
    // prior fetches. RUN_LENGTH_CAP=3 > KEEP_TOP=2 means a run could reach 4
    // before the cap ever sees it, and the portfolio cap (window=15) would
    // effectively never see the true trailing history at all, since a fresh
    // fetch happens almost every card. Fold in the real swipe log's trailing
    // categories (oldest-first, skips included - they're shown/served cards
    // too) ahead of the on-screen cards to restore true continuity.
    const priorCategorySequence = trailingCategories
      .slice(0, COMPOSITION_WINDOW)
      .map(r => r.category)
      .reverse()
      .concat(excludeCategories);

    const assembled = assembleBatch({
      candidatesByType,
      targetShares: { smart: smartShare, popular: popularShare, discovery: discoveryShare },
      batchSize: BATCH_SIZE,
      initialCategorySequence: priorCategorySequence,
      portfolioCapShareFn: portfolioCapShareFor,
      runLengthCap: RUN_LENGTH_CAP,
      compositionWindow: COMPOSITION_WINDOW,
      nearTieMargin: NEAR_TIE_MARGIN + COLDSTART_NEAR_TIE_BONUS * (1 - likeWeight),
      isOnCooldown: isCategoryOnSkipCooldown,
      dislikedSet: D,
      categoriesWithSignal: new Set(categoriesWithSignal),
      // Before the user has unlocked matches, force every card to be a
      // "smart"/building-your-taste card (falling back to popular/discovery
      // only if that pool is genuinely exhausted) instead of the normal
      // weighted-random mix - a new user should see an unbroken, purposeful
      // taste-building sequence with visible progress dots, not a confusing
      // early mix of purposeful and random-feeling cards.
      pinnedType: badgeEligible ? null : 'smart',
    });

    // Reverse to match the existing "weakest at index 0 (shown last),
    // strongest at end (shown first)" frontend contract - assembleBatch
    // builds in shown-soonest-first order.
    assembled.reverse();

    // --- Badges and labeling ---
    assembled.forEach(r => {
      if (r.__type === 'smart') {
        if (badgeEligible) {
          const sim = parseFloat(r.similarity_raw);
          let norm = (sim - 0.1) / 0.7;
          norm = Math.max(0, Math.min(1, norm));
          r.match_pct = Math.round(50 + norm * 49);
        } else {
          r.match_pct = null;
          r.taste_progress = Math.min(likeCount, LIKES_NEEDED_FOR_MATCHES);
          r.swipes_until_matches = Math.max(0, LIKES_NEEDED_FOR_MATCHES - likeCount);
        }
      } else if (r.__type === 'popular') {
        r.match_pct = null;
        r.discovery_type = 'popular';
      } else {
        r.match_pct = null;
        r.discovery_type = 'random';
      }
    });

    // Backfill match_reason for badge-eligible cards that didn't come
    // through the primary ANN query (stratified-floor and recent-vector
    // candidates never had the LATERAL "most similar liked article" lookup
    // applied) - "computed after selection, only for cards receiving a real
    // match_pct," regardless of which retrieval pool supplied them. Cheap:
    // scoped to the small handful of ids that actually need it.
    const needsReason = assembled.filter(r => r.match_pct && !r.match_reason).map(r => r.id);
    if (needsReason.length) {
      const { rows: reasonRows } = await pool.query(`
        SELECT a.id, reason.title AS match_reason
        FROM articles a
        LEFT JOIN LATERAL (
          SELECT liked_article.title
          FROM user_swipes us
          JOIN articles liked_article ON us.article_id = liked_article.id
          WHERE us.user_id = $2 AND us.liked = true AND liked_article.embedding IS NOT NULL
          ORDER BY liked_article.embedding <=> a.embedding
          LIMIT 1
        ) reason ON true
        WHERE a.id = ANY($1::int[])
      `, [needsReason, userId]);
      const reasonById = new Map(reasonRows.map(r => [r.id, r.match_reason]));
      assembled.forEach(r => { if (reasonById.has(r.id)) r.match_reason = reasonById.get(r.id); });
    }

    assembled.forEach(r => {
      delete r.embedding;
      delete r.parsed_embedding;
      delete r.recent_similarity_raw;
      delete r.final_score;
      delete r.__type;
      if (!(r.match_pct)) delete r.match_reason;
    });

    res.json(assembled);
  } catch (err) {
    console.error('Error fetching feed:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
