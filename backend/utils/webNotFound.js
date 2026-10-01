"use strict";

const path = require("path");
const { setNoStoreHeaders } = require("./staticCache");

function createWebNotFoundHandler(frontendDirectory) {
  const documentPath = path.resolve(frontendDirectory, "404.html");
  return (req, res) => {
    setNoStoreHeaders(res);
    res.setHeader("X-Robots-Tag", "noindex, nofollow");
    if (["GET", "HEAD"].includes(String(req.method || "").toUpperCase())) {
      return res.status(404).sendFile(documentPath);
    }
    return res.status(404).type("text/plain").send("Not found");
  };
}

module.exports = { createWebNotFoundHandler };
