const { letterEmail, button } = require('../email/layout');

test('wrapping is idempotent and does not nest complete HTML documents', () => {
  const html = letterEmail('<p>Hello.</p>');
  expect(letterEmail(html)).toBe(html);
  const full = letterEmail('<html><head><title>Previous</title></head><body><p>Hello.</p></body></html>');
  expect(full.match(/<html /g)).toHaveLength(1);
  expect(full).toContain('<p style="margin:0 0 16px;font-size:16px;line-height:1.6;">Hello.</p>');
});
test('buttons keep white text and escape token query delimiters', () => {
  const html = letterEmail(button('https://example.test/reset?token=abc&other=xyz', 'Reset'));
  expect(html).toContain('token=abc&amp;other=xyz');
  expect(html).toMatch(/data-lpc-action="true"[^>]*color:#ffffff/);
});
test('action links become buttons while inline and unsubscribe links stay links', () => {
  const html = letterEmail('<p><a href="https://example.test/matter?id=1&amp;tab=files">Review files</a></p><p>Questions? <a href="mailto:help@example.test">Contact us</a>.</p><p><a href="https://example.test/unsubscribe?token=abc">Unsubscribe</a></p>');
  expect(html.match(/bgcolor="#507bc5"/g)).toHaveLength(1);
  expect(html).toContain('matter?id=1&amp;tab=files');
  expect(html).toContain('unsubscribe?token=abc');
  expect(html).toContain('mailto:help@example.test');
});
test('plain text and whitespace-sensitive messages remain readable', () => {
  expect(letterEmail('Hello\nSecond line')).toContain('Hello<br>Second line');
  expect(letterEmail('<p style="white-space:pre-wrap">Hello\nSecond line</p>')).toContain('white-space:pre-wrap');
});
