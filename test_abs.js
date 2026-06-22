require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
async function test() {
  const {rows} = await pool.query(`
    SELECT a.title as t1, b.title as t2, (1 - (a.embedding <=> b.embedding)) as sim
    FROM articles a, articles b
    WHERE a.id != b.id AND a.embedding IS NOT NULL AND b.embedding IS NOT NULL
    ORDER BY RANDOM() LIMIT 10
  `);
  console.log(rows);
  pool.end();
}
test();
