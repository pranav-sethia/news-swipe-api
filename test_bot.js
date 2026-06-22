const axios = require('axios');
axios.get('https://animationobsessive.substack.com/p/the-image-boards-of-hayao-miyazaki', {
  maxContentLength: 500000,
  headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NewsSwipeBot/1.0; +https://news-swipe-ui.vercel.app)' }
}).then(r => console.log('Length:', r.data.length))
  .catch(e => console.log('Error:', e.message));
