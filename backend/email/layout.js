// Shared, image-independent letter layout for LPC email. Body HTML must already
// be escaped by its producer; this is presentation, not an HTML sanitizer.
const BLUE = '#507bc5';
function escape(value = '') {
  return String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function button(url, label) {
  return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:18px 0;"><tr><td align="center" bgcolor="${BLUE}" style="border-radius:4px;"><a data-lpc-action="true" href="${escape(url)}" style="display:block;padding:13px 12px;color:#ffffff;font-size:16px;line-height:1.4;font-weight:600;text-decoration:none;">${escape(label)}</a></td></tr></table>`;
}
function styleBody(body) {
  return String(body)
    .replace(/<a\b([^>]*)>/gi, (_tag, attrs) => attrs.includes('data-lpc-action="true"') ? _tag : `<a${attrs.replace(/\sstyle="[^"]*"/gi, '')} style="color:${BLUE};text-decoration:underline;">`)
    .replace(/<div\b([^>]*)>/gi, (_tag, attrs) => {
      const style = attrs.match(/style="([^"]*)"/i)?.[1] || '';
      const retained = style.split(';').filter(v => /^\s*(margin(?:-top|-bottom|-left|-right)?|white-space|font-weight)\s*:/i.test(v)).join(';');
      const label = /font-size:\s*1[23]px/i.test(style);
      return `<div${attrs.replace(/\sstyle="[^"]*"/gi, '')} style="font-size:${label ? 14 : 16}px;line-height:1.6;${retained}">`;
    })
    .replace(/<p(\s[^>]*)?>/gi, (_tag, attrs = '') => {
      // Preserve whitespace-sensitive support messages and verification codes.
      const style = attrs.match(/style="([^"]*)"/i)?.[1] || '';
      const retained = style.split(';').filter(v => /^\s*(white-space|letter-spacing|font-weight)\s*:/i.test(v)).join(';');
      return `<p${attrs.replace(/\sstyle="[^"]*"/gi, '')} style="margin:0 0 16px;font-size:16px;line-height:1.6;${retained}">`;
    })
    .replace(/<p[^>]*>\s*(<a\b[^>]*>[^<]+<\/a>)\s*<\/p>/gi, (whole, anchor) => {
      const href = anchor.match(/href="([^"]*)"/i)?.[1];
      if (!href || !/^https?:/i.test(href) || /unsubscribe/i.test(anchor)) return whole;
      return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:18px 0;"><tr><td align="center" bgcolor="${BLUE}" style="border-radius:4px;">${anchor.replace(/\sstyle="[^"]*"/gi, '').replace('<a ', '<a style="display:block;padding:13px 12px;color:#ffffff;font-size:16px;line-height:1.4;font-weight:600;text-decoration:none;" ')}</td></tr></table>`;
    })
    .replace(/<a\b(?![^>]*\bstyle=)([^>]*)>/gi, `<a style="color:${BLUE};text-decoration:underline;"$1>`);
}
function letterEmail(body, { title = 'Let’s-ParaConnect', footer = '' } = {}) {
  if (String(body).includes('data-lpc-email="letter"')) return body;
  const documentBody = String(body).match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
  if (documentBody) body = documentBody[1];
  if (!/<[a-z][\s\S]*>/i.test(String(body))) body = `<p>${escape(body).replace(/\n/g, '<br>')}</p>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(title)}</title></head><body data-lpc-email="letter" style="margin:0;padding:0;background:#f6f8fa;font-family:Arial,Helvetica,sans-serif;color:#596579;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr><td align="center"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="#ffffff" style="max-width:640px;table-layout:fixed;overflow-wrap:anywhere;word-wrap:break-word;background:#ffffff;"><tr><td style="padding:32px 28px;">
<p style="margin:0 0 28px;padding:0 0 24px;border-bottom:1px solid #e3e7ed;color:${BLUE};font-family:Georgia,'Times New Roman',serif;font-size:23px;line-height:1.3;">Let’s-ParaConnect</p>
<div style="font-size:16px;line-height:1.6;">${styleBody(body)}</div>
<p style="margin:20px 0 0;padding:0 0 28px;border-bottom:1px solid #e3e7ed;font-size:16px;line-height:1.6;">— The LPC team</p>
${footer ? `<div style="margin-top:24px;font-size:13px;line-height:1.6;color:#667085;">${footer.replace(/<a\b([^>]*)>/gi, (_tag, attrs) => attrs.includes('data-lpc-action="true"') ? _tag : `<a${attrs.replace(/\sstyle="[^"]*"/gi, '')} style="color:${BLUE};text-decoration:underline;">`)}</div>` : ''}
</td></tr></table></td></tr></table></body></html>`;
}
module.exports = { letterEmail, button, escape, BLUE };
