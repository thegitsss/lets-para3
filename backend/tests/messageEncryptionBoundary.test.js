const crypto = require("crypto");
const previous = process.env.DATA_ENCRYPTION_KEY;
let encryption;
beforeEach(() => { process.env.DATA_ENCRYPTION_KEY = crypto.randomBytes(32).toString("hex"); jest.resetModules(); encryption = require("../utils/dataEncryption"); });
afterAll(() => { if (previous === undefined) delete process.env.DATA_ENCRYPTION_KEY; else process.env.DATA_ENCRYPTION_KEY = previous; });

test.each(["enc:v1:plain legal notes", "enc:v1:" + Buffer.alloc(40).toString("base64"), "historical plaintext", "New confidential content"])("marker-looking input and ordinary text round-trip: %s", (text) => {
 const encrypted = encryption.encryptString(text);
 expect(encrypted).not.toBe(text);
 expect(encryption.decryptString(encrypted)).toBe(text);
});
test("stored authenticated ciphertext remains stable; explicit plaintext cannot bypass encryption", () => {
 const encrypted = encryption.encryptString("Confidential");
 expect(encryption.encryptString(encrypted)).toBe(encrypted);
 const wrapped = encryption.encryptString(encrypted, { plaintext: true });
 expect(wrapped).not.toBe(encrypted);
 expect(encryption.decryptString(wrapped)).toBe(encrypted);
});
test("corrupt authenticated payload fails closed on reads", () => {
 const encrypted = encryption.encryptString("Confidential");
 const payload = Buffer.from(encrypted.slice(7), "base64"); payload[15] ^= 1;
 expect(() => encryption.decryptString("enc:v1:" + payload.toString("base64"))).toThrow();
});
test("nested legacy attachment variants are encrypted and read without mutating stored input", () => {
 const doc = { text: "Private", content: { files: [{ fileName: "Evidence.pdf", fileKey: "cases/one/doc.pdf" }, { originalName: "Prior.pdf", storageKey: "cases/one/prior.pdf" }, { name: "Other.pdf", key: "cases/one/other.pdf" }] } };
 encryption.encryptMessageFields(doc);
 for (const file of doc.content.files) for (const value of Object.values(file)) expect(encryption.isEncrypted(value)).toBe(true);
 const readable = encryption.decryptMessagePayload(doc);
 expect(readable.content.files[0]).toEqual({ fileName: "Evidence.pdf", fileKey: "cases/one/doc.pdf" });
 expect(readable.content.files[1].originalName).toBe("Prior.pdf");
 expect(readable.content.files[2].name).toBe("Other.pdf");
 expect(encryption.isEncrypted(doc.content.files[0].fileName)).toBe(true);
});
test("existing unmodified model fields are not reencrypted during unrelated saves", () => {
 const text = encryption.encryptString("Private");
 const doc = { text, isNew: false, isModified: () => false };
 encryption.encryptMessageFields(doc); expect(doc.text).toBe(text);
});
test("new model text treats even valid ciphertext as incoming plaintext", () => {
 const text = encryption.encryptString("Private");
 const doc = { text, isNew: true, isModified: () => true };
 encryption.encryptMessageFields(doc); expect(encryption.decryptString(doc.text)).toBe(text);
});

test.each(['enc:v1:', 'enc:v1:plain historical text', 'enc:v1:YWJj', 'enc:v1:!!!!'])('malformed stored envelope is never presented as readable text: %s', stored => {
 expect(() => encryption.decryptString(stored)).toThrow();
 const protectedInput = encryption.encryptString(stored, {plaintext:true});
 expect(encryption.decryptString(protectedInput)).toBe(stored);
});
test('noncanonical base64 cannot bypass envelope validation even with authentic ciphertext bytes',()=>{
 const encrypted=encryption.encryptString('Confidential canonical value');
 expect(()=>encryption.decryptString(encrypted.slice(0,10)+'!'+encrypted.slice(10))).toThrow();
});
