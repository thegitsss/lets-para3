const MUTATION_PIPELINE = Object.freeze([
  {
    $match: {
      operationType: { $in: ["insert", "update", "replace", "delete"] },
    },
  },
]);

function id(value) {
  if (!value) return "";
  if (typeof value === "object") return String(value._id || value.id || "");
  return String(value);
}

function defaultModels() {
  return {
    Application: require("../models/Application"),
    Block: require("../models/Block"),
    Case: require("../models/Case"),
    CaseFile: require("../models/CaseFile"),
    Event: require("../models/Event"),
    Job: require("../models/Job"),
    Message: require("../models/Message"),
    Notification: require("../models/Notification"),
    User: require("../models/User"),
  };
}

function defaultPublishers() {
  return {
    publishAllCaseEvents: require("../utils/caseEvents").publishAllCaseEvents,
    publishAllNotificationEvents: require("../utils/notificationEvents").publishAllNotificationEvents,
    publishCaseEvent: require("../utils/caseEvents").publishCaseEvent,
    publishCaseProjectionRefresh: require("../utils/caseProjectionEvents").publishCaseProjectionRefresh,
    publishMatterDiscoveryEvent: require("../utils/matterDiscoveryEvents").publishMatterDiscoveryEvent,
    publishNotificationEvent: require("../utils/notificationEvents").publishNotificationEvent,
  };
}

function eventPayload(type) {
  return { at: new Date().toISOString(), type };
}

function publishUser(publishNotificationEvent, userId, type) {
  const key = id(userId);
  if (key) publishNotificationEvent(key, "notifications", eventPayload(type));
}

function leanSelection(query, projection) {
  if (!query) return Promise.resolve(null);
  const selected = typeof query.select === "function" ? query.select(projection) : query;
  return Promise.resolve(typeof selected?.lean === "function" ? selected.lean() : selected);
}

function createHandlers(publishers, models) {
  const {
    publishCaseEvent,
    publishCaseProjectionRefresh,
    publishMatterDiscoveryEvent,
    publishNotificationEvent,
  } = publishers;

  async function publishWorkspaceParticipants(document, type, caseEvent) {
    const caseId = id(document.caseId);
    if (!caseId) return;
    publishCaseEvent(caseId, caseEvent, eventPayload(type));
    const caseDoc = await models.Case.findById(caseId)
      .select("_id attorney attorneyId paralegal paralegalId pendingParalegalId withdrawnParalegalId invites.paralegalId applicants.paralegalId")
      .lean();
    if (caseDoc) publishCaseProjectionRefresh(caseDoc, type, { caseEvent: "" });
  }

  async function publishApplicationParticipants(document) {
    const type = "application_record_refresh";
    const jobId = id(document.jobId);
    if (!jobId) {
      publishUser(publishNotificationEvent, document.paralegalId, type);
      return;
    }
    const job = await leanSelection(
      models.Job?.findById?.(jobId),
      "_id attorneyId caseId"
    );
    let caseDoc = null;
    const caseId = id(job?.caseId);
    if (caseId) {
      caseDoc = await leanSelection(
        models.Case?.findById?.(caseId),
        "_id attorney attorneyId paralegal paralegalId pendingParalegalId withdrawnParalegalId invites.paralegalId applicants.paralegalId"
      );
    } else if (typeof models.Case?.findOne === "function") {
      caseDoc = await leanSelection(
        models.Case.findOne({ jobId }),
        "_id attorney attorneyId paralegal paralegalId pendingParalegalId withdrawnParalegalId invites.paralegalId applicants.paralegalId"
      );
    }
    if (caseDoc) {
      publishCaseProjectionRefresh(caseDoc, type, {
        additionalUserIds: [document.paralegalId, job?.attorneyId],
      });
      return;
    }
    publishUser(publishNotificationEvent, document.paralegalId, type);
    publishUser(publishNotificationEvent, job?.attorneyId, type);
  }

  return {
    Notification(document) {
      publishUser(publishNotificationEvent, document.userId, "notification_record_refresh");
    },
    Message(document) {
      return publishWorkspaceParticipants(document, "message_record_refresh", "messages");
    },
    CaseFile(document) {
      return publishWorkspaceParticipants(document, "case_file_record_refresh", "documents");
    },
    Event(document) {
      publishUser(publishNotificationEvent, document.owner, "calendar_event_record_refresh");
      const caseId = id(document.caseId);
      if (caseId) publishCaseEvent(caseId, "deadlines", eventPayload("calendar_event_record_refresh"));
    },
    Job(document) {
      publishMatterDiscoveryEvent("matter_discovery_record_refresh");
      publishUser(publishNotificationEvent, document.attorneyId, "matter_discovery_record_refresh");
    },
    Case(document) {
      publishCaseProjectionRefresh(document, "matter_record_refresh", { discovery: true });
    },
    Application(document) {
      return publishApplicationParticipants(document);
    },
    Block(document) {
      publishUser(publishNotificationEvent, document.blockerId, "authorization_refresh");
      publishUser(publishNotificationEvent, document.blockedId, "authorization_refresh");
      publishMatterDiscoveryEvent("matter_visibility_refresh");
      const caseId = id(document.sourceCaseId);
      if (caseId) publishCaseEvent(caseId, "case", eventPayload("authorization_refresh"));
    },
    User(document) {
      publishUser(publishNotificationEvent, document._id, "profile_record_refresh");
    },
  };
}

