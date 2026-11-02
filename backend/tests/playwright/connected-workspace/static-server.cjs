"use strict";
// Test-only server: actual checked-in frontend bytes, no application database,
// credentials, external providers, or confidential user information.
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "../../../../frontend");
const port = Number(process.env.LPC_CONNECTED_TEST_PORT || 19076);
if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid test server port");
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf", ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon" };
const server = http.createServer((req, res) => {
  try {
    const url = new URL(req.url, "http://127.0.0.1:" + port), decoded = decodeURIComponent(url.pathname);
    const target = path.resolve(root, "." + decoded);
    if (req.method !== "GET" || target !== root && !target.startsWith(root + path.sep) || decoded.includes("\0")) { res.writeHead(403).end(); return; }
    const stat = fs.statSync(target);
    if (!stat.isFile()) { res.writeHead(404).end(); return; }
    res.writeHead(200, { "content-type": types[path.extname(target)] || "application/octet-stream", "cache-control": "no-store" });
    fs.createReadStream(target).pipe(res);
  } catch { res.writeHead(404).end(); }
});
server.listen(port, "127.0.0.1");
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.close(() => process.exit(0)));
