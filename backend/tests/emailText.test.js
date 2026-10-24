const { plainTextEmail } = require("../email/plainText");

test("styled email paragraphs retain separation and the usable action URL", () => {
  expect(plainTextEmail('<head><title>Hidden title</title><style>p{color:red}</style></head><p style="margin:0">Hello,</p><p class="body">Your file is ready.</p><a href="https://example.invalid/matter?a=1&amp;b=2"><strong>View file</strong></a>'))
    .toBe("Hello,\n\nYour file is ready.\n\nView file (https://example.invalid/matter?a=1&b=2)");
});

test("escaped submitted text stays literal while lists and line breaks remain readable", () => {
  expect(plainTextEmail('<p>&lt;Review&gt; &amp; confirm&#33;<br>Next line</p><ul><li>First</li><li>Second</li></ul>'))
    .toBe("<Review> & confirm!\nNext line\n\n• First\n\n• Second");
});

test("existing multiline text, readable addresses and Unicode are preserved", () => {
  expect(plainTextEmail('<p>First paragraph\n\nSecond paragraph</p><a href="mailto:help@example.invalid">Contact support</a><p>Let&rsquo;s connect &#x2014; &#128075;</p>'))
    .toBe("First paragraph\n\nSecond paragraph\n\nContact support (mailto:help@example.invalid)\n\nLet’s connect — 👋");
  expect(plainTextEmail('<a href="https://example.invalid">https://example.invalid</a>')).toBe("https://example.invalid");
  expect(plainTextEmail(null)).toBe("");
  expect(() => plainTextEmail("&#99999999;")).not.toThrow();
});
