// Deliberately static: every security response in security.spec.js is synthetic.
// Consequential authorization and CAS checks live in the real route suite.
const http = require("http");
const fs = require("fs");
const path = require("path");
const root = path.resolve(__dirname, "../../../../frontend");
const types = { ".html":"text/html", ".js":"text/javascript", ".mjs":"text/javascript", ".css":"text/css", ".svg":"image/svg+xml", ".woff2":"font/woff2", ".png":"image/png" };
http.createServer((request,response) => {
  const url = new URL(request.url, "http://127.0.0.1"), file = url.pathname === "/assets/vendor/simplewebauthn-13.3.0.js" ? path.resolve(__dirname, "../../../node_modules/@simplewebauthn/browser/dist/bundle/index.umd.min.js") : path.resolve(root, `.${decodeURIComponent(url.pathname)}`);
  if (!(file.startsWith(`${root}${path.sep}`) || url.pathname === "/assets/vendor/simplewebauthn-13.3.0.js") || !fs.existsSync(file) || !fs.statSync(file).isFile()) { response.writeHead(404); response.end("Not found"); return; }
  response.writeHead(200, {"Content-Type": types[path.extname(file)] || "application/octet-stream", "Cache-Control":"no-store"}); fs.createReadStream(file).pipe(response);
}).listen(5287,"127.0.0.1");
