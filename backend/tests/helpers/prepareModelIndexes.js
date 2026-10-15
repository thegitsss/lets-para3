// All test schemas remain provisioned. Bound work to three collections at a
// time, below the smallest harness pool (ten), while serializing models that
// share a collection so they cannot compete over the same index definitions.
module.exports = async function prepareModelIndexes(models) {
  const startedAt = Date.now();
  const collections = new Map();
  for (const model of models) {
    const name = model.collection.name;
    if (!collections.has(name)) collections.set(name, []);
    collections.get(name).push(model);
  }
  const groups = [...collections.values()];
  for (let index = 0; index < groups.length; index += 3) {
    const results = await Promise.allSettled(groups.slice(index, index + 3).map(async group => {
      for (const model of group) {
        await model.init();
        await model.createCollection();
        // A single bulk index command per schema keeps the full set of unique,
        // partial and TTL constraints, without hundreds of separate replica-set
        // index-commit waits. Index definitions are unchanged.
        const definitions = model.schema.indexes().map(([key, options]) => ({ key, ...options }));
        if (definitions.length) await model.collection.createIndexes(definitions, { maxTimeMS: 30000 });
      }
    }));
    const failed = results.find(result => result.status === 'rejected');
    if (failed) throw failed.reason;
  }
  if (process.env.LPC_HARNESS_SETUP_TIMINGS === 'true') process.stderr.write(`[harness-indexes] ${models.length} models / ${collections.size} collections ready in ${Date.now()-startedAt}ms\n`);
};
