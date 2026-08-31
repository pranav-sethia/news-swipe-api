const express = require('express');
const pool = require('../db');
const { apiActionLimiter } = require('../middleware/rateLimiters');

const router = express.Router();

// This route is now pure log-writing - it just records what happened. All
// taste modeling (long-term core, recent-phase responsiveness, category
// affinity) is computed fresh from this log at read time in feed.js, using
// two time-decay half-lives rather than any incrementally-maintained
// EMA/session state. That's what makes an unlike (below) trivially correct
// with no replay/reconstruction step: there's nothing cached to keep in
// sync with the log, because nothing is cached at all.

// POST /api/swipe
router.post('/api/swipe', apiActionLimiter, async (req, res) => {
  const userId = req.user.id;
  const { articleId, liked } = req.body;
  if (!articleId || liked === undefined) {
    return res.status(400).json({ error: 'Missing articleId or liked status' });
  }
  try {
    const query = `
      INSERT INTO user_swipes (user_id, article_id, liked)
      VALUES ($1, $2, $3)
      ON CONFLICT (user_id, article_id) DO UPDATE SET liked = $3, swipe_time = NOW()
      RETURNING *
    `;
    const { rows } = await pool.query(query, [userId, articleId, liked]);
    console.log(`Swipe saved: User ${userId} ${liked === null ? 'skipped neutrally' : (liked ? 'liked' : 'disliked')} Article ${articleId}`);
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23503') {
      console.log(`Article ${articleId} no longer exists. Dropping swipe silently.`);
      return res.status(200).json({ message: 'Article deleted, swipe ignored.' });
    }
    console.error('Error saving swipe:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/swipe/:articleId, unlike/remove a swipe
router.delete('/api/swipe/:articleId', apiActionLimiter, async (req, res) => {
  const userId = req.user.id;
  const { articleId } = req.params;
  try {
    await pool.query('DELETE FROM user_swipes WHERE user_id = $1 AND article_id = $2', [userId, articleId]);
    console.log(`Swipe deleted: User ${userId} un-liked Article ${articleId}`);
    res.status(200).json({ message: 'Swipe removed.' });
  } catch (err) {
    console.error('Error deleting swipe:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/reset - clears swipe history only. The onboarding-seeded
// taste_vector (see routes/onboarding.js) deliberately isn't touched here:
// it reflects the categories the user explicitly chose, not anything
// derived from swipes, so a "reset my taste profile" action forgets learned
// behavior without also discarding a stated preference.
//
// matches_unlocked_at DOES get cleared here, unlike the DELETE route above -
// this is the one place a user is explicitly asking to start over, as
// opposed to a surgical undo/unlike of one swipe, so re-earning the
// milestone here is the correct behavior rather than a bug.
router.post('/api/reset', apiActionLimiter, async (req, res) => {
  const userId = req.user.id;
  try {
    await pool.query('DELETE FROM user_swipes WHERE user_id = $1', [userId]);
    // Tolerates the column not existing yet (see the matching comment in
    // feed.js) - a reset should never fail just because this migration
    // hasn't landed.
    await pool.query('UPDATE users SET matches_unlocked_at = NULL WHERE id = $1', [userId])
      .catch(err => { if (err.code !== '42703') throw err; });
    console.log(`Swipes reset for User ${userId}`);
    res.status(200).json({ message: 'Swipes reset successfully' });
  } catch (err) {
    console.error('Error resetting swipes:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
