// frontend/assets/scripts/views/messages.js
// Cookie-based auth; summaries; voice notes with presign→S3 PUT→message record; signed playback.

import { API_BASE, j as jBase } from "../helpers.js";

const $ = (s) => document.querySelector(s);
const threadListEl = $("#thread-list");
const msgListEl = $("#message-list");
const inputEl = $("#message-input");
const aiPanel = $("#ai-helper");
const aiOut = $("#ai-output");
const sumMenu = $("#summarize-menu");
const sumStart = $("#sum-start");
const sumEnd = $("#sum-end");

let currentThread = null;
let CSRF = null;
const CURRENT_USER_ID = (() => {
  try {
    const user = typeof window.getStoredUser === "function" ? window.getStoredUser() : null;
    return user?.id || user?._id || "";
  } catch {
    return "";
  }
})();

const MESSAGE_JUMP_KEY = "lpc_message_jump";
let pendingJump = consumeMessageJump();

async function getCSRF() {
  if (CSRF) return CSRF;
  try {
    const r = await fetch("/api/csrf", { credentials: "include" });
    const j = await r.json().catch(() => ({}));
    CSRF = j.csrfToken || "";
  } catch { CSRF = ""; }
  return CSRF;
}

// --- fetch helper (always send cookies; JSON if body is object) --------------
async function j(url, opts = {}) {
  const o = { credentials: "include", headers: {}, ...opts };
  if (o.body && typeof o.body === "object" && !(o.body instanceof FormData)) {
    o.headers["Content-Type"] = "application/json";
    o.body = JSON.stringify(o.body);
  }
  // Add CSRF if we have it (harmless when not required)
  if (!o.headers["X-CSRF-Token"]) {
    const tok = await getCSRF();
    if (tok) o.headers["X-CSRF-Token"] = tok;
  }
  try {
    return await (jBase ? jBase(url, o) : (await fetch(url, o)).json());
  } catch (e) {
    const r = await fetch(url, o);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const ct = r.headers.get("content-type") || "";
    return ct.includes("application/json") ? r.json() : r.text();
  }
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;" }[c]));
}

async function ensureAuthed() {
  try {
    const me = await j(`${API_BASE}/users/me`);
    if (!me?.id && !me?._id) throw new Error("no user");
  } catch {
    location.href = "login.html";
  }
}

// --- Threads / Messages ------------------------------------------------------
async function loadThreads(q = "") {
  if (!threadListEl) return [];
  threadListEl.textContent = "Loading…";
  try {
    const data = await j(`${API_BASE}/messages/threads${q ? `?q=${encodeURIComponent(q)}` : ""}`);
    const list = data.threads || [];
    threadListEl.innerHTML =
      list
        .map(
          (t) => `
        <button class="lp-thread" data-id="${t.id}" style="display:block;width:100%;text-align:left;border:1px solid #eee;border-radius:10px;padding:.55rem .6rem;background:#fff;margin-bottom:6px;">
          <div style="font-weight:600">${escapeHtml(t.title || "Thread")}</div>
          <div style="color:#666;font-size:.85rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(t.lastMessageSnippet || "")}</div>
        </button>`
        )
        .join("") || "<div>No threads</div>";
    return list;
  } catch {
    threadListEl.innerHTML = "<div>Couldn’t load threads</div>";
    return [];
  }
}

async function openThread(id) {
  currentThread = id;
  if (!msgListEl) return;
  msgListEl.textContent = "Loading…";
  try {
    const data = await j(`${API_BASE}/messages/${id}`);
    renderMessages(id, data.messages || []);
    // mark read (best-effort)
    j(`${API_BASE}/messages/${id}/read`, { method: "POST", body: {} }).catch(() => {});
  } catch {
    msgListEl.innerHTML = "<div>Couldn’t load messages</div>";
  }
}

