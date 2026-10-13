// Read-only resolution of explicit revision links. Approval stays on the file
// the attorney actually reviewed; earlier versions retain their review history.
function projectRevisionResolutions(files = []) {
  const idOf = (file) => String(file._id || file.id || '');
  const requestedAt = (value) => value ? new Date(value).getTime() : null;
  const byId = new Map(files.map(file => [idOf(file), file]));
  const responses = new Map();
  for (const file of files) {
    const sourceId = String(file.revisionOfFileId || '');
    const source = byId.get(sourceId);
    if (!source || file.uploadedByRole !== 'paralegal' || source.uploadedByRole !== 'paralegal') continue;
    if (String(file.caseId) !== String(source.caseId)) continue;
    if (Number(file.revisionOfVersion) !== Number(source.version || 1) || Number(file.version) <= Number(source.version || 1)) continue;
    if (requestedAt(file.revisionRequestAt) !== requestedAt(source.revisionRequestedAt)) continue;
    if (!responses.has(sourceId)) responses.set(sourceId, []);
    responses.get(sourceId).push(file);
  }
  const memo = new Map();
  function approvedResponse(file, visiting = new Set()) {
    const id = idOf(file);
    if (visiting.has(id)) return null;
    if (file.status === 'approved') return { approvedFileId: id, approvedAt: file.approvedAt || null };
    if (file.status !== 'attorney_revision') return null;
    if (memo.has(id)) return memo.get(id);
    visiting.add(id);
    let resolution = null;
    for (const response of responses.get(id) || []) {
      resolution = approvedResponse(response, visiting);
      if (resolution) break;
    }
    visiting.delete(id);
    memo.set(id, resolution);
    return resolution;
  }
  return files.map(file => ({
    ...file,
    revisionResolution: file.status === 'attorney_revision' && file.uploadedByRole === 'paralegal'
      ? approvedResponse(file) : null,
  }));
}

module.exports = { projectRevisionResolutions };
