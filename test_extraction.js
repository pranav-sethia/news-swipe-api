const axios = require('axios');
const cheerio = require('cheerio');
const { Readability } = require('@mozilla/readability');
const { JSDOM } = require('jsdom');

async function testExtraction(url) {
  try {
    const response = await axios.get(url, { 
      timeout: 10000,
      headers: { 'User-Agent': 'Mozilla/5.0' } 
    });
    const html = response.data;
    const $ = cheerio.load(html);

    const doc = new JSDOM(html, { url });
    const reader = new Readability(doc.window.document);
    const articleData = reader.parse();
    
    let textContent = "";
    let usedFallback = false;
    if (articleData && articleData.textContent) {
      textContent = articleData.textContent;
    } else {
      usedFallback = true;
      $('script, style, nav, footer, header, aside, iframe, noscript').remove();
      textContent = $('body').text();
    }
    
    textContent = textContent.replace(/\s+/g, ' ').trim();
    const wordCount = textContent.split(/\s+/).length;
    const readTimeMinutes = Math.max(1, Math.ceil(wordCount / 225));

    console.log(`URL: ${url}`);
    console.log(`Read Time: ${readTimeMinutes} min`);
    console.log(`Word Count: ${wordCount}`);
    console.log(`Used Fallback: ${usedFallback}`);
    console.log(`Extracted Text snippet: ${textContent.substring(0, 500)}...`);
    console.log('---');
  } catch (error) {
    console.error(`Error on ${url}:`, error.message);
  }
}

async function run() {
  await testExtraction('https://www.poppastring.com/blog/what-we-lost-the-last-time-code-got-cheap');
  await testExtraction('https://www.smpte.org/blog/smpte-makes-its-standards-freely-accessible-openingstandards-library-to-the-global-media-technology-community');
}

run();
