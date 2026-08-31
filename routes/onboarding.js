const express = require('express');
const pool = require('../db');
const { apiActionLimiter } = require('../middleware/rateLimiters');
const { normalize } = require('../utils/matching');

const router = express.Router();

const ALLOWED_CATEGORIES = [
  'Software Engineering', 'Hardware & Systems', 'Artificial Intelligence',
  'Startups & VC', 'Cybersecurity', 'Business & Finance', 'Science & Space',
  'Design & UI/UX', 'Other',
];

// POST /api/onboarding, save a new user's picked topics, used to bias their
// cold-start feed before they have any swipe history.
//
// Also seeds a real (if rough) taste_vector immediately, averaging recent
// articles' embeddings in the chosen categories - so feed.js never has to
// treat "no taste_vector yet" as a special case with its own scoring
// formula. This is deliberately a live average over recent articles rather
// than a cached centroid table: it's a once-per-signup query, not a hot
// path, and always reflects the current article pool.
router.post('/api/onboarding', apiActionLimiter, async (req, res) => {
  const userId = req.user.id;
  const categories = Array.isArray(req.body.categories)
    ? req.body.categories.filter((c) => ALLOWED_CATEGORIES.includes(c))
    : [];

  try {
    await pool.query('UPDATE users SET onboarding_categories = $1 WHERE id = $2', [categories, userId]);

    if (categories.length > 0) {
      // Average PER CATEGORY first, then average those category centroids
      // together with equal weight - NOT a single flat average over a
      // combined, recency-ordered pool. A flat average over all chosen
      // categories at once reintroduces the exact bias already fixed
      // elsewhere in this codebase for the swipe-derived taste vector (see
      // utils/matching.js's per-category retrieval comment): whichever
      // category publishes more frequently in the trailing article stream
      // would dominate the pool (and therefore the average), even though
      // the user picked every category with equal intent. Averaging each
      // category on its own first, then averaging those equally-weighted
      // centroids, makes every chosen category count the same regardless of
      // how often it happens to publish.
      const categoryVectors = await Promise.all(categories.map(async (cat) => {
        const { rows } = await pool.query(`
          SELECT embedding FROM articles
          WHERE category = $1 AND embedding IS NOT NULL
          ORDER BY published_at DESC
          LIMIT 100
        `, [cat]);
        if (rows.length === 0) return null;
        const vectors = rows.map((r) => (typeof r.embedding === 'string' ? JSON.parse(r.embedding) : r.embedding));
        const dim = vectors[0].length;
        const sum = new Array(dim).fill(0);
        for (const vec of vectors) {
          for (let i = 0; i < dim; i++) sum[i] += vec[i];
        }
        return sum.map((v) => v / vectors.length);
      }));

      const validCategoryVectors = categoryVectors.filter(Boolean);
      if (validCategoryVectors.length > 0) {
        const dim = validCategoryVectors[0].length;
        const sum = new Array(dim).fill(0);
        for (const vec of validCategoryVectors) {
          for (let i = 0; i < dim; i++) sum[i] += vec[i];
        }
        const seeded = normalize(sum.map((v) => v / validCategoryVectors.length));

        // Only seed if there's no real taste_vector yet - never clobber
        // genuine swipe-derived taste (e.g. re-submitting onboarding, or a
        // guest who already swiped before finishing this step).
        await pool.query(
          'UPDATE users SET taste_vector = $1 WHERE id = $2 AND taste_vector IS NULL',
          [`[${seeded.join(',')}]`, userId]
        );
      }
    }

    res.status(200).json({ categories });
  } catch (err) {
    console.error('Error saving onboarding categories:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
