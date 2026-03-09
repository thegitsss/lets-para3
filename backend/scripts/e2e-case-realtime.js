const http = require("http");
const path = require("path");
const express = require("express");
const cookieParser = require("cookie-parser");
const puppeteer = require("puppeteer");

const CASE_ID = "507f1f77bcf86cd799439199";
const ATTORNEY_ID = "507f1f77bcf86cd799439111";
const PARALEGAL_ID = "507f1f77bcf86cd799439112";

const USERS = {
  attorney: {
    id: ATTORNEY_ID,
    _id: ATTORNEY_ID,
    role: "attorney",
    status: "approved",
    firstName: "Alex",
    lastName: "Stone",
    email: "samanthasider+attorney@gmail.com",
  },
  paralegal: {
    id: PARALEGAL_ID,
    _id: PARALEGAL_ID,
    role: "paralegal",
    status: "approved",
    firstName: "Priya",
    lastName: "Ng",
    email: "samanthasider+paralegal@gmail.com",
  },
};

const nowIso = () => new Date().toISOString();

function buildCasePayload() {
  return {
    id: CASE_ID,
    _id: CASE_ID,
    title: "Realtime Validation Case",
    details: "Case used to verify SSE + polling realtime behavior.",
    practiceArea: "immigration",
    status: "in progress",
    escrowStatus: "funded",
    escrowIntentId: "pi_realtime_123",
    paymentReleased: false,
    archived: false,
    readOnly: false,
    totalAmount: 80000,
    lockedTotalAmount: 80000,
    currency: "usd",
    attorney: USERS.attorney,
    attorneyId: USERS.attorney,
    paralegal: USERS.paralegal,
    paralegalId: USERS.paralegal,
    tasks: [{ title: "Draft and send first filing", completed: false }],
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
}

function startStubServer() {
  const app = express();
  const frontendRoot = path.resolve(__dirname, "../../frontend");
  let activeCase = buildCasePayload();
  const messages = [];
  const documents = [];
  let streamEnabled = true;
  const streamClients = new Set();

  app.use(cookieParser());
  app.use(express.json({ limit: "1mb" }));
  app.use(express.static(frontendRoot));

  function broadcast(eventName, payload = {}) {
    const frame = `event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const client of streamClients) {
      try {
        client.write(frame);
      } catch {
        streamClients.delete(client);
      }
    }
  }

  app.get("/api/csrf", (_req, res) => {
    res.json({ csrfToken: "e2e-csrf-token" });
  });

  app.get("/api/users/me", (_req, res) => {
    res.json(USERS.attorney);
  });

  app.get("/api/messages/summary", (_req, res) => {
    res.json({ items: [{ caseId: CASE_ID, unread: 0 }] });
  });

  app.get("/api/cases/my", (_req, res) => {
    res.json([
      {
        id: CASE_ID,
        _id: CASE_ID,
        title: activeCase.title,
        status: activeCase.status,
        briefSummary: activeCase.details,
        escrowStatus: activeCase.escrowStatus,
      },
    ]);
  });

  app.get("/api/cases/:caseId", (req, res) => {
    if (req.params.caseId !== CASE_ID) {
      return res.status(404).json({ error: "Case not found" });
    }
    res.json({ ...activeCase, updatedAt: nowIso() });
  });

  app.get("/api/messages/:caseId", (req, res) => {
    if (req.params.caseId !== CASE_ID) {
      return res.status(404).json({ error: "Case not found" });
    }
    res.json({ messages });
  });

  app.post("/api/messages/:caseId/read", (req, res) => {
    if (req.params.caseId !== CASE_ID) {
      return res.status(404).json({ error: "Case not found" });
    }
    res.json({ ok: true });
  });

  app.get("/api/uploads/case/:caseId", (req, res) => {
    if (req.params.caseId !== CASE_ID) {
      return res.status(404).json({ error: "Case not found" });
    }
    res.json({ files: documents });
  });

  app.get("/api/cases/:caseId/stream", (req, res) => {
    if (req.params.caseId !== CASE_ID) {
      return res.status(404).json({ error: "Case not found" });
    }
    if (!streamEnabled) {
      return res.status(503).end();
    }
    res.status(200);
    res.set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    });
    res.flushHeaders?.();
    streamClients.add(res);
    res.write(`event: ready\ndata: ${JSON.stringify({ caseId: CASE_ID, at: nowIso() })}\n\n`);

    const heartbeat = setInterval(() => {
      try {
        res.write(`event: ping\ndata: {}\n\n`);
      } catch {
        clearInterval(heartbeat);
      }
    }, 10000);

    req.on("close", () => {
      clearInterval(heartbeat);
      streamClients.delete(res);
    });
  });

  app.post("/api/test/add-message", (req, res) => {
    const text = String(req.body?.text || "").trim();
    const broadcastEvent = req.body?.broadcast !== false;
    if (!text) return res.status(400).json({ error: "text required" });
    const message = {
      _id: `msg_${messages.length + 1}`,
      caseId: CASE_ID,
      senderId: USERS.paralegal,
      senderRole: "paralegal",
      text,
      createdAt: nowIso(),
      readBy: [],
    };
    messages.push(message);
    if (broadcastEvent) {
      broadcast("messages", { at: nowIso() });
    }
    res.json({ ok: true, id: message._id });
  });

  app.post("/api/test/add-document", (req, res) => {
    const name = String(req.body?.name || "").trim();
    const broadcastEvent = req.body?.broadcast !== false;
    if (!name) return res.status(400).json({ error: "name required" });
    const doc = {
      _id: `doc_${documents.length + 1}`,
      caseId: CASE_ID,
      originalName: name,
      storageKey: `cases/${CASE_ID}/documents/${name}`,
      mimeType: "application/pdf",
      uploadedByRole: "paralegal",
      uploadedBy: USERS.paralegal,
      createdAt: nowIso(),
    };
    documents.push(doc);
    if (broadcastEvent) {
      broadcast("documents", { at: nowIso() });
    }
    res.json({ ok: true, id: doc._id });
  });

  app.post("/api/test/set-task-complete", (req, res) => {
    const completed = req.body?.completed !== false;
    const broadcastEvent = req.body?.broadcast !== false;
    activeCase = {
      ...activeCase,
      tasks: [{ title: "Draft and send first filing", completed }],
      updatedAt: nowIso(),
    };
    if (broadcastEvent) {
      broadcast("tasks", { at: nowIso() });
    }
    res.json({ ok: true, completed });
  });

  app.post("/api/test/drop-stream", (_req, res) => {
    streamEnabled = false;
    for (const client of streamClients) {
      try {
        client.end();
      } catch {}
    }
    streamClients.clear();
    res.json({ ok: true });
  });

  app.post("/api/test/restore-stream", (_req, res) => {
    streamEnabled = true;
    res.json({ ok: true });
  });

  const server = http.createServer(app);
  return new Promise((resolve) => {
    server.listen(0, () => {
      const { port } = server.address();
      resolve({ server, port });
    });
  });
}

async function api(baseUrl, pathName, body) {
  const res = await fetch(`${baseUrl}${pathName}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`POST ${pathName} failed: ${res.status} ${data?.error || ""}`.trim());
  }
  return data;
}

