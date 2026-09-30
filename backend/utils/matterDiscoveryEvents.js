// Process-local invalidation stream. Persisted changes from other web or worker
// processes are mirrored into each process by realtimeProjectionBridge. No
// Matter data is sent over this channel; authenticated paralegals re-fetch
// their own authorized browse/recommendation projections.
const subscribers = new Set();

function addSubscriber(res) {
  subscribers.add(res);
  return () => subscribers.delete(res);
}

function publishMatterDiscoveryEvent(type = "matter_refresh") {
  if (!subscribers.size) return;
  const message = `event: matters\ndata: ${JSON.stringify({
    at: new Date().toISOString(),
    type: String(type || "matter_refresh"),
  })}\n\n`;
  subscribers.forEach((res) => {
    try {
      res.write(message);
    } catch {
      subscribers.delete(res);
    }
  });
}

module.exports = {
  addSubscriber,
  publishMatterDiscoveryEvent,
};
