const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const AxeBuilder = require("@axe-core/playwright").default;

const { projectCanonicalProfile } = require("../services/objectSystem/profileAuthorityContract");
const { projectPresentation } = require("../services/objectSystem/presentationContract");

const frontendRoot = path.resolve(__dirname, "../../frontend");
const cropFixturePath = path.join(frontendRoot, "favicon-32x32.png");
const accountSettingsScreenshotDir = process.env.LPC_ACCOUNT_SETTINGS_SCREENSHOTS || "";
const profileId = "64b000000000000000000021";
const viewerId = "64b000000000000000000022";
const updatedAt = "2026-08-10T12:00:00.000Z";
const photoUrl = `/api/public/paralegals/${profileId}/photo?v=${Date.parse(updatedAt)}`;
const onePixelPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
);
const wideAttorneyPhotoPath = path.join(frontendRoot, "hero-mountain.jpg");
const wideAttorneyPhoto = fs.existsSync(wideAttorneyPhotoPath) ? fs.readFileSync(wideAttorneyPhotoPath) : onePixelPng;
const wideAttorneyPhotoContentType = fs.existsSync(wideAttorneyPhotoPath) ? "image/jpeg" : "image/png";

const profile = {
  _id: profileId,
  id: profileId,
  role: "paralegal",
  firstName: "Taylor",
  lastName: "Morgan",
  name: "Taylor Morgan",
  email: "taylor@example.test",
  status: "approved",
  disabled: false,
  deleted: false,
  preferences: { hideProfile: false },
  bio: "Experienced litigation paralegal supporting focused legal teams.",
  about: "Experienced litigation paralegal supporting focused legal teams.",
  practiceAreas: ["Litigation"],
  specialties: ["Discovery"],
  skills: ["Discovery"],
  yearsExperience: 8,
  availability: "Available",
  location: "New York, NY",
  state: "NY",
  resumeURL: "paralegal-resumes/64b000000000000000000021/resume.pdf",
  profileImage: photoUrl,
  avatarURL: photoUrl,
  profilePhotoStatus: "approved",
  pendingProfileImage: "",
  updatedAt,
  approvedAt: updatedAt,
  createdAt: updatedAt,
};

const presentation = projectPresentation(projectCanonicalProfile({
  source: {
    _id: profile._id,
    role: profile.role,
    firstName: profile.firstName,
    lastName: profile.lastName,
    location: profile.location,
    state: profile.state,
    bio: profile.bio,
    about: profile.about,
    practiceAreas: profile.practiceAreas,
    specialties: profile.specialties,
    skills: profile.skills,
    yearsExperience: profile.yearsExperience,
    availability: profile.availability,
    status: profile.status,
    disabled: profile.disabled,
    deleted: profile.deleted,
    preferences: profile.preferences,
    resumeURL: profile.resumeURL,
    profileImage: profile.profileImage,
    avatarURL: profile.avatarURL,
    profilePhotoStatus: profile.profilePhotoStatus,
    pendingProfileImage: profile.pendingProfileImage,
    updatedAt,
  },
  tier: "public",
  authorizationEvidence: {
    authorized: true,
    boundary: "public",
    publicVisibilityVerified: true,
  },
  expectedSourceUpdatedAt: updatedAt,
  now: new Date(updatedAt),
}), { kind: "card" });

function contentTypeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".html") return "text/html";
  if (ext === ".js" || ext === ".mjs") return "text/javascript";
  if (ext === ".css") return "text/css";
  if (ext === ".svg") return "image/svg+xml";
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  return "application/octet-stream";
}

async function installRoutes(
  page,
  { role, photoStatus = 200, attorneyPhoto = false, userGetDelayMs = 0, dashboardState = "populated", dashboardDelayMs = 0 } = {}
) {
  let viewer = role === "paralegal"
    ? {
        ...profile,
        profileImage: photoUrl,
        avatarURL: photoUrl,
        onboarding: { paralegalProfileTourCompleted: true },
      }
    : {
        id: viewerId,
        _id: viewerId,
        role: "attorney",
        status: "approved",
        firstName: "Alex",
        lastName: "Attorney",
        email: "alex@example.test",
        lawFirm: "Example Law",
        firmWebsite: "https://example.test/",
        linkedInURL: "https://www.linkedin.com/in/alex-attorney",
        practiceAreas: ["Litigation"],
        practiceDescription: "Litigation counsel working with distributed legal teams.",
        bio: "Litigation counsel working with distributed legal teams.",
        publications: ["Practical Discovery, 2025"],
        ...(attorneyPhoto
          ? {
              profileImage: `/api/users/profile-photo/${viewerId}?v=${Date.parse(updatedAt)}`,
              avatarURL: `/api/users/profile-photo/${viewerId}?v=${Date.parse(updatedAt)}`,
              profilePhotoStatus: "approved",
            }
          : {}),
      };
  const state = {
    get viewer() {
      return viewer;
    },
    patchRequests: [],
    profilePhotoUploads: [],
    profilePhotoUploadAttempts: 0,
    preferenceRequests: [],
    failNextProfilePatch: false,
    failNextPhotoUpload: false,
    failNextPhotoRemoval: false,
    dashboardRequests: {
      inventory: 0,
      applications: 0,
      unread: 0,
      events: 0,
    },
  };

  await page.addInitScript((user) => {
    localStorage.setItem("lpc_user", JSON.stringify(user));
  }, viewer);

  await page.route("https://lpc.test/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === `/api/public/paralegals/${profileId}/photo`) {
      if (photoStatus !== 200) {
        await route.fulfill({ status: photoStatus, json: { error: "Profile photo unavailable" } });
      } else {
        await route.fulfill({
          status: 200,
          contentType: "image/png",
          headers: {
            "Cache-Control": "public, max-age=3600, stale-while-revalidate=86400",
            ETag: '"profile-photo-v1"',
            "X-Content-Type-Options": "nosniff",
          },
          body: onePixelPng,
        });
      }
      return;
    }
    if (url.pathname === "/api/csrf") { await route.fulfill({ json: { csrfToken: "synthetic-ui-csrf" } }); return; }
    if (url.pathname === "/api/auth/workspace-release") {
      await route.fulfill({ json: { workspace: { schemaVersion: 1, ownerId: state.viewer.id, role: state.viewer.role, revision: 0, version: "legacy", defaultDestination: `/dashboard-${state.viewer.role}.html` } } }); return;
    }
    if (url.pathname === "/api/notifications") { await route.fulfill({ json: [] }); return; }
    if (url.pathname === "/api/notifications/unread-count") { await route.fulfill({ json: { count: 0 } }); return; }
    if (url.pathname === "/api/notifications/stream") { await route.fulfill({ status: 204, body: "" }); return; }
    if (url.pathname === "/api/payments/attorney-financial-history") {
      await route.fulfill({ json: { ownerId: viewerId, revision: "b".repeat(64), view: url.searchParams.get("view") || "all", q: url.searchParams.get("q") || "", caseId: url.searchParams.get("caseId") || null, total: 0, entries: [], nextCursor: null, summary: { currencies: [], requiresReview: 0, pending: 0, undated: 0 } } }); return;
    }
    if (url.pathname === "/api/auth/me") {
      await route.fulfill({ json: { user: state.viewer } });
      return;
    }
    if (url.pathname === "/api/account/2fa") {
      await route.fulfill({ json: { enabled: false, method: "email" } });
      return;
    }
    if (url.pathname === "/api/account/passkeys") {
      await route.fulfill({ json: { passkeys: [] } });
      return;
    }
    if (url.pathname === "/api/account/sessions") {
      await route.fulfill({ json: { sessions: [] } });
      return;
    }
    if (url.pathname === "/api/blocks") {
      await route.fulfill({ json: [] });
      return;
    }
    if (url.pathname === "/api/users/me/pending-hire") {
      await route.fulfill({ json: { pendingHire: null } });
      return;
    }
    if (url.pathname === "/api/payments/payment-method/default") {
      await route.fulfill({ json: { hasDefault: false, paymentMethod: null } });
      return;
    }
    if (url.pathname === "/api/payments/history") {
      await route.fulfill({ json: { items: [], totalSpent: 0, averageJobCost: 0, count: 0 } });
      return;
    }
    if (url.pathname === "/api/account/preferences") {
      if (route.request().method() === "POST") {
        const payload = route.request().postDataJSON();
        state.preferenceRequests.push(payload);
        await route.fulfill({ json: { success: true, preferences: payload, state: payload.state || "" } });
      } else {
        await route.fulfill({ json: { email: true, theme: "light", fontSize: "md", hideProfile: false, state: "VA" } });
      }
      return;
    }
    if (url.pathname === "/api/users/me") {
      if (route.request().method() === "PATCH") {
        const payload = route.request().postDataJSON();
        state.patchRequests.push(payload);
        await new Promise((resolve) => setTimeout(resolve, 120));
        const removesPhoto = payload.profileImage === "" || payload.avatarURL === "";
        if (removesPhoto && state.failNextPhotoRemoval) {
          state.failNextPhotoRemoval = false;
          await route.fulfill({ status: 503, json: { error: "Temporary photo removal failure" } });
          return;
        }
        if (state.failNextProfilePatch) {
          state.failNextProfilePatch = false;
          await route.fulfill({ status: 503, json: { error: "Temporary profile failure" } });
          return;
        }
        viewer = { ...viewer, ...payload };
      } else if (userGetDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, userGetDelayMs));
      }
      await route.fulfill({ json: state.viewer });
      return;
    }
    if (url.pathname === "/api/uploads/profile-photo" && route.request().method() === "POST") {
      state.profilePhotoUploadAttempts += 1;
      if (state.failNextPhotoUpload) {
        state.failNextPhotoUpload = false;
        await route.fulfill({ status: 503, json: { error: "Temporary photo upload failure" } });
        return;
      }
      const body = route.request().postDataBuffer();
      state.profilePhotoUploads.push({
        contentType: route.request().headers()["content-type"] || "",
        body,
      });
      const version = Date.parse(updatedAt) + state.profilePhotoUploads.length;
      if (role === "paralegal") {
        viewer = {
          ...viewer,
          pendingProfileImage: `/api/users/profile-photo/${profileId}?variant=pending&v=${version}`,
          pendingProfileImageOriginal: `/api/users/profile-photo/${profileId}?variant=pending-original&v=${version}`,
          profilePhotoStatus: "pending_review",
        };
        await route.fulfill({
          json: {
            success: true,
            status: "pending_review",
            pending: true,
            pendingProfileImage: viewer.pendingProfileImage,
            pendingProfileImageOriginal: viewer.pendingProfileImageOriginal,
            profileImage: viewer.profileImage,
          },
        });
      } else {
        viewer = {
          ...viewer,
          profileImage: `/api/users/profile-photo/${viewerId}?v=${version}`,
          avatarURL: `/api/users/profile-photo/${viewerId}?v=${version}`,
          profilePhotoStatus: "approved",
        };
        await route.fulfill({
          json: {
            success: true,
            status: "approved",
            pending: false,
            profileImage: viewer.profileImage,
            avatarURL: viewer.avatarURL,
          },
        });
      }
      return;
    }
    if (url.pathname.startsWith("/api/users/profile-photo/")) {
      await route.fulfill({
        status: 200,
        contentType: attorneyPhoto ? wideAttorneyPhotoContentType : "image/png",
        body: attorneyPhoto ? wideAttorneyPhoto : onePixelPng,
      });
      return;
    }
    if (url.pathname === `/api/paralegals/${profileId}` || url.pathname === `/api/public/paralegals/${profileId}`) {
      await route.fulfill({ json: profile });
      return;
    }
    if (url.pathname === "/public/paralegals") {
      await route.fulfill({
        json: { items: [{ ...profile, presentation }], page: 1, limit: 10, total: 1, pages: 1, hasMore: false },
      });
      return;
    }
    if (url.pathname === "/api/cases/my-active") {
      await route.fulfill({ json: { items: [] } });
      return;
    }
    if (role === "attorney" && url.pathname === "/api/cases/inventory/home") {
      state.dashboardRequests.inventory += 1;
      if (dashboardDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, dashboardDelayMs));
      const empty = dashboardState === "empty", singular = dashboardState === "singular";
      const total = empty ? 0 : singular ? 1 : 6, completed = empty ? 0 : singular ? 1 : 12;
      const titles = ["Martinez discovery", "Northstar contract review", "Acme document production", "Employment response", "Contract exhibits"];
      const items = titles.slice(0, Math.min(5, total)).map((title, index) => ({ id: `66b${String(index + 1).padStart(21, "0")}`, title, practiceArea: "Civil litigation", label: "In Progress" }));
      const weekItems = items.slice(0, singular ? 1 : 2).map((item, index) => ({ ...item, dueDate: index ? "2026-08-23" : "2026-08-21" }));
      const completedItems = Array.from({ length: Math.min(3, completed) }, (_, index) => ({ id: `66d${String(index + 1).padStart(21, "0")}`, title: `Completed Matter ${index + 1}`, practiceArea: "Civil litigation", label: "Completed" }));
      await route.fulfill({ json: {
        ownerId: viewerId, revision: "a".repeat(64), counts: { active: total, applications: 0, draft: 0, archived: completed }, postedCount: total + completed,
        recent: { total, items }, completed: { total: completed, items: completedItems },
        attention: { total: total ? 1 : 0, items: items.slice(0, 1).map(item => ({ ...item, actions: ["files"] })), page: 1, pageSize: 5, pages: 1 },
        week: { start: "2026-08-17", end: "2026-08-23", total: weekItems.length, items: weekItems, page: 1, pageSize: 3, pages: 1 },
      } });
      return;
    }
    if (role === "attorney" && url.pathname === "/api/cases/my") {
      const empty = dashboardState === "empty";
      const singular = dashboardState === "singular";
      const archived = url.searchParams.get("archived") === "true";
      const activeCases = [
        { id: "66b000000000000000000001", _id: "66b000000000000000000001", title: "Martinez discovery", practiceArea: "Civil litigation", status: "in progress", archived: false, paymentReleased: false, escrowStatus: "funded", escrowIntentId: "pi_1", paralegal: { id: "66c000000000000000000001", firstName: "Jordan", lastName: "Lee" }, createdAt: "2026-08-18T12:00:00.000Z", files: [] },
        { id: "66b000000000000000000002", _id: "66b000000000000000000002", title: "Northstar contract review", practiceArea: "Contract law", status: "in progress", archived: false, paymentReleased: false, escrowStatus: "funded", escrowIntentId: "pi_2", paralegal: { id: "66c000000000000000000002", firstName: "Taylor", lastName: "Morgan" }, createdAt: "2026-08-17T12:00:00.000Z", files: [] },
        { id: "66b000000000000000000003", _id: "66b000000000000000000003", title: "Acme document production", practiceArea: "Commercial litigation", status: "in progress", archived: false, paymentReleased: false, escrowStatus: "funded", escrowIntentId: "pi_3", paralegal: { id: "66c000000000000000000003", firstName: "Avery", lastName: "Chen" }, createdAt: "2026-08-16T12:00:00.000Z", files: [] },
      ];
      const completedCases = [
        { id: "66b000000000000000000010", _id: "66b000000000000000000010", title: "Completed test matter", practiceArea: "Civil litigation", status: "completed", archived: true, paymentReleased: false, completedAt: "2026-08-01T12:00:00.000Z", createdAt: "2026-07-01T12:00:00.000Z", files: [] },
      ];
      await route.fulfill({ json: empty ? [] : archived ? completedCases : activeCases.slice(0, singular ? 1 : 3) });
      return;
    }
    if (role === "attorney" && url.pathname === "/api/applications/my-postings") {
      state.dashboardRequests.applications += 1;
      if (dashboardDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, dashboardDelayMs));
      if (dashboardState === "applications-failed") {
        await route.fulfill({ status: 503, json: { error: "Applications temporarily unavailable" } });
        return;
      }
      const applications = dashboardState === "empty" ? [] : Array.from({ length: dashboardState === "singular" ? 1 : 4 }, (_, index) => ({
        id: `application-${index + 1}`,
        jobId: `job-${index + 1}`,
        jobTitle: `Matter ${index + 1}`,
        practiceArea: "Civil litigation",
        paralegal: { id: `paralegal-${index + 1}`, firstName: "Applicant", lastName: String(index + 1) },
        createdAt: `2026-08-${String(20 - index).padStart(2, "0")}T12:00:00.000Z`,
      }));
      await route.fulfill({ json: applications });
      return;
    }
    if (role === "attorney" && url.pathname === "/api/messages/unread-count") {
      state.dashboardRequests.unread += 1;
      if (dashboardDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, dashboardDelayMs));
      await route.fulfill({ json: { count: dashboardState === "empty" ? 0 : dashboardState === "singular" ? 1 : 3 } });
      return;
    }
    if (role === "attorney" && url.pathname === "/api/messages/summary") {
      const unread = dashboardState === "empty" ? 0 : dashboardState === "singular" ? 1 : 3;
      await route.fulfill({ json: { items: unread ? [{ caseId: "66b000000000000000000001", unread }] : [] } }); return;
    }
    if (role === "attorney" && url.pathname === "/api/messages/threads") {
      const unread = dashboardState === "empty" ? 0 : dashboardState === "singular" ? 1 : 3;
      await route.fulfill({ json: { threads: unread ? [{ caseId: "66b000000000000000000001", unread }] : [], total: unread ? 1 : 0 } });
      return;
    }
    if (role === "attorney" && url.pathname === "/api/events") {
      state.dashboardRequests.events += 1;
      await route.fulfill({ json: { items: [], total: 0, page: 1, pages: 0 } });
      return;
    }
    if (role === "attorney" && url.pathname === "/api/checklist") {
      await route.fulfill({ json: { items: [], total: 0, page: 1, pages: 0 } });
      return;
    }
    if (role === "attorney" && url.pathname === "/api/users/me/weekly-notes" && route.request().method() === "GET") {
      const weekStart = url.searchParams.get("weekStart");
      await route.fulfill({ json: { weekStart, notes: Array(7).fill(""), updatedAt: null, revision: `empty:${viewerId}:${weekStart}` } });
      return;
    }
    if (url.pathname.startsWith("/api/")) {
      await route.fulfill({ status: 404, json: { error: "Not available in UI fixture" } });
      return;
    }

    const vendor = { "/assets/vendor/web-vitals-6.1.1.js": "web-vitals/dist/web-vitals.js", "/assets/vendor/simplewebauthn-13.3.0.js": "@simplewebauthn/browser/dist/bundle/index.umd.min.js" }[url.pathname];
    if (vendor) { await route.fulfill({ contentType: "application/javascript", body: fs.readFileSync(path.resolve(__dirname, "../node_modules", vendor)) }); return; }
    const relative = decodeURIComponent(url.pathname).replace(/^\/+/, "") || "index.html";
    const filePath = path.resolve(frontendRoot, relative);
    if (!filePath.startsWith(`${frontendRoot}${path.sep}`) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      await route.fulfill({ status: 404, body: "Not found" });
      return;
    }
    await route.fulfill({ contentType: contentTypeFor(filePath), body: fs.readFileSync(filePath) });
  });
  return state;
}

