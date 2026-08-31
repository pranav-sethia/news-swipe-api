require('dotenv').config();
const { Sentry, enabled: sentryEnabled } = require('./sentry');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const pool = require('./db');
const authMiddleware = require('./authMiddleware');
const { authLimiter } = require('./middleware/rateLimiters');

const authRoutes = require('./routes/auth');
const feedRoutes = require('./routes/feed');
const commentsRoutes = require('./routes/comments');
const swipeRoutes = require('./routes/swipe');
const statsRoutes = require('./routes/stats');
const onboardingRoutes = require('./routes/onboarding');
const accountRoutes = require('./routes/account');

const app = express();
const port = process.env.PORT || 4000;

// Render (and most PaaS hosts) sit one reverse-proxy hop in front of this
// process. Without this, express-rate-limit's default IP key resolves to
// the proxy's own address for every request, collapsing every real user
// into one shared rate-limit bucket.
app.set('trust proxy', 1);

// --- Middleware ---
// Supports a single origin or a comma-separated list, e.g. "https://hackerswipe.io,https://www.hackerswipe.io"
const allowedOrigins = (process.env.FRONTEND_URL || '*').split(',').map(o => o.trim()).filter(Boolean);
const allowedOrigin = allowedOrigins.length === 1 ? allowedOrigins[0] : allowedOrigins;
// This is a pure JSON API consumed from a different origin (the Vercel-hosted frontend),
// so relax CORP/CSP defaults that assume same-origin HTML serving.
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  contentSecurityPolicy: false,
}));
app.use(cors({ origin: allowedOrigin }));
app.use(express.json());

// --- Health Check (Keep-Alive) ---
app.get('/api/health', (req, res) => res.status(200).send('OK'));

// --- Public stats (no auth), a real proof-of-life number for the landing page ---
app.get('/api/stats/public', authLimiter, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT COUNT(*)::int AS count FROM articles');
    res.json({ articleCount: rows[0].count });
  } catch (err) {
    console.error('Error fetching public stats:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// --- AUTH ENDPOINTS (Public) ---
app.use(authRoutes);

// --- APP ENDPOINTS (Protected) ---
app.use('/api', authMiddleware);
app.use(feedRoutes);
app.use(commentsRoutes);
app.use(swipeRoutes);
app.use(statsRoutes);
app.use(onboardingRoutes);
app.use(accountRoutes);

if (sentryEnabled) Sentry.setupExpressErrorHandler(app);

const startServer = async () => {
  try {
    const client = await pool.connect();
    const now = await client.query('SELECT NOW()');
    console.log(`✅ Database connected successfully at: ${now.rows[0].now}`);

    // Add pgvector extension if missing and initialize user taste_vector
    await client.query('CREATE EXTENSION IF NOT EXISTS vector;');
    await client.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS taste_vector vector(384);');
    await client.query('ALTER TABLE articles ADD COLUMN IF NOT EXISTS comments_summary JSONB;');
    await client.query('ALTER TABLE articles ADD COLUMN IF NOT EXISTS summary_generated_at TIMESTAMP;');
    await client.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS onboarding_categories TEXT[];');
    await client.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_token_hash TEXT;');
    await client.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_token_expires TIMESTAMPTZ;');
    await client.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_provider TEXT NOT NULL DEFAULT 'password';");
    await client.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS matches_unlocked_at TIMESTAMPTZ;');
    // An incrementally-maintained session vector + streak-counter mechanism
    // was tried and abandoned in favor of computing everything fresh from
    // user_swipes at read time (see routes/feed.js) - two time-decay
    // half-lives applied to the raw log, rather than separate cached state
    // that could drift from it. Dropping the now-unused columns.
    await client.query('ALTER TABLE users DROP COLUMN IF EXISTS session_vector;');
    await client.query('ALTER TABLE users DROP COLUMN IF EXISTS session_vector_updated_at;');
    await client.query('ALTER TABLE users DROP COLUMN IF EXISTS session_streak;');
    await client.query('ALTER TABLE users DROP COLUMN IF EXISTS taste_surprise_streak;');
    await client.query('CREATE INDEX IF NOT EXISTS articles_embedding_idx ON articles USING hnsw (embedding vector_cosine_ops);');
    console.log(`✅ Schema updated with pgvector support and HNSW index.`);

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
