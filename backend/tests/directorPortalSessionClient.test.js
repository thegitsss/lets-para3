const { execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const moduleUrl = pathToFileURL(path.resolve(__dirname, '../../frontend/assets/scripts/utils/director-portal-session.mjs')).href;
const fixture = `
const owner='a'.repeat(24), other='b'.repeat(24), user={id:owner,role:'director',status:'approved'};
let stored=null, active=true, reads=0, creates=0, saves=[], lostSessions=0;
let currentRead=async()=>user;
const gate=createDirectorPortalSession({
 readCurrentUser:async()=>{reads++;return currentRead();},
 readSession:()=>({user:stored}),persistUser:value=>{saves.push(value);stored=value;},
 createAccount:()=>{creates++;const pinned=stored.id;return {ownerId:pinned,verify(payload){assert.equal(stored.id,pinned);if(payload)assert.equal(payload.ownerId,pinned);},url(path){return path+'?expectedOwnerId='+pinned;}};},
 isDocumentActive:()=>active,
 onConfirmedNoSession:()=>{lostSessions++;stored=null;}
});
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
`;
const run = source => void execFileSync(process.execPath, ['--input-type=module', '--eval', `import assert from 'node:assert/strict';import {createDirectorPortalSession} from ${JSON.stringify(moduleUrl)};${fixture}${source}`], { stdio: 'pipe' });

test('cookie-only entry establishes an approved Director from the current server response and keeps owner guards', () => run(`
 const account=await gate.authorize();assert.equal(reads,1);assert.equal(creates,1);assert.equal(account.ownerId,owner);
 assert.deepEqual(saves,[user]);assert.equal(account.url('/overview'),'/overview?expectedOwnerId='+owner);
 account.verify({ownerId:owner});assert.throws(()=>account.verify({ownerId:other}));
`));
test('cached Director identity cannot authorize a failed current session read', () => run(`
 stored=user;currentRead=async()=>{throw Object.assign(Error('Session expired'),{status:401});};
 await assert.rejects(gate.authorize(),error=>error.status===401);assert.equal(creates,0);assert.deepEqual(saves,[]);
`));
test('disabled deleted unapproved foreign-role and malformed current users never establish financial controls', () => run(`
 for(const change of [{disabled:true},{deleted:true},{status:'pending'},{status:''},{role:'attorney'},{role:'admin'},{role:'paralegal'},{id:'invalid'}]){
  currentRead=async()=>({...user,...change});await assert.rejects(gate.authorize(),error=>error.status===403);
 }
 currentRead=async()=>null;await assert.rejects(gate.authorize(),error=>error.status===403);assert.equal(creates,0);assert.deepEqual(saves,[]);
`));
test('a cached different owner cannot be replaced by a late approved current response', () => run(`
 stored={...user,id:other};await assert.rejects(gate.authorize(),error=>error.status===403);assert.equal(stored.id,other);assert.equal(creates,0);assert.deepEqual(saves,[]);
`));
test('same-tab cache removal owner change or admission change during verification rejects the response without overwriting', () => run(`
 for(const replacement of [null,{...user,id:other},{...user,status:'pending'},{...user,disabled:true}]){
  stored=user;const held=deferred();currentRead=()=>held.promise;const attempt=gate.authorize();stored=replacement;held.resolve(user);
  await assert.rejects(attempt,error=>error.status===403);assert.equal(stored,replacement);
 }assert.equal(creates,0);assert.deepEqual(saves,[]);
`));
test('a storage invalidation rejects even a same-value late response and permits a fresh explicit check', () => run(`
 const held=deferred();currentRead=()=>held.promise;const stale=gate.authorize();gate.invalidate();currentRead=async()=>user;
 const fresh=await gate.authorize();held.resolve(user);await assert.rejects(stale,error=>error.status===403);
 assert.equal(fresh.ownerId,owner);assert.equal(creates,1);assert.deepEqual(saves,[user]);
`));
test('overlapping refresh checks share the current read and do not create duplicate financial controls', () => run(`
 const held=deferred();currentRead=()=>held.promise;const first=gate.authorize(),second=gate.authorize();held.resolve(user);
 assert.equal(await first,await second);assert.equal(reads,1);assert.equal(creates,1);
 currentRead=async()=>user;assert.equal(await gate.authorize(),await first);assert.equal(reads,2);assert.equal(creates,1);
`));
test('a later server owner cannot rebind a financial page already pinned to the original owner', () => run(`
 await gate.authorize();stored=null;currentRead=async()=>({...user,id:other});
 await assert.rejects(gate.authorize(),error=>error.status===403);assert.equal(stored,null);assert.deepEqual(saves,[user]);assert.equal(creates,1);
`));
test('navigation before verification finishes cannot persist or create a financial account', () => run(`
 const held=deferred();currentRead=()=>held.promise;const attempt=gate.authorize();active=false;held.resolve(user);
 await assert.rejects(attempt,error=>error.status===403);assert.equal(creates,0);assert.deepEqual(saves,[]);
`));
test('every subsequent read or financial URL checks current approval and the pinned owner as well as server response ownership', () => run(`
 const account=await gate.authorize();
 for(const replacement of [null,{...user,id:other},{...user,role:'attorney'},{...user,status:'pending'},{...user,disabled:true},{...user,deleted:true}]){
  stored=replacement;assert.throws(()=>account.verify(),error=>error.status===403);assert.throws(()=>account.url('/audit'),error=>error.status===403);
 }stored=user;active=false;assert.throws(()=>account.verify(),error=>error.status===403);
`));
test('unconfirmed server failure has no cached fallback and a separate explicit fresh check can recover', () => run(`
 stored=user;currentRead=async()=>{throw Object.assign(Error('Unavailable'),{status:503});};
 await assert.rejects(gate.authorize(),error=>error.status===503);assert.equal(creates,0);assert.deepEqual(saves,[]);
 currentRead=async()=>user;assert.equal((await gate.authorize()).ownerId,owner);assert.equal(creates,1);
`));
test('a confirmed absent current session clears only the unchanged old owner and never establishes new financial controls', () => run(`
 stored=user;currentRead=async()=>null;
 await assert.rejects(gate.authorize(),error=>error.status===403);
 assert.equal(reads,2);assert.equal(lostSessions,1);assert.equal(stored,null);assert.equal(creates,0);assert.deepEqual(saves,[]);
`));
test('a late confirmed-null response cannot clear a switched owner same-value newer intent or leaving document', () => run(`
 for(const reason of ['owner','generation','document']){
  stored=user;active=true;const held=deferred();currentRead=()=>held.promise;const attempt=gate.authorize();
  if(reason==='owner')stored={...user,id:other};
  if(reason==='generation')gate.invalidate();
  if(reason==='document')active=false;
  held.resolve(null);await assert.rejects(attempt,error=>error.status===403);
  assert.equal(lostSessions,0);assert.equal(stored.id,reason==='owner'?other:owner);
 }assert.equal(creates,0);assert.deepEqual(saves,[]);
`));
test('a transport failure or missing user field does not assert session absence or erase the current owner', () => run(`
 stored=user;currentRead=async()=>{throw Object.assign(Error('Unavailable'),{status:503});};
 await assert.rejects(gate.authorize(),error=>error.status===503);assert.equal(stored,user);assert.equal(lostSessions,0);
 currentRead=async()=>undefined;await assert.rejects(gate.authorize(),error=>error.status===403);
 assert.equal(stored,user);assert.equal(lostSessions,0);assert.equal(creates,0);assert.deepEqual(saves,[]);
`));
test('a newer same-owner session after an old absent response is verified freshly and is not cleared', () => run(`
 stored=user;const held=deferred();let attemptNumber=0;
 currentRead=()=>++attemptNumber===1?held.promise:Promise.resolve(user);
 const attempt=gate.authorize();held.resolve(null);const account=await attempt;
 assert.equal(reads,2);assert.equal(lostSessions,0);assert.equal(stored.id,owner);assert.equal(account.ownerId,owner);
 account.verify({ownerId:owner});assert.equal(creates,1);assert.deepEqual(saves,[user]);
`));
test('failure of the fresh absence confirmation preserves the owner and cannot trigger sign-in cleanup', () => run(`
 stored=user;let attemptNumber=0;currentRead=async()=>{if(++attemptNumber===1)return null;throw Object.assign(Error('Confirmation unavailable'),{status:503});};
 await assert.rejects(gate.authorize(),error=>error.status===503);
 assert.equal(reads,2);assert.equal(stored,user);assert.equal(lostSessions,0);assert.equal(creates,0);assert.deepEqual(saves,[]);
 currentRead=async()=>user;assert.equal((await gate.authorize()).ownerId,owner);assert.equal(lostSessions,0);
`));
test('a late second absence confirmation is rejected after an owner or intent change before clearing any cache', () => run(`
 for(const reason of ['owner','generation','document']){
  stored=user;active=true;const held=deferred();let attemptNumber=0;
  currentRead=()=>++attemptNumber===1?Promise.resolve(null):held.promise;
  const attempt=gate.authorize();await new Promise(resolve=>setImmediate(resolve));assert.equal(attemptNumber,2);
  if(reason==='owner')stored={...user,id:other};if(reason==='generation')gate.invalidate();if(reason==='document')active=false;
  held.resolve(null);await assert.rejects(attempt,error=>error.status===403);
  assert.equal(lostSessions,0);assert.equal(stored.id,reason==='owner'?other:owner);
 }assert.equal(creates,0);assert.deepEqual(saves,[]);
`));