function messageRow(caseId, m, isMine, senderName = "Unknown User") {
  const when = new Date(m.createdAt || m._createdAt || Date.now()).toLocaleString();
  let bodyHTML = "";
  if (m.type === "audio") {
    const key = m.fileKey || m.key || "";
    const title = escapeHtml(m.fileName || "voice-note.webm");
    const transcript = m.transcript ? `<div style="margin-top:.35rem;border-top:1px dashed #e5e5e5;padding-top:.35rem;">${escapeHtml(m.transcript)}</div>` : "";
    // Lazy load a signed URL on click so we don't prefetch all
    bodyHTML = `
      <div>
        <button class="play-audio btn" data-case="${caseId}" data-key="${escapeHtml(key)}" style="padding:6px 8px;border:1px solid #e5e7eb;border-radius:8px;background:#fff;cursor:pointer">Play audio</button>
        <span class="muted" style="margin-left:6px;">${title}</span>
        <div class="audio-holder"></div>
        ${transcript}
      </div>`;
  } else {
    // default to text
    const text = escapeHtml(m.content || m.text || "");
    bodyHTML = text || "<em class='muted'>[empty]</em>";
  }

  return `
    <div class="msg" style="display:flex;gap:.5rem;margin:.4rem 0;${isMine ? "flex-direction:row-reverse;" : ""}">
      <input type="checkbox" class="pick" data-id="${m.id || m._id}" style="margin-top:.5rem;">
      <div style="background:${isMine ? "#f0f5ff" : "#fff"};border:1px solid #eee;border-radius:14px;padding:.55rem .7rem;max-width:75%;">
        <div style="font-weight:600;margin-bottom:.2rem;">${escapeHtml(senderName)}</div>
        ${bodyHTML}
        <div style="color:#888;font-size:.78rem;margin-top:.25rem;">${when}</div>
      </div>
    </div>`;
}

function renderMessages(caseId, list) {
  const uid = CURRENT_USER_ID;
  msgListEl.innerHTML = (list || [])
    .map((m) => {
      const sender = m.senderId;
      const senderId = typeof sender === "object" ? sender?._id || sender?.id : sender;
      const isMine = uid && senderId ? String(senderId) === String(uid) : false;
      const senderName =
        (typeof sender === "object"
          ? `${sender?.firstName || ""} ${sender?.lastName || ""}`.trim()
          : "") || "Unknown User";
      return messageRow(caseId, m, isMine, senderName);
    })
    .join("");
  // delegate play buttons
  msgListEl.querySelectorAll(".play-audio").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const holder = btn.parentElement?.querySelector(".audio-holder");
      if (!holder) return;
      btn.disabled = true;
      try {
        const u = new URL("/api/uploads/signed-get", location.origin);
        u.searchParams.set("caseId", btn.dataset.case || "");
        u.searchParams.set("key", btn.dataset.key || "");
        const jres = await j(u.toString(), { method: "GET" });
        const url = jres.url;
        holder.innerHTML = `<audio controls src="${escapeHtml(url)}" style="margin-top:.25rem;max-width:100%"></audio>`;
      } catch {
        holder.innerHTML = `<div style="color:#b91c1c">Could not fetch playback URL.</div>`;
      } finally {
        btn.disabled = false;
      }
    });
  });

  msgListEl.scrollTop = msgListEl.scrollHeight;
}

async function sendMessage() {
  const text = (inputEl?.value || "").trim();
  if (!text || !currentThread) return;

  // Optimistic UI
  const now = Date.now();
  const optimistic = {
    id: `tmp-${now}`,
    senderId: CURRENT_USER_ID
      ? { _id: CURRENT_USER_ID, firstName: "You" }
      : "me",
    type: "text",
    content: text,
    createdAt: now,
  };
  msgListEl.insertAdjacentHTML("beforeend", messageRow(currentThread, optimistic, true, "You"));
  msgListEl.scrollTop = msgListEl.scrollHeight;
  inputEl.value = "";

  try {
    const data = await j(`${API_BASE}/messages/${currentThread}`, {
      method: "POST",
      body: { type: "text", content: text },
    });
    // backend returns { message }
    const saved = data.message ? [savedNormalize(data.message)] : [];
    // reload the thread to get consistent ordering + read receipts
    const refetch = await j(`${API_BASE}/messages/${currentThread}`);
    renderMessages(currentThread, refetch.messages || saved);
  } catch {
    // rollback via full reload
    await openThread(currentThread);
  }
}

