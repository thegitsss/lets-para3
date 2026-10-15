const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");

const OWNER = "111111111111111111111111";
const OTHER = "222222222222222222222222";
const sourceRoot = path.resolve(process.env.LPC_NOTIFICATION_SOURCE_ROOT || path.join(__dirname, "../../../.."));
const mime = { ".html": "text/html", ".mjs": "application/javascript", ".js": "application/javascript", ".css": "text/css", ".woff2": "font/woff2", ".woff": "font/woff", ".svg": "image/svg+xml" };
const idFor = number => number.toString(16).padStart(24, "0");
function items(count, { owner = OWNER, readEvery = 0, prefix = "Update" } = {}) {
  return Array.from({ length: count }, (_, index) => ({
    id: idFor(index + 1), owner,
    type: "case_update", available: true,
    message: `${prefix} ${index + 1}: the Matter has an update`,
    read: readEvery > 0 && (index + 1) % readEvery === 0,
    isRead: readEvery > 0 && (index + 1) % readEvery === 0,
    createdAt: new Date(Date.UTC(2026, 8, 1, 12, 0, index)).toISOString(),
    action: { label: "View Matter", href: `#/matter/${idFor(index + 1)}` },
    context: { caseId: idFor(index + 1) },
  })).reverse();
}

async function startServer() {
  const state = { records: [], requests: [], faults: [], override: null, stallReads: false, streams: new Set(), held: new Set() };
  function json(res, status, value) {
    if (res.destroyed) return;
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(value));
  }
  function holdNext(method, pathname) {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    state.faults.push({ method, pathname, gate });
    return release;
  }
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://127.0.0.1");
      if (url.pathname === "/api/notifications/stream") {
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
        res.write("event: ready\ndata: {}\n\n");
        const entry = { res, owner: String(req.headers.cookie || "").match(/(?:^|;\s*)mock_owner=([^;]+)/)?.[1] || "" };
        state.streams.add(entry);
        req.on("close", () => state.streams.delete(entry));
        return;
      }
      if (url.pathname.startsWith("/api/")) {
        let raw = "";
        for await (const chunk of req) raw += chunk;
        const body = raw ? JSON.parse(raw) : {};
        const owner = String(req.headers.cookie || "").match(/(?:^|;\s*)mock_owner=([^;]+)/)?.[1] || "";
        const expected = req.method === "GET" ? url.searchParams.get("expectedOwnerId") : body.expectedOwnerId;
        state.requests.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body, owner });
        if (expected && expected !== owner) return json(res, 403, { code: "ACCOUNT_CHANGED", message: "Account changed" });
        if (state.stallReads && req.method === "GET") { state.held.add(res); res.on("close", () => state.held.delete(res)); return; }
        if (state.override && req.method === "GET") {
          const value = state.override(url.pathname);
          if (value) return json(res, value.status || 200, value.body);
        }
        const faultIndex = state.faults.findIndex(fault => fault.method === req.method && fault.pathname === url.pathname);
        if (faultIndex >= 0) {
          const fault = state.faults.splice(faultIndex, 1)[0];
          if (fault.gate) await fault.gate;
          if (fault.body !== undefined || fault.status) return json(res, fault.status || 200, fault.body || { message: "Synthetic failure" });
        }
        const records = state.records.filter(item => item.owner === owner);
        if (req.method === "GET" && url.pathname === "/api/csrf") return json(res, 200, { csrfToken: "local-fixture-token" });
        if (req.method === "GET" && url.pathname.endsWith("/unread-count")) return json(res, 200, { count: records.filter(item => !item.read && !item.isRead).length });
        if (req.method === "GET" && url.pathname === "/api/notifications/page") {
          const unread = url.searchParams.get("unread") === "1";
          let selected = records.filter(item => !unread || (!item.read && !item.isRead));
          const cursor = url.searchParams.get("cursor");
          if (cursor) {
            const position = JSON.parse(Buffer.from(cursor, "base64url").toString());
            if (position.owner !== owner || position.unread !== unread) return json(res, 400, { message: "Invalid fixture cursor" });
            selected = selected.filter(item => item.id < position.id);
          }
          const limit = Number(url.searchParams.get("limit") || 50);
          const visible = selected.slice(0, limit);
          const hasMore = selected.length > limit;
          const nextCursor = hasMore ? Buffer.from(JSON.stringify({ owner, unread, id: visible.at(-1).id })).toString("base64url") : null;
          return json(res, 200, { items: visible.map(({ owner: _owner, ...item }) => item), nextCursor, hasMore });
        }
        if (req.method === "GET" && url.pathname === "/api/notifications") return json(res, 200, records.slice(0, 100));
        if (req.method === "POST") {
          const all = url.pathname === "/api/notifications/read-all";
          const match = url.pathname.match(/^\/api\/notifications\/([a-f\d]{24})\/(read|unread)$/);
          for (const item of records) if (all || item.id === match?.[1]) { item.read = all || match?.[2] === "read"; item.isRead = item.read; }
          return json(res, 200, { success: true });
        }
        if (req.method === "DELETE") {
          const all = url.pathname === "/api/notifications";
          const id = url.pathname.split("/").at(-1);
          state.records = state.records.filter(item => item.owner !== owner || (!all && item.id !== id));
          return json(res, 200, { success: true });
        }
        return json(res, 404, { message: "Unimplemented fixture endpoint" });
      }
      const fixture = url.pathname === "/fixture.html" ? path.join(__dirname, "fixture.html") : url.pathname === "/legacy-fixture.html" ? path.join(__dirname, "legacy-fixture.html") : url.pathname === "/__fixture__/fixture.mjs" ? path.join(__dirname, "fixture.mjs") : null;
      const assets = path.join(sourceRoot, "frontend", "assets");
      const file = fixture || path.resolve(sourceRoot, "frontend", "." + decodeURIComponent(url.pathname));
      if (!fixture && (!url.pathname.startsWith("/assets/") || !file.startsWith(assets + path.sep))) { res.writeHead(404); res.end(); return; }
      const data = await fs.readFile(file);
      res.writeHead(200, { "Content-Type": mime[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-store" });
      res.end(data);
    } catch (error) { json(res, 500, { message: error.message }); }
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return {
    state, holdNext, url: `http://127.0.0.1:${server.address().port}`,
    emit(owner = OWNER, type = "notification_record_refresh") { for (const entry of state.streams) if (entry.owner === owner) entry.res.write(`event: notifications\ndata: ${JSON.stringify({ type })}\n\n`); },
    disconnect() { for (const entry of state.streams) entry.res.end(); },
    async close() { for (const entry of state.streams) entry.res.end(); for (const res of state.held) res.end(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); },
  };
}

module.exports = { OWNER, OTHER, idFor, items, startServer };
