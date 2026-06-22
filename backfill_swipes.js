require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
async function getCat(text) {
  try {
    const res = await fetch('http://127.0.0.1:11434/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'llama3.2',
        system: 'You are a strict categorizer.',
        prompt: 'Categories: Artificial Intelligence, Software Engineering, Hardware & Systems, Startups & VC, Cybersecurity, Business & Finance, Science & Space, Design & UI/UX, Web3 & Crypto, Other.\nPick exactly one category for the following text. Output NOTHING else but the category name.\n\nText:\n' + text.substring(0, 4000),
        stream: false
      })
    });
    const data = await res.json();
    return data.response.trim();
  } catch(e) { return 'Other'; }
}
async function run() {
  try {
    const { rows } = await pool.query("SELECT DISTINCT a.id, a.title, a.description FROM articles a JOIN user_swipes us ON a.id = us.article_id WHERE a.category IS NULL");
    console.log('Categorizing ' + rows.length + ' swiped articles...');
    for(let row of rows) {
      const cat = await getCat(row.title + ' ' + (row.description || ''));
      console.log(row.title.substring(0, 30) + ' => ' + cat);
      await pool.query('UPDATE articles SET category = $1 WHERE id = $2', [cat, row.id]);
    }
  } catch (err) { console.log(err); }
  await pool.end();
}
run();
