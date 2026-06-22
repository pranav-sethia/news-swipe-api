const axios = require('axios');
axios.get('https://animationobsessive.substack.com/p/the-image-boards-of-hayao-miyazaki')
  .then(() => console.log('Success!'))
  .catch(err => console.log('Failed:', err.response ? err.response.status : err.message));
