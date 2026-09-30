const {resolveDeadline,normalizeDetails,explicitDeadlineCandidate}=require('../services/matterDraftDetails');
const today='2026-09-22';
test.each([
 ['april 1','2027-04-01'],['April 1, 2028','2028-04-01'],['Sep 22','2026-09-22'],
 ['September 21','2027-09-21'],['February 29','2028-02-29'],['February 30',''],
 ['April 31, 2027',''],['2027-04-01','2027-04-01'],['2027-02-29',''],
 ['this Wednesday','2026-09-23'],['next Wednesday','2026-09-23'],['tomorrow','2026-09-23'],
 ['in 10 days','2026-10-02'],['04/01',''],['sometime in April',''],
])('resolves %s without changing date-only semantics',(input,expected)=>expect(resolveDeadline(input,today)).toBe(expected));
test('weekday at year boundary resolves to the next calendar year',()=>expect(resolveDeadline('next Friday','2026-12-31')).toBe('2027-01-01'));
test('explicit past year is preserved rather than moved forward silently',()=>expect(resolveDeadline('April 1, 2025',today)).toBe('2025-04-01'));
test.each(['compensation is $500 per hour','compensation is 500-700','compensation is up to 500','compensation is 500 including fees','compensation is CAD 500','compensation is about 500'])('does not interpret %s as flat compensation',async source=>{
 expect(await normalizeDetails({compensation:{amount:'500',source}},source,{today})).toEqual({});
});
test('does not use trial event timing as a work deadline',async()=>{
 expect(await normalizeDetails({deadline:{text:'April 1',source:'trial on April 1'}},'Prepare docs for trial on April 1',{today})).toEqual({});
});
test('explicit values are normalized from source and quotes remain source-bound',async()=>{
 const brief='prep supporting docs for trial in ca. need by april 1. compensation is 500.';
 expect(await normalizeDetails({compensation:{amount:'500',source:'compensation is 500'},deadline:{text:'april 1',source:'need by april 1'},state:{text:'ca',source:'trial in ca'}},brief,{today})).toEqual({compAmount:'500.00',deadline:'2027-04-01',state:'California'});
 expect(await normalizeDetails({compensation:{amount:'1500',source:'compensation is 500'}},brief,{today})).toEqual({});
});
test('missing year uses this year when the date is still ahead',()=>expect(resolveDeadline('April 1','2026-03-01')).toBe('2026-04-01'));

test.each(['by april 1','need by april 1','deadline: April 1','due by April 1'])('resolves source-bound deadline phrase %s',text=>{
 expect(resolveDeadline(text,today)).toBe('2027-04-01');
});
test('recovers an explicit work deadline clause without depending on the generated detail',()=>{
 expect(explicitDeadlineCandidate('prep supporting docs for trial in ca. need by april 1. compensation is 500.')).toEqual({text:'april 1',source:'need by april 1'});
});
test.each(['Prepare docs for trial on April 1.','Do not need by April 1.','Need by April 1 or April 2.','Need by April 1. Need by April 2.','Need by around April 1.','Need by April 31.'])('does not recover ambiguous or unsupported deadline from %s',brief=>{
 expect(explicitDeadlineCandidate(brief)).toBeNull();
});

test('explicit minimum experience and mandatory qualifications populate supported fields',async()=>{
 const brief='At least 5 years experience required. Must know Clio. Excel preferred.';
 expect(await normalizeDetails({experience:{value:'5+ years',text:'5 years experience',source:'At least 5 years experience required'},requirements:[{text:'Clio',source:'Must know Clio'},{text:'Excel',source:'Excel preferred'}]},brief,{today})).toEqual({experience:'5+ years',requirements:['Clio']});
});
test.each([
 ['5 years experience preferred','5 years experience','5+ years'],
 ['At least 2 years experience required','2 years experience','3+ years'],
 ['No minimum experience required','No minimum experience','5+ years'],
])('does not strengthen or round experience: %s',async(source,text,value)=>{
 expect(await normalizeDetails({experience:{source,text,value}},source,{today})).toEqual({});
});
test('does not invent or strengthen requirements from unsupported quotes',async()=>{
 expect(await normalizeDetails({requirements:[{text:'Clio',source:'Must know Clio'},{text:'Excel',source:'Excel preferred'}]},'Excel preferred.',{today})).toEqual({});
});