function savedNormalize(m) {
  return { ...m, id: m.id || m._id };
}

function pickedIds() {
  return [...document.querySelectorAll("#message-list .pick:checked")].map((x) => x.dataset.id);
}

async function summarize(mode) {
  if (!currentThread) return;
  const payload = {};
  if (mode === "daterange") {
    if (!sumStart.value || !sumEnd.value) return;
    payload.start = sumStart.value;
    payload.end = sumEnd.value;
  }
  showAIPanel();
  aiOut.textContent = "Summarizing…";
  try {
    const res = await j(`${API_BASE}/messages/${currentThread}/summary`, { method: "POST", body: payload });
    aiOut.textContent = res.summary || "No summary.";
  } catch {
    aiOut.textContent = "Summary unavailable.";
  }
}

// ---- Voice Notes: recorder + presign + upload + message ---------------------
async function presignUpload({ contentType, ext, folder }) {
  return j("/api/uploads/presign", {
    method: "POST",
    body: { contentType, ext, folder },
  });
}

async function uploadToS3(url, blob, contentType) {
  const r = await fetch(url, { method: "PUT", headers: { "Content-Type": contentType }, body: blob });
  if (!r.ok) throw new Error("S3 upload failed");
}

async function createVoiceMessage(caseId, { fileKey, fileName, mimeType, transcript }) {
  return j(`${API_BASE}/messages/${caseId}/voice`, {
    method: "POST",
    body: { fileKey, fileName, mimeType, transcript },
  });
}

// injected UI inside the AI panel
function ensureRecorderUI() {
  if (!aiPanel) return;
  if (document.getElementById("rec-ui")) return;

  const cssId = "rec-styles";
  if (!document.getElementById(cssId)) {
    const s = document.createElement("style");
    s.id = cssId;
    s.textContent = `
      .rec-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:.5rem 0}
      .rec-badge{display:inline-flex;align-items:center;gap:6px;border:1px solid #e5e7eb;border-radius:999px;padding:4px 10px;background:#fff}
      .rec-dot{width:10px;height:10px;border-radius:50%;background:#ef4444;animation:blink 1.1s infinite}
      @keyframes blink{0%,60%{opacity:1}61%,100%{opacity:.2}}
      .rec-meter{width:180px;height:12px;border-radius:8px;background:#f3f4f6;overflow:hidden;border:1px solid #e5e7eb}
      .rec-fill{height:100%;width:0%}
      .rec-timer{font-family:ui-monospace, SFMono-Regular, Menlo, monospace}
      .rec-txt{white-space:pre-wrap;border:1px dashed #e5e7eb;border-radius:10px;padding:8px;background:#fff;max-height:140px;overflow:auto}
      .btn{padding:8px 10px;border:1px solid #e5e7eb;border-radius:8px;background:#fff;cursor:pointer}
      .btn.primary{background:#111827;color:#fff;border-color:#111827}
    `;
    document.head.appendChild(s);
  }

  aiPanel.style.display = "block";
  aiPanel.innerHTML = `
    <div id="rec-ui">
      <div style="font-weight:700;margin-bottom:.25rem;">AI Helper / Voice Notes</div>

      <div class="rec-row">
        <span class="rec-badge"><span class="rec-dot"></span><span id="rec-status">Idle</span></span>
        <span class="rec-timer" id="rec-timer">00:00</span>
        <div class="rec-meter"><div class="rec-fill" id="rec-fill"></div></div>
        <button class="btn primary" id="voice-note-btn">Record Voice Note</button>
        <button class="btn" id="ai-helper-close">Close</button>
      </div>

      <div style="font-weight:600;margin-top:.25rem;">Transcript (live)</div>
      <div id="rec-txt" class="rec-txt">(speech-to-text will appear here if supported)</div>

      <div style="font-weight:600;margin-top:.5rem;">Output</div>
      <div id="ai-output" style="border:1px solid #e5e7eb;border-radius:10px;padding:8px;background:#fff;"></div>
    </div>
  `;
}

