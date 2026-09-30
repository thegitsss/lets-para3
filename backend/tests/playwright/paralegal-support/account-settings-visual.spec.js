const fs = require("fs");
const path = require("path");
const { test, expect } = require("../support-session-fixture");

const SCREENSHOT_DIR = "/tmp/lpc-account-settings-review";
let navigationSequence = 0;

test.beforeAll(() => {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
});

async function openSettings(page, section, viewport) {
  await page.setViewportSize(viewport);
  await page.emulateMedia({ reducedMotion: "reduce" });
  navigationSequence += 1;
  await page.goto(`/profile-settings.html?accountAudit=${navigationSequence}#${section}`, { waitUntil: "domcontentloaded" });
  await expect(page).not.toHaveURL(/login\.html/);
  await expect(page.locator("#settingsContent")).not.toHaveAttribute("aria-busy", "true");
  const tourClose = page.locator("#profileTourCloseBtn");
  await tourClose.waitFor({ state: "visible", timeout: 600 }).catch(() => {});
  if (await tourClose.isVisible()) {
    await tourClose.click();
    await expect(page.locator("#profileTourTooltip")).not.toHaveClass(/is-active/);
    if (section !== "profile") {
      await page.locator(`[data-settings-section="${section}Section"]`).click();
    }
  }
  await expect(page.locator(`#${section}Section`)).toBeVisible();
  await expect(page.locator("#accountSettingsTitle")).toBeInViewport();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
  await expect.poll(() => page.locator("#main").evaluate((element) => element.scrollTop)).toBe(0);
  await page.waitForTimeout(120);
  await expect(page.locator("#accountSettingsTitle")).toBeInViewport();
  await expect.poll(() => page.locator("#main").evaluate((element) => element.scrollTop)).toBe(0);
}

function relativeLuminance([red, green, blue]) {
  const values = [red, green, blue].map((channel) => {
    const value = channel / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * values[0] + 0.7152 * values[1] + 0.0722 * values[2];
}

function parseRgb(value) {
  const match = String(value || "").match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
  return match ? match.slice(1, 4).map(Number) : null;
}

function contrastRatio(foreground, background) {
  const foregroundLuminance = relativeLuminance(foreground);
  const backgroundLuminance = relativeLuminance(background);
  return (Math.max(foregroundLuminance, backgroundLuminance) + 0.05) /
    (Math.min(foregroundLuminance, backgroundLuminance) + 0.05);
}

async function expectElementContrast(page, foregroundSelector, backgroundSelector, minimum = 4.5) {
  const colors = await page.evaluate(({ foregroundSelector: foreground, backgroundSelector: background }) => ({
    foreground: getComputedStyle(document.querySelector(foreground)).color,
    background: getComputedStyle(document.querySelector(background)).backgroundColor,
  }), { foregroundSelector, backgroundSelector });
  expect(contrastRatio(parseRgb(colors.foreground), parseRgb(colors.background))).toBeGreaterThanOrEqual(minimum);
}

test("Account Settings visual states remain available at desktop and mobile", async ({ page }, testInfo) => {
  const states = ["profile", "security", "preferences"];
  const viewports = [
    ["desktop", { width: 1440, height: 1000 }],
    ["mobile", { width: 390, height: 844 }],
  ];

  for (const [kind, viewport] of viewports) {
    for (const state of states) {
      await openSettings(page, state, viewport);
      await page.screenshot({
        path: path.join(SCREENSHOT_DIR, `${state}-${kind}-${testInfo.project.name}.png`),
        fullPage: false,
      });
    }
  }
});

test("Account Settings preserves every category and opens tabs at the page top", async ({ page }) => {
  await openSettings(page, "profile", { width: 1440, height: 1000 });

  for (const label of ["Profile", "Security", "Preferences"]) {
    await expect(page.locator(".account-settings-tabs")).toContainText(label);
  }
  await expect(page.locator(".paralegal-account-nav")).toContainText("Help");

  for (const [sectionId, heading] of [
    ["profileSection", "Account Settings"],
    ["securitySection", "Security"],
    ["preferencesSection", "Preferences"],
  ]) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.locator(`[data-settings-section="${sectionId}"]`).click();
    await expect(page.locator(`#${sectionId}`)).toBeVisible();
    await expect(page.getByRole("heading", { name: heading, exact: true }).first()).toBeInViewport();
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
    await expect.poll(() => page.locator("#main").evaluate((element) => element.scrollTop)).toBe(0);
  }
});

test("untouched Profile settles with authoritative identity and performs no writes", async ({ page }) => {
  const writes = [];
  page.on("request", (request) => {
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method())) {
      writes.push(`${request.method()} ${new URL(request.url()).pathname}`);
    }
  });

  await openSettings(page, "profile", { width: 1440, height: 1000 });
  const fullName = await page.locator("#fullNameInput").inputValue();
  await expect(page.locator(".lpc-sidebar-profile-trigger .globalProfileName")).toHaveText(fullName);
  await expect(page.locator("#profileSaveBtn")).toBeDisabled();
  await expect(page.locator("#profileSaveStatus")).toHaveText("All changes saved.");
  await expect(page.locator(".paralegal-actions")).toHaveCSS("position", "static");

  const avatarState = await page.locator("#avatarFrame").evaluate((frame) => ({
    hasPhoto: frame.classList.contains("has-photo"),
    initials: frame.querySelector("#avatarInitials")?.textContent || "",
  }));
  if (!avatarState.hasPhoto) {
    const expectedInitials = fullName.split(/\s+/).filter(Boolean).map((part) => part[0].toUpperCase()).join("").slice(0, 2) || "P";
    expect(avatarState.initials).toBe(expectedInitials);
  }
  expect(writes).toEqual([]);
});

