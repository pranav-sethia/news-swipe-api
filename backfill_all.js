require('dotenv').config();
const { Pool } = require('pg');
const axios = require('axios');
const cheerio = require('cheerio');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const OG_FETCH_TIMEOUT_MS = 6000;

async function extractArticleText(url) {
  if (url.includes('news.ycombinator.com')) return null;
  try {
    const response = await axios.get(url, { 
      timeout: OG_FETCH_TIMEOUT_MS,
      headers: { 'User-Agent': 'Mozilla/5.0' } 
    });
    const $ = cheerio.load(response.data);
    $('script, style, nav, footer, header, aside, iframe, noscript').remove();
    const text = $('body').text().replace(/\s+/g, ' ').trim();
    if (text.length < 200) return null;
    return text.substring(0, 4000); // Only send first 4000 chars to save context window
  } catch (error) {
    return null;
  }
}

async function extractMetadata(text) {
  const systemPrompt = `You are an expert data extraction algorithm. You ONLY output valid JSON. Do not include any conversational text.`;
  const promptText = `Analyze the following text and extract exactly 3 bullet points (under 12 words each), 1 category from the list [Software Engineering, Hardware & Systems, Artificial Intelligence, Startups & VC, Cybersecurity, Business & Finance, Science & Space, Design & UI/UX, Web3 & Crypto, Other], 3 highly specific technical tags (e.g., specific framework names, noun phrases, no stop words, e.g. "React 19" instead of "react19"), and an estimated read_time_minutes.
  
JSON Schema:
{
  "category": "string",
  "tags": ["string", "string", "string"],
  "read_time_minutes": number,
  "bullets": ["string", "string", "string"]
}`;

  try {
    const res = await fetch('http://127.0.0.1:11434/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'llama3.2',
        system: systemPrompt,
        prompt: promptText + "\n\nText:\n" + text,
        stream: false,
        format: "json"
      })
    });
    const data = await res.json();
    return JSON.parse(data.response);
  } catch(e) { 
    return null; 
  }
}

async function run() {
  console.log("Starting massive backfill & cleanup...");
  
  // 1. Cleanup old articles
  const deleteOld = await pool.query("DELETE FROM articles WHERE published_at < NOW() - INTERVAL '90 days'");
  console.log(`🧹 Deleted ${deleteOld.rowCount} articles older than 90 days.`);

  // 2. Fetch all articles that haven't been processed yet (tags IS NULL)
  // We process them in descending order so the feed at the top is fixed first!
  const { rows } = await pool.query("SELECT id, title, article_url FROM articles WHERE tags IS NULL ORDER BY published_at DESC");
  console.log(`🚀 Found ${rows.length} articles to process.`);

  let processed = 0;
  let deleted = 0;

  for (const article of rows) {
    console.log(`[${processed + deleted + 1}/${rows.length}] Processing: ${article.title.substring(0, 40)}...`);
    
    // Scrape text
    const text = await extractArticleText(article.article_url);
    if (!text) {
      console.log(`   ❌ Scrape failed or text too short. Deleting.`);
      await pool.query("DELETE FROM user_swipes WHERE article_id = $1", [article.id]);
      await pool.query("DELETE FROM articles WHERE id = $1", [article.id]);
      deleted++;
      continue;
    }

    // Extract metadata
    const metadata = await extractMetadata(text);
    if (!metadata || !metadata.bullets || metadata.bullets.length < 3) {
      console.log(`   ❌ LLM failed to extract proper JSON. Deleting.`);
      await pool.query("DELETE FROM user_swipes WHERE article_id = $1", [article.id]);
      await pool.query("DELETE FROM articles WHERE id = $1", [article.id]);
      deleted++;
      continue;
    }

    // Format description
    const description = metadata.bullets.map(b => `- ${b}`).join('\n');
    const readTime = Math.max(1, Math.round(Number(metadata.read_time_minutes) || 1));
    
    // Update DB
    await pool.query(
      `UPDATE articles 
       SET description = $1, category = $2, tags = $3, read_time_minutes = $4 
       WHERE id = $5`,
      [description, metadata.category, JSON.stringify(metadata.tags), readTime, article.id]
    );

    console.log(`   ✅ Success! [${metadata.category}]`);
    processed++;
  }

  console.log(`\n🎉 DONE!`);
  console.log(`Processed successfully: ${processed}`);
  console.log(`Deleted (low quality): ${deleted}`);
  
  await pool.end();
}

run();
