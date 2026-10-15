const { execFileSync } = require('child_process'), { pathToFileURL } = require('url'), path = require('path');
const url = pathToFileURL(path.resolve(__dirname, '../../frontend/assets/scripts/utils/availability-save.mjs')).href;
function check(code) {
  execFileSync(process.execPath, ['--input-type=module', '--eval', `import assert from 'node:assert/strict'; import {availabilitySnapshot,saveAvailability} from ${JSON.stringify(url)};
  const ownerId='a'.repeat(24),user={id:ownerId,role:'paralegal',status:'approved'};
  const profile={availability:'Available now',availabilityDetails:{status:'available',nextAvailable:null,updatedAt:'2026-09-01T12:00:00Z'}};
  const saved={ownerId,availability:'Unavailable',availabilityDetails:{status:'unavailable',nextAvailable:null,updatedAt:'2026-09-14T12:00:00Z'}};
  let writes=[],reads=0;const api={get:async()=>{reads++;return {user};},post:async(path,body)=>{writes.push({path,body});return saved;}};
  const input={ownerId,profile,status:'unavailable',nextAvailable:null};${code}`], { stdio: ['pipe','pipe','pipe'] });
}
test('save sends the exact displayed precondition and returns only the confirmed owner receipt', () => check(`
  const result=await saveAvailability(api,input);assert.equal(reads,2);assert.equal(writes.length,1);
  assert.deepEqual(writes[0],{path:'/api/paralegals/update-availability',body:{expectedOwnerId:ownerId,expectedValues:{availability:profile},status:'unavailable',nextAvailable:null}});
  assert.deepEqual(result,{availability:saved.availability,availabilityDetails:saved.availabilityDetails});assert.equal(profile.availabilityDetails.status,'available');
`));
test('an unknown profile or replaced account is refused before a write', () => check(`
  await assert.rejects(saveAvailability(api,{...input,profile:{}}),{code:'AVAILABILITY_UNCONFIRMED'});assert.equal(writes.length,0);
  user.id='b'.repeat(24);await assert.rejects(saveAvailability(api,input),{code:'ACCOUNT_CHANGED'});assert.equal(writes.length,0);
`));
test('an account change or view departure while saving cannot commit a client success', () => check(`
  api.post=async()=>{user.id='b'.repeat(24);return saved;};await assert.rejects(saveAvailability(api,input),{code:'ACCOUNT_CHANGED'});
  user.id=ownerId;let current=true;api.post=async()=>{current=false;return saved;};await assert.rejects(saveAvailability(api,{...input,isCurrent:()=>current}),{name:'AbortError'});
`));
test('empty, wrong-owner and malformed successful responses are never replaced by submitted values', () => check(`
  for(const value of [null,{}, {...saved,ownerId:'b'.repeat(24)}, {...saved,availabilityDetails:{status:'available'}}, {...saved,availabilityDetails:{...saved.availabilityDetails,nextAvailable:'2026-02-30'}}]) {
    api.post=async()=>value;await assert.rejects(saveAvailability(api,input),{code:'AVAILABILITY_UNCONFIRMED'});
  }
`));
test('server-effective availability is accepted even when a return date takes effect immediately', () => check(`
  api.post=async()=>({...saved,availability:'Available now',availabilityDetails:{...saved.availabilityDetails,status:'available',nextAvailable:null}});
  assert.equal((await saveAvailability(api,{...input,nextAvailable:'2026-09-14'})).availabilityDetails.status,'available');
`));
test('conflict codes survive the shared API error envelope and failed saves are not repeated', () => check(`
  let attempts=0;api.post=async()=>{attempts++;throw Object.assign(new Error('Review newer values'),{payload:{code:'ACCOUNT_CONFLICT'}});};
  await assert.rejects(saveAvailability(api,input),{code:'ACCOUNT_CONFLICT'});assert.equal(attempts,1);
`));