async function assertNoHorizontalOverflow(page) {
  const dimensions = await page.evaluate(() => ({
    viewport: window.innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
    overflowElements: [...document.querySelectorAll("body *")]
      .map((node) => {
        const rect = node.getBoundingClientRect();
        return {
          tag: node.tagName,
          id: node.id,
          className: typeof node.className === "string" ? node.className : "",
          left: Math.round(rect.left),
          right: Math.round(rect.right),
          width: Math.round(rect.width),
        };
      })
      .filter((item) => item.right > window.innerWidth + 1 || item.left < -1)
      .slice(0, 20),
  }));
  assert.ok(dimensions.scrollWidth <= dimensions.viewport + 1, JSON.stringify(dimensions));
}

async function assertNoCormorant(page, rootSelector = "body") {
  await page.evaluate(() => document.fonts?.ready);
  const offenders = await page.locator(rootSelector).evaluate((root) =>
    [...root.querySelectorAll("*")]
      .filter((node) => getComputedStyle(node).fontFamily.toLowerCase().includes("cormorant"))
      .slice(0, 20)
      .map((node) => ({
        tag: node.tagName,
        id: node.id,
        className: typeof node.className === "string" ? node.className : "",
        fontFamily: getComputedStyle(node).fontFamily,
      }))
  );
  assert.deepEqual(offenders, [], JSON.stringify(offenders, null, 2));
}

async function assertStripeDashboardEmphasis(page, rootSelector = "body") {
  const offenders = await page.locator(rootSelector).evaluate((root) =>
    [...root.querySelectorAll("h1, h2, h3, h4, h5, h6, strong, b")]
      .map((node) => ({
        tag: node.tagName,
        text: String(node.textContent || "").trim().slice(0, 80),
        fontFamily: getComputedStyle(node).fontFamily,
        fontWeight: getComputedStyle(node).fontWeight,
      }))
      .filter(({ tag, fontFamily, fontWeight }) =>
        !/Söhne.*SF Pro Display/i.test(fontFamily) ||
        (/^H[1-6]$/.test(tag) ? fontWeight !== "400" : fontWeight !== "500")
      )
      .slice(0, 30)
  );
  assert.deepEqual(offenders, [], JSON.stringify(offenders, null, 2));
}

async function assertStripeDashboardShell(page) {
  await page.locator(".lpc-global-search-trigger").waitFor({ state: "visible" });
  const isAttorney = await page.locator("body").evaluate((body) => body.classList.contains("attorney-dashboard"));
  const shell = await page.locator("#sidebarNav").evaluate((sidebar) => {
    const nav = sidebar.querySelector("nav");
    const firstLink = nav?.querySelector("a, button");
    const style = getComputedStyle(sidebar);
    return {
      width: sidebar.getBoundingClientRect().width,
      backgroundColor: style.backgroundColor,
      borderRightColor: style.borderRightColor,
      navGap: nav ? getComputedStyle(nav).rowGap : "",
      linkHeight: firstLink?.getBoundingClientRect().height || 0,
      linkRadius: firstLink ? getComputedStyle(firstLink).borderRadius : "",
    };
  });
  assert.ok(Math.abs(shell.width - 230) <= 1, JSON.stringify(shell));
  assert.equal(shell.backgroundColor, "rgb(255, 255, 255)", JSON.stringify(shell));
  assert.equal(
    shell.borderRightColor,
    isAttorney ? "rgb(216, 229, 239)" : "rgb(227, 232, 238)",
    JSON.stringify(shell)
  );
  assert.equal(shell.navGap, "2px", JSON.stringify(shell));
  assert.ok(shell.linkHeight >= 35 && shell.linkHeight <= 37, JSON.stringify(shell));
  assert.equal(shell.linkRadius, "6px", JSON.stringify(shell));

  const layout = await page.evaluate(() => {
    const main = document.querySelector("main.main");
    const topbar = document.querySelector("[data-lpc-universal-header='true']");
    const searchHost = document.querySelector(".lpc-global-search-host");
    const searchTrigger = document.querySelector(".lpc-global-search-trigger");
    const searchLabel = document.querySelector(".lpc-global-search-trigger-label");
    const mainStyle = getComputedStyle(main);
    const topbarStyle = getComputedStyle(topbar);
    const triggerStyle = getComputedStyle(searchTrigger);
    const mainContentLeft = main.getBoundingClientRect().left + parseFloat(mainStyle.paddingLeft);
    const mainContentRight = main.getBoundingClientRect().right - parseFloat(mainStyle.paddingRight);
    const headerContentRight = topbar.getBoundingClientRect().right - parseFloat(topbarStyle.paddingRight);
    return {
      mainContentLeft,
      mainContentRight,
      mainPaddingLeft: parseFloat(mainStyle.paddingLeft),
      mainPaddingRight: parseFloat(mainStyle.paddingRight),
      mainPaddingBottom: parseFloat(mainStyle.paddingBottom),
      topbarMarginBottom: parseFloat(topbarStyle.marginBottom),
      topbarHeight: topbar.getBoundingClientRect().height,
      topbarBorderBottomWidth: topbarStyle.borderBottomWidth,
      topbarBackground: topbarStyle.backgroundColor,
      headerContentRight,
      searchWidth: searchHost.getBoundingClientRect().width,
      searchLeft: searchHost.getBoundingClientRect().left,
      searchRight: searchHost.getBoundingClientRect().right,
      searchHeight: searchTrigger.getBoundingClientRect().height,
      searchRadius: triggerStyle.borderRadius,
      searchBackground: triggerStyle.backgroundColor,
      searchLabelOpacity: getComputedStyle(searchLabel).opacity,
    };
  });
  assert.ok(layout.mainPaddingLeft >= 40 && layout.mainPaddingLeft <= 72, JSON.stringify(layout));
  assert.equal(layout.mainPaddingLeft, layout.mainPaddingRight, JSON.stringify(layout));
  assert.equal(layout.mainPaddingBottom, isAttorney ? 88 : 64, JSON.stringify(layout));
  assert.equal(layout.topbarMarginBottom, 0, JSON.stringify(layout));
  assert.equal(layout.topbarHeight, 68, JSON.stringify(layout));
  assert.equal(layout.topbarBorderBottomWidth, "1px", JSON.stringify(layout));
  assert.equal(layout.topbarBackground, "rgb(255, 255, 255)", JSON.stringify(layout));
  assert.equal(layout.searchWidth, 46, JSON.stringify(layout));
  const expectedTrailingToolsWidth = isAttorney ? 150 : 100;
  assert.ok(
    Math.abs((layout.headerContentRight - layout.searchRight) - expectedTrailingToolsWidth) <= 2,
    JSON.stringify(layout)
  );
  assert.equal(layout.searchHeight, 46, JSON.stringify(layout));
  assert.equal(layout.searchRadius, "999px", JSON.stringify(layout));
  assert.equal(layout.searchBackground, "rgba(0, 0, 0, 0)", JSON.stringify(layout));
  assert.equal(layout.searchLabelOpacity, "0", JSON.stringify(layout));
}

async function assertDashboardBodyCopyUsesSarabun(page, selector) {
  const typography = await page.locator(selector).first().evaluate((node) => ({
    fontFamily: getComputedStyle(node).fontFamily,
    fontWeight: getComputedStyle(node).fontWeight,
  }));
  assert.match(typography.fontFamily, /Sarabun/i, JSON.stringify(typography));
  assert.doesNotMatch(typography.fontFamily, /Söhne|SF Pro Display/i, JSON.stringify(typography));
}

