const { Pool } = require('pg');
require('dotenv').config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function run() {
  try {
    const users = await pool.query('SELECT * FROM users LIMIT 1');
    const user = users.rows[0];
    console.log('User:', user?.id, 'Taste:', user?.taste_vector ? 'exists' : 'null');

    if (!user) return;

    const swipes = await pool.query('SELECT count(*), bool_or(article_id IS NULL) as has_null FROM user_swipes WHERE user_id = $1', [user.id]);
    console.log('Swipes:', swipes.rows);

    if (user.taste_vector) {
      const smartRows = await pool.query(`
            SELECT id, similarity_raw FROM (
              SELECT id, (1 - (embedding <=> $1))::float AS similarity_raw
              FROM articles
              WHERE embedding IS NOT NULL
                AND id NOT IN (SELECT article_id FROM user_swipes WHERE user_id = $2)
              ORDER BY embedding <=> $1
              LIMIT 12
            ) sub
      `, [user.taste_vector, user.id]);
      console.log('SmartRows length:', smartRows.rows.length);
    }
  } catch (e) { console.error(e); }
}
run().then(()=>process.exit(0)).catch(console.error);
