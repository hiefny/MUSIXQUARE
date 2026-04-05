import https from 'node:https';
import fs from 'node:fs';
https.get('https://musixquare.com/', (res) => { 
  fs.writeFileSync('headers_musix.json', JSON.stringify({
    statusCode: res.statusCode, 
    headers: res.headers 
  }, null, 2)); 
});
