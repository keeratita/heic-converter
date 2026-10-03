import http from 'http';
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { pipeline } from 'stream';
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

// Text-like types that benefit from gzip/brotli (the .wasm dominates the payload).
const COMPRESSIBLE_EXTENSIONS = new Set(['.html', '.css', '.js', '.mjs', '.wasm', '.svg', '.json']);

// Exact-match routes (URL path -> file on disk).
const EXACT_ROUTES = new Map([
  ['/', path.join(__dirname, 'index.html')],
  ['/index.html', path.join(__dirname, 'index.html')],
  ['/sandbox.js', path.join(__dirname, 'sandbox.js')],
  ['/api-test.html', path.join(__dirname, 'api-test.html')],
  ['/api-test.js', path.join(__dirname, 'api-test.js')],
  ['/worker.js', path.join(__dirname, 'worker.js')],
  // GitHub Pages demo (docs/) — served with ./dist/ next to it, like the
  // deployed site artifact. '/demo' (no slash) redirects to '/demo/' below:
  // relative asset URLs (./demo.js, ./dist/*, ./worker.js) must resolve
  // under /demo/, or the demo's JS silently 404s.
  ['/demo/', path.join(ROOT_DIR, 'docs/index.html')],
  ['/demo/demo.js', path.join(ROOT_DIR, 'docs/demo.js')],
  ['/demo/worker.js', path.join(ROOT_DIR, 'docs/worker.js')],
]);

// Prefix routes: [prefix, resolver(url) -> file path].
const PREFIX_ROUTES = [
  ['/demo/dist/', (reqUrl) => path.join(ROOT_DIR, reqUrl.slice('/demo'.length))],
  ['/dist/', (reqUrl) => path.join(ROOT_DIR, reqUrl)],
  ['/test/fixtures/', (reqUrl) => path.join(ROOT_DIR, reqUrl)],
];

function resolveRoute(reqUrl) {
  const exact = EXACT_ROUTES.get(reqUrl);
  if (exact) {
    return exact;
  }
  for (const [prefix, resolvePath] of PREFIX_ROUTES) {
    if (reqUrl.startsWith(prefix)) {
      return resolvePath(reqUrl);
    }
  }
  return null;
}

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

  // '/demo' without a trailing slash would resolve the page's relative
  // assets (./demo.js) against the root and 404 them; canonicalize.
  if (reqUrl === '/demo') {
    res.writeHead(302, { Location: '/demo/' });
    res.end();
    return;
  }

  const filePath = resolveRoute(reqUrl);
  if (!filePath) {
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

    let encodedPath = null;
    let transform = null;
    let contentEncoding = null;
    if (COMPRESSIBLE_EXTENSIONS.has(ext)) {
      const acceptEncoding = req.headers['accept-encoding'] || '';
      const wantsBr = /\bbr\b/.test(acceptEncoding);
      const wantsGzip = /\bgzip\b/.test(acceptEncoding);
      // Prefer the pre-compressed artifacts emitted by the build; fall back
      // to compressing on the fly so the sandbox mirrors what a CDN does.
      if (wantsBr && fs.existsSync(`${resolvedPath}.br`)) {
        encodedPath = `${resolvedPath}.br`;
        contentEncoding = 'br';
      } else if (wantsGzip && fs.existsSync(`${resolvedPath}.gz`)) {
        encodedPath = `${resolvedPath}.gz`;
        contentEncoding = 'gzip';
      } else if (wantsBr) {
        transform = zlib.createBrotliCompress();
        contentEncoding = 'br';
      } else if (wantsGzip) {
        transform = zlib.createGzip();
        contentEncoding = 'gzip';
      }
    }

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

    if (contentEncoding) {
      headers['Content-Encoding'] = contentEncoding;
      headers['Vary'] = 'Accept-Encoding';
    }

    res.writeHead(200, headers);

    // stream.pipeline (not .pipe) so a mid-stream error — or the browser
    // disconnecting early — tears down every stream in the chain instead of
    // leaking file descriptors and unobserved 'error' events.
    const streams = [fs.createReadStream(encodedPath ?? resolvedPath)];
    if (transform) {
      streams.push(transform);
    }
    streams.push(res);
    pipeline(...streams, (err) => {
      if (!err) {
        return;
      }
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Internal Server Error');
      } else {
        res.destroy();
      }
    });
  });
});

// Local dev server only: never bind to non-loopback interfaces.
server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n🚀 CSP Sandbox Server running at: http://localhost:${PORT}`);
  console.log(`🔒 Content-Security-Policy is active.`);
  console.log(`📂 Serving sandbox from: test/browser/index.html`);
  console.log(`Press Ctrl+C to stop.\n`);
});
