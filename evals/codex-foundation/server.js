'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const port = Number(process.argv[2] || 12743);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('port must be an integer from 1 to 65535');
}

const fixture = path.join(__dirname, 'smoke.html');
http.createServer((request, response) => {
  if (request.method === 'GET' && request.url === '/favicon.ico') {
    response.writeHead(204);
    response.end();
    return;
  }
  if (request.method !== 'GET' || !['/', '/smoke.html'].includes(request.url)) {
    response.writeHead(404);
    response.end('Not found');
    return;
  }
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  fs.createReadStream(fixture).pipe(response);
}).listen(port, '127.0.0.1', () => {
  console.log(`AgenTeX smoke fixture at http://127.0.0.1:${port}/smoke.html`);
});