test("an unavailable saved profile photo falls back to initials and opens the uploader from the photo", async ({ page }) => {
  await page.route("**/api/users/me", async (route) => {
    if (new URL(route.request().url()).pathname !== "/api/users/me") return route.continue();
    const response = await route.fetch();
    const user = await response.json();
    await route.fulfill({
      response,
      json: {
        ...user,
        profileImage: "/test-assets/unavailable-profile-photo.png",
        avatarURL: "/test-assets/unavailable-profile-photo.png",
      },
    });
  });
  await page.route("**/test-assets/unavailable-profile-photo.png*", (route) => route.abort("failed"));

  await openSettings(page, "profile", { width: 1440, height: 1000 });
  await expect(page.locator("#avatarFrame")).not.toHaveClass(/has-photo/);
  await expect(page.locator("#avatarInitials")).toBeVisible();
  await expect(page.locator("#avatarPhotoActions")).toBeHidden();
  await expect(page.locator("#avatarFrame")).toHaveAttribute("aria-label", "Upload profile photo");
  const fileChooser = page.waitForEvent("filechooser");
  await page.locator("#avatarFrame").click();
  await fileChooser;
});

test("profile photo actions appear only after mouse or keyboard activation", async ({ page }) => {
  const profilePhoto = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  await page.route("**/api/users/me", async (route) => {
    if (new URL(route.request().url()).pathname !== "/api/users/me") return route.continue();
    const response = await route.fetch();
    const user = await response.json();
    await route.fulfill({
      response,
      json: {
        ...user,
        profileImage: profilePhoto,
        avatarURL: profilePhoto,
      },
    });
  });

  await openSettings(page, "profile", { width: 390, height: 844 });
  const frame = page.locator("#avatarFrame");
  const actions = page.locator("#avatarPhotoActions");
  await expect(frame).toHaveClass(/has-photo/);
  await expect(frame).toHaveAttribute("aria-haspopup", "menu");
  await expect(frame).toHaveAttribute("aria-expanded", "false");
  await expect(actions).toBeHidden();

  await frame.click();
  await expect(actions).toBeVisible();
  await expect(frame).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByRole("menuitem", { name: "Edit photo" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Remove photo" })).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(actions).toBeHidden();
  await expect(frame).toBeFocused();

  await frame.press("Enter");
  await expect(actions).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Edit photo" })).toBeFocused();
});

test("restored Profile drafts are explicit and stale drafts cannot replace server state", async ({ page }) => {
  await openSettings(page, "profile", { width: 1440, height: 1000 });
  const serverName = await page.locator("#fullNameInput").inputValue();
  await page.locator("#fullNameInput").fill("Unsaved Draft Name");
  await expect(page.locator("#profileSaveStatus")).toHaveText("Unsaved changes");
  await page.waitForTimeout(180);

  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator("#settingsContent")).not.toHaveAttribute("aria-busy", "true");
  await expect(page.locator("#fullNameInput")).toHaveValue("Unsaved Draft Name");
  await expect(page.locator("#profileSaveBtn")).toBeEnabled();
  await expect(page.locator("#profileSaveStatus")).toHaveText("Unsaved changes");

  await page.evaluate(() => {
    const key = Object.keys(sessionStorage).find((item) => item.startsWith("lpc_profile_settings_draft_v1:"));
    if (!key) throw new Error("Profile draft was not stored");
    const draft = JSON.parse(sessionStorage.getItem(key));
    draft.serverFingerprint = "stale-server-profile";
    sessionStorage.setItem(key, JSON.stringify(draft));
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator("#settingsContent")).not.toHaveAttribute("aria-busy", "true");
  await expect(page.locator("#fullNameInput")).toHaveValue(serverName);
  await expect(page.locator("#profileSaveBtn")).toBeDisabled();
  await expect(page.locator("#profileSaveStatus")).toHaveText("All changes saved.");
});

test("programmatic Profile editors participate in the unsaved-state contract", async ({ page }) => {
  await openSettings(page, "profile", { width: 1440, height: 1000 });
  await page.locator('[data-edit-toggle="skills"]').click();
  const firstSkillRemove = page.locator("#skillsChips .chip-remove").first();
  await expect(firstSkillRemove).toBeVisible();
  await firstSkillRemove.click();
  await expect(page.locator("#profileSaveBtn")).toBeEnabled();
  await expect(page.locator("#profileSaveStatus")).toHaveText("Unsaved changes");

  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator("#settingsContent")).not.toHaveAttribute("aria-busy", "true");
  await page.evaluate(() => {
    Object.keys(sessionStorage)
      .filter((item) => item.startsWith("lpc_profile_settings_draft_v1:"))
      .forEach((item) => sessionStorage.removeItem(item));
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator("#settingsContent")).not.toHaveAttribute("aria-busy", "true");
  await page.locator('[data-edit-toggle="education"]').click();
  await expect(page.locator("#educationModal")).toHaveClass(/is-active/);
  const school = page.locator('#educationModalList [data-field="school"]').first();
  await school.fill("Boston University");
  await page.locator("#educationModalSave").click();
  await expect(page.locator("#profileSaveBtn")).toBeEnabled();
  await expect(page.locator("#profileSaveStatus")).toHaveText("Unsaved changes");
});

test("category switching has one stable scroll owner", async ({ page }) => {
  await openSettings(page, "profile", { width: 390, height: 844 });
  await page.evaluate(() => {
    const main = document.getElementById("main");
    if (main) main.scrollTop = 700;
    window.scrollTo(0, 700);
  });
  await page.locator('[data-settings-section="securitySection"]').click();
  await page.waitForTimeout(150);
  await expect(page.getByRole("heading", { name: "Account Settings", exact: true })).toBeInViewport();
  await expect.poll(() => page.locator("#main").evaluate((element) => element.scrollTop)).toBe(0);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
});

test("every Account Settings category uses the authenticated scroll owner without clipping", async ({ page }) => {
  const finalControlBySection = {
    profile: "#profileSaveBtn",
    security: '[data-deactivate-account]',
    preferences: "#replayParalegalTourBtn",
  };

  for (const viewport of [
    { width: 1440, height: 800 },
    { width: 390, height: 844 },
  ]) {
    for (const section of ["profile", "security", "preferences"]) {
      await openSettings(page, section, viewport);

      const scrollState = await page.locator("#main").evaluate((element) => {
        const style = getComputedStyle(element);
        return {
          clientHeight: element.clientHeight,
          scrollHeight: element.scrollHeight,
          overflowY: style.overflowY,
        };
      });
      expect(scrollState.overflowY).toBe("auto");
      expect(scrollState.scrollHeight).toBeGreaterThanOrEqual(scrollState.clientHeight);

      const sectionState = await page.locator(`#${section}Section`).evaluate((element) => {
        const style = getComputedStyle(element);
        return {
          clientHeight: element.clientHeight,
          scrollHeight: element.scrollHeight,
          height: style.height,
          maxHeight: style.maxHeight,
          overflowY: style.overflowY,
        };
      });
      expect(sectionState.overflowY).toBe("visible");
      expect(sectionState.maxHeight).toBe("none");
      expect(sectionState.scrollHeight).toBeLessThanOrEqual(sectionState.clientHeight + 1);

      if (scrollState.scrollHeight > scrollState.clientHeight + 1) {
        await page.locator("#main").hover();
        await page.mouse.wheel(0, 600);
        await expect.poll(() => page.locator("#main").evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
      }

      await page.locator("#main").evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      const finalControlPosition = await page.locator(finalControlBySection[section]).evaluate((element) => {
        const elementBox = element.getBoundingClientRect();
        const scrollOwnerBox = document.querySelector("#main").getBoundingClientRect();
        return {
          elementBottom: elementBox.bottom,
          elementTop: elementBox.top,
          scrollOwnerBottom: scrollOwnerBox.bottom,
          scrollOwnerTop: scrollOwnerBox.top,
        };
      });
      expect(finalControlPosition.elementBottom).toBeLessThanOrEqual(finalControlPosition.scrollOwnerBottom + 1);
      expect(finalControlPosition.elementTop).toBeGreaterThanOrEqual(finalControlPosition.scrollOwnerTop - 1);
      await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);

      await page.evaluate(() => {
        document.documentElement.classList.add("support-drawer-open", "support-drawer-pinned");
        document.body.classList.add("support-drawer-open", "support-drawer-pinned");
        document.getElementById("main")?.scrollTo({ top: 0 });
      });
      const pinnedScrollState = await page.locator("#main").evaluate((element) => ({
        clientHeight: element.clientHeight,
        scrollHeight: element.scrollHeight,
      }));
      if (pinnedScrollState.scrollHeight > pinnedScrollState.clientHeight + 1) {
        await page.locator("#main").hover();
        await page.mouse.wheel(0, 600);
        await expect.poll(() => page.locator("#main").evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
      }
      await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
    }
  }
});

test("Profile uses one paralegal style generation and keeps the professional record in reading order", async ({ page }) => {
  await openSettings(page, "profile", { width: 390, height: 844 });
  const stylesheetPaths = await page.evaluate(() => Array.from(document.styleSheets)
    .map((sheet) => sheet.href)
    .filter(Boolean)
    .map((href) => new URL(href).pathname));
  expect(stylesheetPaths.filter((pathname) => pathname.endsWith("/global-search.css"))).toHaveLength(1);
  expect(stylesheetPaths.filter((pathname) => pathname.endsWith("/notifications-dashboard.css"))).toHaveLength(1);
  expect(stylesheetPaths.filter((pathname) => pathname.endsWith("/support-drawer.css"))).toHaveLength(1);
  expect(stylesheetPaths).toContain("/assets/styles/profile-settings-paralegal-final.css");
  expect(stylesheetPaths.some((pathname) => pathname.endsWith("/profile-settings-attorney-account.css"))).toBe(false);
  expect(stylesheetPaths.some((pathname) => pathname.endsWith("/profile-settings-focused.css"))).toBe(false);

  const positions = await page.evaluate(() => Object.fromEntries([
    ["photo", "#avatarFrame"],
    ["name", "#fullNameInput"],
    ["practice", "#practiceAreasCard"],
    ["skills", "#skillsCard"],
    ["experience", "#experienceCard"],
  ].map(([name, selector]) => [name, document.querySelector(selector).getBoundingClientRect().top])));
  expect(positions.photo).toBeLessThan(positions.name);
  expect(positions.name).toBeLessThan(positions.practice);
  expect(positions.practice).toBeLessThan(positions.skills);
  expect(positions.skills).toBeLessThan(positions.experience);

  await expect(page.locator("#profileReadiness")).toHaveAttribute("data-state", /ready|incomplete/);
  await expect(page.locator("#profileReadinessTitle")).not.toBeEmpty();
});

test("Profile Settings recomposes around the pinned Assistant and remains overflow-safe", async ({ page }) => {
  await openSettings(page, "profile", { width: 1440, height: 900 });
  const launcher = page.getByRole("button", { name: "Open AI help chat" });
  await expect(launcher).toBeVisible();
  await launcher.click();
  await expect(page.locator("#supportDrawer")).toBeVisible();
  await expect(page.locator("body")).toHaveClass(/support-drawer-pinned/);
  const desktopBounds = await page.evaluate(() => {
    const shell = document.querySelector(".lpc-auth-page-shell").getBoundingClientRect();
    const drawer = document.querySelector("#supportDrawer").getBoundingClientRect();
    const main = document.querySelector("#main");
    return {
      shellRight: shell.right,
      drawerLeft: drawer.left,
      scrollWidth: main.scrollWidth,
      clientWidth: main.clientWidth,
    };
  });
  expect(desktopBounds.shellRight).toBeLessThanOrEqual(desktopBounds.drawerLeft + 1);
  expect(desktopBounds.scrollWidth).toBeLessThanOrEqual(desktopBounds.clientWidth + 1);
  await expect(page.locator("#profileReadiness")).toBeInViewport();
  await page.getByRole("button", { name: "Close assistant" }).click();
  await expect(page.locator("#supportDrawer")).not.toBeVisible();

  for (const width of [320, 360, 375, 390, 430, 768]) {
    await page.setViewportSize({ width, height: 844 });
    const overflow = await page.evaluate(() => ({
      document: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      main: document.querySelector("#main").scrollWidth - document.querySelector("#main").clientWidth,
    }));
    expect(overflow.document).toBeLessThanOrEqual(1);
    expect(overflow.main).toBeLessThanOrEqual(1);
  }
});

test("Preferences save immediately without writing unrelated fields", async ({ page }) => {
  await openSettings(page, "preferences", { width: 1440, height: 1000 });
  await expect(page.locator(".theme-preview-grid .theme-preview")).toHaveText([
    "Light",
    "Dark",
  ]);
  await expect(page.locator(".theme-preview-grid .theme-preview")).toHaveCount(2);
  const writes = [];
  let rejectNextWrite = false;
  await page.route("**/api/account/preferences", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const payload = route.request().postDataJSON();
    writes.push(payload);
    if (rejectNextWrite) {
      rejectNextWrite = false;
      return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Test save failure" }) });
    }
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ success: true, preferences: payload, state: payload.state || "" }) });
  });

  await page.locator('[data-theme-preview="dark"]').click();
  await expect.poll(() => writes.length).toBe(1);
  expect(Object.keys(writes[0]).sort()).toEqual(["fontSize", "theme"]);

  await page.locator("#statePreference").selectOption("NY");
  await expect.poll(() => writes.length).toBe(2);
  expect(writes[1]).toEqual({ state: "NY" });

  rejectNextWrite = true;
  const fontSizePreference = page.locator("#fontSizePreference");
  const failedSize = (await fontSizePreference.inputValue()) === "lg" ? "sm" : "lg";
  await fontSizePreference.selectOption(failedSize);
  await expect(page.locator("#preferencesSaveStatus")).toContainText("Could not save");
  await expect(page.locator("#preferencesSaveStatus")).toHaveAttribute("data-state", "error");
});

