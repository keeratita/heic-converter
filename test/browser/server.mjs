import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '../..');

const PORT = 3000;

// MIME types lookup
const MIME_TYPES = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.json': 'application/json'
};

const server = http.createServer((req, res) => {
  // Parse URL path
  let reqUrl = req.url || '/';
  // Remove query params
  reqUrl = reqUrl.split('?')[0];

  // Reject path traversal outright: every matched route stays under ROOT_DIR,
  // but a `..` segment could otherwise read ANY repository file.
  if (reqUrl.split('/').includes('..')) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden');
    return;
  }

  let filePath;

  // Route mapping
  if (reqUrl === '/' || reqUrl === '/index.html') {
    filePath = path.join(__dirname, 'index.html');
  } else if (reqUrl === '/sandbox.js') {
    filePath = path.join(__dirname, 'sandbox.js');
  } else if (reqUrl === '/demo' || reqUrl === '/demo/') {
    // GitHub Pages demo (docs/) — served with ./dist/ next to it, like the
    // deployed site artifact.
    filePath = path.join(ROOT_DIR, 'docs/index.html');
  } else if (reqUrl === '/demo/demo.js') {
    filePath = path.join(ROOT_DIR, 'docs/demo.js');
  } else if (reqUrl.startsWith('/demo/dist/')) {
    filePath = path.join(ROOT_DIR, reqUrl.slice('/demo'.length));
  } else if (reqUrl.startsWith('/dist/')) {
    filePath = path.join(ROOT_DIR, reqUrl);
  } else if (reqUrl.startsWith('/test/fixtures/')) {
    filePath = path.join(ROOT_DIR, reqUrl);
  } else {
    // 404
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
    return;
  }

  // Safe file reading check (prevent directory traversal)
  const resolvedPath = path.resolve(filePath);
  if (!resolvedPath.startsWith(ROOT_DIR)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden');
    return;
  }

  fs.stat(resolvedPath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('File Not Found');
      return;
    }

    const ext = path.extname(resolvedPath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    // Headers including the strict CSP header
    const headers = {
      'Content-Type': contentType,
      // Strict Content Security Policy
      // - default-src 'self': block everything by default
      // - script-src 'self' 'wasm-unsafe-eval': Allow scripts from 'self', block eval/new Function, but allow WASM execution.
      // - style-src 'self' 'unsafe-inline' https://fonts.googleapis.com: Allow sandbox styles & Google fonts styling
      // - font-src https://fonts.gstatic.com: Allow Google fonts fonts
      // - img-src 'self' blob: data:: Allow displaying local/downloaded/converted images
      // - connect-src 'self': Allow fetching the .wasm module binary
      'Content-Security-Policy': "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' blob: data:; connect-src 'self';"
    };

    res.writeHead(200, headers);

    const stream = fs.createReadStream(resolvedPath);
    stream.on('error', () => {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Internal Server Error');
      }
    });
    stream.pipe(res);
  });
});

// Local dev server only: never bind to non-loopback interfaces.
server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n🚀 CSP Sandbox Server running at: http://localhost:${PORT}`);
  console.log(`🔒 Content-Security-Policy is active.`);
  console.log(`📂 Serving sandbox from: test/browser/index.html`);
  console.log(`Press Ctrl+C to stop.\n`);
});
