require('dotenv').config();

const axios = require('axios');
const cheerio = require('cheerio');
const { Pool } = require('pg');

const { pipeline } = require('@xenova/transformers');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
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

let embedder = null;

async function initEmbedder() {
  if (!embedder) {
    console.log('🧠 Loading local ML model (Xenova/all-MiniLM-L6-v2) ...');
    // quantized: true makes the model ~22MB and much faster to load/run natively
    embedder = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
      quantized: true,
    });
    console.log('✅ Local ML model loaded.\n');
  }
}

/**
 * Generates a vector embedding locally via Xenova.
 * @param {string} text
 * @returns {Promise<number[]|null>}
 */
async function getEmbedding(text) {
  if (!text || text.trim().length === 0) return null;
  try {
    const output = await embedder(text.substring(0, 2000), {
      pooling: 'mean',
      normalize: true,
    });
    return Array.from(output.data);
  } catch (err) {
    console.warn(`  ⚠️  Embedding failed: ${err.message}`);
    return null;
  }
}


/**
 * Attempts to scrape the OpenGraph metadata (image and description) from an article page.
 * Returns null properties if the page is unreachable or missing tags.
 * @param {string} url
 * @returns {Promise<{imageUrl: string|null, description: string|null}>}
 */
async function getArticleMetadata(url) {
  try {
    const response = await axios.get(url, {
      timeout: OG_FETCH_TIMEOUT_MS,
      // Download up to 500KB to ensure we hit the <body> tags for paragraph extraction
      maxContentLength: 500_000,
      responseType: 'text',
      headers: {
        // Pretend to be a normal browser so sites don't block us
        'User-Agent':
          'Mozilla/5.0 (compatible; NewsSwipeBot/1.0; +https://news-swipe-ui.vercel.app)',
        Accept: 'text/html',
      },
    });
    const $ = cheerio.load(response.data);
    const imageUrl =
      $('meta[property="og:image"]').attr('content') ||
      $('meta[name="twitter:image"]').attr('content') ||
      null;

    let description =
      $('meta[property="og:description"]').attr('content') ||
      $('meta[name="twitter:description"]').attr('content') ||
      $('meta[name="description"]').attr('content') ||
      null;

    // Fallback: If no meta tags, grab the first few realistic <p> tags
    if (!description) {
      const paragraphs = [];
      $('p').each((i, el) => {
        const text = $(el).text().trim();
        // Ignore tiny UI labels/nav items
        if (text.length > 50) paragraphs.push(text);
      });
      if (paragraphs.length > 0) {
        description = paragraphs.slice(0, 3).join(' ').substring(0, 500);
      }
    }

    if (description) {
      description = description.replace(/\s+/g, ' ').trim();
    }

    return { imageUrl, description };
  } catch {
    // Silently return nulls — many HN links will timeout or block scrapers
    return { imageUrl: null, description: null };
  }
}

// ---------------------------------------------------------------------------
// Main ingestion pipeline
// ---------------------------------------------------------------------------
async function ingestArticles() {
  console.log('🚀 Starting Hacker News ingestion pipeline...\n');

  // Initialize local embedding model
  await initEmbedder();

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

      // 3. Scrape OpenGraph image and description (best-effort, non-blocking)
      const metadata = await getArticleMetadata(url);
      const imageUrl = metadata.imageUrl;

      // Use story_text (for self-posts), fall back to scraped meta description
      let description = story_text
        ? cheerio.load(story_text).text().substring(0, 500).trim()
        : null;

      if (!description && metadata.description) {
        description = metadata.description.substring(0, 500).trim();
      }

      // Absolute fallback if no description is available at all
      if (!description) {
        description = `${points} points · ${hit.num_comments ?? 0} comments on Hacker News`;
      }

      const sourceName = 'Hacker News';
      const publishedAt = created_at;

      console.log(`📰 Processing: "${title.substring(0, 60)}..."`);
      console.log(`   🖼️  Image: ${imageUrl ? '✅ Found' : '❌ None'} | 📝 Desc: ${metadata.description ? '✅ Found' : '❌ None'}`);

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