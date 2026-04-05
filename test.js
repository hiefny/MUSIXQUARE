const https = require('https');
const fs = require('fs');
https.get('https://mxqr.netlify.app/', (res) => { 
  fs.writeFileSync('headers.json', JSON.stringify({
    statusCode: res.statusCode, 
    headers: res.headers 
  }, null, 2)); 
});
