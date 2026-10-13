// Shared by both attorney editors. Only editable draft fields cross this boundary.
export const draftFields = Object.freeze(["title", "practiceArea", "state", "compAmount", "experience", "deadline", "description", "tasks"]);
export const draftLabels = Object.freeze({ title: "Matter title", practiceArea: "Practice area", state: "State", compAmount: "Compensation", experience: "Experience", deadline: "Deadline", description: "Description", tasks: "Tasks" });
export const validDraftId = (id) => /^[a-f0-9]{24}$/i.test(id || "");
export const validRequestId = (id) => /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(id || "");
export function draftValues(value = {}, { descriptionLimit = 4000 } = {}) {
  const clean = (key, limit) => String(value[key] ?? "").replace(["description", "sourceDescription", "appliedSourceDescription"].includes(key) ? /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g : /[\u0000-\u001F\u007F]/g, "").trim().slice(0, limit);
  return { pendingRequirement: clean("pendingRequirement", 200), appliedSourceDescription: value.appliedSourceDescription == null ? clean("sourceDescription",4000) : clean("appliedSourceDescription",4000), sourceDescription: clean("sourceDescription", 4000), title: clean("title", 300), practiceArea: clean("practiceArea", 200), state: clean("state", 200), compAmount: clean("compAmount", 100), experience: clean("experience", 200), deadline: clean("deadline", 50), description: clean("description", descriptionLimit), requirements: (Array.isArray(value.requirements) ? value.requirements : []).map(item => String(item).replace(/[\u0000-\u001F\u007F]/g, "").trim()).filter(Boolean), tasks: (Array.isArray(value.tasks) ? value.tasks : []).map((task) => ({ title: String(typeof task === "string" ? task : task?.title || "").replace(/[\u0000-\u001F\u007F]/g, "").trim().slice(0, 200) })).filter((task) => task.title) };
}
export const sameDraft = (a, b, options) => JSON.stringify(draftValues(a, options)) === JSON.stringify(draftValues(b, options));
export const hasDraftContent = (value) => Boolean(value.pendingRequirement?.trim() || value.sourceDescription?.trim() || value.requirements?.length) || draftFields.some((key) => key === "tasks" ? value.tasks?.length : String(value[key] || "").trim());
export function readDraft(payload, expectedId, options) {
  const value = payload?.draft;
  if (!value || (value.pendingRequirement !== undefined && typeof value.pendingRequirement !== "string") || (value.requirements !== undefined && (!Array.isArray(value.requirements) || value.requirements.some(item => typeof item !== "string"))) || !validDraftId(value.id) || (expectedId && value.id !== expectedId) || !/^[a-f0-9]{64}$/.test(value.revision || "") || typeof value.rawTitle !== "string" || draftFields.filter((key) => key !== "tasks").some((key) => typeof value[key] !== "string") || !Array.isArray(value.tasks) || value.tasks.some((task) => typeof task?.title !== "string")) throw new Error("invalid_draft");
  return { id: value.id, revision: value.revision, publishedCaseId: validDraftId(value.publishedCaseId) ? value.publishedCaseId : null, values: draftValues({ ...value, title: value.rawTitle }, options) };
}
// Changes to untouched fields come from the server. Explicit local choices win
// only in fields edited since the last confirmed save (tasks are one ordered list).
export function mergeDraft(base, local, remote, options) {
  return draftValues(Object.fromEntries([...draftFields, "requirements", "sourceDescription", "appliedSourceDescription", "pendingRequirement"].map((key) => [key, JSON.stringify(draftValues(base, options)[key]) === JSON.stringify(draftValues(local, options)[key]) ? remote[key] : local[key]])), options);
}
export function dollarCents(value) {
  const text = String(value || "").trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) return null;
  const [whole, fraction = ""] = text.split(".");
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return Number.isSafeInteger(cents) && cents > 0 ? cents : null;
}
export function validDraftDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "")) return false;
  const date = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
export function draftErrors(value, { description = true, descriptionLimit = 4000 } = {}) {
  const data = draftValues(value, { descriptionLimit }), errors = {};
  if (data.title.length < 3) errors.title = "Add a Matter title of at least 3 characters.";
  if (!data.practiceArea) errors.practiceArea = "Choose a practice area.";
  if (!data.state) errors.state = "Choose a state.";
  if (dollarCents(data.compAmount) === null || dollarCents(data.compAmount) < 40000) errors.compAmount = Number(data.compAmount) < 400 ? "Minimum $400" : "Use a valid amount";
  if (data.deadline && !validDraftDate(data.deadline)) errors.deadline = "Enter a valid deadline.";
  if (description && !data.description) errors.description = "Describe the support you need.";
  if (description && !data.tasks.length) errors.tasks = "Add at least one task before publishing.";
  if (description && data.tasks.length > 25) errors.tasks = "Use 25 tasks or fewer before publishing.";
  if (data.requirements.length > 12 || data.requirements.some(item => item.length > 200) || new Set(data.requirements.map(item => item.toLowerCase())).size !== data.requirements.length) errors.requirements = "Use up to 12 unique requirements, each no more than 200 characters.";
  return errors;
}
