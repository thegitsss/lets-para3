// Paralegal Home uses the Attorney V2 page grammar with Paralegal-owned records.
// This view is deliberately independent of the older ld-desktop workspace skin.
import { renderHomeCalendar } from './home-calendar.mjs';
export function renderHomeOverview({ host, model, actions, node, link, button, availability }) {
  const el = (tag, className, text) => node(tag, { className, text });
  const route = (label, href, className = "pv2-overview-link") => link(label, href, className);
  const date = new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric", timeZone: "America/New_York" })
    .format(new Date(`${model.today}T12:00:00Z`));
  const time = value => {
    const at = new Date(value || "");
    return Number.isFinite(at.getTime()) ? at.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "America/New_York" }) : "—";
  };
  const row = ({ title, detail, action, href, unread = false }) => {
    const cells = [el("span", "pv2-overview-row-title", title), el("span", "pv2-overview-row-detail", detail), el("span", "pv2-overview-row-action", action)];
    const item = href ? route("", href, "pv2-overview-row") : node("div", { className: "pv2-overview-row" });
    item.classList.toggle("is-unread", unread);
    item.append(...cells);
    return item;
  };
  const section = (name, rows, { labels, href, empty } = {}) => {
    if (!rows.length && !empty) return null;
    const heading = node("header", { className: "pv2-overview-section-heading" }, [
      el("h2", "", name), rows.length && href && (name !== "For your review" || rows.length > 3) ? route("View all", href, "pv2-overview-section-link") : null,
    ]);
    const body = node("section", { className: `pv2-overview-section${rows.length ? "" : " is-empty"}`, "aria-label": name }, [heading]);
    if (rows.length && labels) body.append(node("div", { className: "pv2-overview-columns", "aria-hidden": "true" }, labels.map(label => el("span", "", label))));
    rows.slice(0, 3).forEach(item => body.append(row(item)));
    if (!rows.length) body.append(el("p", "pv2-overview-empty", empty));
    return body;
  };
  const appendSection = block => { if (block) primary.append(block); };

  host.classList.remove("ld-desktop", "ph-desktop");
  host.classList.add("pv2-overview");
  host.replaceChildren();
  const page = node("div", { className: "pv2-overview-page" });
  const header = node("header", { className: "pv2-overview-header" }, [
    el("h1", "", "Today"), node("time", { className: "pv2-overview-date", text: date }), availability,
  ]);
  const metric = (total, label, href) => {
    const target = route("", href, "pv2-overview-metric");
    target.setAttribute("aria-label", `${total} ${label}`);
    target.append(el("strong", "", String(total)), el("span", "", label));
    return target;
  };
  const counts = node("nav", { className: "pv2-overview-counts", "aria-label": "Work summary" }, [
    model.sources.dashboard.complete ? metric(model.activeWork.length, `Active Matter${model.activeWork.length === 1 ? "" : "s"}`, "/work?section=active") : null,
    model.sources.applications.complete ? metric(model.applicationCount, `Pending application${model.applicationCount === 1 ? "" : "s"}`, "/work?section=applications") : null,
    model.sources.invites.complete ? metric(model.opportunities.invitations.length, `Invitation${model.opportunities.invitations.length === 1 ? "" : "s"}`, "/work?section=invitations") : null,
  ]);
  page.append(header);
  const accountSetup=actions.renderAccountSetup?.({model,snapshot:actions.snapshot});
  if (counts.childElementCount) page.append(counts);
  if(accountSetup)page.append(accountSetup);
  const unavailable = ["dashboard", "profile", "applications", "invites", "threads", "unread", "recommendations"]
    .some(name => ["partial", "error", "unavailable", "stale"].includes(model.sources[name]?.state));
  if (unavailable) {
    page.append(node("div", { className: "pv2-overview-source", role: "status", "data-home-source-state": "partial" }, [
      el("span", "", "Some records are unavailable. Showing the verified information."),
      button("Try again", actions.retry, "pv2-overview-source-retry", { "data-v2-home-retry": "" }),
    ]));
  }

  const layout = node("div", { className: "pv2-overview-layout" });
  const primary = node("div", { className: "pv2-overview-primary" });
  layout.append(primary);
  page.append(layout);

  const attention = [
    ...model.workspace.reviews.action.map(item => ({ ...item, detail: `Revision requested · ${item.contentTitle}: ${item.reason}`, action: "Review revisions" })),
    ...model.attention.candidates.filter(item => ["request", "invitation"].includes(item.kind) || item.kind === "deadline" && item.deadline <= model.today)
      .map(item => ({ ...item, detail: `${item.label} · ${item.detail}`, action: item.actionLabel || "Review" })),
  ];
  if (attention.length) {
    appendSection(section("For your review", attention.map(item => ({ title: item.title, detail: item.detail, action: item.action, href: item.href })), {
      labels: ["Matter", "Reason", "Action"], href: "/home?view=inbox",
    }));
  } else {
    appendSection(section("For your review", [], { empty: model.attention.complete && model.workspace.reviewsComplete
      ? "Nothing needs your attention right now." : "Some review items could not be checked." }));
  }

  const messages = model.communications.recentItems.map(item => ({
    title: item.title, detail: `${item.sender ? `${item.sender}: ` : ""}${item.detail || "No messages yet."}`,
    action: item.unread > 0 ? `${item.unread} unread` : item.eventAt ? time(item.eventAt) : "Open conversation",
    href: item.href, unread: item.unread > 0,
  }));
  appendSection(section("Messages", messages, { href: "/conversations", empty: model.communications.complete
    ? "No Matter conversations yet." : "Messages could not be checked." }));

  const active = model.activeWork.map(item => ({ title: item.title, detail: [item.attorney, item.nextStepLabel || item.label].filter(Boolean).join(" · ") || "—", action: item.deadline ? `Due ${new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", timeZone: "America/New_York" }).format(new Date(`${item.deadline}T12:00:00Z`))}` : time(item.eventAt), href: item.href }));
  appendSection(section("Your Matters", active, { labels: ["Matter", "Attorney / next step", "Deadline / activity"], href: "/work?section=active", empty: model.sources.dashboard.complete
    ? "No active Matters yet." : "Your Matters could not be checked." }));

  const applications = model.recentApplications.map(item => ({ title: item.title, detail: item.label || "—", action: time(item.eventAt), href: item.href }));
  if (applications.length || !model.sources.applications.complete) appendSection(section("Pending applications", applications, { labels: ["Matter", "Status", "Last activity"], href: "/work?section=applications", empty: "Applications could not be checked." }));

  const setup = accountSetup ? null : model.readiness.items[0] || model.profileTodos[0];
  const recommendations = model.opportunities.recommendations;
  if (model.findWork.state === "ready") {
    const matching = node("section", { className: "pv2-overview-matches", "aria-label": "Find work" }, [
      node("header", { className: "pv2-overview-matches-heading" }, [
        el("h2", "", "Find work"), route("Browse all", "/browse", "pv2-overview-section-link"),
      ]),
    ]);
    recommendations.slice(0, 3).forEach(item => {
      const matter = route("", item.href, "pv2-overview-match");
      const metadata = [item.practice, item.state, item.deadline ? `Due ${new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", timeZone: "America/New_York" }).format(new Date(`${item.deadline}T12:00:00Z`))}` : ""].filter(Boolean).join(" · ");
      matter.append(node("span", { className: "pv2-overview-match-main" }, [
        el("strong", "", item.title),
        item.matchReason || metadata ? el("span", "pv2-overview-match-meta", [item.matchReason, metadata].filter(Boolean).join(" · ")) : null,
      ]));
      if (Number.isFinite(item.compensation)) matter.append(el("span", "pv2-overview-match-amount", new Intl.NumberFormat(undefined, { style: "currency", currency: item.currency || "USD", maximumFractionDigits: 0 }).format(item.compensation)));
      matter.append(el("span", "pv2-overview-match-arrow", "→"));
      matching.append(matter);
    });
    primary.append(matching);
  } else {
    const discover = node("section", { className: "pv2-overview-section pv2-overview-discover", "aria-label": "Find work" }, [
      node("header", { className: "pv2-overview-section-heading" }, [
        el("h2", "", setup ? "Your next step" : "Find work"), route("Browse all", "/browse", "pv2-overview-section-link"),
      ]),
    ]);
    discover.dataset.findWorkState = model.findWork.state;
    discover.append(node("p", { className: "pv2-overview-empty", role: "status", text: setup ? `${setup.title}. ${setup.detail}` : model.findWork.message }));
    if (setup) discover.append(route(setup.actionLabel || "Review profile", setup.href, "pv2-overview-section-link"));
    else if (model.findWork.retry) discover.append(button("Retry", actions.retry, "pv2-overview-source-retry", { "data-v2-find-work-retry": "" }));
    else if (model.findWork.href) discover.append(route(model.findWork.actionLabel, model.findWork.href, "pv2-overview-section-link"));
    primary.append(discover);
  }
  if (!primary.childElementCount) layout.remove();
  renderHomeCalendar({ page, model, actions, node, link, button });
  host.append(page);
}