async function run() {
  const { server, port } = await startStubServer();
  const baseUrl = `http://localhost:${port}`;

  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
    protocolTimeout: 120_000,
  });

  const page = await browser.newPage();
  page.setDefaultTimeout(40_000);
  page.setDefaultNavigationTimeout(40_000);
  await page.evaluateOnNewDocument((user) => {
    localStorage.setItem("lpc_user", JSON.stringify(user));
    window.getStoredUser = () => user;
  }, USERS.attorney);

  try {
    await page.goto(`${baseUrl}/case-detail.html?caseId=${CASE_ID}`, {
      waitUntil: "domcontentloaded",
    });

    await page.waitForFunction(
      () => {
        const title = document.getElementById("caseTitle");
        return Boolean(title && /Realtime Validation Case/i.test(title.textContent || ""));
      },
      { timeout: 20_000 }
    );

    const initiallyDisabled = await page.$eval("#caseCompleteButton", (btn) => !!btn.disabled);
    if (!initiallyDisabled) {
      throw new Error("Expected Complete button to be locked before task completion.");
    }

    await api(baseUrl, "/api/test/add-message", {
      text: "SSE message delivered",
      broadcast: true,
    });
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll(".message-bubble .card-body p")].some((node) =>
          (node.textContent || "").includes("SSE message delivered")
        ),
      { timeout: 10_000 }
    );

    await api(baseUrl, "/api/test/add-document", {
      name: "sse-doc.pdf",
      broadcast: true,
    });
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll(".document-label")].some((node) =>
          (node.textContent || "").includes("sse-doc.pdf")
        ),
      { timeout: 10_000 }
    );

    await api(baseUrl, "/api/test/set-task-complete", {
      completed: true,
      broadcast: true,
    });
    await page.waitForFunction(
      () => {
        const btn = document.getElementById("caseCompleteButton");
        return Boolean(btn && !btn.disabled);
      },
      { timeout: 10_000 }
    );

    await api(baseUrl, "/api/test/drop-stream", {});
    await new Promise((resolve) => setTimeout(resolve, 500));

    await api(baseUrl, "/api/test/add-message", {
      text: "Polling fallback message",
      broadcast: false,
    });

    await page.waitForFunction(
      () =>
        [...document.querySelectorAll(".message-bubble .card-body p")].some((node) =>
          (node.textContent || "").includes("Polling fallback message")
        ),
      { timeout: 12_000 }
    );

    console.log("SSE + polling fallback verified in case-detail runtime.");
  } finally {
    await page.close();
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
