#!/usr/bin/env node
"use strict";

// Exercise the installed native library on the actual build host, including Linux.
// This uses generated pixels only; it never reads profiles or calls storage.
const assert = require("node:assert/strict");
const sharp = require("sharp");
const { renderStoredPhotoCrop } = require("../services/profilePhotoRender");

async function main() {
  for (const format of ["png", "jpeg"]) {
    const original = await sharp({
      create: { width: 32, height: 32, channels: 3, background: "#4d70a8" },
    })[format]().toBuffer();
    const cropped = await renderStoredPhotoCrop(original, {
      v: 1, x: 0.25, y: 0.25, width: 0.5, height: 0.5,
    });
    const metadata = await sharp(cropped).metadata();
    assert.equal(metadata.format, "jpeg");
    assert.equal(metadata.width, 600);
    assert.equal(metadata.height, 600);
    assert.equal(metadata.exif, undefined);
    const { info } = await sharp(cropped).raw().toBuffer({ resolveWithObject: true });
    assert.equal(info.width, 600);
    assert.equal(info.height, 600);
  }
  console.log(`[photo-runtime] PNG/JPEG crops and native decoding passed (${process.platform}/${process.arch}, sharp ${sharp.versions.sharp}).`);
}

main().catch((error) => {
  console.error(`[photo-runtime] ${error.message}`);
  process.exitCode = 1;
});
