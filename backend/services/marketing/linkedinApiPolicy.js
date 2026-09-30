"use strict";

// LinkedIn Marketing APIs are date-versioned and older versions are sunset.
// Keep this value code-owned so browser or database input cannot select a stale API.
const LINKEDIN_API_VERSION = "202607";

module.exports = {
  LINKEDIN_API_VERSION,
};
