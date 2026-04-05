import http from 'node:http';
import fs from 'node:fs';
http.get('http://mxqr.netlify.app/', (res) => { 
  fs.writeFileSync('headers_http.json', JSON.stringify({
    statusCode: res.statusCode, 
    headers: res.headers 
  }, null, 2)); 
});
