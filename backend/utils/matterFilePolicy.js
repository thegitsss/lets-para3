"use strict";

// Matter documents have a different working volume from profile documents.
const MAX_MATTER_FILE_BYTES = 500 * 1024 * 1024;
const MATTER_UPLOAD_PART_BYTES = 8 * 1024 * 1024;
const BUFFERED_MATTER_FILE_BYTES = 20 * 1024 * 1024;
// At 8 MiB the monitoring cost is small relative to storage. Smaller originals
// keep Standard; large originals can save automatically without restore waits.
const matterStorageOptions = size => Number.isSafeInteger(size) && size >= MATTER_UPLOAD_PART_BYTES ? { StorageClass: "INTELLIGENT_TIERING" } : {};
module.exports = { MAX_MATTER_FILE_BYTES, MATTER_UPLOAD_PART_BYTES, BUFFERED_MATTER_FILE_BYTES, matterStorageOptions };
