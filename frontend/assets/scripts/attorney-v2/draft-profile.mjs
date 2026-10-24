import { draftPractices, draftStates } from './draft-options.mjs';
const codes = 'AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY'.split(' ');
const canonical = (value, choices) => choices.find(([name])=>name && name.toLowerCase()===String(value||'').trim().toLowerCase())?.[0] || '';
export function draftProfileDefaults(profile = {}) {
  const practices=[...new Set([...(Array.isArray(profile.practiceAreas)?profile.practiceAreas:[]),...(Array.isArray(profile.specialties)?profile.specialties:[])].map(v=>canonical(v,draftPractices)).filter(Boolean))];
  const raw=String(profile.state||'').trim();
  const state=canonical(raw,draftStates) || draftStates[codes.indexOf(raw.toUpperCase())+1]?.[0] || '';
  return {practices, practiceArea:practices.length===1?practices[0]:'',state};
}