async function assertAttorneyOperationalHome(page) {
  await page.locator("#attorneyNeedsAttention").waitFor({ state: "visible" });
  await page.locator("#attorneyOnboardingAttentionCard").waitFor({ state: "visible" });
  await page.waitForFunction(() => document.getElementById("user-name-heading")?.textContent?.trim() === "Alex");
  await page.waitForFunction(() =>
    ["overviewMattersBody", "overviewApplicationsBody", "overviewMessagesBody", "overviewCompletedBody", "deadlineList"]
      .every((id) => ["ready", "failed"].includes(document.getElementById(id)?.dataset.state))
  );

  const home = await page.evaluate(() => {
    const actionQueue = document.getElementById("attorneyNeedsAttention");
    const recentMatters = document.querySelector(".view-home #caseCards")?.closest(".ledger-shell");
    const onboarding = document.getElementById("attorneyOnboardingAttentionCard");
    const statusRail = document.querySelector(".view-home .status-rail-shell");
    const statusGrid = document.querySelector(".view-home .status-rail");
    const overviewGrid = document.querySelector(".view-home .home-overview-grid");
    const overviewCards = Array.from(overviewGrid.querySelectorAll(":scope > .status-rail > .status-item"));
    const completedCard = overviewGrid.querySelector(":scope > .status-rail > .status-completed");
    const deadlinesCard = overviewGrid.querySelector(":scope > .mini-deadlines");
    const caseLedger = document.querySelector(".view-home .case-ledger");
    const commandHeader = document.querySelector(".view-home .command-header");
    const homeLayout = document.querySelector(".view-home .home-layout");
    const homeMain = document.querySelector(".view-home .home-main");
    const homeSidebar = document.querySelector(".view-home .home-sidebar");
    const recentTitle = recentMatters.querySelector(".ledger-title");
    const overviewTitle = statusRail.querySelector(".status-overview-title");
    const matterRows = Array.from(caseLedger.querySelectorAll(".matter-row:not(.skeleton-row)"));
    const style = (node) => {
      const computed = getComputedStyle(node);
      return {
        borderTopWidth: computed.borderTopWidth,
        borderRightWidth: computed.borderRightWidth,
        borderBottomWidth: computed.borderBottomWidth,
        borderLeftWidth: computed.borderLeftWidth,
        borderRadius: computed.borderRadius,
        boxShadow: computed.boxShadow,
      };
    };
    return {
      bodyClass: document.body.classList.contains("attorney-dashboard"),
      heading: document.querySelector(".view-home .command-header h1")?.textContent?.trim(),
      summary: document.querySelector(".view-home .command-summary")?.textContent?.trim(),
      summaryNameMinWidth: getComputedStyle(document.getElementById("user-name-heading")).minWidth,
      createHref: new URL(document.querySelector(".command-create-matter")?.href || "", location.href).pathname,
      actionQueue: style(actionQueue),
      actionQueueInMain: actionQueue.parentElement === homeMain,
      actionQueueDisplay: getComputedStyle(actionQueue).display,
      actionQueueColumns: getComputedStyle(actionQueue).gridTemplateColumns,
      actionQueueBackground: getComputedStyle(actionQueue).backgroundColor,
      headerToAttentionGap: actionQueue.getBoundingClientRect().top - commandHeader.getBoundingClientRect().bottom,
      overviewGap: statusRail.getBoundingClientRect().top - homeLayout.getBoundingClientRect().bottom,
      overviewTop: statusRail.getBoundingClientRect().top,
      overviewWidth: statusRail.getBoundingClientRect().width,
      overviewHeading: overviewTitle.textContent?.trim(),
      overviewGridDisplay: getComputedStyle(overviewGrid).display,
      overviewGridColumns: getComputedStyle(overviewGrid).gridTemplateColumns,
      overviewGridGap: parseFloat(getComputedStyle(overviewGrid).gap),
      overviewCardCount: overviewCards.length,
      overviewCardMinHeight: Math.min(...overviewCards.map((node) => node.getBoundingClientRect().height)),
      overviewCardMaxHeight: Math.max(...overviewCards.map((node) => node.getBoundingClientRect().height)),
      overviewFirstCardBorder: getComputedStyle(overviewCards[0]).borderTopWidth,
      overviewFirstCardWidth: overviewCards[0]?.getBoundingClientRect().width || 0,
      overviewCompletedWidth: completedCard.getBoundingClientRect().width,
      deadlinesCardWidth: deadlinesCard.getBoundingClientRect().width,
      overviewExtendsBelowFold: overviewGrid.getBoundingClientRect().bottom > window.innerHeight,
      recentMatters: style(recentMatters),
      recentMatterColumns: getComputedStyle(caseLedger).gridTemplateColumns,
      recentMatterDisplay: getComputedStyle(caseLedger).display,
      recentMatterCount: matterRows.length,
      recentMattersAllHref: recentMatters.querySelector('.recent-matters-all')?.getAttribute('href'),
      recentMattersAllTarget: recentMatters.querySelector('.recent-matters-all')?.dataset.viewTarget,
      matterRows: matterRows.slice(0, 2).map((row) => ({
        left: row.getBoundingClientRect().left,
        top: row.getBoundingClientRect().top,
        width: row.getBoundingClientRect().width,
        paddingTop: parseFloat(getComputedStyle(row).paddingTop),
        paddingBottom: parseFloat(getComputedStyle(row).paddingBottom),
      })),
      recentTitleSize: parseFloat(getComputedStyle(recentTitle).fontSize),
      recentTitleWeight: Number(getComputedStyle(recentTitle).fontWeight),
      overviewTitleSize: parseFloat(getComputedStyle(overviewTitle).fontSize),
      onboarding: style(onboarding),
      onboardingBackground: getComputedStyle(onboarding).backgroundColor,
      onboardingHeight: onboarding.getBoundingClientRect().height,
      onboardingInRail: onboarding.parentElement === homeSidebar,
      recentMattersInRail: recentMatters.parentElement === homeSidebar,
      recentMattersInMain: recentMatters.parentElement === homeMain,
      overviewAfterLayout: statusRail.previousElementSibling === homeLayout,
      overviewInHomePanel: statusRail.parentElement === document.getElementById("homeCasesPanel"),
      onboardingProgressCopy: onboarding.querySelector('[data-onboarding-progress-copy]')?.textContent?.trim(),
      onboardingProgressNow: onboarding.querySelector('.onboarding-attention-progress')?.getAttribute('aria-valuenow'),
      onboardingProgressWidth: onboarding.querySelector('[data-onboarding-progress-bar]')?.getBoundingClientRect().width,
      onboardingProgressTrackWidth: onboarding.querySelector('.onboarding-attention-progress')?.getBoundingClientRect().width,
      onboardingButtonCount: onboarding.querySelectorAll('button').length,
      onboardingChecklistCount: onboarding.querySelectorAll('[data-onboarding-check-step]').length,
      onboardingStep: onboarding.dataset.step,
      onboardingCta: onboarding.querySelector('[data-onboarding-attention-action]')?.textContent?.trim(),
      onboardingFullyVisible: onboarding.getBoundingClientRect().bottom <= window.innerHeight,
      onboardingProgressColor: getComputedStyle(onboarding.querySelector('[data-onboarding-progress-bar]')).backgroundColor,
      overviewStates: Object.fromEntries(
        ["overviewMattersBody", "overviewApplicationsBody", "overviewMessagesBody", "overviewCompletedBody", "deadlineList"]
          .map((id) => [id, document.getElementById(id)?.dataset.state])
      ),
      overviewCopy: Object.fromEntries(
        ["overviewMattersBody", "overviewApplicationsBody", "overviewMessagesBody", "overviewCompletedBody", "deadlineList"]
          .map((id) => [id, document.getElementById(id)?.textContent?.replace(/\s+/g, " ").trim()])
      ),
      deadlineRowCount: document.querySelectorAll("#deadlineList .overview-deadline-row").length,
      statusRail: style(statusRail),
      statusColumns: getComputedStyle(statusGrid).gridTemplateColumns,
      weeklyNotesOnHome: Boolean(document.querySelector(".view-home .weekly-notes")),
      weeklyNotesInTasks: Boolean(document.querySelector('.view-tasks .weekly-notes')),
      mainWidth: homeMain.getBoundingClientRect().width,
      railWidth: homeSidebar.getBoundingClientRect().width,
      columnGap: homeSidebar.getBoundingClientRect().left - homeMain.getBoundingClientRect().right,
      canvasBackground: getComputedStyle(document.querySelector('main.main')).backgroundColor,
      searchBackground: getComputedStyle(document.querySelector('.lpc-global-search-trigger')).backgroundColor,
      activeNavBackground: getComputedStyle(document.querySelector('#sidebarNav [data-view-target="home"]')).backgroundColor,
      createMatterBackground: getComputedStyle(document.querySelector('.command-create-matter')).backgroundColor,
      keyShadows: [actionQueue, recentMatters, onboarding, statusRail, commandHeader].map((node) => getComputedStyle(node).boxShadow),
    };
  });

  assert.equal(home.bodyClass, true, JSON.stringify(home));
  assert.equal(home.heading, "Today", JSON.stringify(home));
  assert.equal(home.summary, "Welcome, Alex.", JSON.stringify(home));
  assert.equal(home.summaryNameMinWidth, "0px", JSON.stringify(home));
  assert.equal(home.createHref, "/create-case.html", JSON.stringify(home));
  assert.equal(home.actionQueueInMain, true, JSON.stringify(home));
  assert.equal(home.actionQueue.borderLeftWidth, "0px", JSON.stringify(home));
  assert.equal(home.actionQueue.borderRadius, "0px", JSON.stringify(home));
  assert.equal(home.actionQueueDisplay, "block", JSON.stringify(home));
  assert.equal(home.actionQueueColumns, "none", JSON.stringify(home));
  assert.equal(home.actionQueueBackground, "rgb(255, 255, 255)", JSON.stringify(home));
  assert.ok(home.headerToAttentionGap >= 40 && home.headerToAttentionGap <= 48, JSON.stringify(home));
  assert.ok(home.overviewGap >= 48 && home.overviewGap <= 56, JSON.stringify(home));
  assert.ok(Math.abs(home.overviewWidth - (home.mainWidth + home.railWidth + home.columnGap)) <= 2, JSON.stringify(home));
  assert.equal(home.overviewHeading, "Your overview", JSON.stringify(home));
  assert.equal(home.overviewGridDisplay, "grid", JSON.stringify(home));
  assert.equal(home.overviewGridColumns.split(" ").length, 4, JSON.stringify(home));
  assert.ok(home.overviewGridGap >= 8 && home.overviewGridGap <= 12, JSON.stringify(home));
  assert.equal(home.overviewCardCount, 4, JSON.stringify(home));
  assert.ok(home.overviewCardMinHeight >= 150 && home.overviewCardMinHeight <= 180, JSON.stringify(home));
  assert.ok(home.overviewCardMaxHeight <= 180, JSON.stringify(home));
  assert.equal(home.overviewFirstCardBorder, "1px", JSON.stringify(home));
  assert.ok(Math.abs(home.overviewCompletedWidth - home.overviewFirstCardWidth) <= 2, JSON.stringify(home));
  assert.ok(home.deadlinesCardWidth >= home.overviewFirstCardWidth * 1.9, JSON.stringify(home));
  assert.equal(home.recentMatters.borderLeftWidth, "0px", JSON.stringify(home));
  assert.equal(home.recentMatters.borderRadius, "0px", JSON.stringify(home));
  assert.equal(home.recentMatterDisplay, "block", JSON.stringify(home));
  assert.doesNotMatch(home.recentMatterColumns, /px .*px/, JSON.stringify(home));
  assert.equal(home.recentMatterCount, 5, JSON.stringify(home));
  assert.equal(home.recentMattersAllHref, "#cases", JSON.stringify(home));
  assert.equal(home.recentMattersAllTarget, "cases", JSON.stringify(home));
  if (home.matterRows.length > 1) {
    assert.ok(home.matterRows[1].top > home.matterRows[0].top, JSON.stringify(home));
    assert.ok(Math.abs(home.matterRows[1].left - home.matterRows[0].left) <= 1, JSON.stringify(home));
    assert.ok(Math.abs(home.matterRows[1].width - home.matterRows[0].width) <= 1, JSON.stringify(home));
  }
  home.matterRows.forEach((row) => {
    assert.equal(row.paddingTop, 16, JSON.stringify(home));
    assert.equal(row.paddingBottom, 16, JSON.stringify(home));
  });
  assert.equal(home.recentTitleWeight, 400, JSON.stringify(home));
  assert.ok(home.overviewTitleSize > home.recentTitleSize, JSON.stringify(home));
  assert.equal(home.onboardingInRail, true, JSON.stringify(home));
  assert.equal(home.recentMattersInRail, false, JSON.stringify(home));
  assert.equal(home.recentMattersInMain, true, JSON.stringify(home));
  assert.equal(home.overviewAfterLayout, true, JSON.stringify(home));
  assert.equal(home.overviewInHomePanel, true, JSON.stringify(home));
  assert.equal(home.onboarding.borderTopWidth, "0px", JSON.stringify(home));
  assert.equal(home.onboarding.borderLeftWidth, "0px", JSON.stringify(home));
  assert.equal(home.onboarding.borderRadius, "8px", JSON.stringify(home));
  assert.equal(home.onboardingBackground, "rgb(238, 245, 251)", JSON.stringify(home));
  assert.ok(home.onboardingHeight <= 230, JSON.stringify(home));
  assert.match(home.onboardingProgressCopy, /^\d of 3 complete$/, JSON.stringify(home));
  assert.match(home.onboardingProgressNow, /^[0-3]$/, JSON.stringify(home));
  assert.ok(home.onboardingProgressWidth <= home.onboardingProgressTrackWidth, JSON.stringify(home));
  assert.equal(home.onboardingButtonCount, 1, JSON.stringify(home));
  assert.equal(home.onboardingChecklistCount, 0, JSON.stringify(home));
  assert.equal(home.onboardingStep, "payment", JSON.stringify(home));
  assert.equal(home.onboardingCta, "Open payments", JSON.stringify(home));
  assert.equal(home.onboardingFullyVisible, true, JSON.stringify(home));
  assert.equal(home.onboardingProgressColor, "rgb(85, 124, 159)", JSON.stringify(home));
  assert.deepEqual(home.overviewStates, {
    overviewMattersBody: "ready",
    overviewApplicationsBody: "ready",
    overviewMessagesBody: "ready",
    overviewCompletedBody: "ready",
    deadlineList: "ready",
  }, JSON.stringify(home));
  assert.equal(home.overviewCopy.overviewMattersBody, "6 current", JSON.stringify(home));
  assert.equal(home.overviewCopy.overviewApplicationsBody, "4 awaiting review", JSON.stringify(home));
  assert.equal(home.overviewCopy.overviewMessagesBody, "3", JSON.stringify(home));
  assert.equal(home.overviewCopy.overviewCompletedBody, "12", JSON.stringify(home));
  assert.match(home.overviewCopy.deadlineList, /Martinez discovery.*Northstar contract review/, JSON.stringify(home));
  assert.equal(home.deadlineRowCount, 2, JSON.stringify(home));
  assert.equal(home.statusRail.borderLeftWidth, "0px", JSON.stringify(home));
  assert.equal(home.statusRail.borderRightWidth, "0px", JSON.stringify(home));
  assert.equal(home.statusRail.borderRadius, "0px", JSON.stringify(home));
  assert.doesNotMatch(home.statusColumns, /px .*px/, JSON.stringify(home));
  assert.equal(home.weeklyNotesOnHome, false, JSON.stringify(home));
  assert.equal(home.weeklyNotesInTasks, true, JSON.stringify(home));
  assert.ok(home.mainWidth / (home.mainWidth + home.railWidth) >= 0.69, JSON.stringify(home));
  assert.ok(home.mainWidth / (home.mainWidth + home.railWidth) <= 0.71, JSON.stringify(home));
  assert.ok(home.columnGap >= 32 && home.columnGap <= 40, JSON.stringify(home));
  assert.equal(home.canvasBackground, "rgb(255, 255, 255)", JSON.stringify(home));
  assert.equal(home.searchBackground, "rgba(0, 0, 0, 0)", JSON.stringify(home));
  assert.equal(home.activeNavBackground, "rgb(238, 245, 251)", JSON.stringify(home));
  assert.equal(home.createMatterBackground, "rgb(255, 255, 255)", JSON.stringify(home));
  assert.deepEqual(home.keyShadows, ["none", "none", "none", "none", "none"], JSON.stringify(home));
}

