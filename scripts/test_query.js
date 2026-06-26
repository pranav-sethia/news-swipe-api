require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function testQuery() {
  const swipeQuery = `INSERT INTO user_swipes (user_id, article_id, liked) SELECT 1, id, true FROM articles LIMIT 1 ON CONFLICT DO NOTHING;`;
  await pool.query(swipeQuery);

  const query = `
    SELECT a.title, 
      (
        SELECT MAX(1 - (a.embedding <=> liked_a.embedding))
        FROM (
          SELECT article_id 
          FROM user_swipes 
          WHERE user_id = $1 AND liked = true 
          ORDER BY swipe_time DESC 
          LIMIT 5
        ) recent_likes
        JOIN articles liked_a ON recent_likes.article_id = liked_a.id
      ) as similarity
    FROM articles a
    WHERE a.id NOT IN (SELECT article_id FROM user_swipes WHERE user_id = $1)
    ORDER BY similarity DESC NULLS LAST
    LIMIT 7;
  `;
  try {
    const { rows } = await pool.query(query, [1]);
    console.log(rows);
  } catch (err) {
    console.error(err);
  } finally {
    pool.end();
  }
}
testQuery();
