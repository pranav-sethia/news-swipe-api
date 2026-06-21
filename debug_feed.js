const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function run() {
  try {
    const userId = 1; // dummy

    const res = await pool.query(`
        SELECT COUNT(*)
        FROM articles
        WHERE id NOT IN (SELECT article_id FROM user_swipes WHERE user_id = $1 AND article_id IS NOT NULL)
          AND embedding IS NOT NULL
          AND published_at::timestamp > NOW() - INTERVAL '90 days'
    `, [userId]);
    
    console.log("Count with 90 days:", res.rows[0].count);

    const res2 = await pool.query(`
        SELECT COUNT(*)
        FROM articles
        WHERE id NOT IN (SELECT article_id FROM user_swipes WHERE user_id = $1 AND article_id IS NOT NULL)
          AND embedding IS NOT NULL
    `, [userId]);
    console.log("Count without 90 days:", res2.rows[0].count);

  } catch (err) {
    console.error(err);
  } finally {
    pool.end();
  }
}
run();
