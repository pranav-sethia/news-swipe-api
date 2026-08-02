const express = require('express');
const pool = require('../db');

const router = express.Router();

const parseVector = (v) => typeof v === 'string' ? JSON.parse(v) : v;

function alphaFor(swipeCount) {
  if (swipeCount <= 10) return 0.5;
  if (swipeCount > 50) return 0.05;
  return 0.2;
}

function normalize(vec) {
  let magnitude = Math.sqrt(vec.reduce((sum, val) => sum + val * val, 0));
  if (magnitude === 0) magnitude = 1;
  return vec.map(val => val / magnitude);
}

// POST /api/swipe
router.post('/api/swipe', async (req, res) => {
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
      RETURNING *, (xmax = 0) AS is_inserted
    `;
    const { rows } = await pool.query(query, [userId, articleId, liked]);
    const isInserted = rows[0].is_inserted;
    console.log(`Swipe saved: User ${userId} ${liked === null ? 'skipped neutrally' : (liked ? 'liked' : 'disliked')} Article ${articleId}`);

    // If neutral skip or it was a duplicate swipe, do not alter the taste vector.
    if (liked === null || !isInserted) {
      return res.status(201).json(rows[0]);
    }

    // Update the EMA taste_vector
    const currentData = await pool.query(`
      SELECT u.taste_vector, a.embedding,
             (SELECT COUNT(*) FROM user_swipes WHERE user_id = $1) as total_swipes
      FROM users u
      JOIN articles a ON a.id = $2
      WHERE u.id = $1
    `, [userId, articleId]);

    if (currentData.rows.length > 0) {
      const { taste_vector, embedding, total_swipes } = currentData.rows[0];

      // Safety check: skip taste_vector update if article lacks embedding
      if (!embedding) {
        console.log(`Skipping taste vector update: Article ${articleId} lacks embedding.`);
        return res.status(201).json(rows[0]);
      }

      const articleVec = parseVector(embedding);
      let newVectorStr;

      if (!taste_vector) {
        if (liked) {
          // Initialize taste profile
          newVectorStr = `[${articleVec.join(',')}]`;
        } else {
          // First swipe is negative, can't shift an empty vector.
          return res.status(201).json(rows[0]);
        }
      } else {
        const userVec = parseVector(taste_vector);
        const alpha = alphaFor(parseInt(total_swipes, 10));

        let newVec;
        if (liked) {
          newVec = userVec.map((val, i) => (val * (1 - alpha)) + (articleVec[i] * alpha));
        } else {
          // Negative swipe: Shift away from article gently to not banish topics forever
          const negativeAlpha = alpha * 0.15;
          newVec = userVec.map((val, i) => val - (articleVec[i] * negativeAlpha));
        }
        newVectorStr = `[${normalize(newVec).join(',')}]`;
      }

      await pool.query(`UPDATE users SET taste_vector = $1 WHERE id = $2`, [newVectorStr, userId]);
      console.log(`Updated EMA taste vector for User ${userId}`);
    }

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
router.delete('/api/swipe/:articleId', async (req, res) => {
  const userId = req.user.id;
  const { articleId } = req.params;
  try {
    await pool.query('DELETE FROM user_swipes WHERE user_id = $1 AND article_id = $2', [userId, articleId]);

    // Recalculate taste vector from remaining likes AND dislikes to perfectly reconstruct the ML vector
    const allSwipes = await pool.query(`
      SELECT * FROM (
        SELECT a.embedding, us.liked, us.swipe_time
        FROM user_swipes us
        JOIN articles a ON us.article_id = a.id
        WHERE us.user_id = $1 AND us.liked IS NOT NULL AND a.embedding IS NOT NULL
        ORDER BY us.swipe_time DESC
        LIMIT 100
      ) sub
      ORDER BY sub.swipe_time ASC
    `, [userId]);

    if (allSwipes.rows.length === 0) {
      await pool.query('UPDATE users SET taste_vector = NULL WHERE id = $1', [userId]);
    } else {
      let newVec = null;
      let swipeCount = 0;

      for (let i = 0; i < allSwipes.rows.length; i++) {
        const row = allSwipes.rows[i];
        const articleVec = parseVector(row.embedding);
        const liked = row.liked;

        if (newVec === null) {
          if (liked) {
            newVec = articleVec;
            swipeCount++;
          }
          // If first swipe is negative, we can't initialize the vector, so we skip
          continue;
        }

        swipeCount++;
        const alpha = alphaFor(swipeCount);

        if (liked) {
          newVec = newVec.map((val, idx) => (val * (1 - alpha)) + (articleVec[idx] * alpha));
        } else {
          const negativeAlpha = alpha * 0.15;
          newVec = newVec.map((val, idx) => val - (articleVec[idx] * negativeAlpha));
        }
        newVec = normalize(newVec);
      }

      if (newVec === null) {
         // This happens if all remaining swipes are dislikes and we never got a first like.
         await pool.query('UPDATE users SET taste_vector = NULL WHERE id = $1', [userId]);
      } else {
         const newVectorStr = `[${newVec.join(',')}]`;
         await pool.query('UPDATE users SET taste_vector = $1 WHERE id = $2', [newVectorStr, userId]);
      }
    }

    console.log(`Swipe deleted and vector perfectly rebuilt: User ${userId} un-liked Article ${articleId}`);
    res.status(200).json({ message: 'Swipe removed.' });
  } catch (err) {
    console.error('Error deleting swipe:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/reset
router.post('/api/reset', async (req, res) => {
  const userId = req.user.id;
  try {
    await pool.query('DELETE FROM user_swipes WHERE user_id = $1', [userId]);
    // Reset their average embedding vector too
    await pool.query('UPDATE users SET taste_vector = NULL WHERE id = $1', [userId]);
    console.log(`Swipes and vector reset for User ${userId}`);
    res.status(200).json({ message: 'Swipes reset successfully' });
  } catch (err) {
    console.error('Error resetting swipes:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
