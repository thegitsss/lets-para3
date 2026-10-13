import { secureFetch } from "../../auth.js";

function buildQuery(params = {}) {
  const search = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value === undefined || value === null || value === "") return;
    search.set(key, String(value));
  });
  const qs = search.toString();
  return qs ? `?${qs}` : "";
}

async function readJSON(url) {
  const res = await secureFetch(url, {
    headers: { Accept: "application/json" },
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(payload?.error || payload?.message || "Unable to load incident data.");
  }
  return payload;
}

async function writeJSON(url, body) {
  const res = await secureFetch(url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body || {}),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(payload?.error || payload?.message || "Unable to update incident data.");
  }
  return payload;
}

export function fetchIncidentList(params = {}) {
  return readJSON(`/api/admin/incidents${buildQuery(params)}`);
}

export function fetchIncidentDetail(id) {
  return readJSON(`/api/admin/incidents/${encodeURIComponent(id)}`);
}

export function fetchIncidentTimeline(id, params = {}) {
  return readJSON(`/api/admin/incidents/${encodeURIComponent(id)}/timeline${buildQuery(params)}`);
}

export function fetchIncidentClusters(params = {}) {
  return readJSON(`/api/admin/incidents/clusters${buildQuery(params)}`);
}

export function fetchIncidentControlRoomView() {
  return readJSON("/api/admin/ai/control-room/incidents");
}

export function decideIncidentApproval(id, approvalId, body = {}) {
  return writeJSON(`/api/admin/incidents/${encodeURIComponent(id)}/approvals/${encodeURIComponent(approvalId)}/decision`, body);
}