async function assertAttorneyWeeklyNotesInTasks(page) {
  await page.evaluate(() => {
    window.location.hash = "tasks";
  });
  await page.locator('[data-view="tasks"]').waitFor({ state: "visible" });
  await page.locator('.view-tasks .weekly-notes').waitFor({ state: "visible" });
  await page.waitForFunction(() => document.getElementById("weeklyNotesRange")?.textContent?.trim().length > 0);
  await page.waitForFunction(() => document.querySelectorAll('.view-tasks .weekly-note-day').length >= 7);

  const placement = await page.evaluate(() => {
    const taskView = document.querySelector('.view-tasks');
    const taskShell = taskView.querySelector('.tasks-shell');
    const taskBoard = taskView.querySelector('.task-board');
    const weeklyNotes = taskView.querySelector('.weekly-notes');
    const styles = getComputedStyle(weeklyNotes);
    return {
      onlyInstance: document.querySelectorAll('.weekly-notes').length,
      insideTaskShell: weeklyNotes.parentElement === taskShell,
      sectionGap: weeklyNotes.getBoundingClientRect().top - taskBoard.getBoundingClientRect().bottom,
      borderLeftWidth: styles.borderLeftWidth,
      borderRadius: styles.borderRadius,
      backgroundColor: styles.backgroundColor,
      dayCount: weeklyNotes.querySelectorAll('.weekly-note-day').length,
    };
  });

  assert.equal(placement.onlyInstance, 1, JSON.stringify(placement));
  assert.equal(placement.insideTaskShell, true, JSON.stringify(placement));
  assert.ok(placement.sectionGap >= 40, JSON.stringify(placement));
  assert.equal(placement.borderLeftWidth, "0px", JSON.stringify(placement));
  assert.equal(placement.borderRadius, "0px", JSON.stringify(placement));
  assert.equal(placement.backgroundColor, "rgba(0, 0, 0, 0)", JSON.stringify(placement));
  assert.ok(placement.dayCount >= 7, JSON.stringify(placement));

  const rangeBefore = (await page.locator('#weeklyNotesRange').textContent()).trim();
  await page.locator('#weeklyNotesPrev').click();
  await page.waitForFunction(
    (previousRange) => document.getElementById("weeklyNotesRange")?.textContent?.trim() !== previousRange,
    rangeBefore
  );
}

async function runDirectory(browser, viewport, photoStatus = 200, role = "attorney") {
  const page = await browser.newPage({ viewport });
  await installRoutes(page, { role, photoStatus });
  await page.goto("https://lpc.test/browse-paralegals.html");
  await page.waitForSelector("body.authenticated-browse");
  const shell = await page.evaluate(() => {
    const publicHeader = document.querySelector("[data-public-header]");
    const sidebar = document.querySelector("[data-auth-sidebar]");
    return {
      url: location.href,
      publicHeaderDisplay: publicHeader ? getComputedStyle(publicHeader).display : null,
      sidebarDisplay: sidebar ? getComputedStyle(sidebar).display : null,
      sidebarHidden: sidebar?.hidden,
      activeNavigation: document.querySelector("[data-auth-sidebar-nav] [aria-current='page']")?.textContent?.trim(),
    };
  });
  assert.equal(shell.publicHeaderDisplay, "none", JSON.stringify(shell));
  assert.notEqual(shell.sidebarDisplay, "none", JSON.stringify(shell));
  assert.equal(shell.sidebarHidden, false, JSON.stringify(shell));
  assert.equal(shell.activeNavigation, role === "attorney" ? "Paralegals" : undefined, JSON.stringify(shell));

  if (viewport.width <= 960) {
    const toggle = page.locator("[data-auth-sidebar-toggle]");
    await toggle.click();
    assert.equal(await toggle.getAttribute("aria-expanded"), "true");
    await page.waitForFunction(() => {
      const sidebar = document.querySelector("[data-auth-sidebar]");
      return sidebar && sidebar.getBoundingClientRect().left >= -1;
    });
    const sidebarLeft = await page.locator("[data-auth-sidebar]").evaluate((node) => node.getBoundingClientRect().left);
    assert.ok(sidebarLeft >= -1, String(sidebarLeft));
  }
  const image = page.locator(`.paralegal-card[data-paralegal-id="${profileId}"] img`);
  await image.waitFor();
  if (photoStatus === 200) {
    await page.waitForFunction((id) => {
      const node = document.querySelector(`.paralegal-card[data-paralegal-id="${id}"] img`);
      return node?.complete && node.naturalWidth > 0;
    }, profileId);
    assert.equal(new URL(await image.getAttribute("src"), "https://lpc.test").pathname, `/api/public/paralegals/${profileId}/photo`);
  } else {
    await page.waitForFunction((id) => {
      const node = document.querySelector(`.paralegal-card[data-paralegal-id="${id}"] img`);
      return node?.complete && node.naturalWidth > 0 && new URL(node.src).pathname === "/assets/avatar-placeholder.svg";
    }, profileId);
    assert.equal(new URL(await image.getAttribute("src"), "https://lpc.test").pathname, "/assets/avatar-placeholder.svg");
  }
  await assertNoHorizontalOverflow(page);
  if (photoStatus === 200) {
    await page.screenshot({ path: `/tmp/lpc-auth-browse-${role}-${viewport.width}.png`, fullPage: true });
  }
  await page.close();
}

async function runProfile(browser, { role, viewport, self = false }) {
  const page = await browser.newPage({ viewport });
  await installRoutes(page, { role });
  const query = self ? "?me=1" : `?paralegalId=${profileId}`;
  await page.goto(`https://lpc.test/profile-paralegal.html${query}`);
  const image = page.locator("[data-profile-avatar]");
  await image.waitFor();
  await page.waitForFunction(() => {
    const node = document.querySelector("[data-profile-avatar]");
    return node?.complete && node.naturalWidth > 0;
  });
  assert.equal(new URL(await image.getAttribute("src"), "https://lpc.test").pathname, `/api/public/paralegals/${profileId}/photo`);
  const resumeLink = page.locator("#resumeLink");
  await resumeLink.waitFor({ state: "visible" });
  const resumeHref = new URL(await resumeLink.getAttribute("href"), "https://lpc.test");
  assert.equal(resumeHref.pathname, "/api/uploads/view");
  assert.equal(resumeHref.searchParams.get("key"), profile.resumeURL);
  assert.equal(await resumeLink.getAttribute("data-key"), profile.resumeURL);
  await assertNoHorizontalOverflow(page);
  await page.close();
}

async function runProfileSettingsCropper(browser, { role, viewport }) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const state = await installRoutes(page, { role });
  await page.goto(`https://lpc.test/profile-settings.html${role === "attorney" ? "#profile" : ""}`);

  const isAttorney = role === "attorney";
  const rolePanel = page.locator(isAttorney ? "#attorneySettings" : "#paralegalSettings");
  await rolePanel.waitFor({ state: "visible" });
  const input = page.locator(isAttorney ? "#attorneyAvatarInput" : "#avatarInput");
  const preview = page.locator(isAttorney ? "#attorneyAvatarPreview" : "#avatarPreview");
  const modal = page.locator("#photoCropModal");
  const saveButton = page.locator("#photoCropSave");
  const zoom = page.locator("#photoCropZoom");

  await input.setInputFiles(cropFixturePath);
  await modal.waitFor({ state: "visible" });
  assert.equal(await page.evaluate(() => window.Cropper?.default?.version || window.Cropper?.version), "2.1.1");
  await page.waitForFunction(() => {
    const save = document.getElementById("photoCropSave");
    const zoomControl = document.getElementById("photoCropZoom");
    return save && !save.disabled && zoomControl && !zoomControl.disabled;
  });
  assert.equal(await modal.getAttribute("aria-hidden"), "false");
  assert.equal(await modal.getAttribute("inert"), null);
  assert.equal(await page.locator("#photoCropCancel").evaluate((node) => node === document.activeElement), true);
  assert.equal(await page.locator(".photo-crop-stage cropper-canvas").count(), 1, "Cropper UI did not render");
  assert.equal(await page.locator(".photo-crop-stage cropper-image").count(), 1, "Cropper image did not render");
  assert.equal(await page.locator(".photo-crop-stage cropper-selection").count(), 1, "Cropper selection did not render");
  const accessibility = await new AxeBuilder({ page }).include("#photoCropModal").analyze();
  assert.deepEqual(
    accessibility.violations.map((violation) => violation.id),
    [],
    JSON.stringify(accessibility.violations, null, 2)
  );

  await page.evaluate(() => {
    const stage = document.getElementById("photoCropStage");
    window.__cropperMutationAudit = { added: 0, removed: 0 };
    window.__cropperMutationObserver = new MutationObserver((records) => {
      records.forEach((record) => {
        record.addedNodes.forEach((node) => {
          if (node.nodeType === Node.ELEMENT_NODE && node.matches?.("cropper-image")) {
            window.__cropperMutationAudit.added += 1;
          }
        });
        record.removedNodes.forEach((node) => {
          if (node.nodeType === Node.ELEMENT_NODE && node.matches?.("cropper-image")) {
            window.__cropperMutationAudit.removed += 1;
          }
        });
      });
    });
    window.__cropperMutationObserver.observe(stage, { childList: true, subtree: true });
  });
  const cropSelectionBox = await page.locator(".photo-crop-stage cropper-selection").boundingBox();
  assert.ok(cropSelectionBox, "Cropper selection has no draggable bounds");
  const dragX = cropSelectionBox.x + cropSelectionBox.width / 2;
  const dragY = cropSelectionBox.y + cropSelectionBox.height / 2;
  await page.mouse.move(dragX, dragY);
  await page.mouse.down();
  await page.mouse.move(dragX + 8, dragY + 4, { steps: 8 });
  await page.mouse.up();
  const cropperMutationAudit = await page.evaluate(() => {
    window.__cropperMutationObserver.disconnect();
    return window.__cropperMutationAudit;
  });
  assert.deepEqual(cropperMutationAudit, { added: 0, removed: 0 }, "Dragging the cropper mutated its DOM");

  await page.locator("#photoCropStage").focus();
  await page.keyboard.press("ArrowRight");
  await zoom.fill("0.2");
  await zoom.dispatchEvent("input");
  const uploadRequestPromise = page.waitForRequest((request) =>
    request.method() === "POST" && new URL(request.url()).pathname === "/api/uploads/profile-photo"
  );
  await saveButton.click();
  if (isAttorney) {
    await uploadRequestPromise;
    await page.waitForFunction(() => {
      const node = document.getElementById("attorneyAvatarPreview");
      return node?.complete && node.naturalWidth > 0 && new URL(node.src).pathname.startsWith("/api/users/profile-photo/");
    });
  } else {
    await page.waitForFunction(() => {
      const node = document.getElementById("avatarPreview");
      return (
        node &&
        String(node.getAttribute("src") || "").startsWith("data:image/jpeg") &&
        node.complete &&
        node.naturalWidth === 600 &&
        node.naturalHeight === 600
      );
    });
    await page.locator("#profileSaveBtn").click();
  }
  assert.equal(await modal.getAttribute("aria-hidden"), "true");
  assert.equal(await modal.getAttribute("inert"), "");
  assert.equal(await preview.isVisible(), true);
  const uploadRequest = await uploadRequestPromise;
  await waitForToast(
    page,
    isAttorney ? "Profile photo updated!" : "Settings saved and profile photo submitted for review."
  );
  assert.match(uploadRequest.headers()["content-type"] || "", /^multipart\/form-data; boundary=/);
  assert.equal(state.profilePhotoUploads.length, 1);
  const multipartBody = state.profilePhotoUploads[0].body.toString("latin1");
  assert.match(multipartBody, /name="file"; filename="favicon-32x32\.jpg"/);
  assert.match(multipartBody, /Content-Type: image\/jpeg/i);
  assert.match(multipartBody, /name="original"; filename="favicon-32x32\.png"/);
  if (isAttorney) {
    assert.equal(state.viewer.profilePhotoStatus, "approved");
    assert.match(state.viewer.profileImage, /^\/api\/users\/profile-photo\//);
    assert.equal(state.patchRequests.length, 0, "Attorney photo save must not submit general profile settings");
  } else {
    assert.equal(state.viewer.profilePhotoStatus, "pending_review");
    assert.match(state.viewer.pendingProfileImage, /variant=pending/);
    assert.equal(await page.locator("#photoReviewStatus").textContent(), "Your profile is hidden from attorney discovery until your photo is approved.");
  }
  assert.equal(pageErrors.length, 0, pageErrors.join("\n"));
  await assertNoHorizontalOverflow(page);
  await context.close();
}

