import https from 'node:https';
import fs from 'node:fs';
https.get('https://mxqr.netlify.app/', (res) => { 
  fs.writeFileSync('headers.json', JSON.stringify({
    statusCode: res.statusCode, 
    headers: res.headers 
  }, null, 2)); 
});
