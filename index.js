require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const authMiddleware = require('./authMiddleware');

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


// --- HELPER FUNCTION: Compute Rocchio Vector (Information Retrieval) ---
function computeRocchioVector(likedStrings, dislikedStrings, alpha = 1.0, beta = 0.5) {
  if (likedStrings.length === 0) return null;
  const vectorLength = JSON.parse(likedStrings[0]).length; // 384 for all-MiniLM-L6-v2
  const result = new Array(vectorLength).fill(0);

  // Positive feedback routing
  if (likedStrings.length > 0) {
    const avgLiked = new Array(vectorLength).fill(0);
    likedStrings.forEach(str => {
      const v = JSON.parse(str);
      for(let i=0; i<vectorLength; i++) avgLiked[i] += v[i];
    });
    for(let i=0; i<vectorLength; i++) result[i] += alpha * (avgLiked[i] / likedStrings.length);
  }

  // Negative feedback routing
  if (dislikedStrings.length > 0) {
    const avgDisliked = new Array(vectorLength).fill(0);
    dislikedStrings.forEach(str => {
      const v = JSON.parse(str);
      for(let i=0; i<vectorLength; i++) avgDisliked[i] += v[i];
    });
    for(let i=0; i<vectorLength; i++) result[i] -= beta * (avgDisliked[i] / dislikedStrings.length);
  }

  return JSON.stringify(result);
}

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

// --- APP ENDPOINTS (Protected) ---
app.use('/api', authMiddleware);

// GET /api/feed (The "V4 SMART 7+3 Blend" Endpoint)
app.get('/api/feed', async (req, res) => {
  const userId = req.user.id;
  // Define how many recent articles we look at to build the Rocchio profile
  const PROFILE_SIZE = 5;
  const SMART_FEED_SIZE = 7;
  const DUMB_FEED_SIZE = 3;

  try {
    // Fetch Positive Signal (Likes)
    const likedQuery = `
      SELECT a.embedding 
      FROM articles a
      JOIN user_swipes us ON a.id = us.article_id
      WHERE us.user_id = $1 AND us.liked = true
      ORDER BY us.swipe_time DESC
      LIMIT $2;
    `;
    // Fetch Negative Signal (Skips/Dislikes)
    const dislikedQuery = `
      SELECT a.embedding 
      FROM articles a
      JOIN user_swipes us ON a.id = us.article_id
      WHERE us.user_id = $1 AND us.liked = false
      ORDER BY us.swipe_time DESC
      LIMIT $2;
    `;
    
    const [likedResult, dislikedResult] = await Promise.all([
      pool.query(likedQuery, [userId, PROFILE_SIZE]),
      pool.query(dislikedQuery, [userId, PROFILE_SIZE])
    ]);

    let finalFeed = [];
    let queryParams = [userId]; // $1 is always userId

    if (likedResult.rows.length > 0) {
      // --- "7+3" ROCCHIO BLENDED FEED ---
      console.log(`Using SMART 7+3 Rocchio feed for user ${userId}`);
      const likedStrings = likedResult.rows.map(row => row.embedding);
      const dislikedStrings = dislikedResult.rows.map(row => row.embedding);
      
      const tasteVector = computeRocchioVector(likedStrings, dislikedStrings, 1.0, 0.5);
      queryParams.push(tasteVector); // $2 is the highly personalized Rocchio taste vector
      
      // 1. Get 7 SMART articles
      const smartQuery = `
        SELECT id, title, description, article_url, image_url, source_name, published_at, score, num_comments, hn_id, (1 - (embedding <=> $2)) as similarity
        FROM articles
        WHERE id NOT IN (SELECT article_id FROM user_swipes WHERE user_id = $1)
        ORDER BY similarity DESC
        LIMIT ${SMART_FEED_SIZE};
      `;
      const smartRows = (await pool.query(smartQuery, queryParams)).rows;
      finalFeed.push(...smartRows);


      // 2. Get 3 DUMB articles for exploration
      const smartArticleIds = smartRows.map(a => a.id);
      const idPlaceholders = smartArticleIds.length > 0 ? smartArticleIds.join(',') : '0';

      const dumbQuery = `
        SELECT *, NULL as similarity FROM articles
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
        SELECT * FROM articles
        WHERE id NOT IN (SELECT article_id FROM user_swipes WHERE user_id = $1)
        ORDER BY RANDOM()
        LIMIT 10;
      `;
      finalFeed = (await pool.query(dumbQuery, queryParams)).rows;
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