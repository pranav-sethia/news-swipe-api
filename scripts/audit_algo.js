require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function audit() {
  console.log('\n=== STEP 1: Check article embedding coverage ===');
  const { rows: coverage } = await pool.query(`
    SELECT 
      COUNT(*) as total,
      COUNT(embedding) as has_embedding,
      COUNT(description) as has_description,
      AVG(CASE WHEN embedding IS NOT NULL THEN 1 ELSE 0 END) * 100 as pct_embedded
    FROM articles
  `);
  console.table(coverage);

  console.log('\n=== STEP 2: Check swipes table for user 1 ===');
  const { rows: swipes } = await pool.query(`
    SELECT us.liked, a.title 
    FROM user_swipes us JOIN articles a ON us.article_id = a.id 
    WHERE us.user_id = 1 ORDER BY us.swipe_time DESC LIMIT 5
  `);
  console.table(swipes);

  if (swipes.filter(s => s.liked).length === 0) {
    console.log('\n❌ No liked articles for user 1. Cannot test k-NN. Create some likes first.');
    await pool.end(); return;
  }

  console.log('\n=== STEP 3: k-NN query — top 7 recommended articles for user 1 ===');
  const { rows: recs } = await pool.query(`
    SELECT a.title,
      ROUND(CAST(
        (SELECT MAX(1 - (a.embedding <=> liked_a.embedding))
         FROM (SELECT article_id FROM user_swipes WHERE user_id = 1 AND liked = true ORDER BY swipe_time DESC LIMIT 5) r
         JOIN articles liked_a ON r.article_id = liked_a.id)
      AS NUMERIC), 4) as raw_similarity
    FROM articles a
    WHERE a.id NOT IN (SELECT article_id FROM user_swipes WHERE user_id = 1)
    ORDER BY raw_similarity DESC NULLS LAST
    LIMIT 7
  `);
  console.table(recs);

  console.log('\n=== STEP 4: Raw similarity score distribution ===');
  const { rows: dist } = await pool.query(`
    SELECT 
      MIN(raw) as min_sim, MAX(raw) as max_sim, AVG(raw) as avg_sim
    FROM (
      SELECT (SELECT MAX(1 - (a.embedding <=> liked_a.embedding))
         FROM (SELECT article_id FROM user_swipes WHERE user_id = 1 AND liked = true LIMIT 5) r
         JOIN articles liked_a ON r.article_id = liked_a.id) as raw
      FROM articles a
      WHERE a.id NOT IN (SELECT article_id FROM user_swipes WHERE user_id = 1)
    ) sub
    WHERE raw IS NOT NULL
  `);
  console.table(dist);

  await pool.end();
}
audit().catch(console.error);
