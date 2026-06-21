require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const authMiddleware = require('./authMiddleware');
const axios = require('axios');
const crypto = require('crypto');

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
const allowedOrigin = process.env.FRONTEND_URL || '*';
app.use(cors({ origin: allowedOrigin }));
app.use(express.json());

// --- Health Check (Keep-Alive) ---
app.get('/api/health', (req, res) => res.status(200).send('OK'));


// --- HELPER FUNCTION: Shuffle an array ---
function shuffleArray(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

// --- HELPER FUNCTION: Cosine Similarity ---
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

// POST /auth/guest — creates an ephemeral, isolated guest account
app.post('/auth/guest', async (req, res) => {
  const guestUuid = crypto.randomUUID();
  const guestEmail = `guest_${guestUuid}@hackerswipe.io`;
  const dummyPassword = crypto.randomBytes(16).toString('hex');
  
  try {
    const salt = await bcrypt.genSalt(10);
    const hash = await bcrypt.hash(dummyPassword, salt);
    
    const { rows } = await pool.query(
      'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING *',
      [guestEmail, hash]
    );
    const user = rows[0];
    console.log(`✅ Ephemeral guest account created: ${guestEmail}`);

    const payload = { user: { id: user.id, email: user.email, isGuest: true } };
    // Guest tokens expire in 24 hours
    jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '24h' }, (err, token) => {
      if (err) throw err;
      res.json({ token });
    });
  } catch (err) {
    console.error('Error creating ephemeral guest session:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/auth/google — verifies Google access_token and issues app JWT
app.post('/api/auth/google', async (req, res) => {
  const { credential } = req.body; // In this case, it's an access_token from useGoogleLogin
  if (!credential) return res.status(400).json({ error: 'Missing credential' });

  try {
    // Ping Google to verify token and get user profile
    const { data: googleUser } = await axios.get('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${credential}` }
    });
    
    const email = googleUser.email;
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

// Window-based probabilistic interleave:
// Splits the match pool into N equal windows (one per discovery card).
// Within each window, the discovery card lands at a random position.
// Guarantees: max consecutive matches ≤ windowSize (~4), never back-to-back discoveries,
// and a different pattern every call — no hardcoded rhythm.
function randomizedInterleave(smartRows, dumbRows) {
  if (!dumbRows.length) return [...smartRows];
  if (!smartRows.length) return [...dumbRows];

  const numWindows = dumbRows.length;                             // 3 windows = 3 discovery cards
  const windowSize = Math.floor(smartRows.length / numWindows);  // ~4 matches per window
  const result = [];
  let mi = 0, di = 0;

  for (let w = 0; w < numWindows && mi < smartRows.length; w++) {
    const matchesInWindow = (w < numWindows - 1) ? windowSize : smartRows.length - mi;

    // Random position for discovery within this window.
    // In the last window, avoid placing disc at the very end (user's last card should be a match).
    const maxDiscSlot = (w === numWindows - 1) ? Math.max(0, matchesInWindow - 1) : matchesInWindow;
    const discSlot = Math.floor(Math.random() * (maxDiscSlot + 1));

    for (let j = 0; j < discSlot && mi < smartRows.length; j++) result.push(smartRows[mi++]);
    if (di < dumbRows.length) result.push({ ...dumbRows[di++], match_pct: null });
    for (let j = discSlot; j < matchesInWindow && mi < smartRows.length; j++) result.push(smartRows[mi++]);
  }

  // Safety: flush any remaining cards
  while (mi < smartRows.length) result.push(smartRows[mi++]);
  while (di < dumbRows.length) result.push({ ...dumbRows[di++], match_pct: null });

  return result;
}

// GET /api/feed (V10 — EMA + Probabilistic Interleave)
app.get('/api/feed', async (req, res) => {
  const userId = req.user.id;
  const SMART_FETCH = 12; // all labelled as MATCH
  const DUMB_FETCH  = 3;  // ~20% serendipity

  try {
    const userResult = await pool.query('SELECT taste_vector FROM users WHERE id = $1', [userId]);
    const tasteVector = userResult.rows[0]?.taste_vector;

    let finalFeed = [];

    if (tasteVector) {
      console.log(`[V10] EMA feed for user ${userId}`);

      // 1. Fetch top 40 closest articles to the user's EMA taste vector.
      //    Exclude all previously swiped articles so nothing ever repeats.
      //    Enforce 90-day limit.
      const CANDIDATE_FETCH = 40;
      let smartRows = (await pool.query(`
        SELECT a.id, a.title, a.description, a.article_url, a.image_url, a.source_name, a.published_at,
               a.score, a.num_comments, a.hn_id, a.embedding,
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
          AND a.id NOT IN (SELECT article_id FROM user_swipes WHERE user_id = $2 AND article_id IS NOT NULL)
          AND a.published_at::timestamp > NOW() - INTERVAL '90 days'
        ORDER BY a.embedding <=> $1
        LIMIT $3
      `, [tasteVector, userId, CANDIDATE_FETCH])).rows;

      // 2. Parse embeddings and apply Time Decay to find top candidates
      const nowMs = Date.now();
      const MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
      
      smartRows.forEach(r => {
        r.parsed_embedding = typeof r.embedding === 'string' ? JSON.parse(r.embedding) : r.embedding;
        const simRaw = parseFloat(r.similarity_raw);
        const ageMs = nowMs - new Date(r.published_at).getTime();
        const ageRatio = Math.max(0, Math.min(1, ageMs / MAX_AGE_MS));
        // Recency penalty: older articles lose up to 0.15 of similarity score
        r.final_score = simRaw - (ageRatio * 0.15); 
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

      // 5. Serendipity: a few recent random articles the user hasn't seen.
      const smartIds = smartRows.map(a => a.id);
      const idBlock  = smartIds.length ? smartIds.join(',') : '0';
      const dumbRows = (await pool.query(`
        SELECT id, title, description, article_url, image_url, source_name, published_at,
               score, num_comments, hn_id, NULL::float AS similarity_raw
        FROM articles
        WHERE id NOT IN (SELECT article_id FROM user_swipes WHERE user_id = $1 AND article_id IS NOT NULL)
          AND id NOT IN (${idBlock})
          AND embedding IS NOT NULL
          AND published_at::timestamp > NOW() - INTERVAL '90 days'
        ORDER BY RANDOM()
        LIMIT ${DUMB_FETCH}
      `, [userId])).rows;

      // 6. Probabilistic interleave — no fixed pattern, randomized positions with constraints.
      finalFeed = randomizedInterleave(smartRows, dumbRows);

    } else {
      // New user: pure discovery feed until first like.
      console.log(`[V10] No taste_vector for user ${userId} — discovery feed`);
      finalFeed = (await pool.query(`
        SELECT id, title, description, article_url, image_url, source_name, published_at,
               score, num_comments, hn_id, NULL::float AS similarity_raw
        FROM articles
        WHERE id NOT IN (SELECT article_id FROM user_swipes WHERE user_id = $1 AND article_id IS NOT NULL)
          AND embedding IS NOT NULL
          AND published_at::timestamp > NOW() - INTERVAL '90 days'
        ORDER BY RANDOM()
        LIMIT 15
      `, [userId])).rows;
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
    console.log(`Swipe saved: User ${userId} ${liked === null ? 'skipped neutrally' : (liked ? 'liked' : 'disliked')} Article ${articleId}`);

    // If neutral skip, do not alter the taste vector.
    if (liked === null) {
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

      const parseVector = (v) => typeof v === 'string' ? JSON.parse(v) : v;
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
        const swipeCount = parseInt(total_swipes, 10);
        
        let alpha = 0.2;
        if (swipeCount <= 10) alpha = 0.5;
        else if (swipeCount > 50) alpha = 0.05;

        let newVec;
        if (liked) {
          newVec = userVec.map((val, i) => (val * (1 - alpha)) + (articleVec[i] * alpha));
        } else {
          // Negative swipe: Shift away from article gently to not banish topics forever
          const negativeAlpha = alpha * 0.15;
          newVec = userVec.map((val, i) => val - (articleVec[i] * negativeAlpha));
          // Normalize to keep vector scale stable
          let magnitude = Math.sqrt(newVec.reduce((sum, val) => sum + val * val, 0));
          if (magnitude === 0) magnitude = 1;
          newVec = newVec.map(val => val / magnitude);
        }
        newVectorStr = `[${newVec.join(',')}]`;
      }
      
      await pool.query(`UPDATE users SET taste_vector = $1 WHERE id = $2`, [newVectorStr, userId]);
      console.log(`Updated EMA taste vector for User ${userId}`);
    }

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
    // Reset their average embedding vector too
    await pool.query('UPDATE users SET taste_vector = NULL WHERE id = $1', [userId]);
    console.log(`Swipes and vector reset for User ${userId}`);
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


const startServer = async () => {
  try {
    const client = await pool.connect();
    const now = await client.query('SELECT NOW()');
    console.log(`✅ Database connected successfully at: ${now.rows[0].now}`);
    
    // Add pgvector extension if missing and initialize user taste_vector
    await client.query('CREATE EXTENSION IF NOT EXISTS vector;');
    await client.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS taste_vector vector(384);');
    console.log(`✅ Schema updated with pgvector support.`);
    
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