require('dotenv').config();
const sharp = require('sharp');
const pool = require('../db');

const IMAGE_CHECK_TIMEOUT_MS = 5000;
const MIN_IMAGE_DIMENSION = 200;
const MIN_MEAN_BRIGHTNESS = 30;
const CONCURRENCY = 5;

// Same check as ingest.js's isImageGoodQuality - kept as a separate copy here
// since this is a one-off migration script, not a shared module.
async function isImageGoodQuality(imageUrl) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), IMAGE_CHECK_TIMEOUT_MS);
    const res = await fetch(imageUrl, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) return false;

    const buffer = Buffer.from(await res.arrayBuffer());
    const image = sharp(buffer);
    const metadata = await image.metadata();
    if (!metadata.width || !metadata.height || metadata.width < MIN_IMAGE_DIMENSION || metadata.height < MIN_IMAGE_DIMENSION) {
      return false;
    }

    const stats = await image.stats();
    const channels = stats.channels.slice(0, 3);
    const meanBrightness = channels.reduce((sum, c) => sum + c.mean, 0) / channels.length;
    return meanBrightness >= MIN_MEAN_BRIGHTNESS;
  } catch {
    return false;
  }
}

async function backfillImageQuality() {
  console.log('Running one-time backfill: nulling out image_url for existing dark/tiny images...');
  try {
    const { rows: articles } = await pool.query(
      'SELECT id, image_url FROM articles WHERE image_url IS NOT NULL'
    );
    console.log(`Checking ${articles.length} articles with an image_url...`);

    let rejected = 0;
    let checked = 0;

    for (let i = 0; i < articles.length; i += CONCURRENCY) {
      const batch = articles.slice(i, i + CONCURRENCY);
      const results = await Promise.all(
        batch.map(async (a) => ({ id: a.id, good: await isImageGoodQuality(a.image_url) }))
      );

      const badIds = results.filter((r) => !r.good).map((r) => r.id);
      if (badIds.length > 0) {
        await pool.query('UPDATE articles SET image_url = NULL WHERE id = ANY($1)', [badIds]);
        rejected += badIds.length;
      }

      checked += batch.length;
      console.log(`Checked ${checked}/${articles.length} (${rejected} rejected so far)`);
    }

    console.log(`Done. Rejected ${rejected} of ${articles.length} images - those articles now use the fallback textures.`);
  } catch (error) {
    console.error('Error during backfill:', error);
  } finally {
    process.exit(0);
  }
}

backfillImageQuality();
