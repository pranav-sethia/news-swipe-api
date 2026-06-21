const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function run() {
  try {
    const userId = 34; // guest user ID from previous check
    const userResult = await pool.query('SELECT taste_vector FROM users WHERE id = $1', [userId]);
    const tasteVector = userResult.rows[0]?.taste_vector;

    console.log("Taste vector:", tasteVector);

    let finalFeed = [];

    if (tasteVector) {
      console.log("HAS TASTE VECTOR");
      // ... same logic ...
    } else {
      console.log("NO TASTE VECTOR");
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
    
    console.log("Feed length:", finalFeed.length);

  } catch (err) {
    console.error(err);
  } finally {
    pool.end();
  }
}
run();
