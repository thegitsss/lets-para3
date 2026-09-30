const net = require("net");
const sendEmail = require("../utils/email");

let server;
let port;
let messages;
let rejectRecipients;
const sockets = new Set();

beforeAll(async () => {
  server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.setEncoding("utf8");
    socket.write("220 localhost LPC test SMTP\r\n");
    let buffer = "", data = false, message = [];
    socket.on("data", (chunk) => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf("\r\n")) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (data) {
          if (line === ".") {
            data = false;
            messages.push(message.join("\r\n"));
            message = [];
            socket.write("250 Message accepted\r\n");
          } else message.push(line.startsWith("..") ? line.slice(1) : line);
        } else if (/^EHLO|^HELO/.test(line)) socket.write("250 localhost\r\n");
        else if (/^MAIL FROM/.test(line)) socket.write("250 OK\r\n");
        else if (/^RCPT TO/.test(line)) socket.write(rejectRecipients ? "550 Recipient rejected\r\n" : "250 OK\r\n");
        else if (line === "DATA") { data = true; socket.write("354 End with dot\r\n"); }
        else if (line === "QUIT") socket.end("221 Goodbye\r\n");
        else socket.write("250 OK\r\n");
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  port = server.address().port;
});

beforeEach(() => {
  messages = [];
  rejectRecipients = false;
  process.env.EMAIL_DISABLE = "false";
});
afterEach(() => { process.env.EMAIL_DISABLE = "true"; });
afterAll(async () => {
  for (const socket of sockets) socket.destroy();
  if (server?.listening) await new Promise((resolve) => server.close(resolve));
});

function options(extra = {}) {
  return { smtp: { host: "127.0.0.1", port, secure: false }, from: "LPC <sender@example.invalid>", ...extra };
}

test("the actual mail transport delivers LPC HTML, text, attachments and safe headers to loopback SMTP", async () => {
  const result = await sendEmail("recipient@example.invalid", "Matter update\r\nBcc: injected@example.invalid", "<p>Document ready</p>", options({
    text: "Document ready",
    attachments: [{ filename: "receipt.txt", content: "receipt content" }],
    throwOnError: true,
  }));
  expect(result.accepted).toEqual(["recipient@example.invalid"]);
  expect(messages).toHaveLength(1);
  expect(messages[0]).toContain("Content-Type: multipart/mixed");
  expect(messages[0]).toContain("Document ready");
  expect(messages[0]).toContain("receipt.txt");
  expect(messages[0]).toMatch(/^Subject: Matter update[ \t]+Bcc: injected@example\.invalid\r?$/m);
  expect(messages[0]).not.toMatch(/^Bcc:/m);
});

test("SMTP rejection remains a failure for both error-return and throw-on-error callers", async () => {
  rejectRecipients = true;
  const result = await sendEmail("recipient@example.invalid", "Test", "<p>Test</p>", options());
  expect(result.error).toBe(true);
  await expect(sendEmail("recipient@example.invalid", "Test", "<p>Test</p>", options({ throwOnError: true }))).rejects.toMatchObject({ code: "EENVELOPE" });
  expect(messages).toHaveLength(0);
});

test("generated plain-text mail retains paragraph boundaries and the action destination", async () => {
  const result = await sendEmail("recipient@example.invalid", "File ready", '<p style="margin:0">Hello,</p><p class="body">Your file is ready.</p><a href="https://example.invalid/files/123">View file</a>', options({ throwOnError: true }));
  expect(result.accepted).toEqual(["recipient@example.invalid"]);
  expect(messages).toHaveLength(1);
  const plainPart = messages[0].split("Content-Type: text/plain")[1]?.split("Content-Type: text/html")[0];
  expect(plainPart).toBeDefined();
  const decoded = plainPart.replace(/=\r?\n/g, "").replace(/=([0-9A-F]{2})/gi, (_match, hex) => String.fromCharCode(parseInt(hex, 16)));
  expect(decoded).toContain("Hello,\r\n\r\nYour file is ready.\r\n\r\nView file (https://example.invalid/files/123)");
});
