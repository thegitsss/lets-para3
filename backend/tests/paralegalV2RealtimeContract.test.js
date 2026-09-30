const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "../..");
const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), "utf8");

describe("Paralegal V2 realtime and reconciliation contract", () => {
  test("participant refreshes carry no domain record and stay scoped to authorized streams", () => {
    const { addSubscriber: addCaseSubscriber } = require("../utils/caseEvents");
    const { addSubscriber: addNotificationSubscriber } = require("../utils/notificationEvents");
    const { addSubscriber: addDiscoverySubscriber } = require("../utils/matterDiscoveryEvents");
    const { publishCaseProjectionRefresh } = require("../utils/caseProjectionEvents");
    const caseWrites = [];
    const attorneyWrites = [];
    const paralegalWrites = [];
    const unrelatedWrites = [];
    const discoveryWrites = [];
    const unsubscribers = [
      addCaseSubscriber("matter-1", { write: (value) => caseWrites.push(String(value)) }),
      addNotificationSubscriber("attorney-1", { write: (value) => attorneyWrites.push(String(value)) }),
      addNotificationSubscriber("paralegal-1", { write: (value) => paralegalWrites.push(String(value)) }),
      addNotificationSubscriber("unrelated-1", { write: (value) => unrelatedWrites.push(String(value)) }),
      addDiscoverySubscriber({ write: (value) => discoveryWrites.push(String(value)) }),
    ];

    publishCaseProjectionRefresh({
      _id: "matter-1",
      attorneyId: "attorney-1",
      paralegalId: "paralegal-1",
      title: "Must not leave the authorized API projection",
      details: "Confidential",
    }, "matter_updated_refresh", { discovery: true });
    unsubscribers.forEach((unsubscribe) => unsubscribe());

    for (const writes of [caseWrites, attorneyWrites, paralegalWrites, discoveryWrites]) {
      expect(writes.join("\n")).toContain("matter_updated_refresh");
      expect(writes.join("\n")).not.toContain("Must not leave");
      expect(writes.join("\n")).not.toContain("Confidential");
    }
    expect(unrelatedWrites).toEqual([]);
  });

  test("participant refresh reaches every populated legacy and canonical participant alias exactly once", () => {
    const { addSubscriber: addNotificationSubscriber } = require("../utils/notificationEvents");
    const { publishCaseProjectionRefresh } = require("../utils/caseProjectionEvents");
    const ids = [
      "attorney-current",
      "attorney-legacy",
      "paralegal-current",
      "paralegal-legacy",
      "paralegal-pending",
      "paralegal-withdrawn",
      "paralegal-invited",
      "paralegal-applicant",
    ];
    const writes = new Map(ids.map((id) => [id, []]));
    const unsubscribers = ids.map((id) => addNotificationSubscriber(id, {
      write: (value) => writes.get(id).push(String(value)),
    }));

    publishCaseProjectionRefresh({
      _id: "matter-aliases",
      attorneyId: "attorney-current",
      attorney: "attorney-legacy",
      paralegalId: "paralegal-current",
      paralegal: "paralegal-legacy",
      pendingParalegalId: "paralegal-pending",
      withdrawnParalegalId: "paralegal-withdrawn",
      invites: [
        { paralegalId: "paralegal-invited" },
        { paralegalId: "paralegal-current" },
      ],
      applicants: [
        { paralegalId: "paralegal-applicant" },
        { paralegalId: "paralegal-invited" },
      ],
    }, "matter_updated_refresh");
    unsubscribers.forEach((unsubscribe) => unsubscribe());

    ids.forEach((id) => {
      expect(writes.get(id)).toHaveLength(1);
      expect(writes.get(id)[0]).toContain("matter_updated_refresh");
    });
  });

  test("delete fallbacks invalidate only live subscribers and never include record content", () => {
    const {
      addSubscriber: addCaseSubscriber,
      publishAllCaseEvents,
    } = require("../utils/caseEvents");
    const {
      addSubscriber: addNotificationSubscriber,
      publishAllNotificationEvents,
    } = require("../utils/notificationEvents");
    const firstCase = [];
    const secondCase = [];
    const firstUser = [];
    const secondUser = [];
    const unsubscribers = [
      addCaseSubscriber("matter-1", { write: (value) => firstCase.push(String(value)) }),
      addCaseSubscriber("matter-2", { write: (value) => secondCase.push(String(value)) }),
      addNotificationSubscriber("user-1", { write: (value) => firstUser.push(String(value)) }),
      addNotificationSubscriber("user-2", { write: (value) => secondUser.push(String(value)) }),
    ];

    publishAllCaseEvents("messages", { type: "message_record_deleted_refresh" });
    publishAllNotificationEvents("notifications", { type: "notification_record_deleted_refresh" });
    unsubscribers.forEach((unsubscribe) => unsubscribe());

    for (const writes of [firstCase, secondCase]) {
      expect(writes).toHaveLength(1);
      expect(writes[0]).toContain("message_record_deleted_refresh");
      expect(writes[0]).not.toContain("matter-1");
      expect(writes[0]).not.toContain("matter-2");
    }
    for (const writes of [firstUser, secondUser]) {
      expect(writes).toHaveLength(1);
      expect(writes[0]).toContain("notification_record_deleted_refresh");
      expect(writes[0]).not.toContain("user-1");
      expect(writes[0]).not.toContain("user-2");
    }
  });

  test("messages and files provide immediate events plus reconnect and polling reconciliation", () => {
    const messagesRoute = read("backend/routes/messages.js");
    const uploadsRoute = read("backend/routes/uploads.js");
    const messageClient = read("frontend/assets/scripts/paralegal-v2/matter-messages.mjs");
    const fileClient = read("frontend/assets/scripts/paralegal-v2/matter-files.mjs");

    expect(messagesRoute).toMatch(/publishCaseEvent\(caseId, "messages"/);
    expect(messagesRoute).toMatch(/publishCaseProjectionRefresh\(caseDoc, "message_refresh"/);
    expect(messagesRoute.match(/publishCaseProjectionRefresh\(req\.case, "message_refresh"/g)?.length).toBeGreaterThanOrEqual(4);
    expect(uploadsRoute).toMatch(/publishCaseEvent\(caseDoc\._id, "documents"/);
    expect(uploadsRoute).toMatch(/publishCaseParticipantRefresh\(caseDoc, "case_file_uploaded_refresh"\)/);
    for (const client of [messageClient, fileClient]) {
      expect(client).toMatch(/source\.addEventListener\("open", \(\) => \{[\s\S]*scheduleRefresh\(\)/);
      expect(client).toMatch(/source\.addEventListener\("error"/);
      expect(client).toMatch(/startPolling\(\)/);
      expect(client).toMatch(/document\.addEventListener\("visibilitychange"/);
      expect(client).toMatch(/window\.addEventListener\("online"/);
    }
    expect(messageClient).toMatch(/source\.addEventListener\("messages", scheduleRefresh\)/);
    expect(fileClient).toMatch(/source\.addEventListener\("documents", scheduleRefresh\)/);
  });

  test("message and document retries use stable idempotency keys and preserve unfinished work", () => {
    const messageClient = read("frontend/assets/scripts/paralegal-v2/matter-messages.mjs");
    const fileClient = read("frontend/assets/scripts/paralegal-v2/matter-files.mjs");
    const messageModel = read("backend/models/Message.js");
    const fileModel = read("backend/models/CaseFile.js");

    expect(messageClient).toMatch(/clientMessageId/);
    expect(messageModel).toMatch(/clientMessageId/);
    expect(messageModel).toMatch(/partialFilterExpression/);
    expect(fileClient).toMatch(/formData\.append\("clientUploadId", entry\.clientUploadId\)/);
    expect(fileClient).toMatch(/Math\.min\(3, entries\.length\)/);
    expect(fileClient).toMatch(/Unfinished files remain selected/);
    expect(fileModel).toMatch(/clientUploadId/);
    expect(fileModel).toMatch(/partialFilterExpression/);
  });

  test("notifications and matter discovery reconcile on events, reconnect, visibility, and online recovery", () => {
    const notifications = read("frontend/assets/scripts/utils/notification-center.mjs");
    const discovery = read("frontend/assets/scripts/paralegal-v2/matter-discovery-controller.mjs");
    const app = read("frontend/assets/scripts/paralegal-v2/app.mjs");
    const jobs = read("backend/routes/jobs.js");

    expect(notifications).toMatch(/new EventSource\("\/api\/notifications\/stream"\)/);
    expect(notifications).toMatch(/pendingSignalTypes\.add\(type\)/);
    expect(notifications).toContain('ownedRequest("/api/notifications/unread-count"');
    expect(notifications).toContain('mutate("/api/notifications", "DELETE", "clear-all")');
    expect(notifications).toContain('title: refinePresentation ? "Dismiss all notifications?" : "Clear all notifications?"');
    expect(notifications).toContain('confirmLabel: refinePresentation ? "Dismiss all" : "Clear all"');
    expect(notifications).toMatch(/new BroadcastChannel\(`\$\{SYNC_STORAGE_PREFIX\}\$\{userId\}`\)/);
    expect(discovery).toMatch(/new EventSource\("\/api\/jobs\/stream"\)/);
    expect(discovery).toContain('api.get("/api/jobs/discovery-version")');
    expect(discovery).toMatch(/nextSource\.addEventListener\("matters"/);
    expect(discovery).toMatch(/nextSource\.addEventListener\("open"/);
    expect(discovery).toMatch(/startPolling\(\)/);
    expect(discovery).toMatch(/discoveryVersion !== nextVersion/);
    const discoveryOpenHandler = discovery.split('addEventListener("open"')[1]?.split('addEventListener("matters"')[0] || "";
    expect(discoveryOpenHandler).not.toContain("stopPolling()");
    expect(jobs).toMatch(/router\.get\("\/stream", \.\.\.authenticatedGuards, requireRole\("paralegal"\)/);
    expect(app).toMatch(/lpc:v2-authoritative-refresh/);
    expect(app).toMatch(/requiresAuthorizationCheck/);
    expect(app).toMatch(/"authorization_refresh"/);
    expect(app).toMatch(/establishSession\(\)\.then/);
    expect(app).toContain('"notification_record_"');
  });

  test("every projection-changing V2 mutation reaches sibling tabs while acknowledgements stay quiet", () => {
    const apiClient = read("frontend/assets/scripts/paralegal-v2/api-client.mjs");
    const app = read("frontend/assets/scripts/paralegal-v2/app.mjs");

    expect(apiClient).toMatch(/if \(!SAFE_METHODS\.has\(method\)\)[\s\S]*onMutationCommitted\?\.\(\{ url, method \}\)/);
    expect(apiClient).toMatch(/xhr\.status >= 200 && xhr\.status < 300[\s\S]*onMutationCommitted\?\.\(\{ url, method: "POST" \}\)/);
    expect(apiClient.indexOf("onMutationCommitted?.({ url, method });"))
      .toBeGreaterThan(apiClient.indexOf("if (!response.ok)"));
    expect(app).toMatch(/publishLifecycleRefresh\(\{ url, method, sourceId: v2MutationSourceId \}\)/);
    expect(app).toMatch(/function isProjectionMutation/);
    expect(app).toMatch(/pathname === "\/api\/notifications\/workspace-presence"/);
    expect(app).toContain('if (/^\\/api\\/messages\\/[^/]+\\/read$/.test(pathname)) return false;');
    expect(app).toContain('if (/^\\/api\\/notifications(?:\\/|$)/.test(pathname)) return false;');
    expect(app).toContain('if (/^\\/api\\/support(?:\\/|$)/.test(pathname)) return false;');
    expect(app).toMatch(/event\.detail\?\.sourceId === v2MutationSourceId[\s\S]*invalidateAuthoritativeViews\(\{ includeSettings: false \}\)[\s\S]*lpc:notifications-refreshed/);
    expect(app).toMatch(/protectInteraction: event\.detail\?\.accessMayChange !== true/);
  });

  test("tab return and reconnect discard cached projections before refreshing", () => {
    const app = read("frontend/assets/scripts/paralegal-v2/app.mjs");
    const invalidation = app.match(/function invalidateAuthoritativeViews\([^]*?\n\}/)?.[0];
    expect(invalidation).toBeDefined();
    const calls = [];
    const view = name => ({ invalidate: options => { calls.push([name, options]); return true; } });
    const invalidate = new Function("homeView", "browseView", "workView", "settingsView", `${invalidation}; return invalidateAuthoritativeViews;`)(view("home"), view("browse"), view("work"), view("settings"));
    expect(invalidate()).toBe(true);
    expect(calls.splice(0)).toEqual([["home", undefined], ["browse", undefined], ["work", { preserveDownloads: false }], ["settings", undefined]]);
    expect(invalidate({ includeSettings: false, preserveDownloads: true })).toBe(false);
    expect(calls).toEqual([["home", undefined], ["browse", undefined], ["work", { preserveDownloads: true }]]);
    expect(app).toMatch(/function reauthorizeAndRefresh[\s\S]*invalidateAuthoritativeViews\(\{ preserveDownloads: protectInteraction \}\)[\s\S]*establishSession\(\)\.then/);
    expect(app).toMatch(/addEventListener\("pageshow"[\s\S]*reauthorizeAndRefresh\(\)/);
    expect(app).toMatch(/addEventListener\("online"[\s\S]*reauthorizeAndRefresh\(\)/);
    expect(app).toMatch(/addEventListener\("visibilitychange"[\s\S]*reauthorizeAndRefresh\(\)/);
    expect(app).toMatch(/profile\(\?:_record\)\?/);
  });

  test("message and file signals do not unnecessarily repaint an open Browse view", () => {
    const app = read("frontend/assets/scripts/paralegal-v2/app.mjs");
    expect(app).toContain('"message_"');
    expect(app).toContain('"case_file_"');
    expect(app).toContain('"calendar_event_"');
    expect(app).toMatch(/if \(affectsDiscovery\) browseView\.invalidate\(\)/);
    expect(app).toMatch(/affectsDiscovery \? "browse" : ""/);
    expect(app).toMatch(/scheduleRouteRefresh\(routes\)/);
  });

  test("live reconciliation is surface-aware and cannot close an in-progress route dialog", () => {
    const app = read("frontend/assets/scripts/paralegal-v2/app.mjs");
    expect(app).toContain("WORK_SIGNAL_PREFIXES");
    expect(app).toMatch(/function signalAffectsWork/);
    expect(app).toMatch(/function scheduleRouteRefresh/);
    expect(app).toMatch(/function openRouteDialogs/);
    expect(app).toMatch(/dialog\.addEventListener\("close"/);
    expect(app).toMatch(/if \(reason !== "external"\) return/);
    expect(app).not.toMatch(/\["home", "work"\]\.includes\(current\.name\)/);
  });

  test("Home, Browse, and Work cannot recache an invalidated in-flight response", () => {
    for (const relative of ["home-view.mjs", "browse-view.mjs", "work-view.mjs"]) {
      const source = read(`frontend/assets/scripts/paralegal-v2/${relative}`);
      expect(source).toMatch(/(?:let |, )cacheRevision = 0/);
      expect(source).toMatch(/const revision = cacheRevision/);
      if (relative === "home-view.mjs") {
        // Home now paints independent sources and discards aborted revisions;
        // it must never retry an old identity through the former shared loop.
        expect(source).toMatch(/controller\?\.abort\(\)/);
        expect(source).toMatch(/if \(!valid\(\) \|\| revision !== cacheRevision\) return/);
        expect(source).toMatch(/if \(valid\(\) && revision === cacheRevision\) queuePaint/);
        expect(source).toMatch(/session === sessionRevision && userId === key\(\)/);
      } else {
        expect(source).toMatch(/if \(pending === pendingSnapshot\) throw error/);
        expect(source).toMatch(/catch \(error\) \{[\s\S]*if \(revision !== cacheRevision\) continue/);
        expect(source).toMatch(/if \(revision !== cacheRevision\) continue/);
        expect(source).toMatch(/pendingSnapshot = null/);
      }
      expect(source).toMatch(/cacheRevision \+= 1/);
    }
  });

  test("revoked and expired managed sessions leave the protected shell", () => {
    const apiClient = read("frontend/assets/scripts/paralegal-v2/api-client.mjs");
    const app = read("frontend/assets/scripts/paralegal-v2/app.mjs");
    expect(apiClient).toMatch(/status !== 403/);
    expect(apiClient).toMatch(/session expired\|invalid token\|this account has been deactivated/);
    expect(apiClient).toMatch(/onAuthenticationLost\?\.\(error\)/);
    expect(app).toMatch(/notificationsController\?\.stop\?\.\(\)/);
    expect(app).toMatch(/matterDiscoveryController\?\.stop\?\.\(\)/);
    expect(app).toMatch(/location\.replace\(paralegalV2LoginDestination\(location\.hash\)\)/);
  });

  test("lifecycle, dispute, and payment mutations invalidate participant projections after persistence", () => {
    const cases = read("backend/routes/cases.js");
    const disputes = read("backend/routes/disputes.js");
    const payments = read("backend/routes/payments.js");
    const funding = read("backend/services/attorneyFunding.js");
    const webhook = read("backend/routes/paymentsWebhook.js");
    for (const signal of [
      "matter_invitation_sent_refresh",
      "matter_invitation_response_refresh",
      "matter_updated_refresh",
      "matter_termination_refresh",
      "matter_withdrawn_refresh",
      "matter_relisted_refresh",
      "matter_completed_refresh",
      "matter_payout_refresh",
    ]) expect(cases).toContain(signal);
    expect(disputes).toContain("matter_dispute_refresh");
    expect(disputes).toContain("matter_dispute_comment_refresh");
    expect(payments).toContain('require("../services/attorneyFunding")');
    expect(payments).toContain("attorneyFunding.write(req, stripe)");
    expect(funding).toMatch(/async function verifyAndRecord[\s\S]*await transaction\([\s\S]*await updateCase\([\s\S]*\n  \}\);[\s\S]*publishCaseProjectionRefresh\(current, "matter_payment_refresh"/);
    expect(webhook).toContain("matter_chargeback_refresh");
    expect(webhook).toContain("matter_refund_refresh");
    expect(webhook).toContain("matter_payout_refresh");
  });
});
