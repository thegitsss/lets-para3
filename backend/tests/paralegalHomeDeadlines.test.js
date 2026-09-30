const { execFileSync } = require("child_process");
const { pathToFileURL } = require("url");
const path = require("path");
const url = name => pathToFileURL(path.resolve(__dirname, `../../frontend/assets/scripts/paralegal-v2/${name}.mjs`)).href;
function check(code) {
  execFileSync(process.execPath, ["--input-type=module", "--eval", `
    import assert from 'node:assert/strict';
    import { loadHomeDeadlines as load } from ${JSON.stringify(url("home-deadlines"))};
    import { deadlineTimelineRange as rangeFor } from ${JSON.stringify(url("home-timeline"))};
    const owner='a'.repeat(24), other='b'.repeat(24), range={start:'2026-08-01',end:'2027-02-01'};
    const event=(n,patch={})=>({id:n.toString(16).padStart(24,'0'),owner,type:'deadline',start:'2026-09-10T12:00:00.000Z',isAllDay:true,...patch});
    const response=(items,page=1,total=items.length)=>({ownerId:owner,page,limit:200,total,pages:Math.ceil(total/200),items});
    ${code}
  `], { encoding: "utf8" });
}

test("loads every stable page including reminders beyond the former default window", () => check(`
  const items=Array.from({length:403},(_,n)=>event(n+1,{start:n<402?'2026-09-10T12:00:00.000Z':'2027-01-30T12:00:00.000Z'}));
  const calls=[];const api={get:async href=>{const q=new URL(href,'https://local.test').searchParams;calls.push(q);const page=Number(q.get('page'));return response(items.slice((page-1)*200,page*200),page,403);}};
  const value=await load(api,owner,range);assert.equal(value.items.length,403);assert.equal(value.pagesRead,3);assert.equal(value.recordsRead,403);assert.deepEqual(value.range,range);
  assert.deepEqual(calls.map(q=>q.get('page')),['1','2','3']);assert.ok(calls.every(q=>q.get('expectedOwnerId')===owner&&q.get('type')==='deadline'&&q.get('from')==='2026-08-01T00:00:00.000Z'&&q.get('to')==='2027-02-01T23:59:59.999Z'));
`));
test("keeps UTC all-day dates and New York timed dates at both calendar boundaries", () => check(`
  const items=[event(1,{start:'2026-08-01T03:59:59Z',isAllDay:false}),event(2,{start:'2026-08-01T04:00:00Z',isAllDay:false}),event(3,{start:'2027-02-01T00:00:00Z',isAllDay:true}),event(4,{start:'2027-02-01T04:59:59Z',isAllDay:false}),event(5,{start:'2027-02-01T05:00:00Z',isAllDay:false})];
  const value=await load({get:async()=>response(items)},owner,range);assert.deepEqual(value.items.map(x=>x.id),[items[1].id,items[3].id]);assert.equal(value.total,2);assert.equal(value.recordsRead,5);
`));
test("rejects incomplete, duplicate, changed, unordered and wrong-account pages", () => check(`
  const rows=Array.from({length:201},(_,n)=>event(n+1));
  for(const corrupt of [r=>({...r,ownerId:other}),r=>({...r,total:202}),r=>({...r,items:[]}),r=>({...r,items:[rows[0]]}),r=>({...r,items:[event(300,{owner:other})]}),r=>({...r,items:[event(202,{start:'2026-08-02'})]})]) {
    const api={get:async href=>new URL(href,'https://local.test').searchParams.get('page')==='1'?response(rows.slice(0,200),1,201):corrupt(response(rows.slice(200),2,201))};
    await assert.rejects(load(api,owner,range),/could not be verified/);
  }
`));
test("a failed later page and account departure never return a partial success", () => check(`
  const rows=Array.from({length:200},(_,n)=>event(n+1));let calls=0;
  await assert.rejects(load({get:async()=>{if(++calls===1)return response(rows,1,201);throw new Error('Network unavailable');}},owner,range),/Network unavailable/);assert.equal(calls,2);
  let current=true;await assert.rejects(load({get:async()=>{current=false;return response([]);}},owner,range,{isCurrent:()=>current}),{name:'AbortError'});
  const control=new AbortController();control.abort();await assert.rejects(load({get:async()=>assert.fail('No request after abort')},owner,range,{signal:control.signal}),{name:'AbortError'});
`));
test("validates empty responses and range input without inventing no reminders", () => check(`
  assert.equal((await load({get:async()=>response([])},owner,range)).items.length,0);
  await assert.rejects(load({get:async()=>({items:[]})},owner,range),/could not be verified/);
  for(const bad of [{start:'2026-02-30',end:'2026-03-30'},{start:'2026-10-01',end:'2026-01-01'},{}]) await assert.rejects(load({get:async()=>assert.fail('Invalid range queried')},owner,bad),/could not be verified/);
`));
test("six-month periods preserve year, leap-day and quarter-navigation boundaries", () => check(`
  assert.deepEqual([rangeFor('2026-12-31',0,6).start,rangeFor('2026-12-31',0,6).end],['2026-11-01','2027-05-01']);
  const next=rangeFor('2026-12-31',1,6);assert.equal(next.start,'2027-02-01');assert.equal(next.end,'2027-08-01');assert.equal(next.months.length,6);
  assert.equal(rangeFor('2028-02-29',0,6).start,'2028-01-01');assert.equal(rangeFor('2028-02-29',-1,6).start,'2027-10-01');assert.equal(rangeFor('2028-02-29').months.length,3);
`));
