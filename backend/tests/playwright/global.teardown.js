"use strict";

const { removeStorageState } = require("./auth-state");

module.exports = async (config) => {
  const paths = new Set(
    (config?.projects || [])
      .map((project) => project?.use?.storageState)
      .filter((storageState) => typeof storageState === "string")
  );
  for (const storageStatePath of paths) removeStorageState(storageStatePath);
};
