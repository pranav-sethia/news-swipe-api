require('dotenv').config();
const axios = require('axios');
const cheerio = require('cheerio');
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function getSummary(text) {
  if (!text || text.length < 60) return text?.substring(0, 150).trim() + '...' || null;
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
    const summary = data.response.trim();
    const lower = summary.toLowerCase();
    if (lower.includes("cannot be fulfilled") || lower.includes("insufficient") || lower.includes("unable to extract") || lower.includes("cannot fulfill")) {
      return null;
    }
    return summary;
  } catch (error) {
    console.error(`Error generating summary via Ollama:`, error.message);
    return null;
  }
}

async function scrapeHackerNews(pages = 3) {
  let articles = [];
  try {
    for (let p = 1; p <= pages; p++) {
      console.log(`Scraping page ${p}...`);
      const response = await axios.get(`https://news.ycombinator.com/news?p=${p}`);
      const $ = cheerio.load(response.data);

      $('.athing').each((i, el) => {
        const id = $(el).attr('id');
        const titleEl = $(el).find('.titleline > a').first();
        const title = titleEl.text().trim();
        const url = titleEl.attr('href') || `https://news.ycombinator.com/item?id=${id}`;
        
        const subtext = $(el).next().find('.subtext');
        const scoreText = subtext.find('.score').text() || '0 points';
        const score = parseInt(scoreText.replace(/\D/g, '')) || 0;
        
        const commentsText = subtext.find('a').last().text() || '0 comments';
        const commentsMatch = commentsText.match(/(\d+)\s*comment/);
        const numComments = commentsMatch ? parseInt(commentsMatch[1]) : 0;
        
        const ageEl = subtext.find('.age');
        const timeAttr = ageEl.attr('title');
        let published_at = new Date();
        if (timeAttr) {
          published_at = new Date(timeAttr);
        }

        if (title && url) {
          articles.push({ hn_id: id, title, url, score, num_comments: numComments, published_at });
        }
      });
      await new Promise(r => setTimeout(r, 1000));
    }
  } catch (error) {
    console.error('Error scraping HN:', error.message);
  }
  return articles;
}

async function extractArticleData(url) {
  if (url.includes('news.ycombinator.com')) return null;
  try {
    const res = await axios.get(url, { timeout: 3000, headers: { 'User-Agent': 'Mozilla/5.0' } });
    const $ = cheerio.load(res.data);
    $('script, style, nav, footer, iframe').remove();
    let text = $('body').text().replace(/\s+/g, ' ').trim();
    if (text.length < 100) return null;
    let imageUrl = $('meta[property="og:image"]').attr('content') || $('meta[name="twitter:image"]').attr('content') || null;
    let sourceName = $('meta[property="og:site_name"]').attr('content') || new URL(url).hostname.replace(/^www\./, '');
    return { text, imageUrl, sourceName };
  } catch (e) {
    return null;
  }
}

async function processArticles() {
  const articles = await scrapeHackerNews(3);
  console.log(`Found ${articles.length} historical articles.`);
  
  for (const article of articles) {
    try {
      const exists = await pool.query('SELECT id FROM articles WHERE hn_id = $1', [article.hn_id]);
      if (exists.rows.length > 0) continue;

      let description = '';
      let imageUrl = null;
      let sourceName = new URL(article.url).hostname.replace(/^www\./, '');

      const extracted = await extractArticleData(article.url);
      if (extracted) {
        description = await getSummary(extracted.text);
        imageUrl = extracted.imageUrl;
        sourceName = extracted.sourceName || sourceName;
      }
      
      if (!description) {
        console.log(`⚠️ Skipped: Not enough text or LLM refused (${article.title})`);
        continue;
      }

      await pool.query(`
        INSERT INTO articles (hn_id, title, article_url, image_url, source_name, published_at, score, num_comments, description)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        ON CONFLICT (hn_id) DO NOTHING
      `, [
        article.hn_id, article.title, article.url, imageUrl, sourceName, 
        article.published_at, article.score, article.num_comments, description
      ]);
      console.log(`✅ Saved: ${article.title}`);
    } catch (e) {
      console.error(`Failed to save ${article.title}:`, e.message);
    }
  }
  pool.end();
}

processArticles();
