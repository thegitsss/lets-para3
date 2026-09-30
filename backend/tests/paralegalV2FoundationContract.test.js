const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { pathToFileURL } = require("url");

const root = path.resolve(__dirname, "../..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

function evaluateBrowserModule(relativePath, expression) {
  const moduleUrl = pathToFileURL(path.join(root, relativePath)).href;
  const script = `import * as subject from ${JSON.stringify(moduleUrl)}; console.log(JSON.stringify(${expression}));`;
  const output = execFileSync(process.execPath, ["--input-type=module", "--eval", script], { encoding: "utf8" });
  return JSON.parse(output);
}

const ownedFiles = [
  "frontend/paralegal-v2.html",
  "frontend/assets/styles/paralegal-v2.css",
  "frontend/assets/scripts/paralegal-v2/first-paint.js",
  "frontend/assets/scripts/paralegal-v2/shell-prime.js",
  "frontend/assets/scripts/paralegal-v2/api-client.mjs",
  "frontend/assets/scripts/paralegal-v2/session-boundary.mjs",
  "frontend/assets/scripts/paralegal-v2/router.mjs",
  "frontend/assets/scripts/paralegal-v2/app.mjs",
  "frontend/assets/scripts/paralegal-v2/deep-links.mjs",
  "frontend/assets/scripts/paralegal-v2/search-controller.mjs",
  "frontend/assets/scripts/paralegal-v2/notifications-controller.mjs",
  "frontend/assets/scripts/paralegal-v2/help-view.mjs",
  "frontend/assets/styles/paralegal-v2-global.css",
  "docs/PARALEGAL_V2_PHASE0_BASELINE.md",
];

describe("Paralegal V2 isolated Phase 1 foundation", () => {
  test('retry hints do not make the API client repeat a mutation', () => {
    const result = evaluateBrowserModule('frontend/assets/scripts/paralegal-v2/api-client.mjs', `await (async()=>{
      const methods=[];
      const api=subject.createApiClient({fetchImpl:async(path,options)=>{
        methods.push(options.method || 'GET');
        if(path==='/api/csrf')return new Response(JSON.stringify({csrfToken:'isolated-token'}),{headers:{'Content-Type':'application/json'}});
        return new Response('{}',{status:503,headers:{'Content-Type':'application/json','Retry-After':'5'}});
      }});
      let hint;
      try{await api.post('/api/messages/aaaaaaaaaaaaaaaaaaaaaaaa',{text:'Keep this single'});}catch(error){hint=error.retryAfterMs;}
      return {methods,hint};
    })()`);
    expect(result).toEqual({ methods: ['GET', 'POST'], hint: 5000 });
  });
  test("session snapshots are idempotent so authenticated tabs cannot create a storage-event loop", () => {
    const auth = read("frontend/assets/scripts/auth.js");
    const session = read("frontend/assets/scripts/utils/session.js");

    expect(auth).toContain('const current = localStorage.getItem(USER_KEY) || ""');
    expect(auth).toContain("payload !== current");
    expect(auth).toContain("user.id || user._id");
    expect(session).toContain('localStorage.getItem("lpc_user") !== payload');
    const app = read("frontend/assets/scripts/paralegal-v2/app.mjs");
    expect(app).toContain("projectSessionIdentity(identity)");
    expect(app).toContain("persistSession({ user: projected })");
  });

  test.each(ownedFiles)("ships %s", (file) => {
    expect(fs.existsSync(path.join(root, file))).toBe(true);
  });

  test("the initial document contains one complete persistent shell", () => {
    const html = read("frontend/paralegal-v2.html");
    expect(html.match(/<body\b/g)).toHaveLength(1);
    expect(html.match(/data-v2-persistent="sidebar"/g)).toHaveLength(1);
    expect(html.match(/data-v2-persistent="header"/g)).toHaveLength(1);
    expect(html.match(/data-v2-persistent="assistant"/g)).toHaveLength(1);
    expect(html.match(/data-v2-route-outlet/g)).toHaveLength(1);
    expect(html).toMatch(/data-v2-toast-region/);
    expect(html).toMatch(/data-v2-dialog-host/);
    expect(html).toMatch(/aria-label="Collapse sidebar"[^>]*aria-controls="v2-sidebar"[^>]*aria-expanded="true"[^>]*data-v2-sidebar-grip/s);
    expect(html).toMatch(/<a class="v2-skip-link" href="#main">Skip to main content<\/a>/);
    expect(html).toMatch(/<main class="v2-view" id="main"/);
    expect(html).not.toMatch(/universal-header\.js|sidebar-profile\.js|dashboard-paralegal\.js/);
  });

  test("ordinary navigation replaces only the route outlet", () => {
    const app = read("frontend/assets/scripts/paralegal-v2/app.mjs");
    const router = read("frontend/assets/scripts/paralegal-v2/router.mjs");
    const css = read("frontend/assets/styles/paralegal-v2.css");
    expect(app).toMatch(/outlet\.replaceChildren\(view\)/);
    expect(app).not.toMatch(/outlet\.replaceChildren\([^\n]*createLoadingView/);
    expect(app).not.toMatch(/document\.body\.innerHTML|location\.assign\([^)]*#\/|location\.replace\([^)]*#\//);
    expect(router).toMatch(/dataset\.lpcV2Navigation = "pending"/);
    expect(router).toMatch(/scrollElement\.scrollTop = restoredScrollTop/);
    // The delayed-frame browser journey verifies route focus/overlay ordering.
    expect(router).toMatch(/event\.detail === 0/);
    expect(css).toMatch(/\.v2-route-arriving[\s\S]*v2-route-arrive 150ms/);
    expect(css).toMatch(/prefers-reduced-motion: reduce/);
    expect(app).toMatch(/window\.__LPC_PARALEGAL_V2__/);
    expect(app).toMatch(/sidebar: document\.querySelector/);
    expect(app).toMatch(/header: document\.querySelector/);
    expect(app).toMatch(/assistant: document\.querySelector/);
  });

  test("the foundation does not load privileged workflow endpoints", () => {
    const app = read("frontend/assets/scripts/paralegal-v2/app.mjs");
    const session = read("frontend/assets/scripts/paralegal-v2/session-boundary.mjs");
    const bootstrapCalls = app.match(/api\.(?:get|post|request|upload|blob)\(\s*["']\/api\/[^"']+/g) || [];
    expect(bootstrapCalls).toEqual([]);
    expect(session).toContain('readSession(api, { signal })');
    const sessionRead = read("frontend/assets/scripts/utils/session-read.mjs");
    expect(sessionRead.match(/["']\/api\/[^"']+/g)?.map((value) => value.slice(1))).toEqual(["/api/auth/me"]);
  });

  test("the API boundary is same-origin, cookie-authenticated, CSRF-aware, and does not retry mutations", () => {
    const source = read("frontend/assets/scripts/paralegal-v2/api-client.mjs");
    expect(source).toMatch(/startsWith\("\/api\/"\)/);
    expect(source).toMatch(/credentials: "include"/);
    expect(source).toMatch(/"X-CSRF-Token"/);
    expect(source).toMatch(/SAFE_METHODS/);
    expect(source).not.toMatch(/setInterval/);
  });

  test("the API boundary announces only server-confirmed mutations", () => {
    const moduleUrl = pathToFileURL(path.join(root, "frontend/assets/scripts/paralegal-v2/api-client.mjs")).href;
    const script = `
      import { createApiClient } from ${JSON.stringify(moduleUrl)};
      const events = [];
      const response = (body, status = 200) => new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
      const fetchImpl = async (url, options = {}) => {
        if (url === "/api/csrf") return response({ csrfToken: "contract-token" });
        if (url === "/api/cases/failure") return response({ error: "Rejected" }, 409);
        return response({ ok: true, method: options.method });
      };
      const api = createApiClient({
        fetchImpl,
        onMutationCommitted(event) { events.push(event); },
      });
      await api.get("/api/cases/current");
      await api.post("/api/cases/current", { title: "Updated" });
      let failed = false;
      try { await api.post("/api/cases/failure", {}); } catch { failed = true; }
      const callbackSafeApi = createApiClient({
        fetchImpl,
        onMutationCommitted() { throw new Error("consumer failure"); },
      });
      const callbackSafeResult = await callbackSafeApi.post("/api/cases/current", {});
      console.log(JSON.stringify({ events, failed, callbackSafeResult }));
    `;
    const result = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "--eval", script], { encoding: "utf8" }));
    expect(result).toEqual({
      events: [{ url: "/api/cases/current", method: "POST" }],
      failed: true,
      callbackSafeResult: { ok: true, method: "POST" },
    });
  });

  test("the session boundary reauthorizes stale and multi-tab contexts without polling", () => {
    const source = read("frontend/assets/scripts/paralegal-v2/app.mjs");
    const sharedSession = read("frontend/assets/scripts/utils/session.js");
    expect(source).toMatch(/addEventListener\("storage"/);
    expect(source).toMatch(/event\.key !== "lpc_user"/);
    expect(source).toMatch(/leavingProtectedShell = true/);
    expect(source).toMatch(/sessionCheckController\?\.abort\(\)/);
    expect(source).toMatch(/if \(!leavingProtectedShell\) persistSession/);
    expect(source).toMatch(/addEventListener\("lpc:lifecycle-refresh"/);
    expect(source).toMatch(/addEventListener\("pageshow"/);
    expect(source).toMatch(/document\.visibilityState !== "visible"\) return/);
    expect(source).not.toMatch(/setInterval/);
    expect(sharedSession).toMatch(/requestGeneration !== sessionGeneration/);
    expect(sharedSession).toMatch(/if \(!isLoginPage\(\)\)/);
  });

  test("an unauthenticated V2 route returns to the persistent shell after sign-in", () => {
    const app = read("frontend/assets/scripts/paralegal-v2/app.mjs");
    const session = read("frontend/assets/scripts/paralegal-v2/session-boundary.mjs");
    const login = read("frontend/assets/scripts/login.js");
    expect(app).toMatch(/paralegalV2LoginDestination\(location\.hash\)/);
    expect(session).toMatch(/login\.html\?next=/);
    expect(read("frontend/assets/scripts/auth.js")).toMatch(/window\.location\.pathname === "\/paralegal-v2\.html"/);
    const { resolve } = require("../../frontend/assets/scripts/utils/login-return-target");
    expect(resolve("https://external.example/paralegal-v2.html#/home", "paralegal")).toBe("");
    expect(resolve("/dashboard-attorney.html", "paralegal")).toBe("");
    expect(resolve("/paralegal-v2.html#/home", "paralegal")).toBe("/paralegal-v2.html#/home");
    expect(login).toMatch(/resolvePostLoginTarget\(data\.user\)/);
  });

  test("the shell preserves the approved sizing and interaction constraints", () => {
    const html = read("frontend/paralegal-v2.html");
    const css = read("frontend/assets/styles/paralegal-v2.css");
    const app = read("frontend/assets/scripts/paralegal-v2/app.mjs");
    const support = read("frontend/assets/scripts/utils/support-drawer.js");
    expect(css).toMatch(/--v2-header-height: 68px/);
    expect(css).toMatch(/--v2-assistant-width: 384px/);
    expect(css).toMatch(/scrollbar-gutter: stable/);
    expect(css).toMatch(/\.v2-mobile-menu[\s\S]*width: 44px[\s\S]*height: 44px/);
    expect(css).toMatch(/\.v2-nav-link\[aria-current="page"\][\s\S]*color: var\(--v2-blue-hover\)/);
    expect(css).toMatch(/body\.v2-sidebar-collapsed[\s\S]*--v2-sidebar-width: 76px/);
    expect(css).toMatch(/body\.v2-sidebar-collapsed \.v2-nav-link span[\s\S]*clip: rect\(0, 0, 0, 0\)/);
    expect(app).toMatch(/function setSidebarCollapsed\(collapsed\)/);
    expect(html).not.toMatch(/data-v2-assistant-pin|aria-label="Pin/);
    expect(support).toMatch(/AI can make mistakes\. Check important information\./);
    expect(app).toMatch(/sidebar\.addEventListener\("wheel"[\s\S]*\{ passive: false \}/);
    expect(app).toMatch(/outlet\.scrollTop = Math\.max\(0, Math\.min\(maximumScroll, outlet\.scrollTop \+ delta\)\)/);
    expect(app).toMatch(/prefers-reduced-motion: reduce/);
    expect(css).toMatch(/v2-view--empty-scroll-forward[\s\S]*v2-empty-scroll-forward/);
    expect(css).toMatch(/v2-view--empty-scroll-back[\s\S]*v2-empty-scroll-back/);
    expect(css).not.toMatch(/box-shadow/);
  });

  test("all primary controls expose names, ownership, and expanded state", () => {
    const html = read("frontend/paralegal-v2.html");
    expect(html).toMatch(/aria-label="Open navigation"[^>]*aria-controls="v2-sidebar"[^>]*aria-expanded="false"/s);
    expect(html).toMatch(/<label[^>]*for="v2-search-input">Search your workspace<\/label>/);
    expect(html).toMatch(/id="v2-search-input"[^>]*aria-controls="v2-search-panel"[^>]*aria-expanded="false"/s);
    expect(html.match(/data-v2-search-form/g)).toHaveLength(1);
    expect(html.indexOf("data-v2-search-form")).toBeLessThan(html.indexOf("data-v2-search-panel"));
    expect(html).toMatch(/aria-label="View notifications"[^>]*aria-controls="v2-notifications-panel"[^>]*aria-expanded="false"/s);
    expect(html).toMatch(/aria-label="Open LPC Assistant"[^>]*aria-controls="supportDrawer"[^>]*aria-expanded="false"/s);
    expect(html).toMatch(/id="main" tabindex="-1"/);
  });

  test("route parsing supports primary and deep-link responsibilities", () => {
    const routes = evaluateBrowserModule(
      "frontend/assets/scripts/paralegal-v2/router.mjs",
      `[
        subject.parseRouteHash("#/home"),
        subject.parseRouteHash("#/browse?state=CA"),
        { tab: subject.parseRouteHash("#/settings?tab=security").query.get("tab") },
        subject.parseRouteHash("#/profile/abc%20123"),
        subject.parseRouteHash("#/matter/64b000000000000000000001"),
        subject.parseRouteHash("#/unknown")
      ]`
    );
    expect(routes[0]).toMatchObject({ name: "home", found: true });
    expect(routes[1]).toMatchObject({ name: "browse", found: true });
    expect(routes[2].tab).toBe("security");
    expect(routes[3].params.profileId).toBe("abc 123");
    expect(routes[4].params.matterId).toBe("64b000000000000000000001");
    expect(routes[5]).toMatchObject({ name: "not-found", found: false });
  });

  test("session projection stores presentation identity only and normalizes retired themes", () => {
    const projected = evaluateBrowserModule(
      "frontend/assets/scripts/paralegal-v2/session-boundary.mjs",
      `subject.projectSessionIdentity({
        _id: "user-1",
        role: "Paralegal",
        status: "approved",
        firstName: "Dana",
        email: "must-not-be-cached@example.com",
        password: "must-not-be-cached",
        preferences: { theme: "mountain-dark", fontSize: "lg", secret: "no" }
      })`
    );
    expect(projected).toMatchObject({ id: "user-1", role: "paralegal", firstName: "Dana" });
    expect(projected.preferences).toEqual({ theme: "dark", fontSize: "lg" });
    expect(projected).not.toHaveProperty("email");
    expect(projected).not.toHaveProperty("password");
    expect(projected.preferences).not.toHaveProperty("secret");
  });

  test("partial profile saves preserve verified identity, appearance, and onboarding", () => {
    const result = evaluateBrowserModule("frontend/assets/scripts/paralegal-v2/session-boundary.mjs", `(() => {
      const identity = { id: "user-1", role: "paralegal", status: "approved", firstName: "Dana", preferences: { theme: "dark", fontSize: "lg" }, onboarding: { paralegalTourCompleted: true, paralegalProfileTourCompleted: true } };
      const profile = { _id: "user-1", firstName: "Dani", preferences: { fontSize: "xl" }, bio: "Private profile text" };
      return { updated: subject.projectProfileIdentity(profile, identity), identity, profile };
    })()`);
    expect(result.updated).toMatchObject({ id: "user-1", role: "paralegal", status: "approved", firstName: "Dani", preferences: { theme: "dark", fontSize: "xl" }, onboarding: { paralegalTourCompleted: true, paralegalProfileTourCompleted: true } });
    expect(result.updated).not.toHaveProperty("bio");
    expect(result.identity.firstName).toBe("Dana");
    expect(result.identity.preferences.fontSize).toBe("lg");
    expect(result.profile).not.toHaveProperty("role");
  });

  test("profile display updates cannot replace account ownership or session authority", () => {
    const result = evaluateBrowserModule("frontend/assets/scripts/paralegal-v2/session-boundary.mjs", `(() => {
      const identity = { id: "user-1", role: "paralegal", status: "approved", disabled: false, deleted: false };
      return [subject.projectProfileIdentity({ _id: "user-2", firstName: "Another account" }, identity), subject.projectProfileIdentity({ _id: "user-1" }, null), subject.projectProfileIdentity(null, identity), subject.projectProfileIdentity({ _id: "user-1", role: "admin", status: "suspended", disabled: true, deleted: true }, identity)];
    })()`);
    expect(result.slice(0, 3)).toEqual([null, null, null]);
    expect(result[3]).toMatchObject({ id: "user-1", role: "paralegal", status: "approved", disabled: false, deleted: false });
  });
});

test('Matter returns preserve allowed list filters and reject external or nested destinations', () => {
 const actual=evaluateBrowserModule('frontend/assets/scripts/paralegal-v2/router.mjs',`(() => {
  const source='/work?section=applications&appQuery=Alex%20Lee&appStatus=shortlisted&appPage=2&highlightCase=aaaaaaaaaaaaaaaaaaaaaaaa&returnTo=https%3A%2F%2Fevil.test';
  const safe=subject.safeMatterReturn(source), href=subject.withMatterReturn('/matter/bbbbbbbbbbbbbbbbbbbbbbbb?tab=files&fileId=cccccccccccccccccccccccc',source);
  return {safe,href,bad:['https://evil.test','//evil.test','/work/other','/settings','/work#bad','/work\\\\evil'].map(value=>subject.safeMatterReturn(value)),duplicate:subject.safeMatterReturn('/work?section=active&section=history&appPage=0'),home:subject.safeMatterReturn('/home?view=reviews&item=submission:cccccccccccccccccccccccc')};
 })()`);
 expect(actual.safe).toBe('/work?section=applications&appQuery=Alex+Lee&appStatus=shortlisted&appPage=2&highlightCase=aaaaaaaaaaaaaaaaaaaaaaaa');
 const query=new URLSearchParams(actual.href.split('?')[1]);expect(query.get('returnTo')).toBe(actual.safe);expect(query.get('fileId')).toBe('cccccccccccccccccccccccc');expect(query.get('tab')).toBe('files');
 expect(actual.bad).toEqual([null,null,null,null,null,null]);expect(actual.duplicate).toBe('/work');expect(actual.home).toContain('view=reviews');
});
