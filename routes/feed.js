const express = require('express');
const pool = require('../db');
const { cosineSimilarity, randomizedInterleave, parseVector, normalize } = require('../utils/matching');
const { apiActionLimiter } = require('../middleware/rateLimiters');

const router = express.Router();

const CANDIDATE_FETCH = 40;         // core-vector candidate pool size
const RECENT_CANDIDATE_FETCH = 20;  // extra pool pulled in when the recent-phase vector carries real weight
const SMART_FETCH = 12;             // all labelled as MATCH
const DUMB_FETCH = 3;               // ~20% serendipity, random discovery
const POPULAR_FETCH = 2;            // taste-independent - the biggest HN stories, so a strong match vector never fully buries them
const SWIPE_HISTORY_LIMIT = 300;    // generous cap on how far back to look - at this product's realistic ~20-100-swipe lifetime, this is never actually hit

// One taste model, two speeds, computed fresh from the raw swipe log on every
// request - no incrementally-maintained vector/streak state anywhere. A
// user's "core" identity and their current few-day "phase" aren't different
// KINDS of signal needing different mechanisms - they're the same measurement
// (how much have they liked things like this, weighted by how recently) taken
// at two different half-lives. A half-life in the 48-72h band is simultaneously:
// barely decayed after an hour (full within-session responsiveness), still
// substantial after 3-4 days (a real phase is still felt while it's
// happening), and faded to near-nothing after 1-2 weeks with no reinforcement
// (a phase that ends actually ends) - one continuous curve covers "this
// session" and "this week's phase" together, with nothing to reset or gate.
const CORE_HALF_LIFE_HOURS = 60 * 24;  // 60 days - stable baseline across a realistic whole lifetime on this app
const RECENT_HALF_LIFE_HOURS = 60;     // 2.5 days - same-session AND multi-day-phase, together
const DISLIKE_DAMPENING = 0.15;        // shift away from disliked things gently, don't banish a topic forever
// How much decayed "recent evidence mass" it takes for the recent-phase
// vector to start counting for about half the blend - reuses the exact same
// n/(n+K) shape as TASTE_CONFIDENCE_M below, just applied to decayed mass
// instead of a raw swipe count, so a couple of recent likes already produce a
// real, felt pull with no hard streak gate standing in the way.
const RECENT_MASS_PIVOT = 3;

// Cold-start confidence ramp (IMDb-style Bayesian weighting: weight =
// n/(n+m)). Every user is scored by the same formula - how much the
// swipe-derived similarity term counts grows smoothly from ~0 to ~1 as real
// swipes accumulate, with no threshold anywhere for a feed to visibly "flip."
const TASTE_CONFIDENCE_M = 8;

// HN score as a small, log-scaled tie-breaker. Constant normalization (rather
// than the max score in the current candidate batch) keeps the contribution
// stable across requests instead of shifting with whatever happens to be in
// the pool that call.
function scoreBonus(score) {
  return (Math.log1p(score || 0) / Math.log1p(1000)) * 0.05;
}

// Score contribution from a user's category affinity, blended the same way
// (core vs. recent-phase) as the embedding similarity below. Bounded to
// roughly the same magnitude as the recency penalty, so no one signal
// dominates.
function categoryBonusFrom(affinity) {
  if (!affinity) return 0;
  return Math.sign(affinity) * Math.min(Math.abs(affinity), 5) * 0.01;
}

