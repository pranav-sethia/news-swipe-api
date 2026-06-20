/**
 * ingest_historical.js — Batch-ingest the top HN stories from the past N days
 * 
 * Uses the Algolia HN API with a date filter to pull high-quality stories
 * from the past week (or month) without touching the front_page tag.
 * 
 * Run: node ingest_historical.js --days=7
 *      node ingest_historical.js --days=30
 */
require('dotenv').config();

const axios = require('axios');
const cheerio = require('cheerio');
const { Pool } = require('pg');
const { pipeline } = require('@xenova/transformers');

// ─── Config ──────────────────────────────────────────────────────────────────
const DAYS_BACK = parseInt(process.argv.find(a => a.startsWith('--days='))?.split('=')[1] || '7');
const MIN_POINTS = 100;         // Higher bar for historical articles (only quality content)
const MAX_ARTICLES = 200;       // Max articles to fetch per run
const OG_FETCH_TIMEOUT_MS = 4000;
const SLEEP_MS = 300;           // Polite delay between scrapes

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let embedder = null;
let summarizer = null;

async function initModels() {
  if (!embedder) {
    process.stdout.write('🧠 Loading ML embedder... ');
    embedder = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', { quantized: true });
    console.log('✅');
  }
  if (!summarizer) {
    process.stdout.write('🧠 Loading AI summarizer... ');
    summarizer = await pipeline('summarization', 'Xenova/t5-small', { quantized: true });
    console.log('✅\n');
  }
}

async function getEmbedding(text) {
  try {
    const output = await embedder(text, { pooling: 'mean', normalize: true });
    return Array.from(output.data);
  } catch { return null; }
}

async function getSummary(text) {
  if (!summarizer || !text || text.length < 60) return text?.trim() || null;
  try {
    const result = await summarizer(`summarize: ${text.substring(0, 2500)}`, {
      max_new_tokens: 90, min_new_tokens: 15, repetition_penalty: 1.5, no_repeat_ngram_size: 2, num_beams: 3
    });
    let s = result[0].summary_text.trim();
    s = s.charAt(0).toUpperCase() + s.slice(1);
    if (!s.match(/[.!?]$/)) s += '.';
    return s;
  } catch { return text.substring(0, 150).trim() + '...'; }
}

async function scrapeMetadata(url) {
  try {
    const resp = await axios.get(url, {
      timeout: OG_FETCH_TIMEOUT_MS, maxContentLength: 500_000, responseType: 'text',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NewsSwipeBot/1.0)', Accept: 'text/html' }
    });
    const $ = cheerio.load(resp.data);
    const imageUrl = $('meta[property="og:image"]').attr('content') || $('meta[name="twitter:image"]').attr('content') || null;
    const paragraphs = [];
    $('p').each((_, el) => {
      const txt = $(el).text().replace(/\s+/g, ' ').trim();
      const isJunk = txt.toLowerCase().match(/(cookie|javascript|subscribe|newsletter|sign in|log in|copyright)/);
      if (txt.length > 60 && txt.split(' ').length > 8 && !isJunk) paragraphs.push(txt);
    });
    const fullText = paragraphs.slice(0, 6).join(' ').replace(/\s+/g, ' ').trim();
    const ogDesc = $('meta[property="og:description"]').attr('content') || $('meta[name="description"]').attr('content') || null;
    return { imageUrl, fullText, description: ogDesc };
  } catch { return { imageUrl: null, fullText: '', description: null }; }
}

async function main() {
  console.log(`\n📅 Fetching top HN stories from the past ${DAYS_BACK} day(s) (min ${MIN_POINTS} points)...\n`);
  await initModels();

  const cutoffTimestamp = Math.floor(Date.now() / 1000) - (DAYS_BACK * 86400);
  const url = `https://hn.algolia.com/api/v1/search?tags=story&numericFilters=created_at_i>${cutoffTimestamp},points>${MIN_POINTS}&hitsPerPage=${MAX_ARTICLES}&attributesToRetrieve=objectID,title,url,points,num_comments,created_at,story_text`;

  const { data } = await axios.get(url);
  const hits = data.hits || [];
  console.log(`Found ${hits.length} qualifying stories.\n`);

  // Check how many are already in the DB to avoid redundant work
  const { rows: existing } = await pool.query('SELECT article_url FROM articles');
  const existingUrls = new Set(existing.map(r => r.article_url));

  let savedCount = 0, skippedCount = 0;

  for (const hit of hits) {
    const { objectID, title, url: articleUrl, points, num_comments, created_at, story_text } = hit;
    if (!title || !articleUrl) { skippedCount++; continue; }
    if (points < MIN_POINTS) { skippedCount++; continue; }

    // Skip if already in DB (the ON CONFLICT handles it, but this saves scraping time)
    if (existingUrls.has(articleUrl)) {
      console.log(`⏭  Already in DB: "${title.substring(0, 60)}"`);
      skippedCount++;
      continue;
    }

    const metadata = await scrapeMetadata(articleUrl);
    let rawText = story_text ? cheerio.load(story_text).text() :
      (metadata.fullText?.length > 80 ? metadata.fullText : metadata.description);
    rawText = rawText?.replace(/\s+/g, ' ').trim() || '';

    if (rawText.length < 100) {
      console.log(`⏭  Skipped: insufficient text (< 100 chars) for "${title.substring(0, 40)}..."`);
      skippedCount++;
      continue;
    }

    process.stdout.write(`📰 "${title.substring(0, 55)}..." `);

    let description = null;
    if (rawText.length > 60) {
      process.stdout.write('✨ ');
      description = await getSummary(rawText);
    } else {
      description = metadata.description || `${points} pts · ${num_comments ?? 0} comments on Hacker News`;
    }

    const textToEmbed = `${title}. ${description}`;
    const embedding = await getEmbedding(textToEmbed);
    if (!embedding) { console.log('⚠️  embed fail, skipping'); skippedCount++; continue; }

    const embeddingStr = `[${embedding.join(',')}]`;
    await pool.query(`
      INSERT INTO articles (title, description, article_url, image_url, source_name, published_at, embedding, score, num_comments, hn_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      ON CONFLICT (article_url) DO UPDATE SET
        score = EXCLUDED.score, num_comments = EXCLUDED.num_comments,
        embedding = EXCLUDED.embedding, description = EXCLUDED.description, image_url = EXCLUDED.image_url
    `, [title, description, articleUrl, metadata.imageUrl, 'Hacker News', created_at, embeddingStr, points, num_comments, objectID]);

    console.log(`✅ (${points}pts)`);
    savedCount++;
    await sleep(SLEEP_MS);
  }

  const { rows: total } = await pool.query('SELECT COUNT(*) FROM articles');
  console.log(`\n--- Historical Ingest Complete ---`);
  console.log(`✅ Ingested: ${savedCount} new articles`);
  console.log(`⏭  Skipped: ${skippedCount} (already in DB or low quality)`);
  console.log(`📦 Total articles in DB: ${total[0].count}`);
  await pool.end();
}

main().catch(console.error);
