import { readFinancial } from './financial-read.js';
import { onAdminPrivateInvalidation } from './shared.js';

let pending = null, generation = 0;
onAdminPrivateInvalidation(() => { generation++; pending = null; });
// Share an in-flight executive read between the summary and initial queue. A
// completed read is never retained as current evidence for a later decision.
export function readExecutive() {
  if (pending) return pending;
  const request = generation;
  const read = readFinancial('/api/admin/workspace/executive', { suppressToast: true }).then(data => {
    if (request !== generation) throw new Error('Admin access changed. Refresh before continuing.');
    return data;
  }).finally(() => { if (pending === read) pending = null; });
  pending = read;
  return read;
}