// GET /api/feed
router.get('/api/feed', apiActionLimiter, async (req, res) => {
  const userId = req.user.id;

  try {
    // Update user activity to track inactive accounts
    await pool.query('UPDATE users SET last_active = NOW() WHERE id = $1', [userId]).catch(err => console.error('Failed to update last_active:', err));

    const userResult = await pool.query('SELECT taste_vector FROM users WHERE id = $1', [userId]);
    const onboardingVector = userResult.rows[0]?.taste_vector ? parseVector(userResult.rows[0].taste_vector) : null;

    // The single source of truth for all taste modeling: every real swipe
    // (like/dislike), how long ago it happened, its article's embedding and
    // category. Everything below - the core vector, the recent-phase vector,
    // category affinity, and the confidence ramp - is derived from these rows
    // alone, recomputed fresh every request.
    const swipeRows = (await pool.query(`
      SELECT a.embedding, a.category, us.liked,
             EXTRACT(EPOCH FROM (NOW() - us.swipe_time)) / 3600.0 AS hours_ago
      FROM user_swipes us
      JOIN articles a ON a.id = us.article_id
      WHERE us.user_id = $1 AND us.liked IS NOT NULL AND a.embedding IS NOT NULL
      ORDER BY us.swipe_time DESC
      LIMIT ${SWIPE_HISTORY_LIMIT}
    `, [userId])).rows;

    const totalRealSwipes = swipeRows.length;
    const tasteWeight = totalRealSwipes / (totalRealSwipes + TASTE_CONFIDENCE_M);

    const dim = onboardingVector ? onboardingVector.length : (swipeRows[0] ? parseVector(swipeRows[0].embedding).length : 384);
    const sumCore = new Array(dim).fill(0);
    const sumRecent = new Array(dim).fill(0);
    let recentMass = 0;
    const catCore = new Map();   // category -> decayed net affinity, core half-life
    const catRecent = new Map(); // category -> decayed net affinity, recent half-life

    swipeRows.forEach(row => {
      const vec = parseVector(row.embedding);
      const hoursAgo = parseFloat(row.hours_ago);
      const wCore = Math.pow(0.5, hoursAgo / CORE_HALF_LIFE_HOURS);
      const wRecent = Math.pow(0.5, hoursAgo / RECENT_HALF_LIFE_HOURS);
      const sign = row.liked ? 1 : -DISLIKE_DAMPENING;

      for (let i = 0; i < dim; i++) {
        sumCore[i] += sign * wCore * vec[i];
        sumRecent[i] += sign * wRecent * vec[i];
      }
      recentMass += wRecent;

      if (row.category) {
        catCore.set(row.category, (catCore.get(row.category) || 0) + sign * wCore);
        catRecent.set(row.category, (catRecent.get(row.category) || 0) + sign * wRecent);
      }
    });

    // A near-zero magnitude means no meaningful signal yet (e.g. only
    // dislikes so far, or no swipes at all) - treat as absent rather than
    // normalizing noise into a meaningless direction.
    const coreMagnitude = Math.sqrt(sumCore.reduce((s, v) => s + v * v, 0));
    const recentMagnitude = Math.sqrt(sumRecent.reduce((s, v) => s + v * v, 0));
    const coreVector = coreMagnitude > 1e-6 ? normalize(sumCore) : null;
    const recentVector = recentMagnitude > 1e-6 ? normalize(sumRecent) : null;

    // How much the recent-phase vector counts, relative to the core one -
    // asymptotic (never fully overrides core identity), driven by decayed
    // evidence mass rather than a discrete streak, so it grows the moment
    // real recent signal exists instead of waiting for a hard gate to clear.
    const recentWeight = recentMass / (recentMass + RECENT_MASS_PIVOT);

    const catBlend = new Map();
    const allCategories = new Set([...catCore.keys(), ...catRecent.keys()]);
    allCategories.forEach(cat => {
      const blended = (1 - recentWeight) * (catCore.get(cat) || 0) + recentWeight * (catRecent.get(cat) || 0);
      catBlend.set(cat, blended);
    });
    const dislikedCategories = [...catBlend.entries()].filter(([, v]) => v < 0).map(([cat]) => cat);

    // Retrieval vector: whichever best represents established taste. Every
    // user has a real onboardingVector from the moment they finish onboarding
    // (see routes/onboarding.js), so coreVector is almost always what's used
    // here; the fallback below only matters for an account that skipped
    // onboarding AND hasn't swiped yet - and even then tasteWeight is ~0, so
    // scoring already contributes nothing from similarity regardless of
    // which branch supplied the candidates.
    const retrievalVector = coreVector || onboardingVector;

    let smartRows;
    if (retrievalVector) {
      smartRows = (await pool.query(`
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
          AND a.published_at::timestamp > NOW() - INTERVAL '90 days'
        ORDER BY a.embedding <=> $1
        LIMIT $3
      `, [`[${retrievalVector.join(',')}]`, userId, CANDIDATE_FETCH])).rows;

      // When the recent-phase vector currently carries real weight, also pull
      // candidates near IT - a genuine pivot can be cosine-far from the core
      // vector and would otherwise never enter the pool for a score bonus to
      // rescue afterward.
      if (recentVector && recentWeight > 0.05) {
        const existingIds = smartRows.map(r => r.id);
        const recentRows = (await pool.query(`
          SELECT a.id, a.title, a.description, a.article_url, a.image_url, a.source_name, a.published_at,
                 a.score, a.num_comments, a.hn_id, a.embedding, a.read_time_minutes, a.category,
                 (1 - (a.embedding <=> $1))::float AS recent_similarity_raw
          FROM articles a
          WHERE a.embedding IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM user_swipes us2 WHERE us2.user_id = $2 AND us2.article_id = a.id)
            AND a.published_at::timestamp > NOW() - INTERVAL '90 days'
            AND NOT (a.id = ANY($3::int[]))
          ORDER BY a.embedding <=> $1
          LIMIT $4
        `, [`[${recentVector.join(',')}]`, userId, existingIds, RECENT_CANDIDATE_FETCH])).rows;
        smartRows = smartRows.concat(recentRows);
      }
    } else {
      smartRows = (await pool.query(`
        SELECT id, title, description, article_url, image_url, source_name, published_at,
               score, num_comments, hn_id, embedding, read_time_minutes, category,
               NULL::float AS similarity_raw, NULL::text AS match_reason
        FROM articles
        WHERE embedding IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM user_swipes us2 WHERE us2.user_id = $1 AND us2.article_id = articles.id)
        ORDER BY published_at DESC
        LIMIT $2
      `, [userId, CANDIDATE_FETCH])).rows;
    }

    // Parse embeddings once; compute whichever similarity value wasn't
    // already supplied by SQL, then blend the two similarity SCORES - not
    // the vectors themselves. Averaging two vectors that point in genuinely
    // different directions (exactly the case being designed for - a real
    // topic pivot) can produce something dissimilar to both.
    const nowMs = Date.now();
    const MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;

    smartRows.forEach(r => {
      r.parsed_embedding = typeof r.embedding === 'string' ? JSON.parse(r.embedding) : r.embedding;

      const simCore = r.similarity_raw != null
        ? parseFloat(r.similarity_raw)
        : (retrievalVector ? cosineSimilarity(r.parsed_embedding, retrievalVector) : 0);
      const simRecent = recentVector
        ? (r.recent_similarity_raw != null
            ? parseFloat(r.recent_similarity_raw)
            : cosineSimilarity(r.parsed_embedding, recentVector))
        : simCore; // no-op when there's no recent-phase signal yet

      const simBlended = (1 - recentWeight) * simCore + recentWeight * simRecent;
      r.similarity_raw = simBlended; // downstream badge/sort logic reads this field unchanged

      const ageMs = nowMs - new Date(r.published_at).getTime();
      const ageRatio = Math.max(0, Math.min(1, ageMs / MAX_AGE_MS));
      // Recency penalty: older articles lose up to 0.15 of similarity score
      r.final_score = (tasteWeight * simBlended) - (ageRatio * 0.15)
        + categoryBonusFrom(catBlend.get(r.category))
        + scoreBonus(r.score);
    });

    // De-dupe (the recent-phase fetch above already excludes ids already in
    // the core set, but a candidate could otherwise appear via both if that
    // filter were ever loosened - cheap safety net either way).
    const seenIds = new Set();
    smartRows = smartRows.filter(r => (seenIds.has(r.id) ? false : (seenIds.add(r.id), true)));

    // Sort by final_score descending
    smartRows.sort((a, b) => b.final_score - a.final_score);

    // Apply MMR (Maximal Marginal Relevance) to select top diverse articles
    const selectedSmart = [];
    for (const candidate of smartRows) {
      if (selectedSmart.length >= SMART_FETCH) break;

      let maxSimilarityToSelected = -1;
      for (const selected of selectedSmart) {
        const sim = cosineSimilarity(candidate.parsed_embedding, selected.parsed_embedding);
        if (sim > maxSimilarityToSelected) maxSimilarityToSelected = sim;
      }

      // Diversity penalty: if it's too similar (> 0.90) to something already selected, skip it
      if (maxSimilarityToSelected > 0.90) {
         continue;
      }
      selectedSmart.push(candidate);
    }

    // If we filtered out too many, backfill with whatever we had to ensure we hit SMART_FETCH
    if (selectedSmart.length < SMART_FETCH) {
      for (const candidate of smartRows) {
        if (selectedSmart.length >= SMART_FETCH) break;
        if (!selectedSmart.find(s => s.id === candidate.id)) {
          selectedSmart.push(candidate);
        }
      }
    }

    smartRows = selectedSmart;

    // Label ALL smart articles with relative match % (50-99%). This is
    // always a RELATIVE ranking display (how this card compares to the rest
    // of the candidate pool), never a calibrated confidence score, so it
    // isn't tapered down for a low-data new account - a card here is,
    // relatively speaking, genuinely one of this pool's best matches
    // regardless of how much history informed the pool.
    if (smartRows.length > 0) {
      smartRows.forEach(r => {
        const sim = parseFloat(r.similarity_raw);
        // Absolute scaling: Map raw cosine similarity (~0.1 to 0.8) to a percentage (50% to 99%)
        let norm = (sim - 0.1) / 0.7;
        norm = Math.max(0, Math.min(1, norm)); // Clamp between 0.0 and 1.0
        r.match_pct = Math.round(50 + norm * 49); // 50% to 99%
        delete r.embedding; // Cleanup before sending to client
        delete r.parsed_embedding;
        delete r.recent_similarity_raw;
      });
    }

    // Sort ascending: weakest at index 0 (shown last), strongest at end (shown first).
    smartRows.sort((a, b) => parseFloat(a.similarity_raw) - parseFloat(b.similarity_raw));

    // Serendipity: a few recent random articles the user hasn't seen, excluding
    // categories they've already told us (via net dislikes) they don't want.
    // Random discovery shouldn't mean "show them what they just disliked".
    const smartIds = smartRows.map(a => a.id);
    const dumbRows = (await pool.query(`
      SELECT id, title, description, article_url, image_url, source_name, published_at,
             score, num_comments, hn_id, read_time_minutes, NULL::float AS similarity_raw
      FROM articles
      WHERE NOT EXISTS (SELECT 1 FROM user_swipes us2 WHERE us2.user_id = $1 AND us2.article_id = articles.id)
        AND NOT (id = ANY($2::int[]))
        AND embedding IS NOT NULL
        AND published_at::timestamp > NOW() - INTERVAL '7 days'
        AND (category IS NULL OR NOT (category = ANY($3::text[])))
      ORDER BY RANDOM()
      LIMIT ${DUMB_FETCH}
    `, [userId, smartIds, dislikedCategories])).rows;
    dumbRows.forEach(r => { r.discovery_type = 'random'; });

    // Popular: the biggest HN stories by real engagement, regardless of taste
    // match - so a strong match vector never fully buries a story everyone's
    // talking about just because it isn't this user's usual topic.
    const excludedIds = [...smartIds, ...dumbRows.map(r => r.id)];
    const popularRows = (await pool.query(`
      SELECT id, title, description, article_url, image_url, source_name, published_at,
             score, num_comments, hn_id, read_time_minutes, NULL::float AS similarity_raw
      FROM articles
      WHERE NOT EXISTS (SELECT 1 FROM user_swipes us2 WHERE us2.user_id = $1 AND us2.article_id = articles.id)
        AND NOT (id = ANY($2::int[]))
        AND embedding IS NOT NULL
        AND published_at::timestamp > NOW() - INTERVAL '7 days'
        AND (category IS NULL OR NOT (category = ANY($3::text[])))
      ORDER BY score DESC, num_comments DESC
      LIMIT ${POPULAR_FETCH}
    `, [userId, excludedIds, dislikedCategories])).rows;
    popularRows.forEach(r => { r.discovery_type = 'popular'; });

    // Probabilistic interleave, no fixed pattern, randomized positions with constraints.
    const finalFeed = randomizedInterleave(smartRows, [...dumbRows, ...popularRows]);

    res.json(finalFeed);

  } catch (err) {
    console.error('Error fetching feed:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
