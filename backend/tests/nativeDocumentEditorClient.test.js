const { execFileSync } = require("child_process"), { pathToFileURL } = require("url"), path = require("path");
const moduleUrl = pathToFileURL(path.resolve(__dirname, "../../frontend/assets/scripts/connected-workspace/native-editor.mjs")).href;
function check(code) {
  execFileSync(process.execPath, ["--input-type=module", "--eval", `import assert from 'node:assert/strict';import {validateNativeEditorSession,readNativeEditorStatus} from ${JSON.stringify(moduleUrl)};
  const ownerId='a'.repeat(24),caseId='b'.repeat(24),fileId='c'.repeat(24),sessionId='d'.repeat(24);
  const value={sessionId,savedVersion:2,expiresAt:'2030-01-01T00:00:00Z',editorOrigin:'https://editor.test',scriptUrl:'https://editor.test/web-apps/apps/api/documents/api.js',config:{documentType:'word',document:{fileType:'docx',key:'synthetic-key'},editorConfig:{user:{id:ownerId}},token:'signed.synthetic.config'}};
  const context={ownerId,caseId,fileId,sessionId,minimumVersion:2};
  const state={ownerId,caseId,fileId,sessionId,savedVersion:2,state:'open',saveRequest:null};${code}`], { stdio: ["pipe", "pipe", "pipe"] });
}
test("native editor executes only the exact signed provider origin and refuses account substitution", () => check(`
  assert.equal(validateNativeEditorSession(value,ownerId,'https://lpc.test').editorOrigin,'https://editor.test');
  for(const scriptUrl of ['https://other.test/web-apps/apps/api/documents/api.js','https://editor.test/other.js','http://editor.test/web-apps/apps/api/documents/api.js','https://editor.test/web-apps/apps/api/documents/api.js?unexpected=1'])assert.throws(()=>validateNativeEditorSession({...value,scriptUrl},ownerId,'https://lpc.test'));
  assert.throws(()=>validateNativeEditorSession(value,'e'.repeat(24),'https://lpc.test'));
`));
test("native saved-version reads refuse stale versions, changed object scope and incomplete confirmations", () => check(`
  assert.deepEqual(readNativeEditorStatus(state,context),state);
  for(const patch of [{ownerId:'e'.repeat(24)},{ownerId:undefined},{fileId:'e'.repeat(24)},{savedVersion:1},{state:'success'},{saveRequest:{id:'0'.repeat(36),state:'confirmed',version:3}},{saveRequest:{id:'0'.repeat(36),state:'confirmed',version:null}}])assert.throws(()=>readNativeEditorStatus({...state,...patch},context));
`));
test("only backend-confirmed correlated receipts carry a confirmed version", () => check(`
  const request={id:'1'.repeat(36),state:'unknown',version:null};
  assert.equal(readNativeEditorStatus({...state,saveRequest:request},context).saveRequest.state,'unknown');
  assert.equal(readNativeEditorStatus({...state,saveRequest:{...request,state:'confirmed',version:2}},context).saveRequest.version,2);
`));
