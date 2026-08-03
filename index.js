require('dotenv').config();
const { Sentry, enabled: sentryEnabled } = require('./sentry');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const pool = require('./db');
const authMiddleware = require('./authMiddleware');

const authRoutes = require('./routes/auth');
const feedRoutes = require('./routes/feed');
const commentsRoutes = require('./routes/comments');
const swipeRoutes = require('./routes/swipe');
const statsRoutes = require('./routes/stats');
const onboardingRoutes = require('./routes/onboarding');
const accountRoutes = require('./routes/account');

const app = express();
const port = process.env.PORT || 4000;

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
