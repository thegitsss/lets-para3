export function isSafeSupportHref(href = "") {
  const value = String(href || "").trim();
  if (!value) return false;
  if (/^(?:javascript|data|vbscript|blob):/i.test(value)) return false;
  if (/^https?:/i.test(value) || value.startsWith("//")) return false;
  if (/\s/.test(value)) return false;
  return /^(?:\/)?[A-Za-z0-9._~!$&'()*+,;=:@/?#%-]+$/.test(value) && (value.includes(".html") || value.startsWith("#"));
}

function buildMarkdownLinkSegments(text = "") {
  const messageText = String(text || "");
  if (!messageText.includes("[") || !messageText.includes("](")) {
    return null;
  }

  const pattern = /\[([^\]]+)\]\(([^)]+)\)/g;
  const segments = [];
  let cursor = 0;
  let matched = false;

  for (const match of messageText.matchAll(pattern)) {
    const [raw, label, href] = match;
    const index = match.index ?? -1;
    if (index < 0) continue;

    if (index > cursor) {
      segments.push({ type: "text", text: messageText.slice(cursor, index) });
    }

    if (isSafeSupportHref(href)) {
      segments.push({ type: "link", text: label, href });
      matched = true;
    } else {
      segments.push({ type: "text", text: raw });
    }

    cursor = index + raw.length;
  }

  if (!matched) {
    return null;
  }

  if (cursor < messageText.length) {
    segments.push({ type: "text", text: messageText.slice(cursor) });
  }

  return segments;
}

function buildRawHrefSegments(text = "") {
  const messageText = String(text || "");
  const pattern = /(^|[\s(])((?:\/)?[A-Za-z0-9._~!$&'()*+,;=:@/?#%-]+(?:\.html(?:#[A-Za-z0-9._~!$&'()*+,;=:@/?#%-]*)?|#[A-Za-z0-9._~!$&'()*+,;=:@/?#%-]+))(?=$|[\s),.?!;:])/g;
  const segments = [];
  let cursor = 0;
  let matched = false;

  for (const match of messageText.matchAll(pattern)) {
    const prefix = match[1] || "";
    const href = match[2] || "";
    const index = match.index ?? -1;
    if (index < 0) continue;
    const hrefStart = index + prefix.length;

    if (hrefStart > cursor) {
      segments.push({ type: "text", text: messageText.slice(cursor, hrefStart) });
    }

    if (isSafeSupportHref(href)) {
      segments.push({ type: "link", text: href, href });
      matched = true;
    } else {
      segments.push({ type: "text", text: href });
    }

    cursor = hrefStart + href.length;
  }

  if (!matched) {
    return null;
  }

  if (cursor < messageText.length) {
    segments.push({ type: "text", text: messageText.slice(cursor) });
  }

  return segments;
}

export function buildSupportInlineSegments(text = "", navigation = null) {
  const messageText = String(text || "");
  const markdownSegments = buildMarkdownLinkSegments(messageText);
  if (markdownSegments?.length) {
    return markdownSegments;
  }

  const rawHrefSegments = buildRawHrefSegments(messageText);
  if (rawHrefSegments?.length) {
    return rawHrefSegments;
  }

  const inlineLinkText = String(navigation?.inlineLinkText || "here").trim() || "here";
  const href = String(navigation?.ctaHref || "").trim();
  const fallbackLabel = String(navigation?.ctaLabel || inlineLinkText).trim() || inlineLinkText;

  if (!navigation || !isSafeSupportHref(href)) {
    return [{ type: "text", text: messageText }];
  }

  const lowerText = messageText.toLowerCase();
  const lowerInlineLinkText = inlineLinkText.toLowerCase();
  const linkIndex = lowerText.indexOf(lowerInlineLinkText);

  if (linkIndex === -1) {
    return [
      ...(messageText ? [{ type: "text", text: `${messageText}${/\s$/.test(messageText) ? "" : " "}` }] : []),
      { type: "link", text: fallbackLabel, href },
    ];
  }

  return [
    ...(linkIndex > 0 ? [{ type: "text", text: messageText.slice(0, linkIndex) }] : []),
    { type: "link", text: messageText.slice(linkIndex, linkIndex + inlineLinkText.length) || inlineLinkText, href },
    ...(linkIndex + inlineLinkText.length < messageText.length
      ? [{ type: "text", text: messageText.slice(linkIndex + inlineLinkText.length) }]
      : []),
  ];
}
