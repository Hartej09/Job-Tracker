// Local preview of the web app: node dev/serve.js, then open http://localhost:8765/?seed
// Rebuilds the page from Index.html + includes on every request.
'use strict';
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.PORT || 8765);
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

function buildPage() {
  let html = read('Index.html').replace(/<\?!=\s*include\('(\w+)'\);?\s*\?>/g, (_, name) => {
    const content = read(name + '.html');
    if (name !== 'JavaScript') return content;
    return '<script src="/dev/gas-mocks.js"></script>' +
      '<script src="/dev/preview-shim.js"></script>' +
      '<script src="/Code.gs"></script>' + content;
  });
  // doGet adds these in Apps Script.
  return html.replace('<head>', '<head><meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>Job Tracker (preview)</title>');
}

const FILES = {
  '/Code.gs': 'Code.gs',
  '/dev/gas-mocks.js': 'dev/gas-mocks.js',
  '/dev/preview-shim.js': 'dev/preview-shim.js',
  '/dev/sample_jobs.csv': 'dev/sample_jobs.csv',
};

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(buildPage());
    }
    if (FILES[url.pathname]) {
      const type = url.pathname.endsWith('.csv') ? 'text/csv' : 'text/javascript';
      res.writeHead(200, { 'Content-Type': type + '; charset=utf-8' });
      return res.end(read(FILES[url.pathname]));
    }
    res.writeHead(404).end('Not found');
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'text/plain' }).end(String(e.stack || e));
  }
}).listen(PORT, '127.0.0.1', () => console.log('Preview: http://localhost:' + PORT + '/?seed'));
