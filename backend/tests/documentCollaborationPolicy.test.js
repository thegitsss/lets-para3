const jwt = require("jsonwebtoken"), { Readable } = require("stream");
const editor = require("../services/connectedWorkspace/editor");
const secret = "synthetic-provider-secret-at-least-32-characters";
const settings = { secret, origin: "https://editor.synthetic.test" };
const signed = payload => jwt.sign(payload, secret, { algorithm: "HS256", expiresIn: "5m" });

test("provider configuration accepts HTTPS origins and local development, but refuses credentials, paths, and insecure production", () => {
  const env = { NODE_ENV: "production", ONLYOFFICE_DOCUMENT_SERVER_URL: "https://editor.synthetic.test", ONLYOFFICE_JWT_SECRET: secret, APP_BASE_URL: "https://lpc.synthetic.test", S3_BUCKET: "synthetic", JWT_SECRET: "app-secret" };
  expect(editor.configuration(env)).toMatchObject({ configured: true, origin: settings.origin, scriptUrl: `${settings.origin}/web-apps/apps/api/documents/api.js` });
  for (const server of ["http://editor.synthetic.test", "https://name:password@editor.synthetic.test", "https://editor.synthetic.test/subpath", "file:///etc/passwd", "https://editor.synthetic.test?token=secret"]) expect(editor.configuration({ ...env, ONLYOFFICE_DOCUMENT_SERVER_URL: server }).configured).toBe(false);
  expect(editor.configuration({ ...env, NODE_ENV: "development", ONLYOFFICE_DOCUMENT_SERVER_URL: "http://localhost:8080", APP_BASE_URL: "http://localhost:5050" }).configured).toBe(true);
  expect(editor.publicStatus({ ...env, ONLYOFFICE_JWT_SECRET: "" })).toMatchObject({ configured: false, formats: ["docx"] });
});
test("callback accepts documented signed body and header envelope formats and only returns signed values", () => {
  const payload = { key: "document-key", status: 6, url: `${settings.origin}/cache/a.docx`, users: ["known-user"] };
  expect(editor.verifiedCallback({ body: { token: signed(payload), url: "https://evil.test" } }, settings)).toMatchObject(payload);
  expect(editor.verifiedCallback({ headers: { authorization: `Bearer ${signed({ operation: "callback", payload })}` }, body: { status: 2, users: ["other-user"] } }, settings)).toEqual(payload);
});
test("an editor-config JWT, source JWT, wrong-purpose JWT, altered JWT, or unsigned callback cannot authorize saving", () => {
  const examples = [
    { body: { token: signed({ document: { key: "document-key" }, editorConfig: { mode: "edit" } }) } },
    { body: { token: signed({ purpose: "document-source", sid: "session-id", uid: "actor" }) } },
    { body: { token: signed({ operation: "download", key: "document-key", status: 2 }) } },
    { body: { token: signed({ key: "document-key", status: 2 }).slice(0, -5) + "xxxxx" } },
    { body: { key: "document-key", status: 2 } },
  ];
  for (const request of examples) expect(() => editor.verifiedCallback(request, settings)).toThrow(expect.objectContaining({ status: 403 }));
});
test.each(["https://other.test/a", "https://editor.synthetic.test:444/a", "https://editor.synthetic.test@other.test/a", "http://editor.synthetic.test/a", "https://editor.synthetic.test/a#fragment", "http://169.254.169.254/latest/meta-data"])("provider download allowlist rejects %s", url => {
  expect(() => editor.downloadUrl(url, settings)).toThrow();
});
test("provider download accepts only the exact configured origin", () => {
  expect(editor.downloadUrl("https://editor.synthetic.test/cache/a.docx?expires=123", settings)).toBe("https://editor.synthetic.test/cache/a.docx?expires=123");
});
test("bounded document reader enforces total bytes even without a content-length header", async () => {
  expect(await editor.boundedBuffer(Readable.from([Buffer.from("ab"), Buffer.from("cd")]), 4)).toEqual(Buffer.from("abcd"));
  await expect(editor.boundedBuffer(Readable.from([Buffer.from("abc"), Buffer.from("def")]), 4)).rejects.toMatchObject({ status: 413 });
  await expect(editor.boundedBuffer(Buffer.alloc(5), 4)).rejects.toMatchObject({ status: 413 });
  await expect(editor.boundedBuffer(Readable.from([]), 4)).rejects.toMatchObject({ status: 502 });
});
