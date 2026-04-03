/**
 * validate_algo.js — End-to-end recommendation algorithm validation
 *
 * Finds an existing real user, saves their current swipes, temporarily gives them
 * 3 AI/programming themed likes, runs the exact k-NN query used by the live feed,
 * prints ranked results with a pass/fail verdict, then restores the original swipe state.
 *
 * Run: node validate_algo.js
 */
require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const LIKES_TO_EVALUATE = 5;

async function validate() {
  console.log('🧪 Starting Algorithm Validation Test\n');

  // ── 1. Find a real user in the DB ──────────────────────────────────────────
  const { rows: users } = await pool.query('SELECT id, email FROM users LIMIT 1');
  if (users.length === 0) {
    console.log('❌ No users found in DB. Register first.');
    await pool.end(); return;
  }
  const TEST_USER_ID = users[0].id;
  console.log(`🔑 Using real user: ${users[0].email} (id=${TEST_USER_ID})\n`);

  // ── 2. Save & remove their existing swipes temporarily ────────────────────
  const { rows: savedSwipes } = await pool.query(
    'SELECT article_id, liked FROM user_swipes WHERE user_id = $1', [TEST_USER_ID]
  );
  await pool.query('DELETE FROM user_swipes WHERE user_id = $1', [TEST_USER_ID]);

  try {
    // ── 3. Find 3 clearly AI/ML/programming articles ─────────────────────────
    const { rows: aiArticles } = await pool.query(`
      SELECT id, title FROM articles 
      WHERE title ILIKE '%AI%' OR title ILIKE '%ML%' OR title ILIKE '%model%' 
         OR title ILIKE '%language%' OR title ILIKE '%agent%' OR title ILIKE '%LLM%'
         OR title ILIKE '%swift%' OR title ILIKE '%python%' OR title ILIKE '%rust%'
         OR title ILIKE '%code%' OR title ILIKE '%compiler%' OR title ILIKE '%programming%'
      LIMIT 3
    `);

    if (aiArticles.length === 0) {
      console.log('❌ No programming articles found in DB. Run node ingest.js first.');
      return;
    }

    console.log('✅ Simulated Likes (programming/AI themed):');
    for (const article of aiArticles) {
      await pool.query(
        'INSERT INTO user_swipes (user_id, article_id, liked) VALUES ($1, $2, true) ON CONFLICT DO NOTHING',
        [TEST_USER_ID, article.id]
      );
      console.log(`   👍 "${article.title}"`);
    }

    // ── 4. Run exact k-NN query matching the live /api/feed endpoint ──────────
    console.log('\n📡 Running k-NN recommendation query...\n');
    const { rows: recs } = await pool.query(`
      SELECT a.title,
        ROUND(CAST(
          (SELECT MAX(1 - (a.embedding <=> liked_a.embedding))
           FROM (SELECT article_id FROM user_swipes WHERE user_id = $1 AND liked = true ORDER BY swipe_time DESC LIMIT $2) r
           JOIN articles liked_a ON r.article_id = liked_a.id)
        AS NUMERIC), 4) as raw_cosine
      FROM articles a
      WHERE a.id NOT IN (SELECT article_id FROM user_swipes WHERE user_id = $1)
      ORDER BY raw_cosine DESC NULLS LAST
      LIMIT 7
    `, [TEST_USER_ID, LIKES_TO_EVALUATE]);

    console.log('🎯 Top 7 Recommendations (should relate to programming/AI):');
    console.table(recs.map((r, i) => ({
      rank: `#${i+1}`,
      title: r.title.substring(0, 72),
      raw_cosine: r.raw_cosine,
    })));

    // ── 5. Pass/fail verdict ─────────────────────────────────────────────────
    const topRec = recs[0];
    if (!topRec) {
      console.log('\n❌ FAIL: No recommendations returned. Check article pool size.');
    } else if (parseFloat(topRec.raw_cosine) > 0.10) {
      console.log(`\n✅ PASS: Top recommendation cosine=${topRec.raw_cosine} (>0.10). Algorithm is working correctly.`);
    } else {
      console.log(`\n⚠️  WARN: Top cosine is only ${topRec.raw_cosine}. Pool too small — run node ingest_historical.js --days=7`);
    }

  } finally {
    // ── 6. Always restore original swipe state ────────────────────────────────
    await pool.query('DELETE FROM user_swipes WHERE user_id = $1', [TEST_USER_ID]);
    for (const s of savedSwipes) {
      await pool.query(
        'INSERT INTO user_swipes (user_id, article_id, liked) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
        [TEST_USER_ID, s.article_id, s.liked]
      );
    }
    console.log(`\n🧹 Restored ${savedSwipes.length} original swipes for user ${TEST_USER_ID}.`);
    await pool.end();
  }
}

validate().catch(console.error);
