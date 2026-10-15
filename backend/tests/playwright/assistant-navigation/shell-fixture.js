const { test: base } = require("playwright/test");
const http = require("node:http"), fs = require("node:fs/promises"), path = require("node:path");
const sourceRoot = path.resolve(process.env.LPC_HELP_SOURCE_ROOT || path.join(__dirname, "../../../.."));
const mime = { ".html": "text/html", ".mjs": "application/javascript", ".js": "application/javascript", ".css": "text/css", ".woff2": "font/woff2", ".woff": "font/woff", ".svg": "image/svg+xml", ".png": "image/png" };
const test = base.extend({
  shellServer: async ({}, use) => {
    const frontend = path.join(sourceRoot, "frontend");
    const server = http.createServer(async (req, res) => {
      try {
        const pathname = decodeURIComponent(new URL(req.url, "http://127.0.0.1").pathname);
        const file = path.resolve(frontend, `.${pathname}`);
        if (req.method !== "GET" || !(pathname.startsWith("/assets/") || ["/attorney-v2.html", "/paralegal-v2.html", "/login.html"].includes(pathname)) || !file.startsWith(`${frontend}${path.sep}`)) { res.writeHead(404); res.end(); return; }
        const content = await fs.readFile(file);
        res.writeHead(200, { "Content-Type": mime[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-store" }); res.end(content);
      } catch { res.writeHead(404); res.end(); }
    });
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    try { await use(`http://127.0.0.1:${server.address().port}`); }
    finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  },
  baseURL: async ({ shellServer }, use) => use(shellServer),
});
test.beforeEach(async ({ context, shellServer }) => {
  await context.route("**/*", route => new URL(route.request().url()).origin === shellServer ? route.continue() : route.abort("blockedbyclient"));
});
module.exports = { test };
