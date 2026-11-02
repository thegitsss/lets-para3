"use strict";
const { parentPort, workerData } = require("node:worker_threads");
const { createRequire } = require("node:module");
const MAX_TEXT = 180000;
function inspectDocx(buffer) {
  const wordRequire = createRequire(require.resolve("word-extractor"));
  return new Promise((resolve, reject) => {
    wordRequire("yauzl").fromBuffer(buffer, { lazyEntries: true, validateEntrySizes: true, strictFileNames: true }, (error, zip) => {
      if (error) return reject(error);
      let count = 0, size = 0, document = false, types = false, ended = false;
      function fail() { if (ended) return; ended = true; zip.close(); reject(new Error("Invalid document")); }
      zip.on("error", fail);
      zip.on("entry", entry => {
        count++; size += entry.uncompressedSize;
        if (count > 1500 || size > 40 * 1024 * 1024 || (entry.generalPurposeBitFlag & 1) || /vbaProject\.bin$/i.test(entry.fileName)) return fail();
        if (entry.fileName === "word/document.xml") document = true;
        if (entry.fileName === "[Content_Types].xml") types = true;
        zip.readEntry();
      });
      zip.on("end", () => { if (!ended) { ended = true; document && types ? resolve() : reject(new Error("Invalid document")); } });
      zip.readEntry();
    });
  });
}
(async () => {
  let pdf;
  try {
    const buffer = Buffer.from(workerData.buffer), type = workerData.type;
    let pages = [];
    if (type === "pdf") {
      const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
      pdf = await getDocument({ data: new Uint8Array(buffer), isEvalSupported: false, useSystemFonts: false, disableFontFace: true, verbosity: 0, stopAtErrors: true }).promise;
      if (pdf.numPages > 80) throw new Error("Too many pages");
      let size = 0;
      for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
        const page = await pdf.getPage(pageNumber), content = await page.getTextContent();
        const text = content.items.map(item => typeof item.str === "string" ? item.str + (item.hasEOL ? "\n" : " ") : "").join("").trim();
        size += text.length;
        if (size > MAX_TEXT) throw new Error("Too much text");
        pages.push({ page: pageNumber, section: null, text });
      }
    } else {
      let text;
      if (type === "txt") text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
      else {
        if (type === "docx") await inspectDocx(buffer);
        if (type === "doc") require("../resumeOleHeaderGuard.cjs").assertBoundedOleHeader(buffer);
        const Extractor = require("word-extractor");
        const document = await new Extractor().extract(buffer), options = { filterUnicode: false };
        const sections = [document.getBody(options)];
        for (const [label, method] of [["Footnotes", "getFootnotes"], ["Endnotes", "getEndnotes"], ["Headers", "getHeaders"], ["Footers", "getFooters"], ["Text boxes", "getTextboxes"]]) {
          const value = document[method]?.(options);
          if (typeof value === "string" && value.trim()) sections.push(label + "\n" + value);
        }
        text = sections.join("\n\n").replace(/\r\n?/g, "\n");
      }
      if (text.includes("\0") || text.length > MAX_TEXT) throw new Error("Invalid text");
      pages = text.split(/\n\s*\n/).filter(text => text.trim()).map((text, index) => ({ page: null, section: index + 1, text: text.trim() }));
    }
    if (type !== "pdf" && !pages.some(page => page.text)) throw new Error("No readable text");
    parentPort.postMessage({ pages, needsOcr: type === "pdf" && pages.some(page => !page.text), unreadablePages: pages.filter(page => !page.text).map(page => page.page) });
  } catch { parentPort.postMessage({ error: true }); }
  finally { await pdf?.destroy(); }
})();
