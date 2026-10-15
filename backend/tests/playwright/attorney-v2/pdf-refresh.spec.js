const { expect } = require('playwright/test');
const { test } = require('../workspace-search/shell-fixture');
for (const change of ['security', 'access']) test(`quiet refresh preserves an unchanged PDF preview and clears it after ${change} changes`, async ({ page }) => {
  await page.route('**/attorney-v2.html', route => route.fulfill({contentType:'text/html',body:'<!doctype html><html><body><button id="outside">Outside files</button><main></main></body></html>'}));
  await page.goto('/attorney-v2.html');
  await page.evaluate(async () => {
    Object.defineProperty(navigator,'pdfViewerEnabled',{value:true,configurable:true});
    const { createWorkspaceFiles } = await import('/assets/scripts/attorney-v2/workspace-files.mjs');
    const caseId='a'.repeat(24), ownerId='b'.repeat(24), fileId='c'.repeat(24);
    const file={id:fileId,name:'Agreement.pdf',revision:'d'.repeat(64),reviewRevision:'e'.repeat(64),mimeType:'application/pdf',size:40,version:1,uploadedAt:null,securityStatus:'clean',status:'pending_review',uploadedByRole:'attorney',notes:'',requestedAt:null,approvedAt:null,replacedAt:null,revisionOf:null,canReview:false};
    window.pdfRefresh={reads:0,change:null};
    const api={
      async readWorkspaceFiles(_id,{fileId:selected}) {
        window.pdfRefresh.reads++;
        if(window.pdfRefresh.change==='access')throw Object.assign(new Error('Participant access revoked'),{status:403});
        if(window.pdfRefresh.change==='security')file.securityStatus='blocked';
        return {caseId,ownerId,caseTitle:'Synthetic PDF review',access:'available',legacyAttachments:false,canUpload:false,files:[structuredClone(file)],nextCursor:null,selection:selected?'found':'none',selectedFile:selected?structuredClone(file):null};
      },
      async prepareMatterPdfPreview(){return 'about:blank';},
      async readWorkspaceUpload(){throw new Error('Upload outside this focused fixture');},
      async readWorkspaceFileHistory(){throw new Error('History outside this focused fixture');}
    };
    const panel=createWorkspaceFiles(caseId,{api,signal:new AbortController().signal,ownerId,route:{query:new URLSearchParams()},privateState:{fileReviews:new Map()}});
    document.querySelector('main').append(panel);await panel.readiness;
  });
  const panel=page.locator('[data-workspace-files]');
  await panel.getByRole('button',{name:'Agreement.pdf',exact:true}).click();
  await panel.getByRole('button',{name:'Preview file',exact:true}).click();
  await expect(panel.locator('iframe')).toHaveCount(1);
  await page.locator('#outside').focus();
  await page.evaluate(async()=>{window.originalPdfFrame=document.querySelector('iframe');await document.querySelector('[data-workspace-files]').sync();});
  expect(await page.evaluate(()=>window.pdfRefresh.reads)).toBe(2);
  expect(await page.evaluate(()=>window.originalPdfFrame.isConnected&&document.querySelector('iframe')===window.originalPdfFrame)).toBe(true);
  await page.evaluate(async change=>{window.pdfRefresh.change=change;await document.querySelector('[data-workspace-files]').sync();},change);
  await expect(panel.locator('iframe')).toHaveCount(0);
  if(change==='security')await expect(panel.getByRole('button',{name:'Preview file',exact:true})).toBeDisabled();
  else await expect(panel).toHaveAttribute('data-state','restricted');
});
