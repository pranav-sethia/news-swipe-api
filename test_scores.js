require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
async function test() {
  const {rows} = await pool.query('SELECT title, (embedding <=> (SELECT embedding FROM articles WHERE title ILIKE \'%apple%\' LIMIT 1)) as dist FROM articles WHERE embedding IS NOT NULL ORDER BY dist ASC LIMIT 5');
  console.log(rows);
  pool.end();
}
test();
