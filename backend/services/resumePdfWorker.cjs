'use strict';
const { parentPort, workerData } = require('node:worker_threads');
(async () => {
  let document;
  try {
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    document = await getDocument({ data: new Uint8Array(workerData), isEvalSupported: false, useSystemFonts: false, disableFontFace: true, verbosity: 0, stopAtErrors: true }).promise;
    if (document.numPages > 15) throw new Error();
    let text = '';
    for (let index = 1; index <= document.numPages; index++) {
      const page = await document.getPage(index);
      const { items } = await page.getTextContent();
      let lastY = null;
      for (const item of items) {
        if (typeof item.str !== 'string') continue;
        const y = item.transform?.[5];
        if (lastY !== null && y !== lastY) { const gap = Math.abs(y - lastY) > (item.height || 12) * 1.6; text += text.endsWith('\n') ? (gap ? '\n' : '') : (gap ? '\n\n' : '\n'); }
        text += item.str + (item.hasEOL ? '\n' : ' '); lastY = y;
        if (text.length > 100000) throw new Error();
      }
      text += '\n\n';
    }
    parentPort.postMessage({ text });
  } catch { parentPort.postMessage({ error: true }); }
  finally { await document?.destroy(); }
})();
