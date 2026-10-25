const names = ['Microsoft Office','Microsoft','Clio','iManage','PDF','Excel','Word','Adobe Acrobat','Westlaw','LexisNexis'];
export const requirementSuggestions = ['Clio proficiency','Microsoft Office proficiency','iManage proficiency','PDF editing proficiency','Excel proficiency','Adobe Acrobat proficiency','Westlaw research experience','LexisNexis research experience'];
export function normalizeRequirement(value) {
  let text=String(value||'').trim().replace(/\s+/g,' ');
  for(const name of names)text=text.replace(new RegExp('\\b'+name+'\\b','gi'),name);
  if(!text.startsWith('iManage'))text=text.replace(/^\p{L}/u,letter=>letter.toLocaleUpperCase());
  return text;
}
// Suggestions are known qualifications. A custom requirement is an attorney
// decision, not something a word-shape heuristic can certify as meaningful.
export function needsRequirementClarification(value) {
  return !requirementSuggestions.some(item=>item.toLowerCase()===normalizeRequirement(value).toLowerCase());
}
