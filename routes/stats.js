const express = require('express');
const pool = require('../db');

const router = express.Router();

// GET /api/taste-profile
router.get('/api/taste-profile', async (req, res) => {
  const userId = req.user.id;
  try {
    // Tally up the liked categories
    const query = `
      SELECT a.category, COUNT(*) as count
      FROM user_swipes us
      JOIN articles a ON us.article_id = a.id
      WHERE us.user_id = $1 AND us.liked = true AND a.category IS NOT NULL
      GROUP BY a.category
      ORDER BY count DESC
    `;
    const { rows } = await pool.query(query, [userId]);

    // Calculate total to return percentages
    let total = 0;
    rows.forEach(r => total += parseInt(r.count, 10));

    const profile = rows.map(r => ({
      category: r.category,
      count: parseInt(r.count, 10),
      percentage: total > 0 ? Math.round((parseInt(r.count, 10) / total) * 100) : 0
    }));

    res.json({ totalLiked: total, profile });
  } catch (err) {
    console.error('Error fetching taste profile:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/stats
router.get('/api/stats', async (req, res) => {
  const userId = req.user.id;
  console.log(`Fetching stats for user ${userId}`);

  try {
    // Query 1: Get total swipe count
    const totalSwipesQuery = 'SELECT COUNT(*) FROM user_swipes WHERE user_id = $1';
    const totalSwipesResult = await pool.query(totalSwipesQuery, [userId]);
    const totalSwipes = parseInt(totalSwipesResult.rows[0].count, 10);

    // Query 2: Get top 3 liked sources (as our "topics")
    const topTopicsQuery = `
      SELECT a.source_name, COUNT(*) as like_count
      FROM user_swipes us
      JOIN articles a ON us.article_id = a.id
      WHERE us.user_id = $1 AND us.liked = true
      GROUP BY a.source_name
      ORDER BY like_count DESC
      LIMIT 3;
    `;
    const topTopicsResult = await pool.query(topTopicsQuery, [userId]);
    const topTopics = topTopicsResult.rows.map(row => row.source_name);

    res.json({
      totalSwipes: totalSwipes,
      topTopics: topTopics
    });

  } catch (err) {
    console.error(`Error fetching stats for user ${userId}:`, err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/liked-articles
router.get('/api/liked-articles', async (req, res) => {
  const userId = req.user.id;
  console.log(`Fetching liked articles for user ${userId}`);

  try {
    const query = `
      SELECT a.id, a.title, a.article_url, a.source_name, a.image_url, a.category, a.score, a.read_time_minutes, us.swipe_time
      FROM articles a
      JOIN user_swipes us ON a.id = us.article_id
      WHERE us.user_id = $1 AND us.liked = true
      ORDER BY us.swipe_time DESC;
    `;
    const { rows } = await pool.query(query, [userId]);
    res.json(rows);
  } catch (err) {
    console.error(`Error fetching liked articles for user ${userId}:`, err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/me/stats
router.get('/api/me/stats', async (req, res) => {
  const userId = req.user.id;
  try {
    const query = `
      SELECT
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE liked = true) as likes,
        COUNT(*) FILTER (WHERE liked = false) as dislikes,
        COUNT(*) FILTER (WHERE liked IS NULL) as skips
      FROM user_swipes
      WHERE user_id = $1
    `;
    const { rows } = await pool.query(query, [userId]);
    const r = rows[0];

    // Calculate a simple day streak in JS
    const streakQuery = `
      SELECT DISTINCT DATE(swipe_time) as swipe_date
      FROM user_swipes
      WHERE user_id = $1
      ORDER BY swipe_date DESC
      LIMIT 30
    `;
    const streakRows = await pool.query(streakQuery, [userId]);
    let streak = 0;
    if (streakRows.rows.length > 0) {
      let current = new Date();
      current.setHours(0, 0, 0, 0);

      for (let i = 0; i < streakRows.rows.length; i++) {
        const d = new Date(streakRows.rows[i].swipe_date);
        d.setHours(0, 0, 0, 0);
        const diffDays = Math.floor((current - d) / (1000 * 60 * 60 * 24));

        if (i === 0) {
          if (diffDays <= 1) {
            streak = 1;
            current = d;
          } else {
            break;
          }
        } else {
          if (diffDays === 1) {
            streak++;
            current = d;
          } else {
            break;
          }
        }
      }
    }

    res.json({
      total: parseInt(r.total || 0, 10),
      likes: parseInt(r.likes || 0, 10),
      dislikes: parseInt(r.dislikes || 0, 10),
      skips: parseInt(r.skips || 0, 10),
      streak
    });
  } catch (err) {
    console.error('Error fetching detailed stats:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
