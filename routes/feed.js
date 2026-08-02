const express = require('express');
const pool = require('../db');
const { cosineSimilarity, randomizedInterleave } = require('../utils/matching');

const router = express.Router();

// Score contribution from a user's category affinity (likes minus dislikes for
// that category). Bounded to roughly the same magnitude as the recency
// penalty below, so one signal doesn't dominate the other.
function categoryBonus(category, affinityMap) {
  if (!category) return 0;
  const affinity = affinityMap.get(category);
  if (!affinity) return 0;
  return Math.sign(affinity) * Math.min(Math.abs(affinity), 5) * 0.01;
}

// HN score as a small, log-scaled tie-breaker. Constant normalization (rather
// than the max score in the current candidate batch) keeps the contribution
// stable across requests instead of shifting with whatever happens to be in
// the pool that call.
function scoreBonus(score) {
  return (Math.log1p(score || 0) / Math.log1p(1000)) * 0.05;
}

// GET /api/feed (V10, EMA + Probabilistic Interleave)
router.get('/api/feed', async (req, res) => {
  const userId = req.user.id;
  const SMART_FETCH = 12; // all labelled as MATCH
  const DUMB_FETCH  = 3;  // ~20% serendipity

  try {
    // Update user activity to track inactive accounts
    await pool.query('UPDATE users SET last_active = NOW() WHERE id = $1', [userId]).catch(err => console.error('Failed to update last_active:', err));

    const userResult = await pool.query('SELECT taste_vector FROM users WHERE id = $1', [userId]);
    const tasteVector = userResult.rows[0]?.taste_vector;

    // Per-user category affinity: net likes minus dislikes per category.
    // Reused for the smart feed's ranking bonus and to keep the discovery
    // pool from surfacing categories the user has already told us they dislike.
    const affinityRows = (await pool.query(`
      SELECT a.category,
             COUNT(*) FILTER (WHERE us.liked = true) - COUNT(*) FILTER (WHERE us.liked = false) AS affinity
      FROM user_swipes us
      JOIN articles a ON us.article_id = a.id
      WHERE us.user_id = $1 AND a.category IS NOT NULL
      GROUP BY a.category
    `, [userId])).rows;
    const affinityMap = new Map(affinityRows.map(r => [r.category, parseInt(r.affinity, 10)]));
    const dislikedCategories = affinityRows.filter(r => parseInt(r.affinity, 10) < 0).map(r => r.category);

    let finalFeed = [];

    if (tasteVector) {
      console.log(`[V10] EMA feed for user ${userId}`);

      // 1. Fetch top 40 closest articles to the user's EMA taste vector.
      //    Exclude all previously swiped articles so nothing ever repeats.
      //    Enforce 90-day limit.
      const CANDIDATE_FETCH = 40;
      let smartRows = (await pool.query(`
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
      `, [tasteVector, userId, CANDIDATE_FETCH])).rows;

      // 2. Parse embeddings and blend in recency, category affinity, and HN score
      const nowMs = Date.now();
      const MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;

      smartRows.forEach(r => {
        r.parsed_embedding = typeof r.embedding === 'string' ? JSON.parse(r.embedding) : r.embedding;
        const simRaw = parseFloat(r.similarity_raw);
        const ageMs = nowMs - new Date(r.published_at).getTime();
        const ageRatio = Math.max(0, Math.min(1, ageMs / MAX_AGE_MS));
        // Recency penalty: older articles lose up to 0.15 of similarity score
        r.final_score = simRaw - (ageRatio * 0.15)
          + categoryBonus(r.category, affinityMap)
          + scoreBonus(r.score);
      });

      // Sort by final_score descending
      smartRows.sort((a, b) => b.final_score - a.final_score);

      // 3. Apply MMR (Maximal Marginal Relevance) to select top diverse articles
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

      // 4. Label ALL smart articles with relative match % (72–99%).
      //    Relative scoring means there are ALWAYS badges — no hard threshold that silently drops them.
      if (smartRows.length > 0) {
        smartRows.forEach(r => {
          const sim = parseFloat(r.similarity_raw);
          // Absolute scaling: Map raw cosine similarity (~0.1 to 0.8) to a percentage (50% to 99%)
          let norm = (sim - 0.1) / 0.7;
          norm = Math.max(0, Math.min(1, norm)); // Clamp between 0.0 and 1.0
          r.match_pct = Math.round(50 + norm * 49); // 50% to 99%
          delete r.embedding; // Cleanup before sending to client
          delete r.parsed_embedding;
        });
      }

      // Sort ascending: weakest at index 0 (shown last), strongest at end (shown first).
      smartRows.sort((a, b) => parseFloat(a.similarity_raw) - parseFloat(b.similarity_raw));

      // 5. Serendipity: a few recent random articles the user hasn't seen, excluding
      //    categories they've already told us (via net dislikes) they don't want.
      //    Random discovery shouldn't mean "show them what they just disliked".
      const smartIds = smartRows.map(a => a.id);
      const idBlock  = smartIds.length ? smartIds.join(',') : '0';
      const dumbRows = (await pool.query(`
        SELECT id, title, description, article_url, image_url, source_name, published_at,
               score, num_comments, hn_id, read_time_minutes, NULL::float AS similarity_raw
        FROM articles
        WHERE NOT EXISTS (SELECT 1 FROM user_swipes us2 WHERE us2.user_id = $1 AND us2.article_id = articles.id)
          AND id NOT IN (${idBlock})
          AND embedding IS NOT NULL
          AND published_at::timestamp > NOW() - INTERVAL '7 days'
          AND (category IS NULL OR NOT (category = ANY($2::text[])))
        ORDER BY RANDOM()
        LIMIT ${DUMB_FETCH}
      `, [userId, dislikedCategories])).rows;

      // 6. Probabilistic interleave — no fixed pattern, randomized positions with constraints.
      finalFeed = randomizedInterleave(smartRows, dumbRows);

    } else {
      // New user: no personalization signal yet, so rank by a blend of recency
      // and HN's own score instead of pure recency. Otherwise a just-posted,
      // barely-upvoted story outranks something the community actually liked.
      console.log(`[V10] No taste_vector for user ${userId}, discovery feed`);
      const candidatePool = (await pool.query(`
        SELECT id, title, description, article_url, image_url, source_name, published_at,
               score, num_comments, hn_id, read_time_minutes, NULL::float AS similarity_raw
        FROM articles
        WHERE NOT EXISTS (SELECT 1 FROM user_swipes us2 WHERE us2.user_id = $1 AND us2.article_id = articles.id)
          AND embedding IS NOT NULL
        ORDER BY published_at DESC
        LIMIT 60
      `, [userId])).rows;

      const nowMs = Date.now();
      candidatePool.forEach(r => {
        const ageHours = (nowMs - new Date(r.published_at).getTime()) / (1000 * 60 * 60);
        r.discovery_score = -ageHours / 24 + Math.log1p(r.score || 0) * 2;
      });
      candidatePool.sort((a, b) => a.discovery_score - b.discovery_score);
      // Weakest first (shown last), strongest last (shown first), matching the
      // personalized branch's stacking convention.
      finalFeed = candidatePool.slice(-15).map(({ discovery_score, ...rest }) => rest);
    }

    res.json(finalFeed);

  } catch (err) {
    console.error('Error fetching feed:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
