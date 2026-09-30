const { execFileSync } = require('child_process');
const { pathToFileURL } = require('url');
const path = require('path');
const url = pathToFileURL(path.resolve(__dirname, '../../frontend/assets/scripts/legacy-paralegal-calendar.mjs')).href;
function check(code) {
  execFileSync(process.execPath, ['--input-type=module','--eval', `import assert from 'node:assert/strict'; import {calendarRows, calendarRange} from ${JSON.stringify(url)};
  const ownerId='a'.repeat(24),caseId='b'.repeat(24),eventId='c'.repeat(24),range=calendarRange('2026-09-08');
  const matter={caseId,paralegalId:ownerId,title:'Matter date',deadlineDate:'2026-09-10',status:'in progress',archived:false,paymentReleased:false,escrowStatus:'funded',escrowIntentId:'pi_synthetic'};
  const reminder={id:eventId,owner:ownerId,type:'deadline',title:'Private reminder',start:'2026-09-10',isAllDay:true};
  ${code}`], { stdio: ['pipe','pipe','pipe'] });
}
test('calendar combines sources without merging separate records that share a title or date', () => check(`
  const rows=calendarRows({matters:[matter,matter],reminders:[{...reminder,title:matter.title},reminder],ownerId,range});
  assert.equal(rows.length,2);assert.deepEqual(new Set(rows.map(r=>r.source)),new Set(['matter','event']));assert.equal(rows.find(r=>r.source==='matter').caseId,caseId);assert.equal(rows.find(r=>r.source==='event').caseId,'');
`));
test('calendar uses New York timed dates, exact seven-day boundaries and year rollover', () => check(`
  const dates=['2026-09-08T03:59:59Z','2026-09-08T04:00:00Z','2026-09-15T03:59:59Z','2026-09-15T04:00:00Z'];
  const rows=calendarRows({ownerId,range,reminders:dates.map((start,n)=>({...reminder,id:(n+1).toString(16).padStart(24,'0'),start,isAllDay:false}))});
  assert.deepEqual(rows.map(r=>r.start),['2026-09-08','2026-09-14']);assert.deepEqual(calendarRange('2026-12-29'),{start:'2026-12-29',end:'2027-01-05'});assert.throws(()=>calendarRange('2026-02-30'));
`));
test('foreign, revoked, finalized and inaccessible linked records do not appear as current work', () => check(`
  for(const patch of [{paralegalId:'d'.repeat(24)},{paralegalAccessRevokedAt:'2026-09-01'},{archived:true},{paymentReleased:true},{status:'completed'}]) {
    assert.deepEqual(calendarRows({ownerId,range,matters:[{...matter,...patch}],reminders:[{...reminder,caseId}]}),[]);
  }
  for(const patch of [{owner:'d'.repeat(24)},{type:'task'},{completed:true},{cancelled:true},{status:'closed'}]) assert.deepEqual(calendarRows({ownerId,range,reminders:[{...reminder,...patch}]}),[]);
  const rows=calendarRows({ownerId,range,matters:[{...matter,escrowStatus:'pending'}],reminders:[{...reminder,caseId}]});assert.equal(rows.length,2);assert.ok(rows.every(row=>!row.caseId));
`));
