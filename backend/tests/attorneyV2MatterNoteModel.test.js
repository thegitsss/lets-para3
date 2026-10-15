const { execFileSync } = require("child_process"), { pathToFileURL } = require("url"), path = require("path");
const url = (name) => pathToFileURL(path.resolve(__dirname, `../../frontend/assets/scripts/attorney-v2/${name}.mjs`)).href;
const check = (source) => { execFileSync(process.execPath, ["--input-type=module", "--eval", `import assert from 'node:assert/strict'; import * as m from ${JSON.stringify(url("matter-note-model"))}; import {createPrivateState} from ${JSON.stringify(url("private-state"))}; ${source}`], { stdio: "pipe" }); };
test("lost-save recovery keeps later typing and a deliberate undo to the original text", () => check(`
  for(const edit of ['Later text','Original']) { const draft=m.noteDraft({note:'Original',revision:'a'.repeat(64)}); m.editNote(draft,'Submitted');draft.sent={note:'Submitted',revision:draft.revision};draft.uncertain=true;m.editNote(draft,edit);assert.equal(m.reconcileNote(draft,{note:'Submitted',revision:'b'.repeat(64)}),'confirmed');assert.equal(draft.note,edit);assert.equal(draft.baseline,'Submitted');assert.equal(draft.dirty,true); }
`));
test("same revision permits explicit retry; changed server note requires conflict review", () => check(`
  const draft=m.noteDraft({note:'Original',revision:'a'.repeat(64)});m.editNote(draft,'Edited');draft.uncertain=true;draft.sent={note:'Edited',revision:draft.revision};assert.equal(m.reconcileNote(draft,{note:'Original',revision:draft.revision}),'retained');assert.equal(draft.uncertain,false);assert.equal(draft.dirty,true);const remote={note:'Admin feedback',revision:'b'.repeat(64)};assert.equal(m.reconcileNote(draft,remote),'conflict');assert.equal(draft.note,'Edited');m.adoptNote(draft,remote,true);assert.equal(draft.baseline,'Admin feedback');assert.equal(draft.note,'Edited');
`));
test("private notes trigger unsaved protection and are erased at the account boundary", () => check(`
  const state=createPrivateState();state.matterNotes.set('case',{note:'PRIVATE',uncertain:true});assert.equal(state.hasUnsaved(),true);state.clear();assert.equal(state.matterNotes.size,0);assert.equal(state.hasUnsaved(),false);
`));
test("a response for another Matter or malformed revision cannot replace the note", () => check(`
  assert.throws(()=>m.readMatterNote({caseId:'other',note:'Private',revision:'a'.repeat(64)},'this'));assert.throws(()=>m.readMatterNote({caseId:'this',note:'Private',revision:'bad'},'this'));assert.equal(m.readMatterNote({caseId:'this',note:'x'.repeat(10001),revision:'a'.repeat(64)},'this').note.length,10001);
`));