async function waitForSaveState(page, buttonId) {
  await page.waitForFunction((id) => {
    const button = document.getElementById(id);
    return Boolean(button?.disabled && button.textContent?.trim() === "Saving…");
  }, buttonId);
}

async function waitForToast(page, message) {
  await page.waitForFunction((expected) => {
    const toast = document.getElementById("toastBanner");
    return Boolean(toast?.classList.contains("show") && toast.textContent?.trim() === expected);
  }, message);
}

async function waitForCropperReady(page) {
  await page.waitForFunction(() => {
    const save = document.getElementById("photoCropSave");
    const zoomControl = document.getElementById("photoCropZoom");
    return save && !save.disabled && zoomControl && !zoomControl.disabled;
  });
}

async function assertAttorneyPhotoEditorLayout(page, viewport) {
  const layout = await page.evaluate(() => {
    const card = document.querySelector("#photoCropModal .photo-crop-card");
    const stage = document.getElementById("photoCropStage");
    const title = document.getElementById("photoCropTitle");
    const slider = document.getElementById("photoCropZoom");
    const canvas = stage?.querySelector("cropper-canvas");
    const selection = stage?.querySelector("cropper-selection");
    const cardRect = card?.getBoundingClientRect();
    const stageRect = stage?.getBoundingClientRect();
    const saveRect = document.getElementById("photoCropSave")?.getBoundingClientRect();
    const sliderStyle = slider ? getComputedStyle(slider) : null;
    const titleStyle = title ? getComputedStyle(title) : null;
    const canvasStyle = canvas ? getComputedStyle(canvas) : null;
    const selectionStyle = selection ? getComputedStyle(selection) : null;
    const modalStyle = getComputedStyle(document.getElementById("photoCropModal"));
    return {
      card: cardRect && {
        width: cardRect.width,
        height: cardRect.height,
        top: cardRect.top,
        bottom: cardRect.bottom,
        clientHeight: card.clientHeight,
        scrollHeight: card.scrollHeight,
      },
      stage: stageRect && { width: stageRect.width, height: stageRect.height },
      saveBottom: saveRect?.bottom,
      titleFontSize: titleStyle?.fontSize,
      titleFontFamily: titleStyle?.fontFamily,
      sliderAccent: sliderStyle?.accentColor,
      canvasBackgroundImage: canvasStyle?.backgroundImage,
      selectionOutline: selectionStyle?.outlineColor,
      modalZIndex: Number(modalStyle.zIndex),
      canvasHasCheckerboardAttribute: canvas?.hasAttribute("background"),
      selectionHasDefaultOutline: selection?.hasAttribute("outlined"),
      previewCount: document.querySelectorAll(".photo-crop-preview").length,
    };
  });

  assert.ok(layout.card && layout.stage, JSON.stringify(layout));
  const expectedCardWidth = viewport.width <= 640 ? viewport.width - 24 : 480;
  assert.ok(Math.abs(layout.card.width - expectedCardWidth) <= 1, JSON.stringify(layout));
  const expectedStageSize = viewport.width <= 640 ? Math.min(320, viewport.width - 66) : 320;
  assert.ok(Math.abs(layout.stage.width - expectedStageSize) <= 1, JSON.stringify(layout));
  assert.ok(Math.abs(layout.stage.width - layout.stage.height) <= 1, JSON.stringify(layout));
  assert.ok(layout.card.height <= Math.min(620, viewport.height - 24), JSON.stringify(layout));
  assert.ok(layout.card.top >= 11 && layout.card.bottom <= viewport.height - 11, JSON.stringify(layout));
  assert.ok(layout.saveBottom <= viewport.height - 11, JSON.stringify(layout));
  if (viewport.width >= 641) {
    assert.ok(layout.card.scrollHeight <= layout.card.clientHeight + 1, JSON.stringify(layout));
  }
  assert.equal(layout.titleFontSize, "20px");
  assert.match(layout.titleFontFamily || "", /Söhne.*SF Pro Display/i);
  assert.equal(layout.sliderAccent, "rgb(182, 164, 122)");
  assert.equal(layout.modalZIndex, 3000);
  assert.equal(layout.canvasBackgroundImage, "none");
  assert.doesNotMatch(layout.selectionOutline || "", /0, 85, 255|0, 123, 255|59, 130, 246/);
  assert.equal(layout.canvasHasCheckerboardAttribute, false);
  assert.equal(layout.selectionHasDefaultOutline, false);
  assert.equal(layout.previewCount, 0);
}

async function openAndAssertSidebarAccountMenu(page, viewport, screenshotDir = "") {
  if (viewport.width <= 900) {
    await page.locator("#sidebarToggle").click();
    await page.waitForFunction(() => document.body.classList.contains("nav-open"));
  }

  const trigger = page.locator(".lpc-sidebar-profile-trigger");
  await trigger.waitFor({ state: "visible" });
  const triggerBox = await trigger.boundingBox();
  assert.ok(triggerBox, "Sidebar account trigger did not render");
  assert.match((await trigger.textContent()) || "", /Alex Attorney/);
  await trigger.click();

  const menu = page.locator(".lpc-sidebar-account-menu");
  await menu.waitFor({ state: "visible" });
  assert.equal(await trigger.getAttribute("aria-expanded"), "true");
  assert.equal(await menu.locator(".lpc-account-menu-product").textContent(), "Let’s-ParaConnect");
  assert.equal(await menu.locator("[data-account-settings] .lpc-account-menu-label").textContent(), "Settings");
  assert.equal(await menu.locator("[data-account-create] .lpc-account-menu-label").textContent(), "Create");
  assert.equal(await menu.locator(".lpc-account-menu-user-name").textContent(), "Alex Attorney");
  const profileLink = menu.locator("a.lpc-account-menu-user");
  assert.equal(await profileLink.count(), 1);
  const profileUrl = new URL(await profileLink.getAttribute("href"), "https://lpc.test");
  assert.equal(profileUrl.pathname, "/profile-settings.html");
  assert.equal(profileUrl.hash, "#profile");
  assert.equal(await profileLink.getAttribute("aria-label"), "Open profile settings for Alex Attorney");
  assert.equal(await menu.locator("[data-logout] .lpc-account-menu-label").textContent(), "Sign out");
  assert.equal(new URL(await menu.locator("[data-account-settings]").getAttribute("href"), "https://lpc.test").pathname, "/profile-settings.html");
  assert.equal(new URL(await menu.locator("[data-account-create]").getAttribute("href"), "https://lpc.test").pathname, "/create-case.html");
  assert.equal(await menu.getByText(/sandbox/i).count(), 0);
  assert.equal(await menu.locator(".lpc-account-menu-icon").count(), 4);
  assert.equal(await menu.locator(".lpc-account-menu-trailing-icon").count(), 2);
  await page.waitForFunction(() => {
    const image = document.querySelector(".lpc-account-menu-avatar");
    return image?.complete && image.naturalWidth > 0;
  });

  const menuBox = await menu.boundingBox();
  assert.ok(menuBox, "Sidebar account menu did not render");
  assert.ok(Math.abs(menuBox.width - Math.min(270, viewport.width - 24)) <= 1, JSON.stringify(menuBox));
  assert.ok(Math.abs(menuBox.y - (triggerBox.y + triggerBox.height + 8)) <= 8, JSON.stringify({ menuBox, triggerBox }));
  assert.ok(menuBox.x >= 11 && menuBox.x + menuBox.width <= viewport.width - 11, JSON.stringify(menuBox));
  assert.ok(menuBox.y + menuBox.height <= viewport.height - 11, JSON.stringify(menuBox));

  const accessibility = await new AxeBuilder({ page }).include(".lpc-sidebar-account-menu").analyze();
  assert.deepEqual(
    accessibility.violations.map((violation) => violation.id),
    [],
    JSON.stringify(accessibility.violations, null, 2)
  );

  if (screenshotDir) {
    await page.screenshot({
      path: path.join(screenshotDir, `attorney-sidebar-account-menu-${viewport.width}x${viewport.height}.png`),
      fullPage: false,
    });
  }

  await page.keyboard.press("Escape");
  await menu.waitFor({ state: "hidden" });
  assert.equal(await trigger.getAttribute("aria-expanded"), "false");
  assert.equal(await trigger.evaluate((node) => node === document.activeElement), true);
  if (viewport.width <= 900) {
    if (await page.evaluate(() => document.body.classList.contains("nav-open"))) {
      await page.locator("#sidebarToggle").click();
    }
    await page.waitForFunction(() => !document.body.classList.contains("nav-open"));
  }
}

async function confirmRemoval(page) {
  const dialog = page.locator(".lpc-dialog");
  await dialog.waitFor({ state: "visible" });
  await dialog.locator(".lpc-dialog__button--primary").click();
}

async function runAttorneyPhotoReliability(browser, viewport) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const state = await installRoutes(page, { role: "attorney", attorneyPhoto: true });
  await page.goto("https://lpc.test/profile-settings.html#profile");
  await page.locator("#attorneySettings").waitFor({ state: "visible" });
  await page.waitForFunction(() => {
    const image = document.getElementById("attorneyAvatarPreview");
    return image?.complete && image.naturalWidth > 0;
  });

  const avatar = page.locator("#attorneyAvatarPreview");
  const originalAvatarSrc = await avatar.getAttribute("src");
  assert.match(originalAvatarSrc, /^\/api\/users\/profile-photo\//);

  await page.locator("#attorneyAvatarFrame").click();
  await page.locator("#photoCropModal").waitFor({ state: "visible" });
  await waitForCropperReady(page);
  assert.equal(await page.locator("#photoCropError").isHidden(), true);
  assert.equal(await page.locator("#photoCropLoading").getAttribute("aria-hidden"), "true");
  await page.locator("#photoCropClose").click();
  assert.equal(
    await page.locator("#attorneyAvatarFrame").evaluate((node) => node === document.activeElement),
    true,
    "Closing the editor did not restore focus to the invoking avatar"
  );

  state.failNextPhotoUpload = true;
  await page.locator("#attorneyAvatarInput").setInputFiles(cropFixturePath);
  await page.locator("#photoCropModal").waitFor({ state: "visible" });
  await page.waitForFunction(() => document.getElementById("photoCropImage")?.src.startsWith("data:image/"));
  await waitForCropperReady(page);
  await page.locator("#photoCropSave").click();
  await page.locator("#photoCropError").waitFor({ state: "visible" });
  assert.equal(await page.locator("#photoCropModal").getAttribute("aria-hidden"), "false");
  assert.equal(await avatar.getAttribute("src"), originalAvatarSrc, "Failed upload replaced the saved avatar");
  assert.equal(state.profilePhotoUploadAttempts, 1);

  const retryUpload = page.waitForResponse((response) =>
    response.request().method() === "POST" && new URL(response.url()).pathname === "/api/uploads/profile-photo"
  );
  await page.locator("#photoCropTryAgain").click();
  assert.equal((await retryUpload).ok(), true);
  await page.waitForFunction(() => document.getElementById("photoCropModal")?.getAttribute("aria-hidden") === "true");
  await page.waitForFunction((previousSrc) => {
    const image = document.getElementById("attorneyAvatarPreview");
    return image?.complete && image.naturalWidth > 0 && image.getAttribute("src") !== previousSrc;
  }, originalAvatarSrc);
  assert.equal(state.profilePhotoUploadAttempts, 2);
  assert.equal(state.profilePhotoUploads.length, 1);
  const refreshedAvatarSrc = await avatar.getAttribute("src");
  assert.notEqual(refreshedAvatarSrc, originalAvatarSrc);
  const globalAvatarSources = await page.locator(".nav-profile-photo, .globalProfileImage").evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute("src"))
  );
  globalAvatarSources.forEach((src) => assert.equal(src, refreshedAvatarSrc));

  state.failNextPhotoRemoval = true;
  await page.locator("#removeAttorneyAvatarBtn").click();
  const failedRemoval = page.waitForResponse((response) =>
    response.request().method() === "PATCH" && new URL(response.url()).pathname === "/api/users/me"
  );
  await confirmRemoval(page);
  assert.equal((await failedRemoval).status(), 503);
  await waitForToast(page, "Temporary photo removal failure");
  assert.equal(await avatar.getAttribute("src"), refreshedAvatarSrc, "Failed removal cleared the avatar");

  await page.locator("#removeAttorneyAvatarBtn").click();
  const successfulRemoval = page.waitForResponse((response) =>
    response.request().method() === "PATCH" && new URL(response.url()).pathname === "/api/users/me"
  );
  await confirmRemoval(page);
  assert.equal((await successfulRemoval).ok(), true);
  await waitForToast(page, "Profile photo removed.");
  await page.waitForFunction(() => {
    const image = document.getElementById("attorneyAvatarPreview");
    return image?.complete && image.naturalWidth > 0 && new URL(image.src).pathname === "/assets/avatar-placeholder.svg";
  });
  assert.equal(await page.locator("#removeAttorneyAvatarBtn").isHidden(), true);
  assert.equal(pageErrors.length, 0, pageErrors.join("\n"));
  await assertNoHorizontalOverflow(page);
  await context.close();
}

