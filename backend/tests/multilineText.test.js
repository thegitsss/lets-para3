const { cleanText, cleanMessage, cleanTitle, cleanPlainText } = require('../utils/sanitize');

test.each(['\n', '\r\n', '\r'])('multiline text preserves paragraphs and separates tabbed words with %j line endings', ending => {
  const value = `  First paragraph.${ending}${ending}Second paragraph.${ending}\tItem one\tItem two  `;
  const expected = 'First paragraph.\n\nSecond paragraph.\nItem one Item two';
  expect(cleanText(value)).toBe(expected);
  expect(cleanMessage(value)).toBe(expected);
});

test('multiline text removes markup and non-text controls while retaining meaningful line breaks', () => {
  expect(cleanText('<strong>Review</strong>\u0000 the scope.\n\nKeep\u0007 the references.\u007f')).toBe('Review the scope.\n\nKeep the references.');
  expect(cleanText('<a<b>done')).toBe('done');
  expect(cleanText('<'.repeat(20000))).toBe('<'.repeat(10000));
});

test('single-line titles and explicitly flat text retain their existing whitespace behavior', () => {
  const value = '  <b>Discovery</b>\r\n\r\nresponses\tand exhibits  ';
  expect(cleanTitle(value)).toBe('Discovery responses and exhibits');
  expect(cleanText(value, { allowNewlines: false })).toBe('Discovery responses and exhibits');
});

test('multiline plain-text fields retain literal markup-shaped text and existing spaces', () => {
  expect(cleanPlainText('  Compare <draft> to <final>.\r\n\r\nKeep  both\tversions.\u0000  ')).toBe('Compare <draft> to <final>.\n\nKeep  both versions.');
  expect(cleanPlainText('First\n\nSecond', { max: 9 })).toBe('First\n\nSe');
});

test('text limits include preserved line breaks and reject non-text values without coercion', () => {
  expect(cleanMessage('First\n\nSecond', 9)).toBe('First\n\nSe');
  expect(cleanText('First\n\nSecond', { max: 9 })).toBe('First\n\nSe');
  for (const value of [null, undefined, {}, 42]) expect(cleanText(value)).toBe('');
});
