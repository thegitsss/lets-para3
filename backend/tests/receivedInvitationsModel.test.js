const { execFileSync } = require('node:child_process'), { pathToFileURL } = require('node:url'), path = require('node:path');
const url = pathToFileURL(path.resolve(__dirname,'../../frontend/assets/scripts/utils/received-invitations.mjs')).href;
const check=source=>{execFileSync(process.execPath,['--input-type=module','--eval',`import assert from 'node:assert/strict';import * as m from ${JSON.stringify(url)};
const owner='a'.repeat(24),revision='b'.repeat(64),items=Array.from({length:105},(_,i)=>({id:(i+1).toString(16).padStart(24,'0'),title:'Invitation '+i,inviteStatus:'pending',inviteInvitedAt:null}));
const value=(offset=0)=>({ownerId:owner,revision,items:items.slice(offset,offset+50),page:{total:items.length,offset,limit:50,hasMore:offset+50<items.length,nextCursor:offset+50<items.length?revision+':'+(offset+50):null}});
const user={id:owner,role:'paralegal',status:'approved'};
${source}`],{stdio:'pipe'});};
test('the queue loads every verified page with exact unique records and verifies the account before returning',()=>check(`
 const calls=[];const api={get:async path=>{calls.push(path);return path==='/api/auth/me'?{user}:value(Number(new URL(path,'https://fixture.test').searchParams.get('cursor')?.split(':')[1]||0));}};
 const result=await m.loadReceivedInvitations(api,owner);assert.equal(result.items.length,105);assert.equal(calls.length,4);assert.equal(calls[0],'/api/cases/invited-to');assert.equal(calls[3],'/api/auth/me');assert.equal(new Set(result.items.map(item=>item.id)).size,105);
`));
test('missing page metadata wrong owner and incoherent counts dates membership and continuation fail closed',()=>check(`
 for(const patch of [{ownerId:'c'.repeat(24)},{page:null},{items:[]},{revision:'bad'},{page:{...value().page,total:0}},{page:{...value().page,nextCursor:revision+':0'}}])assert.throws(()=>m.readInvitationPage({...value(),...patch},owner));
 for(const patch of [{inviteStatus:'accepted'},{inviteInvitedAt:'invalid'},{id:'wrong'}])assert.throws(()=>m.readInvitationPage({...value(),items:[{...items[0],...patch},...items.slice(1,50)]},owner));
 assert.throws(()=>m.readInvitationPage({items:[]},owner));
`));
test('changed second pages and failed reads cannot return a partial invitation queue',()=>check(`
 for(const mode of ['changed','failed','duplicate']){let reads=0;const api={get:async path=>{if(++reads===1)return value();if(mode==='failed')throw new Error('Unavailable');const page=value(50);if(mode==='changed')page.revision='c'.repeat(64);else page.items[0]=items[0];return page;}};await assert.rejects(m.loadReceivedInvitations(api,owner));}
`));
test('view cancellation and an account switch withhold the accumulated private invitations',()=>check(`
 let current=true;await assert.rejects(m.loadReceivedInvitations({get:async()=>{current=false;return value();}},owner,{isCurrent:()=>current}),e=>e.name==='AbortError');
 const api={get:async path=>path==='/api/auth/me'?{user:{...user,id:'c'.repeat(24)}}:value(Number(new URL(path,'https://fixture.test').searchParams.get('cursor')?.split(':')[1]||0))};await assert.rejects(m.loadReceivedInvitations(api,owner),e=>e.status===403);
`));
