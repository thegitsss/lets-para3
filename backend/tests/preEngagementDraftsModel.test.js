const { execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const moduleUrl = pathToFileURL(path.resolve(__dirname, '../../frontend/assets/scripts/utils/pre-engagement-drafts.mjs')).href;
function check(source) {
  execFileSync(process.execPath, ['--input-type=module', '--eval', `import assert from 'node:assert/strict'; import {createPreEngagementDrafts} from ${JSON.stringify(moduleUrl)};
let owner='owner-a', saved=0;const model=createPreEngagementDrafts({getOwner:()=>owner,onSaved:()=>saved++});
const selection={caseId:'case-a',applicationId:''},pre={revision:7,status:'requested'};
${source}`], { stdio: 'pipe' });
}

test('a changed background revision preserves the pending decision and actual File until explicit review', () => check(`
const draft=model.get(selection,pre);draft.file=new File(['signed bytes'],'agreement.pdf');draft.confidentialityAcknowledged=true;draft.conflictsResponseType='disclosure';draft.conflictsDisclosureText='Private disclosure';draft.sending=true;
const reopened=model.get(selection,{...pre,revision:8});assert.equal(reopened,draft);assert.equal(reopened.requestPre.revision,7);assert.equal(await reopened.file.text(),'signed bytes');assert.equal(model.pending(selection),true);
draft.sending=false;draft.pending=true;assert.equal(model.get(selection,{...pre,revision:8}),draft);
draft.pending=false;const reviewed=model.get(selection,{...pre,revision:8});assert.notEqual(reviewed,draft);assert.equal(reviewed.confidentialityAcknowledged,false);assert.equal(reviewed.conflictsResponseType,'');assert.equal(reviewed.file,null);assert.equal(reviewed.conflictsDisclosureText,'Private disclosure');
`));

test('empty application IDs stay isolated by Matter while a replacement source shares the pending guard', () => check(`
const first=model.get(selection,pre);first.sending=true;const other=model.get({caseId:'case-b',applicationId:''},pre);assert.notEqual(first,other);assert.equal(model.pending({caseId:'case-b'}),false);assert.equal(model.pending({...selection,applicationId:'new-canonical-id'}),true);
`));

test('account loss followed by the same owner returning cannot revive an old completion or private draft', () => check(`
const first=model.get(selection,pre);first.file=new File(['private'],'private.pdf');first.conflictsDisclosureText='Private';let seen=0;model.observe(first,()=>seen++);model.clear();owner='owner-b';owner='owner-a';const replacement=model.get(selection,pre);model.saved(first,{status:'submitted',revision:8});model.notify(first);assert.equal(model.isCurrent(first),false);assert.equal(model.isCurrent(replacement),true);assert.equal(first.file,null);assert.equal(first.conflictsDisclosureText,'');assert.equal(seen,0);assert.equal(saved,0);assert.equal(replacement.savedPre,undefined);
`));

test('confirmed state remains attached through a temporary close and a newer request requires fresh acknowledgement', () => check(`
const draft=model.get(selection,pre);model.saved(draft,{status:'submitted',revision:8});assert.equal(saved,1);assert.equal(model.hasDrafts(),false);assert.equal(model.get(selection,pre).savedPre.status,'submitted');assert.equal(model.get(selection,{...pre,revision:8}).savedPre.status,'submitted');const revised=model.get(selection,{...pre,revision:9});assert.equal(revised.savedPre,undefined);assert.equal(revised.requestRevision,9);assert.equal(revised.confidentialityAcknowledged,false);
`));

test('a detached observer is discarded and the reopened observer receives the pending completion', () => check(`
const draft=model.get(selection,pre);let old=0,current=0;model.observe(draft,()=>{old++;return false;});model.observe(draft,()=>{current++;return true;});model.notify(draft);model.notify(draft);assert.equal(old,1);assert.equal(current,2);
`));
