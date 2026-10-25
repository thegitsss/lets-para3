export const FIELDS = Object.freeze({ experience: ['title', 'years', 'description'], education: ['school', 'degree', 'fieldOfStudy', 'grade', 'activities', 'startMonth', 'startYear', 'endMonth', 'endYear'], skills: null, practiceAreas: null, languages: ['name', 'proficiency'], bio: null, linkedInURL: null });
export const LABELS = { experience: 'Experience', education: 'Education', skills: 'Skills / tools', practiceAreas: 'Practice areas', languages: 'Languages', bio: 'About', linkedInURL: 'LinkedIn' };
export const LIMITS = { experience: 30, education: 30, skills: 5, practiceAreas: 50, languages: 30 };
const normalized = value => String(value || '').normalize('NFKC').toLowerCase().replace(/\.(?=[\p{L}\s.]|$)/gu, '').replace(/[\p{P}\p{S}\s]+/gu, ' ').trim();
export function sameEntry(field, a, b) {
  if (field === 'experience') return normalized(a.title) === normalized(b.title) && normalized(a.years) === normalized(b.years);
  if (field === 'education') return normalized(a.school) === normalized(b.school) && normalized(a.degree) === normalized(b.degree);
  if (field === 'languages') return normalized(a.name) === normalized(b.name);
  return normalized(a) === normalized(b);
}
export function mergeSuggestions(profile, rows) {
  const patch = {};
  for (const { field, value, selected } of rows) {
    if (!selected || !Object.hasOwn(FIELDS, field)) continue;
    if (field === 'experience' && !String(value.title || value.description || '').trim()) throw new Error('Add a role or description to the selected experience.');
    if (field === 'education' && !String(value.school || value.degree || '').trim()) throw new Error('Add a school or degree to the selected education.');
    if (field === 'languages' && !String(value.name || '').trim()) throw new Error('Add a name to the selected language.');
    if (['skills','practiceAreas'].includes(field) && !String(value || '').trim()) throw new Error(`Enter a value for the selected ${LABELS[field]} suggestion.`);
    if (Object.hasOwn(LIMITS, field)) {
      const entries = patch[field] || [...(profile[field] || [])];
      if (!entries.some(entry => sameEntry(field, entry, value))) {
        if (entries.length >= LIMITS[field]) throw new Error(`${LABELS[field]} is full. Remove an entry in Profile before importing more.`);
        entries.push(value); patch[field] = entries;
      }
    } else if (String(value || '').trim() && value !== profile[field]) patch[field] = value;
  }
  return patch;
}

// Keep every saved array entry for merging, including profiles larger than the
// normal editor limit. Normalizing the display must never truncate an import.
export function resumeImportSnapshot(user) {
  const snapshot = Object.fromEntries(Object.keys(FIELDS).map(field => [field,
    Object.hasOwn(LIMITS, field) ? structuredClone(Array.isArray(user[field]) ? user[field] : []) : String(user[field] || '')]));
  if (!snapshot.practiceAreas.length && Array.isArray(user.specialties)) snapshot.practiceAreas = structuredClone(user.specialties);
  if (!snapshot.bio) snapshot.bio = String(user.about || '');
  return snapshot;
}
