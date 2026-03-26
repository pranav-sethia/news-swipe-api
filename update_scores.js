/**
 * update_scores.js
 * 
 * Lightweight script that patches score, num_comments, and hn_id on EXISTING articles
 * by fetching the latest HN front page data — no embeddings needed.
 * 
 * Run this when the ML service is down or when you just want fresh stats.
 */
require('dotenv').config();
const axios = require('axios');
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const HN_ALGOLIA_URL = 'https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=100';

async function run() {
  console.log('🔄 Fetching current HN front page...');
  const { data } = await axios.get(HN_ALGOLIA_URL);
  const hits = data.hits || [];
  console.log(`   Found ${hits.length} stories.\n`);

  const client = await pool.connect();
  console.log('✅ Connected to database.\n');

  let updated = 0;
  try {
    for (const hit of hits) {
      const { url, points, num_comments, objectID } = hit;
      if (!url) continue;

      const result = await client.query(
        `UPDATE articles
         SET score = $1, num_comments = $2, hn_id = $3
         WHERE article_url = $4
         RETURNING title`,
        [points ?? null, num_comments ?? null, objectID, url]
      );

      if (result.rowCount > 0) {
        console.log(`✅ Updated: "${result.rows[0].title?.substring(0, 60)}" → ${points}pts / ${num_comments} comments`);
        updated++;
      }
    }
  } finally {
    client.release();
    pool.end();
  }

  console.log(`\n--- Done ---`);
  console.log(`✅ Updated ${updated} existing articles with fresh score/comment data.`);
}

run().catch((err) => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});
