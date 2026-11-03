"use strict";

const path = require("path");
const { setNoStoreHeaders } = require("./staticCache");

function createWebNotFoundHandler(frontendDirectory) {
  const documentRoot = path.resolve(frontendDirectory);
  return (req, res) => {
    setNoStoreHeaders(res);
    res.setHeader("X-Robots-Tag", "noindex, nofollow");
    if (["GET", "HEAD"].includes(String(req.method || "").toUpperCase())) {
      return res.status(404).sendFile("404.html", { root: documentRoot });
    }
    return res.status(404).type("text/plain").send("Not found");
  };
}

module.exports = { createWebNotFoundHandler };
