import https from 'node:https';
import fs from 'node:fs';

const options = {
  hostname: 'mxqr.netlify.app',
  port: 443,
  path: '/',
  method: 'GET',
  headers: {
    'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'
  }
};

const req = https.request(options, (res) => {
  fs.writeFileSync('headers_googlebot.json', JSON.stringify({
    statusCode: res.statusCode, 
    headers: res.headers 
  }, null, 2)); 
});

req.on('error', (e) => {
  console.error(e);
});
req.end();
