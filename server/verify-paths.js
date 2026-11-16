// verify-paths.js — check all web files load from /peerdrop/ subpath
const http = require('http');
const fs   = require('fs');
const path = require('path');

const BASE = path.join(__dirname, '..', 'web');
const PORT = 8081;
const PREFIX = '/peerdrop';

const server = http.createServer((req, res) => {
  let url = req.url;
  if (url.startsWith(PREFIX)) url = url.slice(PREFIX.length);
  if (!url || url === '/') url = '/index.html';
  const file = path.resolve(BASE, '.' + url);
  if (!file.startsWith(BASE)) { res.writeHead(403); res.end(); return; }
  if (!fs.existsSync(file))   { res.writeHead(404); res.end('Not found: ' + url); return; }
  const ext  = path.extname(file);
  const mime = { '.html':'text/html', '.css':'text/css', '.js':'application/javascript', '.json':'application/json' }[ext] || 'text/plain';
  res.writeHead(200, { 'Content-Type': mime });
  fs.createReadStream(file).pipe(res);
});

server.listen(PORT, '127.0.0.1', () => {
  const files = [
    '/',
    '/styles.css',
    '/js/config.js',
    '/js/main.js',
    '/js/signaling.js',
    '/js/peer.js',
    '/js/ui.js',
    '/js/utils.js',
    '/js/transfer.js',
    '/js/stream.js',
    '/js/stats.js',
    '/js/manual-sdp.js',
  ];

  let ok = 0, fail = 0, pending = files.length;

  files.forEach(f => {
    const p = PREFIX + f;
    http.get({ hostname: '127.0.0.1', port: PORT, path: p }, (r) => {
      if (r.statusCode === 200) {
        ok++;
        console.log('  OK  ' + p);
      } else {
        fail++;
        console.error('  FAIL ' + p + ' → HTTP ' + r.statusCode);
      }
      r.resume();
      if (--pending === 0) done();
    }).on('error', (e) => {
      fail++;
      console.error('  ERR ' + p + ': ' + e.message);
      if (--pending === 0) done();
    });
  });

  function done() {
    console.log('\nFiles served OK: ' + ok + '  Failed: ' + fail);
    server.close(() => process.exit(fail > 0 ? 1 : 0));
  }
});
