require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const authMiddleware = require('./authMiddleware');
const { OAuth2Client } = require('google-auth-library');

const app = express();
const port = process.env.PORT || 4000;

// --- Database Connection Setup ---
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false,
  },
});

// --- Middleware ---
const allowedOrigin = process.env.FRONTEND_URL;
app.use(cors({ origin: allowedOrigin }));
app.use(express.json());


// --- HELPER FUNCTION: Shuffle an array ---
function shuffleArray(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

// --- AUTH ENDPOINTS (Public) ---
app.post('/auth/register', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required.' });
  }
  try {
    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);
    const query = 'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id, email';
    const { rows } = await pool.query(query, [email, passwordHash]);
    console.log(`New user registered: ${email}`);
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(400).json({ error: 'Email already in use.' });
    }
    console.error('Error during registration:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/auth/login', async (req, res) => {
  console.log('Login attempt with body:', req.body);
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required.' });
  }
  try {
    const query = 'SELECT * FROM users WHERE email = $1';
    const { rows } = await pool.query(query, [email]);
    const user = rows[0];
    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials.' });
    }
    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) {
      return res.status(401).json({ error: 'Invalid credentials.' });
    }
    const payload = { user: { id: user.id, email: user.email } };
    jwt.sign(
      payload,
      process.env.JWT_SECRET,
      { expiresIn: '7d' },
      (err, token) => {
        if (err) throw err;
        res.json({ token });
      }
    );
  } catch (err) {
    console.error('Error during login:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /auth/guest — returns a token for the shared guest account
app.post('/auth/guest', async (req, res) => {
  const GUEST_EMAIL = 'guest@hackerswipe.io';
  const GUEST_PASSWORD = process.env.GUEST_PASSWORD || 'guestpass_hackerswipe_2025';
  try {
    // Ensure guest account exists
    const existing = await pool.query('SELECT * FROM users WHERE email = $1', [GUEST_EMAIL]);
    let user = existing.rows[0];
    if (!user) {
      const salt = await bcrypt.genSalt(10);
      const hash = await bcrypt.hash(GUEST_PASSWORD, salt);
      const { rows } = await pool.query(
        'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING *',
        [GUEST_EMAIL, hash]
      );
      user = rows[0];
      console.log('✅ Guest account created.');
    }
    const payload = { user: { id: user.id, email: user.email, isGuest: true } };
    jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '24h' }, (err, token) => {
      if (err) throw err;
      res.json({ token });
    });
  } catch (err) {
    console.error('Error creating guest session:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/auth/google — verifies Google token and issues app JWT
app.post('/api/auth/google', async (req, res) => {
  const { credential } = req.body;
  if (!credential) return res.status(400).json({ error: 'Missing credential' });

  const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);
  try {
    const ticket = await client.verifyIdToken({
      idToken: credential,
      audience: process.env.GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload();
    const email = payload.email;
    if (!email) throw new Error('No email found in Google token');

    // Check if user exists
    let { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    let user = rows[0];

    // If no user, create one securely with a random unguessable password hash
    if (!user) {
      const dummyPassword = 'GOOGLE_SSO_' + Array.from({length: 32}, () => Math.random().toString(36).charAt(2)).join('');
      const salt = await bcrypt.genSalt(10);
      const hash = await bcrypt.hash(dummyPassword, salt);
      const inserted = await pool.query(
        'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING *',
        [email, hash]
      );
      user = inserted.rows[0];
      console.log(`✅ Google SSO account created for ${email}`);
    }

    // Issue standard JWT
    const jwtPayload = { user: { id: user.id, email: user.email } };
    jwt.sign(jwtPayload, process.env.JWT_SECRET, { expiresIn: '7d' }, (err, token) => {
      if (err) throw err;
      res.json({ token, user: { id: user.id, email: user.email } });
    });
  } catch (err) {
    console.error('Google Auth verification failed:', err);
    res.status(401).json({ error: 'Invalid Google Token' });
  }
});

// --- APP ENDPOINTS (Protected) ---
app.use('/api', authMiddleware);

// GET /api/feed (The "V5 SMART k-NN Blend" Endpoint)
app.get('/api/feed', async (req, res) => {
  const userId = req.user.id;
  // Evaluate the user's latest 5 distinct liked articles
  const LIKES_TO_EVALUATE = 5;
  const SMART_FEED_SIZE = 7;
  const DUMB_FEED_SIZE = 3;

  try {
    // Check if user has ANY likes to activate the Recommendation Engine
    const likeCheck = await pool.query('SELECT 1 FROM user_swipes WHERE user_id = $1 AND liked = true LIMIT 1', [userId]);

    let finalFeed = [];

    if (likeCheck.rows.length > 0) {
      console.log(`Using MULTI-MODAL k-NN feed for user ${userId}`);
      
      // 1. Get 7 SMART articles using a k-Nearest Neighbors projection against ANY of the recent 5 likes
      const smartQuery = `
        SELECT a.id, a.title, a.description, a.article_url, a.image_url, a.source_name, a.published_at, a.score, a.num_comments, a.hn_id,
          (
            SELECT MAX(1 - (a.embedding <=> liked_a.embedding))
            FROM (
              SELECT article_id 
              FROM user_swipes 
              WHERE user_id = $1 AND liked = true 
              ORDER BY swipe_time DESC 
              LIMIT $2
            ) recent_likes
            JOIN articles liked_a ON recent_likes.article_id = liked_a.id
          ) as similarity
        FROM articles a
        WHERE a.id NOT IN (SELECT article_id FROM user_swipes WHERE user_id = $1)
        ORDER BY similarity DESC NULLS LAST
        LIMIT $3;
      `;
      const smartRows = (await pool.query(smartQuery, [userId, LIKES_TO_EVALUATE, SMART_FEED_SIZE])).rows;
      
      // Normalize similarity scores to a human-friendly 70-99% range using min-max scaling
      const rawScores = smartRows.map(r => parseFloat(r.similarity)).filter(s => !isNaN(s));
      const minS = Math.min(...rawScores);
      const maxS = Math.max(...rawScores);
      const range = maxS - minS || 1; // avoid div by 0
      smartRows.forEach(r => {
        if (r.similarity != null) {
          const normalized = (parseFloat(r.similarity) - minS) / range; // 0..1
          r.match_pct = Math.round(70 + normalized * 29); // scale to 70-99
        }
      });
      
      finalFeed.push(...smartRows);

      // 2. Get 3 DUMB articles for exploration
      const smartArticleIds = smartRows.map(a => a.id);
      const idPlaceholders = smartArticleIds.length > 0 ? smartArticleIds.join(',') : '0';

      const dumbQuery = `
        SELECT id, title, description, article_url, image_url, source_name, published_at, score, num_comments, hn_id, NULL as similarity 
        FROM articles
        WHERE id NOT IN (SELECT article_id FROM user_swipes WHERE user_id = $1)
        AND id NOT IN (${idPlaceholders})
        ORDER BY RANDOM()
        LIMIT ${DUMB_FEED_SIZE};
      `;
      const dumbRows = (await pool.query(dumbQuery, [userId])).rows;
      finalFeed.push(...dumbRows);

      // 3. Shuffle the 7+3 feed so the dumb articles are mixed in
      finalFeed = shuffleArray(finalFeed);

    } else {
      // --- 100% "DUMB" FEED (New User) ---
      console.log(`User ${userId} has no likes. Using DUMB feed (random articles)`);
      const dumbQuery = `
        SELECT id, title, description, article_url, image_url, source_name, published_at, score, num_comments, hn_id, NULL as similarity 
        FROM articles
        WHERE id NOT IN (SELECT article_id FROM user_swipes WHERE user_id = $1)
        ORDER BY RANDOM()
        LIMIT 10;
      `;
      finalFeed = (await pool.query(dumbQuery, [userId])).rows;
    }

    res.json(finalFeed);

  } catch (err) {
    console.error('Error fetching feed:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/swipe
app.post('/api/swipe', async (req, res) => {
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
    console.log(`Swipe saved: User ${userId} ${liked ? 'liked' : 'disliked'} Article ${articleId}`);
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('Error saving swipe:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/swipe/:articleId — unlike/remove a swipe
app.delete('/api/swipe/:articleId', async (req, res) => {
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

// POST /api/reset
app.post('/api/reset', async (req, res) => {
  const userId = req.user.id; 
  try {
    await pool.query('DELETE FROM user_swipes WHERE user_id = $1', [userId]);
    console.log(`Swipes reset for User ${userId}`);
    res.status(200).json({ message: 'Swipes reset successfully' });
  } catch (err) {
    console.error('Error resetting swipes:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/stats
app.get('/api/stats', async (req, res) => {
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
app.get('/api/liked-articles', async (req, res) => {
  const userId = req.user.id;
  console.log(`Fetching liked articles for user ${userId}`);

  try {
    const query = `
      SELECT a.id, a.title, a.article_url, a.source_name
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


// --- Start Server ---
const startServer = async () => {
  try {
    const client = await pool.connect();
    const now = await client.query('SELECT NOW()');
    console.log(`✅ Database connected successfully at: ${now.rows[0].now}`);
    client.release();

    app.listen(port, () => {
      console.log(`Server running on port ${port}`);
    });

  } catch (err) {
    console.error('❌ Error connecting to the database', err);
    process.exit(1); 
  }
};

startServer();