"use strict";
// Independently runnable policy/parser checks. They do not require Mongo,
// provider credentials, confidential files, or a live third-party service.
jest.mock("../ai/config", () => ({ getOpenAIClient: () => null, createStructuredResponse: jest.fn(), isAiEnabled: () => false }));
const service = require("../services/connectedWorkspace/preparation");
const matching = require("../services/connectedWorkspace/matching");
const oid = "0123456789abcdef01234567";
function minimalPdf(text) {
  const stream = "BT /F1 12 Tf 50 750 Td (" + text + ") Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Length " + Buffer.byteLength(stream) + " >>\nstream\n" + stream + "\nendstream",
  ];
  let output = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(output)); output += (index + 1) + " 0 obj\n" + object + "\nendobj\n"; });
  const xref = Buffer.byteLength(output);
  output += "xref\n0 6\n0000000000 65535 f \n";
  for (const offset of offsets.slice(1)) output += String(offset).padStart(10, "0") + " 00000 n \n";
  output += "trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n" + xref + "\n%%EOF\n";
  return Buffer.from(output);
}
async function minimalDocx(text) {
  const { ZipArchive } = require("archiver");
  const archive = new ZipArchive();
  const chunks = [];
  const ended = new Promise((resolve, reject) => { archive.on("data", chunk => chunks.push(chunk)); archive.on("end", () => resolve(Buffer.concat(chunks))); archive.on("error", reject); });
  archive.append('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>', { name: "[Content_Types].xml" });
  archive.append('<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>' + text + '</w:t></w:r></w:p></w:body></w:document>', { name: "word/document.xml" });
  await archive.finalize();
  return ended;
}
test("literal document citations preserve stable file, version and actual page references", () => {
  const sources = [{ sourceId: "doc:p7", name: "Synthetic.pdf", fileId: oid, version: 3, page: 7, text: "The appointment is March 3, 2026." }];
  const output = service.validateProposal({ summary: "An unsupported summary should never be displayed", items: [{ title: "Review appointment date", citations: [{ sourceId: "doc:p7", quote: "March 3, 2026" }] }], questions: [], observations: [] }, sources);
  expect(output).not.toHaveProperty("summary");
  expect(output.items[0].citations[0]).toMatchObject({ fileId: oid, version: 3, page: 7, name: "Synthetic.pdf" });
});
test.each([
  { sourceId: "unknown-source", quote: "March 3, 2026" },
  { sourceId: "known", quote: "April 3, 2026" },
])("unknown and nonliteral source references are rejected: %j", citation => {
  expect(() => service.validateProposal({ summary: "", items: [{ title: "Check date", citations: [citation] }], questions: [], observations: [] }, [{ sourceId: "known", text: "March 3, 2026" }])).toThrow(/linked reliably/);
});
test("a source-provided instruction cannot inject extra model output fields", () => {
  expect(() => service.validateProposal({ summary: "", items: [], questions: [], observations: [], releaseFunds: true }, [])).toThrow();
});
test("working checklist preparation requires a bounded strict request and unique-style identity", () => {
  expect(service.requestSchema.safeParse({ fileIds: [oid], requestId: "abcdabcd-abcd-abcd-abcd-abcdabcdabcd" }).success).toBe(true);
  expect(service.requestSchema.safeParse({ fileIds: new Array(9).fill(oid), requestId: "abcdabcd-abcd-abcd-abcd-abcdabcdabcd" }).success).toBe(false);
  expect(service.requestSchema.safeParse({ fileIds: [], requestId: "bad", autoAccept: true }).success).toBe(false);
});
test("a new paralegal assignment gets a different access partition", () => {
  const baseline = { attorney: oid, paralegal: "1123456789abcdef01234567", hiredAt: "2026-01-01" };
  expect(service.assignmentKey(baseline)).not.toBe(service.assignmentKey({ ...baseline, paralegal: "2123456789abcdef01234567" }));
  expect(service.assignmentKey(baseline)).not.toBe(service.assignmentKey({ ...baseline, hiredAt: "2026-02-01" }));
});
test("scope fingerprints include authoritative calendar deadlines and text beyond model input limits", () => {
  const baseline = { attorney: oid, paralegal: "1123456789abcdef01234567", hiredAt: "2026-01-01", title: "Synthetic", details: "A".repeat(19000), tasks: [], deadlineDate: "2026-03-03" };
  expect(service.scopeHash(baseline)).not.toBe(service.scopeHash({ ...baseline, deadlineDate: "2026-03-04" }));
  expect(service.scopeHash(baseline)).not.toBe(service.scopeHash({ ...baseline, details: baseline.details + "Changed tail" }));
});
test("professional evidence omits private resume, contact, financial and matter contents", () => {
  const value = { bio: "Discovery preparation", skills: ["Clio"], practiceAreas: ["Litigation"], experience: [{ title: "Paralegal", description: "Prepared chronologies." }], email: "PRIVATE@example.test", resumeURL: "PRIVATE-RESUME", phoneNumber: "PRIVATE-PHONE", stripeAccountId: "PRIVATE-STRIPE", matters: ["PRIVATE-MATTER"] };
  const serialized = JSON.stringify(matching.evidenceFields(value));
  expect(serialized).toContain("Discovery preparation");
  expect(serialized).not.toContain("PRIVATE");
  expect(matching.evidenceFields(value).every(row => row.evidenceType === "self_reported")).toBe(true);
});
test("related-term retrieval cites the actual profile statement rather than inventing a qualification", () => {
  const result = matching.lexicalScore("Prepare a chronology", { bio: "I build litigation timelines.", skills: [], practiceAreas: [] });
  expect(result.score).toBeGreaterThan(0);
  expect(result.evidence[0].text).toBe("I build litigation timelines.");
  expect(result.evidence[0].evidenceType).toBe("self_reported");
});
test("semantic similarity rejects malformed vectors and has a bounded interpretable result", () => {
  expect(matching.cosine([1, 0], [1, 0])).toBeCloseTo(1);
  expect(matching.cosine([1, 0], [0, 1])).toBeCloseTo(0);
  expect(matching.cosine([0, 0], [0, 0])).toBe(0);
  expect(matching.cosine([1], [1, 2])).toBe(0);
  expect(matching.cosine([NaN, 1], [1, 0])).toBe(0);
});
test("matching rejects unsupported fields and unbounded filter values", () => {
  expect(matching.requestSchema.safeParse({ query: "discovery", privateResumes: true }).success).toBe(false);
  expect(matching.requestSchema.safeParse({ query: "discovery", minimumYears: -1 }).success).toBe(false);
  expect(matching.requestSchema.safeParse({ query: "discovery", requiredSkills: new Array(13).fill("Clio") }).success).toBe(false);
});
test("text extraction gives text sections rather than fabricated page numbers", async () => {
  const result = await service.extract(Buffer.from("First paragraph.\n\nSecond paragraph."), "txt");
  expect(result.pages).toEqual([{ page: null, section: 1, text: "First paragraph." }, { page: null, section: 2, text: "Second paragraph." }]);
});
test("real synthetic PDF extraction retains the document's page reference", async () => {
  const result = await service.extract(minimalPdf("Synthetic appointment March 3, 2026."), "pdf");
  expect(result.pages).toHaveLength(1);
  expect(result.pages[0].page).toBe(1);
  expect(result.pages[0].text).toContain("March 3, 2026");
});
test("real synthetic DOCX extraction yields text sections without claiming Word page fidelity", async () => {
  const result = await service.extract(await minimalDocx("Synthetic chronology instruction."), "docx");
  expect(result.pages[0]).toMatchObject({ page: null, section: 1 });
  expect(result.pages[0].text).toContain("Synthetic chronology instruction");
});
test.each(["pdf", "doc", "docx"])("malformed %s documents fail closed inside the bounded worker", async type => {
  await expect(service.extract(Buffer.from("Not a valid document"), type)).rejects.toMatchObject({ status: 422, publicCode: "PREPARATION_UNREADABLE" });
});
test("non-UTF8 and null-containing text are rejected rather than silently normalized", async () => {
  await expect(service.extract(Buffer.from([0xff, 0xfe, 0]), "txt")).rejects.toMatchObject({ status: 422 });
  await expect(service.extract(Buffer.from("A null\u0000inside"), "txt")).rejects.toMatchObject({ status: 422 });
});
