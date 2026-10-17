'use strict';
// Conservative, local extraction. No instructions in a document are executed.
// Unrecognized layouts are left for manual entry rather than inferred.
const HEADINGS = {
  experience: /^(?:work |professional |employment )?(?:experience|history)$/i,
  education: /^education(?: & training)?$/i,
  skills: /^(?:skills(?:\s*[&/]\s*tools)?|tools|technical skills)$/i,
  practiceAreas: /^practice areas$/i,
  languages: /^languages$/i,
  bio: /^(?:summary|professional summary|about)$/i,
};
const LIMITS = { skills: 50, practiceAreas: 50, experience: 30, education: 30, languages: 30 };
function extractSuggestions(text) {
  if (typeof text !== 'string' || text.length > 100000) throw new Error('Unreadable résumé');
  const sections = {}; let current = null;
  for (const raw of text.replace(/\r/g, '').split('\n')) {
    const line = raw.trim().replace(/^\s*[•●▪]\s*/, '');
    const heading = Object.keys(HEADINGS).find(key => HEADINGS[key].test(line.replace(/:$/, '')));
    if (heading) { current = heading; sections[current] ||= []; continue; }
    // Other headings terminate a section. Do not absorb contact/qualification data.
    if (/^(?:references|certifications?|awards|contact|publications|interests|volunteering)\s*:?$/i.test(line)) current = null;
    if (current) sections[current].push(line);
  }
  const suggestions = [];
  const push = (field, value, source) => suggestions.push({ field, value, source });
  for (const field of ['skills', 'practiceAreas']) {
    for (const value of (sections[field] || []).flatMap(line => line.split(/[,;•]/)).map(v => v.trim()).filter(Boolean).slice(0, LIMITS[field])) {
      if (value.length <= (field === 'skills' ? 200 : 200)) push(field, value, value);
    }
  }
  for (const source of (sections.languages || []).filter(Boolean).slice(0, 30)) {
    const match = source.match(/^(.+?)\s*[(\-–:]\s*(Native|Fluent|Professional|Conversational|Basic)\)?$/i);
    const name = (match ? match[1] : source).trim();
    if (name.length <= 120) push('languages', { name, proficiency: match ? match[2][0].toUpperCase() + match[2].slice(1).toLowerCase() : '' }, source);
  }
  for (const field of ['experience', 'education']) {
    const blocks = (sections[field] || []).join('\n').trim().split(/\n\s*\n/).filter(Boolean).slice(0, 30);
    for (const source of blocks) {
      const lines = source.split('\n');
      if (field === 'experience') {
        // Keep dates verbatim; never total overlapping roles or invent a company.
        const date = lines.find(line => /\b(?:19|20)\d{2}\b\s*(?:[-–—]|to)\s*(?:\b(?:19|20)\d{2}\b|present|current)/i.test(line));
        push(field, { title: lines[0].slice(0, 300), years: date && date.length <= 120 ? date : '', description: lines.slice(1).filter(line => line !== date).join('\n').slice(0, 5000) }, source);
      } else {
        const school = lines.find(line => /\b(?:university|college|school|institute|academy)\b/i.test(line));
        const degree = lines.find(line => /\b(?:bachelor|master|associate|doctor|certificate|diploma)\b|\b[BM]\.?(?:A|S)\.?\b/i.test(line));
        // Without explicit labels, date components and field of study stay blank.
        if (school || degree) push(field, { school: (school || '').slice(0, 200), degree: (degree || '').slice(0, 200), fieldOfStudy: '', grade: '', activities: '', startMonth: '', startYear: '', endMonth: '', endYear: '' }, source);
      }
    }
  }
  const summary = (sections.bio || []).join('\n').trim();
  if (summary && summary.length <= 4000) push('bio', summary, summary);
  const linkedIn = text.match(/https:\/\/(?:www\.)?linkedin\.com\/in\/[a-zA-Z0-9_-]+\/?/);
  if (linkedIn) push('linkedInURL', linkedIn[0], linkedIn[0]);
  return { suggestions, processor: 'local-rules', warnings: ['Only clearly labeled sections are read. Check the source beside every suggestion. Dates, qualifications and missing details are never inferred.'] };
}
module.exports = { extractSuggestions };
