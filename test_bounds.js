require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
async function test() {
  const {rows} = await pool.query(`
    SELECT MIN(1 - (a.embedding <=> b.embedding)) as min_sim, MAX(1 - (a.embedding <=> b.embedding)) as max_sim 
    FROM articles a, articles b 
    WHERE a.id != b.id AND a.embedding IS NOT NULL AND b.embedding IS NOT NULL LIMIT 1000
  `);
  console.log(rows);
  pool.end();
}
test();
