self.addEventListener("push", (event) => {
  if (!event.data) return;
  let data = {};
  try {
    data = event.data.json();
  } catch (_) {
    data = { type: "system", payload: { message: event.data.text() } };
  }
  const title = buildTitle(data);
  const body = buildBody(data);
  const options = {
    body,
    badge: "/assets/icons/bell.png",
    icon: "/assets/icons/icon-192.png",
    data,
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = "/dashboard-paralegal.html";
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.includes(targetUrl) && "focus" in client) {
          return client.focus();
        }
      }
      if (clients.openWindow) {
        return clients.openWindow(targetUrl);
      }
      return null;
    })
  );
});

function buildTitle(data = {}) {
  switch (data.type) {
    case "message":
      return "New message on LPC";
    case "case_invite":
      return "New case invitation";
    case "case_update":
      return "Case updated";
    case "payout_released":
      return "Payout released";
    default:
      return "LPC notification";
  }
}

function buildBody(data = {}) {
  const payload = data.payload || {};
  switch (data.type) {
    case "message":
      return `From ${payload.fromName || "a user"}`;
    case "case_invite":
      return `Invited to ${payload.caseTitle || "a case"}`;
    case "case_update":
      return `${payload.caseTitle || "Case"} changed`;
    case "payout_released":
      return `Payout processed${payload.amount ? ` (${payload.amount})` : ""}`;
    default:
      return payload.message || "Open LPC to view.";
  }
}