function showAIPanel() {
  ensureRecorderUI();
}

let mediaRec = null;
let chunks = [];
let meterRAF = 0;
let audioCtx = null;
let analyser = null;
let sourceNode = null;
let startTs = 0;
let timerId = 0;

// speech recognition
const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null;
let recActive = false;
let recTextFinal = "";
let recTextInterim = "";

function updateTimer() {
  const ms = Date.now() - startTs;
  const sec = Math.floor(ms / 1000);
  const m = String(Math.floor(sec / 60)).padStart(2, "0");
  const s = String(sec % 60).padStart(2, "0");
  const tEl = $("#rec-timer");
  if (tEl) tEl.textContent = `${m}:${s}`;
}

function drawMeter() {
  if (!analyser) return;
  const buf = new Uint8Array(analyser.fftSize);
  analyser.getByteTimeDomainData(buf);
  let sum = 0;
  for (let i = 0; i < buf.length; i++) {
    const v = (buf[i] - 128) / 128;
    sum += v * v;
  }
  const rms = Math.sqrt(sum / buf.length);
  const pct = Math.min(100, Math.max(0, Math.round(rms * 180)));
  const fill = $("#rec-fill");
  if (fill) {
    fill.style.width = `${pct}%`;
    fill.style.background = pct > 60 ? "#ef4444" : pct > 30 ? "#f59e0b" : "#10b981";
  }
  meterRAF = requestAnimationFrame(drawMeter);
}

function setStatus(s) {
  const el = $("#rec-status");
  if (el) el.textContent = s;
}

function setTranscriptBox() {
  const box = $("#rec-txt");
  if (!box) return;
  const text =
    (recTextFinal ? recTextFinal + "\n" : "") +
    (recTextInterim ? "… " + recTextInterim : "");
  box.textContent = text || "(speech-to-text will appear here if supported)";
}

async function startRecording() {
  if (mediaRec) return;
  showAIPanel();

  const btn = $("#voice-note-btn");
  const out = $("#ai-output");
  const txtBox = $("#rec-txt");
  chunks = [];
  recTextFinal = "";
  recTextInterim = "";
  setTranscriptBox();
  out.textContent = "Recording… click Stop to upload.";
  setStatus("Recording");

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    // Audio meter setup
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    sourceNode = audioCtx.createMediaStreamSource(stream);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 1024;
    sourceNode.connect(analyser);
    meterRAF = requestAnimationFrame(drawMeter);

    // Timer
    startTs = Date.now();
    updateTimer();
    timerId = setInterval(updateTimer, 500);

    // Recorder
    mediaRec = new MediaRecorder(stream, { mimeType: "audio/webm" });
    mediaRec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    mediaRec.onstop = async () => {
      try {
        if (!currentThread || !chunks.length) return;
        setStatus("Uploading…");
        const blob = new Blob(chunks, { type: "audio/webm" });
        const fileName = `voice-${Date.now()}.webm`;

        // 1) presign
        const { url, key } = await presignUpload({
          contentType: "audio/webm",
          ext: "webm",
          folder: "voice-notes",
        });

        // 2) PUT to S3
        await uploadToS3(url, blob, "audio/webm");

        // 3) create message with fileKey + transcript
        const transcript = (recTextFinal + (recTextInterim ? " " + recTextInterim : "")).trim();
        await createVoiceMessage(currentThread, {
          fileKey: key,
          fileName,
          mimeType: "audio/webm",
          transcript,
        });

        // 4) refresh thread
        const refetch = await j(`${API_BASE}/messages/${currentThread}`);
        renderMessages(currentThread, refetch.messages || []);
        out.textContent = "Voice note added.";
      } catch (e) {
        out.textContent = "Failed to add voice note.";
      } finally {
        cleanupRecording();
      }
    };
    mediaRec.start(300);

    // Speech recognition (best-effort)
    if (SpeechRec) {
      rec = new SpeechRec();
      rec.lang = "en-US";
      rec.interimResults = true;
      rec.continuous = true;

      rec.onresult = (ev) => {
        for (let i = ev.resultIndex; i < ev.results.length; i++) {
          const res = ev.results[i];
          if (res.isFinal) {
            recTextFinal += (recTextFinal ? " " : "") + res[0].transcript.trim();
            recTextInterim = "";
          } else {
            recTextInterim = res[0].transcript.trim();
          }
        }
        setTranscriptBox();
      };
      rec.onend = () => {
        if (recActive) try { rec.start(); } catch {}
      };
      try {
        rec.start();
        recActive = true;
        txtBox && (txtBox.style.opacity = "1");
      } catch {
        // ignore
      }
    } else if (txtBox) {
      txtBox.textContent = "(Speech recognition not supported in this browser.)";
      txtBox.style.opacity = "0.8";
    }

    if (btn) btn.textContent = "Stop";
  } catch {
    const out = $("#ai-output");
    out.textContent = "Mic permission denied or unsupported.";
    cleanupRecording(true);
  }
}

