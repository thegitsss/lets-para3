const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const AxeBuilder = require("@axe-core/playwright").default;

const { projectCanonicalProfile } = require("../services/objectSystem/profileAuthorityContract");
const { projectPresentation } = require("../services/objectSystem/presentationContract");

const frontendRoot = path.resolve(__dirname, "../../frontend");
const cropFixturePath = path.join(frontendRoot, "favicon-32x32.png");
const profileId = "64b000000000000000000021";
const viewerId = "64b000000000000000000022";
const updatedAt = "2026-08-10T12:00:00.000Z";
const photoUrl = `/api/public/paralegals/${profileId}/photo?v=${Date.parse(updatedAt)}`;
const onePixelPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
);

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

async function installRoutes(page, { role, photoStatus = 200 } = {}) {
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
      };
  const state = {
    get viewer() {
      return viewer;
    },
    patchRequests: [],
    profilePhotoUploads: [],
    failNextProfilePatch: false,
  };

  await page.addInitScript((user) => {
    localStorage.setItem("lpc_user", JSON.stringify(user));
  }, viewer);

  await page.route("http://lpc.test/**", async (route) => {
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
    if (url.pathname === "/api/auth/me") {
      await route.fulfill({ json: { user: state.viewer } });
      return;
    }
    if (url.pathname === "/api/users/me") {
      if (route.request().method() === "PATCH") {
        const payload = route.request().postDataJSON();
        state.patchRequests.push(payload);
        await new Promise((resolve) => setTimeout(resolve, 120));
        if (state.failNextProfilePatch) {
          state.failNextProfilePatch = false;
          await route.fulfill({ status: 503, json: { error: "Temporary profile failure" } });
          return;
        }
        viewer = { ...viewer, ...payload };
      }
      await route.fulfill({ json: state.viewer });
      return;
    }
    if (url.pathname === "/api/uploads/profile-photo" && route.request().method() === "POST") {
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
      await route.fulfill({ status: 200, contentType: "image/png", body: onePixelPng });
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
    if (url.pathname.startsWith("/api/")) {
      await route.fulfill({ status: 404, json: { error: "Not available in UI fixture" } });
      return;
    }

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

async function runDirectory(browser, viewport, photoStatus = 200, role = "attorney") {
  const page = await browser.newPage({ viewport });
  await installRoutes(page, { role, photoStatus });
  await page.goto("http://lpc.test/browse-paralegals.html");
  await page.waitForSelector("body.authenticated-browse");
  const shell = await page.evaluate(() => ({
    utilityHeaderDisplay: getComputedStyle(document.querySelector("[data-utility-header]")).display,
    sidebarDisplay: getComputedStyle(document.querySelector("[data-auth-sidebar]")).display,
    sidebarHidden: document.querySelector("[data-auth-sidebar]").hidden,
    guestHidden: document.querySelector("[data-utility-guest]").hidden,
    signInHidden: document.querySelector("[data-utility-auth]").hidden,
    signUpHidden: document.querySelector("[data-utility-signup]").hidden,
    activeNavigation: document.querySelector("[data-auth-sidebar-nav] [aria-current='page']")?.textContent?.trim(),
  }));
  assert.equal(shell.utilityHeaderDisplay, "none");
  assert.notEqual(shell.sidebarDisplay, "none");
  assert.equal(shell.sidebarHidden, false);
  assert.equal(shell.guestHidden, true);
  assert.equal(shell.signInHidden, true);
  assert.equal(shell.signUpHidden, true);
  assert.equal(shell.activeNavigation, role === "attorney" ? "Paralegals" : undefined);

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
    assert.equal(new URL(await image.getAttribute("src"), "http://lpc.test").pathname, `/api/public/paralegals/${profileId}/photo`);
  } else {
    await page.waitForFunction((id) => {
      const node = document.querySelector(`.paralegal-card[data-paralegal-id="${id}"] img`);
      return String(node?.src || "").startsWith("data:image/svg+xml");
    }, profileId);
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
  await page.goto(`http://lpc.test/profile-paralegal.html${query}`);
  const image = page.locator("[data-profile-avatar]");
  await image.waitFor();
  await page.waitForFunction(() => {
    const node = document.querySelector("[data-profile-avatar]");
    return node?.complete && node.naturalWidth > 0;
  });
  assert.equal(new URL(await image.getAttribute("src"), "http://lpc.test").pathname, `/api/public/paralegals/${profileId}/photo`);
  const resumeLink = page.locator("#resumeLink");
  await resumeLink.waitFor({ state: "visible" });
  const resumeHref = new URL(await resumeLink.getAttribute("href"), "http://lpc.test");
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
  await page.goto("http://lpc.test/profile-settings.html");

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

  await page.locator("#photoCropStage").focus();
  await page.keyboard.press("ArrowRight");
  await zoom.fill("0.2");
  await zoom.dispatchEvent("input");
  await saveButton.click();
  await page.waitForFunction((selector) => {
    const node = document.querySelector(selector);
    return (
      node &&
      String(node.getAttribute("src") || "").startsWith("data:image/jpeg") &&
      node.complete &&
      node.naturalWidth === 600 &&
      node.naturalHeight === 600
    );
  }, isAttorney ? "#attorneyAvatarPreview" : "#avatarPreview");
  assert.equal(await modal.getAttribute("aria-hidden"), "true");
  assert.equal(await modal.getAttribute("inert"), "");
  assert.equal(await preview.isVisible(), true);
  const uploadRequestPromise = page.waitForRequest((request) =>
    request.method() === "POST" && new URL(request.url()).pathname === "/api/uploads/profile-photo"
  );
  await page.locator(isAttorney ? "#saveAttorneyProfile" : "#profileSaveBtn").click();
  const uploadRequest = await uploadRequestPromise;
  await waitForToast(
    page,
    isAttorney ? "Profile updated!" : "Settings saved and profile photo submitted for review."
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
  } else {
    assert.equal(state.viewer.profilePhotoStatus, "pending_review");
    assert.match(state.viewer.pendingProfileImage, /variant=pending/);
    assert.equal(await page.locator("#photoReviewStatus").textContent(), "Pending");
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

async function runProfileSettingsSave(browser, { role, viewport }) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const state = await installRoutes(page, { role });
  await page.goto("http://lpc.test/profile-settings.html");

  const isAttorney = role === "attorney";
  const rolePanel = page.locator(isAttorney ? "#attorneySettings" : "#paralegalSettings");
  await rolePanel.waitFor({ state: "visible" });

  if (isAttorney) {
    assert.equal(await page.locator("#attorneyFirmName").inputValue(), "Example Law");
    await page.locator("#attorneyLinkedIn").fill("https://example.com/not-linkedin");
    await page.locator("#saveAttorneyProfile").click();
    await waitForToast(page, "Enter a valid LinkedIn URL.");
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