function createDeleteFallbacks(publishers) {
  const {
    publishAllCaseEvents,
    publishAllNotificationEvents,
    publishCaseEvent,
    publishMatterDiscoveryEvent,
    publishNotificationEvent,
  } = publishers;

  function allNotifications(type) {
    publishAllNotificationEvents?.("notifications", eventPayload(type));
  }

  function allCases(event, type) {
    publishAllCaseEvents?.(event, eventPayload(type));
  }

  return {
    Notification() {
      allNotifications("notification_record_deleted_refresh");
    },
    Message() {
      allCases("messages", "message_record_deleted_refresh");
      allNotifications("message_record_deleted_refresh");
    },
    CaseFile() {
      allCases("documents", "case_file_record_deleted_refresh");
      allNotifications("case_file_record_deleted_refresh");
    },
    Event() {
      allCases("deadlines", "calendar_event_record_deleted_refresh");
      allNotifications("calendar_event_record_deleted_refresh");
    },
    Job() {
      publishMatterDiscoveryEvent("matter_discovery_record_deleted_refresh");
      allNotifications("matter_discovery_record_deleted_refresh");
    },
    Case(documentId) {
      const caseId = id(documentId);
      if (caseId) publishCaseEvent(caseId, "case", eventPayload("matter_record_deleted_refresh"));
      publishMatterDiscoveryEvent("matter_record_deleted_refresh");
      allNotifications("matter_record_deleted_refresh");
    },
    Application() {
      publishMatterDiscoveryEvent("application_record_deleted_refresh");
      allNotifications("application_record_deleted_refresh");
    },
    Block() {
      publishMatterDiscoveryEvent("matter_visibility_refresh");
      allNotifications("authorization_refresh");
    },
    User(documentId) {
      const userId = id(documentId);
      if (userId) publishNotificationEvent(userId, "notifications", eventPayload("authorization_refresh"));
    },
  };
}

/**
 * Mirrors persisted MongoDB changes into this web process's existing SSE
 * subscribers. It never publishes record content: browsers receive only an
 * opaque invalidation and re-fetch through their normal authorized routes.
 *
 * Existing client polling remains the fallback when the connected MongoDB
 * topology or account does not permit change streams.
 */
function startRealtimeProjectionBridge({
  models = defaultModels(),
  publishers = defaultPublishers(),
  logger = null,
  restartDelayMs = 5_000,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  const handlers = createHandlers(publishers, models);
  const deleteFallbacks = createDeleteFallbacks(publishers);
  const states = new Map();
  let stopped = false;

  function log(level, message, error) {
    const method = logger?.[level];
    if (typeof method === "function") method.call(logger, message, error);
  }

  function schedule(name) {
    const state = states.get(name);
    if (!state || stopped || state.timer) return;
    state.timer = setTimer(() => {
      state.timer = null;
      open(name);
    }, restartDelayMs);
    state.timer?.unref?.();
  }

  function open(name) {
    const state = states.get(name);
    if (!state || stopped || state.stream) return;
    try {
      const stream = state.model.watch(MUTATION_PIPELINE, {
        fullDocument: "updateLookup",
        fullDocumentBeforeChange: "whenAvailable",
      });
      state.stream = stream;
      stream.on("change", (change) => {
        if (stopped) return;
        const isDelete = change?.operationType === "delete";
        const document = isDelete ? change?.fullDocumentBeforeChange : change?.fullDocument;
        const operation = document
          ? () => state.handler(document)
          : isDelete
          ? () => deleteFallbacks[name]?.(change?.documentKey?._id)
          : null;
        if (!operation) return;
        Promise.resolve(operation()).catch((error) => {
          log("warn", `Realtime ${name} projection failed.`, error);
        });
      });
      stream.on("error", (error) => {
        if (state.stream === stream) state.stream = null;
        log("warn", `Realtime ${name} change stream is unavailable; client polling remains active.`, error);
        schedule(name);
      });
      stream.on("close", () => {
        if (state.stream === stream) state.stream = null;
        schedule(name);
      });
    } catch (error) {
      log("warn", `Realtime ${name} change stream could not start; client polling remains active.`, error);
      schedule(name);
    }
  }

  Object.entries(models).forEach(([name, model]) => {
    const handler = handlers[name];
    if (!model || typeof model.watch !== "function" || typeof handler !== "function") return;
    states.set(name, { model, handler, stream: null, timer: null });
  });
  states.forEach((_state, name) => open(name));

  return Object.freeze({
    activeStreams() {
      return [...states.values()].filter((state) => state.stream).length;
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      const closing = [];
      states.forEach((state, name) => {
        if (state.timer) clearTimer(state.timer);
        state.timer = null;
        const stream = state.stream;
        state.stream = null;
        if (stream && typeof stream.close === "function") {
          closing.push(Promise.resolve(stream.close()).catch((error) => {
            log("warn", `Realtime ${name} change stream could not close cleanly.`, error);
          }));
        }
      });
      await Promise.all(closing);
    },
  });
}

module.exports = {
  MUTATION_PIPELINE,
  startRealtimeProjectionBridge,
};