function stopRecording() {
  if (!mediaRec) return;
  try {
    if (rec && recActive) {
      recActive = false;
      try { rec.stop(); } catch {}
    }
    if (mediaRec.state !== "inactive") mediaRec.stop();
  } catch {
    cleanupRecording(true);
  }
}

function cleanupRecording(abort = false) {
  setStatus("Idle");
  cancelAnimationFrame(meterRAF);
  meterRAF = 0;
  clearInterval(timerId);
  timerId = 0;
  const btn = $("#voice-note-btn");
  if (btn) btn.textContent = "Record Voice Note";

  try { mediaRec?.stream?.getTracks()?.forEach((t) => t.stop()); } catch {}
  mediaRec = null;
  sourceNode && sourceNode.disconnect?.();
  analyser = null;
  try { audioCtx?.close?.(); } catch {}
  audioCtx = null;

  if (abort) {
    chunks = [];
    const out = $("#ai-output");
    out.textContent = "Recording canceled.";
  }
}

// ---- Wiring -----------------------------------------------------------------
function wireEvents() {
  document.addEventListener("click", (e) => {
    if (e.target.classList?.contains("lp-thread")) openThread(e.target.dataset.id);
    if (e.target.id === "send-btn") sendMessage();

    if (e.target.id === "ai-helper-btn") {
      showAIPanel();
    }
    if (e.target.id === "ai-helper-close") {
      if (mediaRec) stopRecording();
      aiPanel.style.display = "none";
    }

    if (e.target.id === "summarize-btn") {
      sumMenu.style.display = sumMenu.style.display === "none" ? "block" : "none";
    }
    if (e.target.closest?.("#summarize-menu")) {
      const mode = e.target.dataset.mode;
      if (!mode) return;
      sumMenu.style.display = "none";
      if (mode === "daterange") {
        sumStart.style.display = "";
        sumEnd.style.display = "";
      } else {
        sumStart.style.display = "none";
        sumEnd.style.display = "none";
      }
      summarize(mode);
    }

    if (e.target.id === "voice-note-btn") {
      if (!mediaRec) startRecording();
      else stopRecording();
    }
  });

  const searchEl = $("#msg-search");
  if (searchEl) {
    let t;
    searchEl.addEventListener("input", () => {
      clearTimeout(t);
      t = setTimeout(() => loadThreads(searchEl.value.trim()), 250);
    });
  }

  inputEl?.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });
}

async function init() {
  if (!threadListEl || !msgListEl) return;
  await ensureAuthed();
  const threads = await loadThreads();
  const targetId = (pendingJump && pendingJump.caseId) || threads[0]?.id;
  pendingJump = null;
  if (targetId) {
    openThread(targetId);
  }
  wireEvents();
}
document.addEventListener("DOMContentLoaded", init);

function consumeMessageJump() {
  try {
    const raw = sessionStorage.getItem(MESSAGE_JUMP_KEY);
    if (!raw) return null;
    sessionStorage.removeItem(MESSAGE_JUMP_KEY);
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
