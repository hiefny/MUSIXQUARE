import https from 'node:https';
import fs from 'node:fs';

const req = https.get('https://mxqr.netlify.app/robots.txt', (res) => {
  fs.writeFileSync('headers_robots.json', JSON.stringify({
    statusCode: res.statusCode, 
    headers: res.headers 
  }, null, 2)); 
});
req.on('error', console.error);
