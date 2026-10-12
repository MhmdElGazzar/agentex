'use strict';
// Local product fixture for live Copilot certification; this is not an AI worker.
const http = require('node:http');
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>AgenTeX Copilot fixture</title></head>
<body><form id="join"><label>Name <input id="name" name="name" required></label><button type="submit">Join</button></form>
<p id="message" hidden></p><script>
document.getElementById('join').addEventListener('submit', event => {
  event.preventDefault();
  const name = document.getElementById('name').value;
  const message = document.getElementById('message');
  message.textContent = 'Welcome, ' + name + '!';
  message.hidden = false;
});
</script></body></html>`;
const server = http.createServer((request, response) => {
  if (request.url !== '/') { response.writeHead(404); response.end('Not found'); return; }
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  response.end(html);
});
if (require.main === module) {
  server.listen(8766, '127.0.0.1', () => console.log('AgenTeX fixture http://127.0.0.1:8766/'));
}
module.exports = { server };
