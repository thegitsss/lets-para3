const {dateOnlyFromZonedInstant,parseDateOnlyParts,addCalendarDays}=require('../utils/businessDate');
const months=['january','february','march','april','may','june','july','august','september','october','november','december'];
const weekdays=['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
const normalize=value=>String(value||'').toLowerCase().replace(/\s+/g,' ').trim();
const contains=(source,quote)=>Boolean(quote&&normalize(source).includes(normalize(quote)));
function resolveDeadline(text,today=dateOnlyFromZonedInstant()){
 const value=normalize(text).replace(/[.,]$/,'').replace(/^(?:(?:need(?:ed)?|due|deliver|complete|finish|ready) by|deadline(?: is|:)?|by)\s+/, '');
 if(!parseDateOnlyParts(today))return '';
 if(/^\d{4}-\d{2}-\d{2}$/.test(value))return parseDateOnlyParts(value)?value:'';
 if(value==='today')return today;
 if(value==='tomorrow')return addCalendarDays(today,1);
 if(value==='day after tomorrow'||value==='the day after tomorrow')return addCalendarDays(today,2);
 const days=/^(?:in|within) (\d{1,3}) (?:calendar )?days?$/.exec(value);
 if(days)return addCalendarDays(today,Number(days[1]));
 const weekday=/^(?:(this|next|this upcoming|upcoming) )?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)$/.exec(value);
 if(weekday){
  const offset=(weekdays.indexOf(weekday[2])-new Date(today+'T12:00:00Z').getUTCDay()+7)%7;
  return addCalendarDays(today,offset|| (weekday[1]==='this'?0:7));
 }
 const match=/^([a-z]+)\.? (\d{1,2})(?:st|nd|rd|th)?(?:,? (\d{4}))?$/.exec(value);
 if(!match)return '';
 const month=months.findIndex(name=>name===match[1]||name.slice(0,3)===match[1]);
 if(month<0)return '';
 const day=Number(match[2]),year=Number(match[3]||today.slice(0,4));
 const format=y=>`${y}-${String(month+1).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
 if(match[3])return parseDateOnlyParts(format(year))?format(year):'';
 // Missing year follows the product's next-upcoming-date rule, including leap days.
 for(let y=year;y<=year+4;y++){const date=format(y);if(parseDateOnlyParts(date)&&date>=today)return date;}
 return '';
}
// Recover only explicit work-deadline clauses. This candidate still goes through
// the AI fidelity check with the full request before it can populate a field.
function explicitDeadlineCandidate(brief){
 const clauses=String(brief).split(/[.!?;\n]/).map(value=>value.trim()).filter(Boolean);
 const candidates=[];
 for(const clause of clauses){
  if(/\b(?:not|no|never|ignore|cancel|remove|maybe|possibly|around|either|or|if|unless|would|could)\b|n't\b/i.test(clause))continue;
  const match=/^(?:(?:i |we )?need(?:ed)? by|(?:work |documents? |docs? |deliverables? )?(?:due|ready|completed|finished)(?: by)?|deadline(?: is|:)?)[ :]+(.+)$/i.exec(clause);
  if(match&&resolveDeadline(match[1]))candidates.push({text:match[1],source:clause});
 }
 // Multiple deadline clauses require interpretation, not an arbitrary selection.
 return candidates.length===1?candidates[0]:null;
}
async function normalizeDetails(details,brief,{today=dateOnlyFromZonedInstant()}={}){
 const result={};
 if(!details)return result;
 const compensation=details.compensation;
 if(compensation&&contains(brief,compensation.source)){
  const quote=compensation.source;
  const amounts=(quote.match(/\d[\d,]*(?:\.\d{1,2})?/g)||[]).map(v=>v.replace(/,/g,''));
  const amount=String(compensation.amount);
  const numeric=Number(amount);
  // One explicit USD flat amount; never turn hourly rates, ranges or fee-inclusive totals into compensation.
  if(/^\d+(?:\.\d{1,2})?$/.test(amount)&&numeric>0&&Number.isSafeInteger(Math.round(numeric*100))&&amounts.length===1&&Number(amounts[0])===numeric&&
    !/hour|\/\s*hr|per\s+(?:day|week|page)|between|\bto\b|[-–]|including|includes|total|all[- ]in|€|£|eur|cad|aud|gbp|up to|maximum|approx|about|maybe/i.test(quote)&&
    /compensation|budget|flat|pay|offer|\$|usd|dollars/i.test(quote))result.compAmount=numeric.toFixed(2);
 }
 const deadline=details.deadline;
 if(deadline&&contains(brief,deadline.source)&&contains(deadline.source,deadline.text)){
  // Event timing alone is not a work deadline; the model and fidelity check must also agree.
  if(/\b(?:need(?:ed)?|due|deadline|deliver|complete|finish|ready)\b|\bby\b/i.test(deadline.source)&&! /\b(?:maybe|possibly|around|either|or)\b/i.test(deadline.source)){
   const date=resolveDeadline(deadline.text,today);if(date)result.deadline=date;
  }
 }
 const experience=details.experience;
 if(experience&&contains(brief,experience.source)&&contains(experience.source,experience.text)){
  const text=normalize(experience.text), value=experience.value;
  const threshold=/^(?:at least |minimum(?: of)? |min(?:imum)?[.:]? )?(1|3|5|7|10|12)\+? years?(?: of)?(?: (?:professional|paralegal|legal))? experience(?: (?:required|minimum))?$/.exec(text);
  const mandatory=/\b(?:must|required|minimum|at least|need)\b|\d\+/i.test(experience.source);
  const uncertain=/\b(?:prefer|preferred|ideally|optional|not|no|nice|around|about|or)\b/i.test(experience.source);
  if(threshold&&mandatory&&!uncertain&&value===threshold[1]+'+ years')result.experience=value;
 }
 const requirements=details.requirements || [];
 const supported=requirements.filter(item=>contains(brief,item.source)&&contains(item.source,item.text)&&/\b(?:must|required|requirements?|mandatory|minimum|at least)\b/i.test(item.source)&&!/\b(?:prefer|preferred|ideally|optional|not|no|nice)\b/i.test(item.source));
 if(supported.length)result.requirements=[...new Set(supported.map(item=>item.text.trim()))];
 const state=details.state;
 if(state&&contains(brief,state.source)&&contains(state.source,state.text)){
  const {draftProfileDefaults}=await import('../../frontend/assets/scripts/attorney-v2/draft-profile.mjs');
  const canonical=draftProfileDefaults({state:state.text}).state;if(canonical)result.state=canonical;
 }
 return result;
}
module.exports={normalizeDetails,resolveDeadline,explicitDeadlineCandidate};
