// Convert LPC's generated email markup, preserving readable paragraphs and actions.
function plainTextEmail(html = '') {
  const decode = value => String(value).replace(/&(#x[0-9a-f]+|#\d+|nbsp|amp|lt|gt|quot|apos|rsquo|lsquo|rdquo|ldquo|mdash|ndash);/gi, (entity, name) => {
    const named = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", mdash: "—", ndash: "–" };
    if (name[0] !== '#') return named[name.toLowerCase()];
    const code = name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : Number(name.slice(1));
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : entity;
  });
  return decode(String(html || "")
    .replace(/<(head|script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi, (_match, attrs, label) => {
      const href = attrs.match(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
      const url = href?.[1] ?? href?.[2] ?? '';
      const text = label.replace(/<[^>]+>/g, '').trim();
      return /^(https?:|mailto:)/i.test(url) && decode(text) !== decode(url) ? `${text} (${url})` : text;
    })
    .replace(/<(?:p|div|section|h[1-6]|tr|table)\b[^>]*>/gi, '\n\n')
    .replace(/<br\b[^>]*>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n• ')
    .replace(/<\/(?:p|div|section|h[1-6]|tr|table)\s*>/gi, '\n\n')
    .replace(/<\/(?:li|td|th)\s*>/gi, '\n')
    .replace(/<[^>]+>/g, ''))
    .replace(/[ \t]+\n/g, '\n').replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n').trim();
}
module.exports = { plainTextEmail };