async function runAttorneySettingsLayout(browser, viewport) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const state = await installRoutes(page, { role: "attorney", attorneyPhoto: true });
  await page.goto("https://lpc.test/profile-settings.html");
  await page.locator("#settingsDirectorySection").waitFor({ state: "visible" });
  await assertNoCormorant(page);
  assert.equal(await page.locator("#accountSettingsTitle").textContent(), "Settings");
  assert.equal(await page.locator("[data-settings-destination]").count(), 12);
  assert.equal(await page.getByRole("searchbox", { name: "Search settings", exact: true }).getAttribute("id"), "settingsDirectorySearch");
  const settingsNavIcons = await page.locator("#navSettings, #navProfile, #navSecurity, #navPreferences").evaluateAll((items) =>
    items.map((item) => ({ kind: item.dataset.sidebarIcon, markup: item.querySelector(".sidebar-nav-icon")?.innerHTML || "" }))
  );
  assert.deepEqual(settingsNavIcons.map(({ kind }) => kind), ["settings", "profile", "security", "preferences"]);
  assert.equal(new Set(settingsNavIcons.map(({ markup }) => markup)).size, 4, JSON.stringify(settingsNavIcons));

  const directoryLayout = await page.evaluate(() => {
    const directory = document.getElementById("settingsDirectorySection");
    const firstGrid = directory.querySelector(".settings-directory-grid");
    const firstDestination = directory.querySelector(".settings-destination");
    const directoryStyle = getComputedStyle(directory);
    const destinationStyle = getComputedStyle(firstDestination);
    return {
      columns: getComputedStyle(firstGrid).gridTemplateColumns.split(" ").filter(Boolean).length,
      width: directory.getBoundingClientRect().width,
      backgroundColor: directoryStyle.backgroundColor,
      backgroundImage: directoryStyle.backgroundImage,
      destinationBorderWidth: destinationStyle.borderTopWidth,
      destinationBoxShadow: destinationStyle.boxShadow,
      destinationColor: destinationStyle.color,
    };
  });
  const expectedDirectoryColumns = viewport.width <= 640 ? 1 : viewport.width <= 960 ? 2 : 3;
  assert.equal(directoryLayout.columns, expectedDirectoryColumns, JSON.stringify(directoryLayout));
  assert.ok(directoryLayout.width <= 1201, JSON.stringify(directoryLayout));
  assert.equal(directoryLayout.backgroundImage, "none");
  assert.equal(directoryLayout.destinationBorderWidth, "0px");
  assert.equal(directoryLayout.destinationBoxShadow, "none");
  assert.notEqual(directoryLayout.destinationColor, "rgb(0, 0, 238)");

  const shouldCapture = Boolean(accountSettingsScreenshotDir && [390, 1440].includes(viewport.width));
  if (shouldCapture) {
    fs.mkdirSync(accountSettingsScreenshotDir, { recursive: true });
    await page.screenshot({
      path: path.join(accountSettingsScreenshotDir, `attorney-settings-directory-${viewport.width}x${viewport.height}.png`),
      fullPage: true,
    });
  }

  await page.locator("#settingsDirectorySearch").fill("passkeys");
  assert.equal(await page.locator("[data-settings-destination]:visible").count(), 1);
  assert.equal(await page.locator("[data-settings-destination]:visible strong").textContent(), "Sign-in & security");
  await page.locator("#settingsDirectorySearch").fill("definitely-not-a-setting");
  await page.locator("#settingsDirectoryEmpty").waitFor({ state: "visible" });
  assert.equal(await page.locator("#settingsDirectoryEmpty").textContent(), "No settings found.");
  await page.locator("#settingsDirectorySearch").fill("");

  const directoryAccessibility = await new AxeBuilder({ page }).include("#settingsDirectorySection").analyze();
  assert.deepEqual(
    directoryAccessibility.violations.map((violation) => violation.id),
    [],
    JSON.stringify(directoryAccessibility.violations, null, 2)
  );

  const destinationHrefs = await page.locator("[data-settings-destination]").evaluateAll((links) =>
    links.map((link) => link.getAttribute("href"))
  );
  assert.equal(destinationHrefs.some((href) => /connected|oauth|verification/i.test(href)), false);
  assert.equal(destinationHrefs.includes("dashboard-attorney.html?from=settings&settingsTarget=payment-method#funds"), true);
  assert.equal(destinationHrefs.includes("dashboard-attorney.html?from=settings&settingsTarget=billing-history#funds"), true);
  destinationHrefs.filter((href) => href && !href.startsWith("#")).forEach((href) => {
    const pathname = new URL(href, "https://lpc.test").pathname.replace(/^\/+/, "");
    assert.equal(fs.existsSync(path.join(frontendRoot, pathname)), true, `Missing settings destination: ${href}`);
  });

  await page.locator('a[href="#profile:personal"]').click();
  await page.locator("#attorneySettings").waitFor({ state: "visible" });
  assert.equal(new URL(page.url()).hash, "#profile:personal");
  await page.goBack();
  await page.locator("#settingsDirectorySection").waitFor({ state: "visible" });
  assert.equal(new URL(page.url()).hash, "");
  await page.goForward();
  await page.locator("#attorneySettings").waitFor({ state: "visible" });
  assert.equal(new URL(page.url()).hash, "#profile:personal");
  assert.equal(await page.locator("#accountSettingsTitle").textContent(), "Account Settings");
  assert.equal(await page.locator("#attorneySettings .attorney-settings-panel").count(), 3);
  assert.equal(await page.locator("#saveAttorneyProfile").isDisabled(), true);
  assert.equal(await page.locator('#attorneySettings input[type="tel"]').count(), 0);
  const professionalHeadingTypography = await page.locator("#attorneyProfessionalHeading").evaluate((heading) => {
    const style = getComputedStyle(heading);
    return { fontFamily: style.fontFamily, fontWeight: style.fontWeight };
  });
  assert.match(professionalHeadingTypography.fontFamily, /Söhne.*SF Pro Display/i);
  assert.equal(professionalHeadingTypography.fontWeight, "400");
  const settingsEmphasisTypography = await page.locator("h1, h2, h3, h4, h5, h6, strong, b").evaluateAll((nodes) =>
    nodes.map((node) => ({
      tag: node.tagName,
      text: String(node.textContent || "").trim().slice(0, 80),
      fontFamily: getComputedStyle(node).fontFamily,
      fontWeight: getComputedStyle(node).fontWeight,
    }))
  );
  assert.deepEqual(
    settingsEmphasisTypography.filter(({ fontFamily }) => !/Söhne.*SF Pro Display/i.test(fontFamily)),
    [],
    JSON.stringify(settingsEmphasisTypography, null, 2)
  );
  assert.deepEqual(
    settingsEmphasisTypography.filter(({ tag, fontWeight }) =>
      (/^H[1-6]$/.test(tag) && fontWeight !== "400") || (["STRONG", "B"].includes(tag) && fontWeight !== "500")
    ),
    [],
    JSON.stringify(settingsEmphasisTypography, null, 2)
  );

  if (viewport.width > 960) {
    const shellLayout = await page.evaluate(() => {
      const sidebarRect = document.getElementById("sidebarNav").getBoundingClientRect();
      const contentRect = document.getElementById("main").getBoundingClientRect();
      const settingsRect = document.getElementById("settingsContent").getBoundingClientRect();
      return {
        sidebarWidth: sidebarRect.width,
        leftGutter: settingsRect.left - sidebarRect.right,
        rightGutter: contentRect.right - settingsRect.right,
        settingsWidth: settingsRect.width,
        availableWidth: contentRect.width,
      };
    });
    assert.ok(Math.abs(shellLayout.sidebarWidth - 230) <= 1, JSON.stringify(shellLayout));
    assert.ok(shellLayout.leftGutter >= 31 && shellLayout.leftGutter <= 69, JSON.stringify(shellLayout));
    assert.ok(shellLayout.rightGutter >= shellLayout.leftGutter - 1, JSON.stringify(shellLayout));
    assert.ok(Math.abs(shellLayout.settingsWidth - 1080) <= 5, JSON.stringify(shellLayout));

    const scrollMetrics = await page.locator("#main").evaluate((main) => ({
      clientHeight: main.clientHeight,
      scrollHeight: main.scrollHeight,
      overflowY: getComputedStyle(main).overflowY,
    }));
    assert.equal(scrollMetrics.overflowY, "auto", JSON.stringify(scrollMetrics));
    assert.ok(scrollMetrics.scrollHeight > scrollMetrics.clientHeight + 20, JSON.stringify(scrollMetrics));
    await page.locator("#main").evaluate((main) => main.scrollTo({ top: 500, behavior: "instant" }));
    await page.waitForFunction(() => document.getElementById("main")?.scrollTop > 0);
    await page.locator("#main").evaluate((main) => main.scrollTo({ top: 0, behavior: "instant" }));
  }

  const flatPanelStyles = await page.locator("#attorneySettings .attorney-settings-panel").evaluateAll((panels) =>
    panels.map((panel) => {
      const style = getComputedStyle(panel);
      return {
        borderLeftWidth: style.borderLeftWidth,
        borderRadius: style.borderRadius,
        boxShadow: style.boxShadow,
      };
    })
  );
  for (const style of flatPanelStyles) {
    assert.equal(style.borderLeftWidth, "0px");
    assert.equal(style.borderRadius, "0px");
    assert.equal(style.boxShadow, "none");
  }

  const firstNameLayout = await page.locator("#attorneyFirstName").evaluate((input) => {
    const label = document.querySelector('label[for="attorneyFirstName"]');
    const inputRect = input.getBoundingClientRect();
    const labelRect = label.getBoundingClientRect();
    return { inputLeft: inputRect.left, labelLeft: labelRect.left, inputTop: inputRect.top, labelTop: labelRect.top };
  });
  if (viewport.width > 640) {
    assert.ok(firstNameLayout.inputLeft > firstNameLayout.labelLeft + 100, "Desktop settings values should align beside labels");
  } else {
    assert.ok(firstNameLayout.inputTop > firstNameLayout.labelTop, "Mobile settings values should stack below labels");
  }
  await assertNoHorizontalOverflow(page);

  const accessibility = await new AxeBuilder({ page }).include("#attorneySettings").analyze();
  assert.deepEqual(
    accessibility.violations.map((violation) => violation.id),
    [],
    JSON.stringify(accessibility.violations, null, 2)
  );

  if (shouldCapture) {
    await page.screenshot({
      path: path.join(accountSettingsScreenshotDir, `attorney-account-settings-${viewport.width}x${viewport.height}.png`),
      fullPage: true,
    });
  }

  await openAndAssertSidebarAccountMenu(page, viewport, shouldCapture ? accountSettingsScreenshotDir : "");
  if (viewport.width <= 900) {
    await page.waitForFunction(() => document.getElementById("sidebarNav")?.getBoundingClientRect().right <= 1);
  }

  await page.locator("#navSecurity").evaluate((button) => button.click());
  await page.locator("#securitySection").waitFor({ state: "visible" });
  if (viewport.width <= 960 && (await page.locator("#sidebarToggle").getAttribute("aria-expanded")) === "true") {
    await page.locator("#sidebarToggle").evaluate((button) => button.click());
  }
  const securityLayout = await page.locator("#securitySection").evaluate((section) => {
    const grid = section.querySelector(".security-grid");
    const firstBlock = section.querySelector(".settings-block:not([data-paralegal-only])");
    const hero = section.querySelector(".two-factor-hero");
    const blockStyle = getComputedStyle(firstBlock);
    return {
      columns: getComputedStyle(grid).gridTemplateColumns.split(" ").filter(Boolean).length,
      borderLeftWidth: blockStyle.borderLeftWidth,
      borderRadius: blockStyle.borderRadius,
      boxShadow: blockStyle.boxShadow,
      heroDisplay: getComputedStyle(hero).display,
    };
  });
  assert.equal(securityLayout.columns, viewport.width > 960 ? 2 : 1);
  assert.equal(securityLayout.borderLeftWidth, "0px");
  assert.equal(securityLayout.borderRadius, "0px");
  assert.equal(securityLayout.boxShadow, "none");
  assert.equal(securityLayout.heroDisplay, "none");
  await assertNoHorizontalOverflow(page);
  const securityAccessibility = await new AxeBuilder({ page }).include("#securitySection").analyze();
  assert.deepEqual(
    securityAccessibility.violations.map((violation) => violation.id),
    [],
    JSON.stringify(securityAccessibility.violations, null, 2)
  );

  if (viewport.width === 1440) {
    await page.reload();
    await page.locator("#securitySection").waitFor({ state: "visible" });
    assert.equal(new URL(page.url()).hash, "#security");
  }

  if (shouldCapture) {
    await page.screenshot({
      path: path.join(accountSettingsScreenshotDir, `attorney-security-settings-${viewport.width}x${viewport.height}.png`),
      fullPage: true,
    });
  }

  await page.locator("#navPreferences").evaluate((button) => button.click());
  await page.locator("#preferencesSection").waitFor({ state: "visible" });
  assert.equal(await page.locator("#preferencesSection [data-theme-preview]").count(), 2);
  assert.equal(await page.locator('#preferencesSection [data-theme-preview="light"]').count(), 1);
  assert.equal(await page.locator('#preferencesSection [data-theme-preview="dark"]').count(), 1);
  assert.equal(await page.locator("#themePreference").inputValue(), "light");
  const preferencesLayout = await page.locator("#preferencesSection .preferences-layout").evaluate((layout) => ({
    columns: getComputedStyle(layout).gridTemplateColumns.split(" ").filter(Boolean).length,
    width: layout.getBoundingClientRect().width,
  }));
  assert.equal(preferencesLayout.columns, viewport.width > 960 ? 2 : 1, JSON.stringify(preferencesLayout));
  assert.ok(preferencesLayout.width > 0, JSON.stringify(preferencesLayout));
  await assertNoHorizontalOverflow(page);
  const preferencesAccessibility = await new AxeBuilder({ page }).include("#preferencesSection").analyze();
  assert.deepEqual(
    preferencesAccessibility.violations.map((violation) => violation.id),
    [],
    JSON.stringify(preferencesAccessibility.violations, null, 2)
  );

  if (viewport.width === 1440) {
    await page.reload();
    await page.locator("#preferencesSection").waitFor({ state: "visible" });
    assert.equal(new URL(page.url()).hash, "#preferences");
  }

  if (shouldCapture) {
    await page.screenshot({
      path: path.join(accountSettingsScreenshotDir, `attorney-preferences-settings-${viewport.width}x${viewport.height}.png`),
      fullPage: true,
    });
  }

  let preferencesResponse = page.waitForResponse((response) =>
    response.request().method() === "POST" && new URL(response.url()).pathname === "/api/account/preferences"
  );
  await page.locator('#preferencesSection [data-theme-preview="dark"]').click();
  await preferencesResponse;
  assert.equal(state.preferenceRequests.at(-1)?.theme, "dark");
  preferencesResponse = page.waitForResponse((response) =>
    response.request().method() === "POST" && new URL(response.url()).pathname === "/api/account/preferences"
  );
  await page.locator('#preferencesSection [data-theme-preview="light"]').click();
  await preferencesResponse;
  assert.equal(state.preferenceRequests.at(-1)?.theme, "light");

  await page.locator("#navProfile").evaluate((button) => button.click());
  await page.locator("#attorneySettings").waitFor({ state: "visible" });

  await page.locator("#attorneyAvatarFrame").click();
  await page.locator("#photoCropModal").waitFor({ state: "visible" });
  await waitForCropperReady(page);
  await assertAttorneyPhotoEditorLayout(page, viewport);

  if (shouldCapture) {
    await page.screenshot({
      path: path.join(accountSettingsScreenshotDir, `attorney-photo-editor-${viewport.width}x${viewport.height}.png`),
      fullPage: false,
    });
  }

  assert.equal(pageErrors.length, 0, pageErrors.join("\n"));
  await context.close();
}

