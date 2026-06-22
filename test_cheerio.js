const axios = require('axios');
const cheerio = require('cheerio');
axios.get('https://animationobsessive.substack.com/p/the-image-boards-of-hayao-miyazaki')
  .then(res => {
    const $ = cheerio.load(res.data);
    const paragraphs = [];
    $('p').each((i, el) => {
      const txt = $(el).text().replace(/\s+/g, ' ').trim();
      const isSubstantial = txt.length > 60 && txt.split(' ').length > 8;
      const isJunk = txt.toLowerCase().match(/(cookie|javascript|subscribe|newsletter|sign in|log in|copyright|all rights reserved)/);
      if (isSubstantial && !isJunk) paragraphs.push(txt);
    });
    console.log('Paragraphs found:', paragraphs.length);
    console.log('Total text length:', paragraphs.join(' ').length);
  });
