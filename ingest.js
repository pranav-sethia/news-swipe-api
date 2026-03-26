require('dotenv').config();

const axios = require('axios');
const cheerio = require('cheerio');
const { Pool } = require('pg');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const ML_API_URL = (process.env.ML_SERVICE_URL || '').replace(/\/$/, '');
const GRADIO_PREDICT_URL = `${ML_API_URL}/api/predict`;

const HN_ALGOLIA_URL =
  'https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=100';

// Minimum points a story must have to be ingested (filters out low-quality posts)
const MIN_POINTS = 10;

// Timeout (ms) for OpenGraph image scraping — we don't want to block the pipeline
const OG_FETCH_TIMEOUT_MS = 4000;

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Small delay to avoid hammering external services */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Wake the HF Space if sleeping and confirm it's healthy. Returns true if ready. */
async function waitForMlService(maxWaitMs = 180_000) {
  console.log('🔌 Checking ML service health...');
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    try {
      const resp = await axios.post(
        GRADIO_PREDICT_URL,
        { data: ['warmup'] },
        { headers: { 'Gradio-Api-Client': 'js' }, timeout: 20_000 }
      );
      if (resp.data?.data?.[0]?.embedding) {
        console.log('✅ ML service is ready.\n');
        return true;
      }
    } catch {
      // still waking
    }
    const elapsed = Math.round((Date.now() - start) / 1000);
    process.stdout.write(`\r   Still waking up... ${elapsed}s elapsed`);
    await sleep(5000);
  }
  console.log('\n❌ ML service did not respond after 3 minutes.');
  return false;
}

/**
 * Fetches a vector embedding from the Hugging Face ML service.
 * Retries up to 2 times on transient errors.
 * @param {string} text
 * @returns {Promise<number[]|null>}
 */
async function getEmbedding(text) {
  if (!text || text.trim().length === 0) return null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await axios.post(
        GRADIO_PREDICT_URL,
        { data: [text.substring(0, 2000)] },
        { headers: { 'Gradio-Api-Client': 'js' }, timeout: 30_000 }
      );
      const embeddingData = response.data?.data?.[0];
      if (embeddingData?.embedding) return embeddingData.embedding;
    } catch (err) {
      const status = err.response?.status ?? 'Network Error';
      if (attempt < 2) {
        await sleep(3000);
      } else {
        console.warn(`  ⚠️  Embedding failed after 3 attempts: ${status}`);
      }
    }
  }
  return null;
}


/**
 * Attempts to scrape the OpenGraph image URL from an article page.
 * Returns null if the page is unreachable, too slow, or has no og:image tag.
 * @param {string} url
 * @returns {Promise<string|null>}
 */
async function getOgImage(url) {
  try {
    const response = await axios.get(url, {
      timeout: OG_FETCH_TIMEOUT_MS,
      // Only download the first 50 KB — enough to find the <head> tags
      maxContentLength: 50_000,
      responseType: 'text',
      headers: {
        // Pretend to be a normal browser so sites don't block us
        'User-Agent':
          'Mozilla/5.0 (compatible; NewsSwipeBot/1.0; +https://news-swipe-ui.vercel.app)',
        Accept: 'text/html',
      },
    });
    const $ = cheerio.load(response.data);
    const ogImage =
      $('meta[property="og:image"]').attr('content') ||
      $('meta[name="twitter:image"]').attr('content') ||
      null;
    return ogImage || null;
  } catch {
    // Silently return null — many HN links will timeout or block scrapers
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main ingestion pipeline
// ---------------------------------------------------------------------------
async function ingestArticles() {
  console.log('🚀 Starting Hacker News ingestion pipeline...\n');

  if (!ML_API_URL) {
    console.error('❌ ML_SERVICE_URL is not set. Exiting.');
    process.exit(1);
  }

  // Wake HF Space if sleeping (free tier can take up to 3 min to cold-start)
  const mlReady = await waitForMlService();
  if (!mlReady) {
    console.error('❌ ML service unavailable. Run node update_scores.js to refresh stats on existing articles.');
    process.exit(1);
  }

  // 1. Fetch top HN front page stories from Algolia
  console.log('📡 Fetching Hacker News front page from Algolia...');
  let hits;
  try {
    const { data } = await axios.get(HN_ALGOLIA_URL);
    hits = data.hits;
    console.log(`   Found ${hits.length} stories.\n`);
  } catch (err) {
    console.error('❌ Failed to fetch from HN Algolia API:', err.message);
    process.exit(1);
  }

  // 2. Connect to the database
  const client = await pool.connect();
  console.log('✅ Connected to database.\n');

  let savedCount = 0;
  let skippedCount = 0;

  try {
    for (const hit of hits) {
      const { title, url, points, author, created_at, story_text, objectID, num_comments } = hit;

      // --- Filter: must have a title and external URL ---
      if (!title || !url) {
        skippedCount++;
        continue;
      }

      // --- Filter: must meet minimum quality bar ---
      if ((points || 0) < MIN_POINTS) {
        skippedCount++;
        continue;
      }

      // Build the HN comments page link as the source
      const hnCommentsUrl = `https://news.ycombinator.com/item?id=${objectID}`;

      // Use story_text (for self-posts) or fall back to the title as description
      const description = story_text
        ? cheerio.load(story_text).text().substring(0, 500).trim()
        : `${points} points · ${hit.num_comments ?? 0} comments on Hacker News`;

      const sourceName = 'Hacker News';
      const publishedAt = created_at;

      console.log(`📰 Processing: "${title.substring(0, 60)}..."`);

      // 3. Scrape OpenGraph image (best-effort, non-blocking)
      const imageUrl = await getOgImage(url);
      console.log(`   🖼️  Image: ${imageUrl ? '✅ Found' : '❌ None'}`);

      // 4. Get vector embedding (title + description gives best signal)
      const textToEmbed = `${title}. ${description}`;
      const embedding = await getEmbedding(textToEmbed);
      if (!embedding) {
        console.warn(`   ⚠️  Skipping (embedding failed): "${title.substring(0, 40)}"`);
        skippedCount++;
        continue;
      }

      // 5. Upsert into the articles table
      const embeddingString = `[${embedding.join(',')}]`;
      const query = `
        INSERT INTO articles
          (title, description, article_url, image_url, source_name, published_at, embedding, score, num_comments, hn_id)
        VALUES
          ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        ON CONFLICT (article_url) DO UPDATE SET
          score = EXCLUDED.score,
          num_comments = EXCLUDED.num_comments;
      `;
      const values = [
        title,
        description,
        url,
        imageUrl,
        sourceName,
        publishedAt,
        embeddingString,
        points ?? null,
        num_comments ?? null,
        objectID,
      ];

      const result = await client.query(query, values);
      if (result.rowCount > 0) {
        savedCount++;
        console.log(`   ✅ Saved.`);
      } else {
        console.log(`   ⏭️  Already exists, skipped.`);
      }

      // Small delay between articles to be a polite scraper
      await sleep(500);
    }
  } finally {
    client.release();
    await pool.end();
  }

  console.log(`\n--- Ingestion Complete ---`);
  console.log(`✅ Saved: ${savedCount} new articles`);
  console.log(`⏭️  Skipped: ${skippedCount} articles (low quality, no URL, or embed failure)`);
}

ingestArticles();