async function runAccountSettingsStableHydration(browser) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await installRoutes(page, {
    role: "attorney",
    attorneyPhoto: true,
    userGetDelayMs: 500,
  });

  await page.goto("https://lpc.test/profile-settings.html", { waitUntil: "domcontentloaded" });
  assert.equal(await page.locator("body").evaluate((body) => body.classList.contains("settings-layout-ready")), true);
  assert.equal(await page.locator("#accountSettingsBoot").count(), 0);
  const loadingVisibility = await page.evaluate(() => ({
    main: getComputedStyle(document.getElementById("main")).visibility,
    sidebar: getComputedStyle(document.getElementById("sidebarNav")).visibility,
  }));
  assert.deepEqual(loadingVisibility, { main: "visible", sidebar: "visible" });

  await page.waitForFunction(() => document.body.classList.contains("attorney-classic"));
  await page.waitForFunction(() => document.getElementById("settingsContent")?.getAttribute("aria-busy") !== "true");
  assert.equal(await page.locator("body").evaluate((body) => body.classList.contains("attorney-classic")), true);
  assert.equal(await page.locator("#main").evaluate((main) => getComputedStyle(main).visibility), "visible");
  assert.equal(await page.locator("#settingsDirectorySection").isVisible(), true);
  assert.equal(await page.locator("#attorneySettings").isVisible(), false);
  assert.equal(await page.locator("#paralegalSettings").isVisible(), false);
  assert.equal(pageErrors.length, 0, pageErrors.join("\n"));
  await context.close();
}

async function runAttorneyDashboardAccountMenu(browser) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const routeState = await installRoutes(page, { role: "attorney", attorneyPhoto: true });
  await page.goto("https://lpc.test/dashboard-attorney.html");
  await page.locator("#sidebarNav").waitFor({ state: "visible" });
  await assertNoCormorant(page);
  await assertStripeDashboardEmphasis(page);
  await assertStripeDashboardShell(page);
  await assertDashboardBodyCopyUsesSarabun(page, ".matter-meta");
  await assertAttorneyOperationalHome(page);
  assert.equal(routeState.dashboardRequests.inventory, 1, JSON.stringify(routeState.dashboardRequests));
  assert.equal(routeState.dashboardRequests.applications, 1, JSON.stringify(routeState.dashboardRequests));
  assert.equal(routeState.dashboardRequests.events, 0, JSON.stringify(routeState.dashboardRequests));
  if (accountSettingsScreenshotDir) {
    fs.mkdirSync(accountSettingsScreenshotDir, { recursive: true });
    await page.screenshot({
      path: path.join(accountSettingsScreenshotDir, "attorney-dashboard-stripe-typography-1440x900.png"),
      fullPage: false,
    });
    await page.evaluate(() => {
      const main = document.querySelector("main.main");
      const overview = document.querySelector(".home-overview");
      if (main && overview) main.scrollTop = Math.max(0, overview.offsetTop - 80);
    });
    await page.waitForTimeout(100);
    await page.screenshot({
      path: path.join(accountSettingsScreenshotDir, "attorney-dashboard-overview-populated-1440x900.png"),
      fullPage: false,
    });
    await page.evaluate(() => {
      const main = document.querySelector("main.main");
      if (main) main.scrollTop = 0;
    });
  }
  await assertAttorneyWeeklyNotesInTasks(page);
  if (accountSettingsScreenshotDir) {
    await page.screenshot({
      path: path.join(accountSettingsScreenshotDir, "attorney-dashboard-tasks-weekly-notes-1440x900.png"),
      fullPage: false,
    });
  }
  await openAndAssertSidebarAccountMenu(page, { width: 1440, height: 900 });

  await page.goto("https://lpc.test/dashboard-attorney.html?from=settings&settingsTarget=payment-method#funds");
  await page.locator('[data-view="funds"]').waitFor({ state: "visible" });
  await page.locator("#paymentsSettingsBackLink").waitFor({ state: "visible" });
  assert.equal(await page.locator("#paymentsSettingsBackLink").getAttribute("href"), "profile-settings.html");
  await page.waitForFunction(() => document.activeElement?.id === "payment-method-heading");

  await page.goto("https://lpc.test/dashboard-attorney.html?from=settings&settingsTarget=billing-history#funds");
  await page.locator('[data-view="funds"]').waitFor({ state: "visible" });
  await page.locator("#paymentsSettingsBackLink").waitFor({ state: "visible" });
  await page.waitForFunction(() => document.activeElement?.id === "history-heading");
  assert.equal(pageErrors.length, 0, pageErrors.join("\n"));
  await context.close();
}

async function runAttorneyDashboardMobileLayout(browser) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await installRoutes(page, { role: "attorney", attorneyPhoto: true });
  await page.goto("https://lpc.test/dashboard-attorney.html");
  await page.locator("#attorneyNeedsAttention").waitFor({ state: "visible" });
  await page.waitForFunction(() => document.getElementById("overviewMattersBody")?.dataset.state === "ready");

  const mobile = await page.evaluate(() => {
    const attention = document.getElementById("attorneyNeedsAttention");
    const attentionHeader = attention.querySelector(":scope > .ledger-header");
    const caseLedger = document.querySelector(".view-home .case-ledger");
    const main = document.querySelector("main.main");
    const overviewGrid = document.querySelector(".home-overview-grid");
    const overviewModules = [...document.querySelectorAll(".home-overview .status-item, .home-overview .mini-deadlines")];
    return {
      attentionColumns: getComputedStyle(attention).gridTemplateColumns,
      attentionHeaderRightBorder: getComputedStyle(attentionHeader).borderRightWidth,
      attentionHeaderBottomBorder: getComputedStyle(attentionHeader).borderBottomWidth,
      matterColumns: getComputedStyle(caseLedger).gridTemplateColumns,
      mainClientHeight: main.clientHeight,
      mainScrollHeight: main.scrollHeight,
      overviewColumns: getComputedStyle(overviewGrid).gridTemplateColumns.split(" ").length,
      overviewMaxWidth: Math.max(...overviewModules.map((node) => node.getBoundingClientRect().width)),
      overviewMinWidth: Math.min(...overviewModules.map((node) => node.getBoundingClientRect().width)),
    };
  });
  assert.doesNotMatch(mobile.attentionColumns, /px .*px/, JSON.stringify(mobile));
  assert.equal(mobile.attentionHeaderRightBorder, "0px", JSON.stringify(mobile));
  assert.equal(mobile.attentionHeaderBottomBorder, "1px", JSON.stringify(mobile));
  assert.doesNotMatch(mobile.matterColumns, /px .*px/, JSON.stringify(mobile));
  assert.ok(mobile.mainScrollHeight > mobile.mainClientHeight, JSON.stringify(mobile));
  assert.equal(mobile.overviewColumns, 1, JSON.stringify(mobile));
  assert.ok(Math.abs(mobile.overviewMaxWidth - mobile.overviewMinWidth) <= 1, JSON.stringify(mobile));
  if (accountSettingsScreenshotDir) {
    await page.evaluate(() => document.querySelector(".home-overview")?.scrollIntoView({ block: "start" }));
    await page.screenshot({
      path: path.join(accountSettingsScreenshotDir, "attorney-dashboard-overview-populated-390x844.png"),
      fullPage: false,
    });
  }
  await assertNoHorizontalOverflow(page);

  await page.evaluate(() => {
    window.location.hash = "tasks";
  });
  await page.locator('[data-view="tasks"]').waitFor({ state: "visible" });
  await page.locator('.view-tasks .weekly-notes').waitFor({ state: "visible" });
  assert.equal(await page.locator('.view-home .weekly-notes').count(), 0);
  await assertNoHorizontalOverflow(page);
  assert.equal(pageErrors.length, 0, pageErrors.join("\n"));
  await context.close();
}

async function runAttorneyDashboardEmptyOverview(browser) {
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    const routeState = await installRoutes(page, {
      role: "attorney",
      attorneyPhoto: true,
      dashboardState: "empty",
    });
    await page.goto("https://lpc.test/dashboard-attorney.html");
    await page.waitForFunction(() =>
      ["overviewMattersBody", "overviewApplicationsBody", "overviewMessagesBody", "overviewCompletedBody", "deadlineList"]
        .every((id) => document.getElementById(id)?.dataset.state === "ready")
    );
    const empty = await page.evaluate(() => ({
      matters: document.getElementById("overviewMattersBody")?.textContent?.replace(/\s+/g, " ").trim(),
      applications: document.getElementById("overviewApplicationsBody")?.textContent?.replace(/\s+/g, " ").trim(),
      messages: document.getElementById("overviewMessagesBody")?.textContent?.replace(/\s+/g, " ").trim(),
      completed: document.getElementById("overviewCompletedBody")?.textContent?.replace(/\s+/g, " ").trim(),
      week: document.getElementById("deadlineList")?.textContent?.replace(/\s+/g, " ").trim(),
      createHref: document.querySelector(".command-create-matter")?.getAttribute("href"),
      skeletonCount: document.querySelectorAll(".home-overview .overview-module-skeleton").length,
    }));
    assert.equal(empty.matters, "No current Matters.", JSON.stringify(empty));
    assert.equal(empty.applications, "No applications to review.", JSON.stringify(empty));
    assert.equal(empty.messages, "No unread messages.", JSON.stringify(empty));
    assert.equal(empty.completed, "None yet.", JSON.stringify(empty));
    assert.match(empty.week, /No Matter deadlines this week\.$/, JSON.stringify(empty));
    assert.equal(empty.createHref, "create-case.html", JSON.stringify(empty));
    assert.equal(empty.skeletonCount, 0, JSON.stringify(empty));
    assert.equal(routeState.dashboardRequests.inventory, 1, JSON.stringify(routeState.dashboardRequests));
    assert.equal(routeState.dashboardRequests.events, 0, JSON.stringify(routeState.dashboardRequests));
    assert.equal(pageErrors.length, 0, pageErrors.join("\n"));
    await assertNoHorizontalOverflow(page);
    if (accountSettingsScreenshotDir) {
      await page.evaluate(() => document.querySelector(".home-overview")?.scrollIntoView({ block: "start" }));
      await page.screenshot({
        path: path.join(accountSettingsScreenshotDir, `attorney-dashboard-overview-empty-${viewport.width}x${viewport.height}.png`),
        fullPage: false,
      });
    }
    await context.close();
  }
}

async function runAttorneyDashboardResponsiveOverview(browser, viewport) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await installRoutes(page, { role: "attorney", attorneyPhoto: true });
  await page.goto("https://lpc.test/dashboard-attorney.html");
  await page.waitForFunction(() => ["overviewMattersBody", "overviewApplicationsBody", "overviewMessagesBody", "overviewCompletedBody", "deadlineList"].every(id => document.getElementById(id)?.dataset.state === "ready"));
  await page.locator("#attorneyOnboardingAttentionCard").waitFor({ state: "visible" });
  const responsive = await page.evaluate(() => {
    const grid = document.querySelector(".home-overview-grid");
    const layout = document.querySelector(".home-layout");
    return {
      overviewColumns: getComputedStyle(grid).gridTemplateColumns.split(" ").length,
      topColumns: getComputedStyle(layout).gridTemplateColumns.split(" ").length,
    };
  });
  assert.equal(responsive.overviewColumns, viewport.width <= 900 ? 2 : 4, JSON.stringify(responsive));
  assert.equal(responsive.topColumns, viewport.width <= 900 ? 1 : 2, JSON.stringify(responsive));
  await assertNoHorizontalOverflow(page);
  assert.equal(pageErrors.length, 0, pageErrors.join("\n"));
  await context.close();
}

async function runAttorneyDashboardSingularOverview(browser) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await installRoutes(page, { role: "attorney", attorneyPhoto: true, dashboardState: "singular" });
  await page.goto("https://lpc.test/dashboard-attorney.html");
  await page.waitForFunction(() =>
    ["overviewMattersBody", "overviewApplicationsBody", "overviewMessagesBody", "overviewCompletedBody", "deadlineList"]
      .every((id) => document.getElementById(id)?.dataset.state === "ready")
  );
  const copy = await page.evaluate(() => Object.fromEntries(
    ["overviewMattersBody", "overviewApplicationsBody", "overviewMessagesBody", "overviewCompletedBody", "deadlineList"]
      .map((id) => [id, document.getElementById(id)?.textContent?.replace(/\s+/g, " ").trim()])
  ));
  assert.equal(copy.overviewMattersBody, "1 current", JSON.stringify(copy));
  assert.equal(copy.overviewApplicationsBody, "1 awaiting review", JSON.stringify(copy));
  assert.equal(copy.overviewMessagesBody, "1", JSON.stringify(copy));
  assert.equal(copy.overviewCompletedBody, "1", JSON.stringify(copy));
  assert.match(copy.deadlineList, /Martinez discovery/, JSON.stringify(copy));
  assert.equal(await page.locator("#deadlineList .overview-deadline-row").count(), 1);
  assert.equal(pageErrors.length, 0, pageErrors.join("\n"));
  await context.close();
}