test("Preferences expose one visible save status and theme radios work by keyboard", async ({ page }) => {
  await openSettings(page, "preferences", { width: 1440, height: 1000 });
  await expect(page.locator("#preferencesSaveStatus")).toBeInViewport();

  let releaseNotificationSave;
  const notificationSavePending = new Promise((resolve) => {
    releaseNotificationSave = resolve;
  });
  await page.route("**/api/users/me/notification-prefs", async (route) => {
    await notificationSavePending;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ success: true }) });
  });
  const notificationToggle = page.locator("#emailNotificationsToggle");
  await notificationToggle.locator("..").click();
  await expect(page.locator("#preferencesSaveStatus")).toHaveText("Saving…");
  releaseNotificationSave();
  await expect(page.locator("#preferencesSaveStatus")).toHaveText("Notification preferences saved");

  const themeWrites = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/account/preferences") {
      themeWrites.push(request.postDataJSON());
    }
  });
  const lightTheme = page.locator('[data-theme-preview="light"]');
  const waitForSessionRefresh = () => page.waitForResponse((response) => (
    new URL(response.url()).pathname === "/api/auth/me" && response.ok()
  ));
  let sessionRefresh = waitForSessionRefresh();
  await lightTheme.click();
  await expect(lightTheme).toHaveAttribute("aria-checked", "true");
  await expect(page.locator("body")).toHaveClass(/theme-light/);
  await expect.poll(() => themeWrites.length).toBe(1);
  await sessionRefresh;
  await expect(page.locator("body")).toHaveClass(/theme-light/);
  themeWrites.length = 0;
  await lightTheme.focus();
  sessionRefresh = waitForSessionRefresh();
  await lightTheme.press("ArrowRight");
  await expect(page.locator('[data-theme-preview="dark"]')).toHaveAttribute("aria-checked", "true");
  await expect(page.locator("body")).toHaveClass(/theme-dark/);
  await expect.poll(() => themeWrites.length).toBe(1);
  await sessionRefresh;
  await expect(page.locator("body")).toHaveClass(/theme-dark/);

  const colors = await page.locator("#preferencesSection .preferences-layout").evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      color: style.color,
      backgroundColor: style.backgroundColor,
    };
  });
  const foreground = parseRgb(colors.color);
  const background = parseRgb(colors.backgroundColor);
  expect(foreground).not.toBeNull();
  expect(background).not.toBeNull();
  expect(background).not.toEqual([255, 255, 255]);
  expect(contrastRatio(foreground, background)).toBeGreaterThanOrEqual(4.5);

  await page.locator('[data-settings-section="securitySection"]').click();
  await expectElementContrast(
    page,
    '#securitySection .security-column:first-child > .settings-block:first-child h3',
    '#securitySection .security-column:first-child > .settings-block:first-child'
  );
  await expectElementContrast(
    page,
    '#securitySection .security-column:first-child > .settings-block:first-child .muted',
    '#securitySection .security-column:first-child > .settings-block:first-child'
  );

  await page.locator('[data-settings-section="profileSection"]').click();
  await expectElementContrast(page, ".globalProfileName", "#sidebarNav");
  await expectElementContrast(page, "#accountSettingsTitle", "#main", 3);
  await expectElementContrast(page, "#accountSettingsSubtitle", "#main");
  await expectElementContrast(page, "#avatarInitials", ".hero-photo", 3);
  for (const selector of [
    'label[for="emailInput"]',
    'label[for="linkedInInput"]',
    'label[for="yearsExperienceInput"]',
  ]) {
    await expectElementContrast(page, selector, ".profile-photo-block");
  }

  await page.locator('[data-settings-section="preferencesSection"]').click();
  sessionRefresh = waitForSessionRefresh();
  await lightTheme.click();
  await sessionRefresh;
  await expect(lightTheme).toHaveAttribute("aria-checked", "true");
  await expect(page.locator("body")).toHaveClass(/theme-light/);
});
