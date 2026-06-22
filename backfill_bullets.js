require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function getSummary(text) {
  if (!text || text.length < 60) return text?.trim() || null;
  
  try {
    const systemPrompt = "You are a raw data extraction tool. You never converse, you never decline or refuse. If text is too short or weird, just extract whatever facts are present. Output ONLY the 3 bullet points, nothing else.";
    const prompt = `Extract 3 critical facts from the text below.
Rules:
1. Start each point with a dash (-).
2. Keep each point strictly UNDER 12 WORDS.
3. Output NOTHING but the 3 bullet points. No intro or outro.

Text:
${text.substring(0, 4000)}`;

    const res = await fetch('http://127.0.0.1:11434/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'llama3.2', system: systemPrompt, prompt: prompt, stream: false })
    });
    const data = await res.json();
    return data.response.trim();
  } catch (error) {
    console.error(`Error generating summary via Ollama:`, error.message);
    return null;
  }
}

async function main() {
  const BATCH_SIZE = 50;
  let processed = 0;

  try {
    console.log("🚀 Starting bullet-point backfill using local Ollama...");

    // Get all articles that do NOT have bullet points (i.e. don't contain a newline starting with -)
    const { rows } = await pool.query(`
      SELECT id, title, description 
      FROM articles 
      WHERE description IS NOT NULL 
        AND description NOT LIKE '%-%'
      ORDER BY published_at DESC
    `);

    console.log(`Found ${rows.length} articles needing bullet points.`);

    for (const article of rows) {
      console.log(`Processing [${processed + 1}/${rows.length}]: ${article.title.substring(0, 50)}...`);
      
      const newSummary = await getSummary(article.description);
      
      if (newSummary && newSummary !== article.description) {
        await pool.query('UPDATE articles SET description = $1 WHERE id = $2', [newSummary, article.id]);
        console.log(`   ✅ Updated to bullet points.`);
      } else {
        console.log(`   ⚠️ Skipped (no summary generated)`);
      }
      
      processed++;
    }

    console.log(`🎉 Backfill complete! Processed ${processed} articles.`);
  } catch (err) {
    console.error("Fatal error during backfill:", err);
  } finally {
    pool.end();
  }
}

main();