async function runAttorneyDashboardOverviewStateIsolation(browser) {
  const loadingContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const loadingPage = await loadingContext.newPage();
  await installRoutes(loadingPage, {
    role: "attorney",
    attorneyPhoto: true,
    dashboardDelayMs: 350,
  });
  await loadingPage.goto("https://lpc.test/dashboard-attorney.html");
  await loadingPage.locator(".home-overview").waitFor({ state: "visible" });
  await loadingPage.waitForFunction(() => document.getElementById("overviewMattersBody")?.textContent.trim() === "Loading Matters…");
  const loading = await loadingPage.evaluate(() => ({
    states: ["overviewMattersBody", "overviewApplicationsBody", "overviewMessagesBody", "overviewCompletedBody", "deadlineList"]
      .map((id) => document.getElementById(id)?.dataset.state),
    labels: ["overviewMattersBody", "overviewApplicationsBody", "overviewMessagesBody", "overviewCompletedBody", "deadlineList"].map(id => document.getElementById(id)?.textContent.trim()),
    busy: ["overviewMattersBody", "overviewApplicationsBody", "overviewMessagesBody", "overviewCompletedBody", "deadlineList"].every(id => document.getElementById(id)?.getAttribute("aria-busy") === "true"),
  }));
  assert.deepEqual(loading.states, ["loading", "loading", "loading", "loading", "loading"], JSON.stringify(loading));
  assert.deepEqual(loading.labels, ["Loading Matters…", "Loading Applications…", "Loading Messages…", "Loading Completed Matters…", "Loading Deadlines…"], JSON.stringify(loading));
  assert.equal(loading.busy, true, JSON.stringify(loading));
  await loadingPage.waitForFunction(() => document.getElementById("overviewMattersBody")?.dataset.state === "ready");
  await loadingContext.close();

  const failureContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const failurePage = await failureContext.newPage();
  const pageErrors = [];
  failurePage.on("pageerror", (error) => pageErrors.push(error.message));
  await installRoutes(failurePage, {
    role: "attorney",
    attorneyPhoto: true,
    dashboardState: "applications-failed",
  });
  await failurePage.goto("https://lpc.test/dashboard-attorney.html");
  await failurePage.waitForFunction(() => document.getElementById("overviewApplicationsBody")?.dataset.state === "failed");
  await failurePage.waitForFunction(() => ["overviewMattersBody", "overviewApplicationsBody", "overviewMessagesBody", "overviewCompletedBody", "deadlineList"].every(id => ["ready", "failed"].includes(document.getElementById(id)?.dataset.state)));
  const isolated = await failurePage.evaluate(() => Object.fromEntries(
    ["overviewMattersBody", "overviewApplicationsBody", "overviewMessagesBody", "overviewCompletedBody", "deadlineList"]
      .map((id) => [id, document.getElementById(id)?.dataset.state])
  ));
  assert.equal(isolated.overviewApplicationsBody, "failed", JSON.stringify(isolated));
  assert.equal(isolated.overviewMattersBody, "ready", JSON.stringify(isolated));
  assert.equal(isolated.overviewMessagesBody, "ready", JSON.stringify(isolated));
  assert.equal(isolated.overviewCompletedBody, "ready", JSON.stringify(isolated));
  assert.equal(isolated.deadlineList, "ready", JSON.stringify(isolated));
  assert.equal(pageErrors.length, 0, pageErrors.join("\n"));
  await failureContext.close();
}

async function runParalegalDashboardTypography(browser) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await installRoutes(page, { role: "paralegal" });
  await page.goto("https://lpc.test/dashboard-paralegal.html");
  await page.locator("body.lpc-role-dashboard").waitFor({ state: "visible" });
  const displayTypography = await page.evaluate(() => {
    const styleFor = (selector) => {
      const node = document.querySelector(selector);
      const style = node ? getComputedStyle(node) : null;
      return style ? { family: style.fontFamily, weight: style.fontWeight } : null;
    };
    return {
      primaryHeadingPresent: Boolean(document.querySelector(".private-office-greeting h1")),
      sectionHeading: styleFor(".private-office-opportunities h2"),
      sidebarBrand: styleFor("#sidebarNav .logo"),
    };
  });
  assert.equal(displayTypography.primaryHeadingPresent, false, JSON.stringify(displayTypography));
  assert.match(displayTypography.sectionHeading?.family || "", /Cormorant Garamond/i, JSON.stringify(displayTypography));
  assert.equal(displayTypography.sectionHeading?.weight, "400", JSON.stringify(displayTypography));
  assert.match(displayTypography.sidebarBrand?.family || "", /Söhne/i, JSON.stringify(displayTypography));
  await assertStripeDashboardShell(page);
  await assertDashboardBodyCopyUsesSarabun(page, ".private-office-secondary-state");
  if (accountSettingsScreenshotDir) {
    fs.mkdirSync(accountSettingsScreenshotDir, { recursive: true });
    await page.screenshot({
      path: path.join(accountSettingsScreenshotDir, "paralegal-dashboard-stripe-typography-1440x900.png"),
      fullPage: false,
    });
  }
  await context.close();
}

async function runProfileSettingsSave(browser, { role, viewport }) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const state = await installRoutes(page, { role });
  await page.goto(`https://lpc.test/profile-settings.html${role === "attorney" ? "#profile" : ""}`);

  const isAttorney = role === "attorney";
  const rolePanel = page.locator(isAttorney ? "#attorneySettings" : "#paralegalSettings");
  await rolePanel.waitFor({ state: "visible" });
  await assertNoCormorant(page);
  if (!isAttorney) {
    assert.equal(await page.locator("#settingsDirectorySection").isVisible(), false);
    assert.equal(await page.locator("#navSettings").isVisible(), false);
  }

  if (isAttorney) {
    assert.equal(await page.locator("#attorneyFirmName").inputValue(), "Example Law");
    assert.equal(await page.locator("#saveAttorneyProfile").isDisabled(), true);
    await page.locator("#attorneyLinkedIn").fill("https://example.com/not-linkedin");
    await page.locator("#saveAttorneyProfile").click();
    await page.locator("#attorneyLinkedInError").waitFor({ state: "visible" });
    assert.equal(await page.locator("#attorneyLinkedInError").textContent(), "Enter a valid LinkedIn URL.");
    assert.equal(await page.locator("#attorneyLinkedIn").evaluate((node) => node === document.activeElement), true);
    assert.equal(state.patchRequests.length, 0, "Invalid attorney profile must not be submitted");

    await page.locator("#attorneyFirstName").fill("Alexandra");
    await page.locator("#attorneyLastName").fill("Counsel");
    await page.locator("#attorneyLinkedIn").fill("linkedin.com/in/alexandra-counsel");
    await page.locator("#attorneyFirmName").fill("Counsel & Partners");
    await page.locator("#attorneyFirmWebsite").fill("counsel.example");
    await page.locator("#attorneyPracticeDescription").fill("Enterprise litigation counsel collaborating with specialist paralegals.");
    await page.locator("#attorneyPublications").fill("Discovery Systems, 2026\nEvidence Operations, 2025");
    await page.locator("#attorneyPracticeDropdownToggle").click();
    await page.locator("#attorneyPracticeDropdown .dropdown-option", { hasText: /^Contract Law$/ }).click();

    state.failNextProfilePatch = true;
    const failedRequest = page.waitForRequest((request) =>
      request.method() === "PATCH" && new URL(request.url()).pathname === "/api/users/me"
    );
    await page.locator("#saveAttorneyProfile").click();
    await waitForSaveState(page, "saveAttorneyProfile");
    await failedRequest;
    await waitForToast(page, "Temporary profile failure");
    assert.equal(await page.locator("#attorneyFirmName").inputValue(), "Counsel & Partners");

    const successfulRequest = page.waitForRequest((request) =>
      request.method() === "PATCH" && new URL(request.url()).pathname === "/api/users/me"
    );
    await page.locator("#saveAttorneyProfile").click();
    await waitForSaveState(page, "saveAttorneyProfile");
    const request = await successfulRequest;
    const payload = request.postDataJSON();
    await waitForToast(page, "Profile updated!");
    assert.equal(await page.locator("#saveAttorneyProfile").isDisabled(), true);
    assert.equal(await page.locator("#attorneySaveStatus").textContent(), "Changes saved.");

    assert.equal(payload.firstName, "Alexandra");
    assert.equal(payload.lastName, "Counsel");
    assert.equal(payload.linkedInURL, "https://linkedin.com/in/alexandra-counsel");
    assert.equal(payload.lawFirm, "Counsel & Partners");
    assert.equal(payload.firmWebsite, "https://counsel.example/");
    assert.equal(payload.practiceDescription, "Enterprise litigation counsel collaborating with specialist paralegals.");
    assert.deepEqual(payload.publications, ["Discovery Systems, 2026", "Evidence Operations, 2025"]);
    assert.deepEqual(payload.practiceAreas.sort(), ["Contract Law", "Litigation"]);

    await page.reload();
    await page.locator("#attorneySettings").waitFor({ state: "visible" });
    assert.equal(await page.locator("#attorneyFirstName").inputValue(), "Alexandra");
    assert.equal(await page.locator("#attorneyFirmName").inputValue(), "Counsel & Partners");
    assert.equal(await page.locator("#attorneyPracticeDescription").inputValue(), payload.practiceDescription);
  } else {
    assert.equal(await page.locator("#fullNameInput").inputValue(), "Taylor Morgan");
    await page.locator("#fullNameInput").fill("Taylor Jordan Morgan");
    await page.locator("#linkedInInput").fill("linkedin.com/in/taylor-jordan-morgan");
    await page.locator("#yearsExperienceInput").fill("9");
    await page.locator('[data-edit-toggle="bio"]').click();
    await page.locator("#bioInput").fill("Senior litigation paralegal focused on discovery operations and trial readiness.");
    await page.locator('[data-edit-toggle="practiceAreas"]').click();
    await page.locator("#paralegalPracticeDropdownToggle").click();
    await page.locator("#paralegalPracticeDropdown .dropdown-option", { hasText: /^Contract Law$/ }).click();

    const successfulRequest = page.waitForRequest((request) =>
      request.method() === "PATCH" && new URL(request.url()).pathname === "/api/users/me"
    );
    await page.locator("#profileSaveBtn").click();
    await waitForSaveState(page, "profileSaveBtn");
    const request = await successfulRequest;
    const payload = request.postDataJSON();
    await waitForToast(page, "Settings saved!");

    assert.equal(payload.firstName, "Taylor");
    assert.equal(payload.lastName, "Jordan Morgan");
    assert.equal(payload.linkedInURL, "https://linkedin.com/in/taylor-jordan-morgan");
    assert.equal(payload.yearsExperience, 9);
    assert.equal(payload.bio, "Senior litigation paralegal focused on discovery operations and trial readiness.");
    assert.deepEqual(payload.practiceAreas.sort(), ["Contract Law", "Litigation"]);

    await page.reload();
    await page.locator("#paralegalSettings").waitFor({ state: "visible" });
    assert.equal(await page.locator("#fullNameInput").inputValue(), "Taylor Jordan Morgan");
    assert.equal(await page.locator("#linkedInInput").inputValue(), "https://linkedin.com/in/taylor-jordan-morgan");
    assert.equal(await page.locator("#yearsExperienceInput").inputValue(), "9");
    assert.equal(
      await page.locator("#bioDisplay").textContent(),
      "Senior litigation paralegal focused on discovery operations and trial readiness."
    );
  }

  assert.equal(pageErrors.length, 0, pageErrors.join("\n"));
  await assertNoHorizontalOverflow(page);
  await context.close();
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    await runDirectory(browser, { width: 1280, height: 800 });
    await runDirectory(browser, { width: 390, height: 844 });
    await runDirectory(browser, { width: 390, height: 844 }, 404);
    await runDirectory(browser, { width: 1280, height: 800 }, 200, "paralegal");
    if (process.env.LPC_DIRECTORY_ONLY !== "1") {
      await runProfile(browser, { role: "attorney", viewport: { width: 1280, height: 800 } });
      await runProfile(browser, { role: "paralegal", viewport: { width: 390, height: 844 }, self: true });
      await runProfileSettingsCropper(browser, { role: "attorney", viewport: { width: 1280, height: 800 } });
      await runProfileSettingsCropper(browser, { role: "paralegal", viewport: { width: 390, height: 844 } });
      await runAccountSettingsStableHydration(browser);
      for (const viewport of [
        { width: 360, height: 800 },
        { width: 390, height: 844 },
        { width: 768, height: 1024 },
        { width: 1440, height: 900 },
        { width: 1920, height: 1080 },
      ]) {
        await runAttorneySettingsLayout(browser, viewport);
      }
      await runAttorneyDashboardAccountMenu(browser);
      await runAttorneyDashboardMobileLayout(browser);
      await runAttorneyDashboardResponsiveOverview(browser, { width: 768, height: 1024 });
      await runAttorneyDashboardResponsiveOverview(browser, { width: 1920, height: 1080 });
      await runAttorneyDashboardSingularOverview(browser);
      await runAttorneyDashboardOverviewStateIsolation(browser);
      await runAttorneyDashboardEmptyOverview(browser);
      await runParalegalDashboardTypography(browser);
      await runAttorneyPhotoReliability(browser, { width: 1440, height: 900 });
      await runProfileSettingsSave(browser, { role: "attorney", viewport: { width: 1280, height: 800 } });
      await runProfileSettingsSave(browser, { role: "paralegal", viewport: { width: 390, height: 844 } });
    }
    console.log("profile-photo-ui: PASS");
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
