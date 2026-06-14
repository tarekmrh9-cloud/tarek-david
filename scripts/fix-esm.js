"use strict";
/**
 * postinstall fix: patches @dongdev/fca-unofficial nested gradient-string
 * (ESM-only v3) so it can be require()'d in CommonJS.
 */
const fs   = require("fs");
const path = require("path");

const CJS_SHIM = `"use strict";
// CJS shim for gradient-string v3 (ESM)
function gradient() {
  return function(text) { return text; };
}
gradient.atlas = function(t) { return t; };
gradient.cristal = function(t) { return t; };
gradient.teen = function(t) { return t; };
gradient.mind = function(t) { return t; };
gradient.morning = function(t) { return t; };
gradient.vice = function(t) { return t; };
gradient.passion = function(t) { return t; };
gradient.fruit = function(t) { return t; };
gradient.instagram = function(t) { return t; };
gradient.retro = function(t) { return t; };
gradient.summer = function(t) { return t; };
gradient.rainbow = function(t) { return t; };
gradient.pastel = function(t) { return t; };
module.exports = gradient;
module.exports.default = gradient;
`;

const targets = [
  "node_modules/@dongdev/fca-unofficial/node_modules/gradient-string",
  "node_modules/gradient-string",
];

let patched = 0;

for (const dir of targets) {
  const distFile = path.join(dir, "dist", "index.js");
  const pkgFile  = path.join(dir, "package.json");

  if (!fs.existsSync(distFile)) continue;

  try {
    // Overwrite with CJS shim
    fs.writeFileSync(distFile, CJS_SHIM, "utf8");

    // Remove "type":"module" from package.json
    if (fs.existsSync(pkgFile)) {
      const pkg = JSON.parse(fs.readFileSync(pkgFile, "utf8"));
      if (pkg.type === "module") {
        delete pkg.type;
        fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2), "utf8");
      }
    }

    console.log(`[fix-esm] patched: ${dir}`);
    patched++;
  } catch (e) {
    console.warn(`[fix-esm] skipped ${dir}: ${e.message}`);
  }
}

if (patched === 0) {
  console.log("[fix-esm] nothing to patch.");
} else {
  console.log(`[fix-esm] done — ${patched} target(s) patched.`);
}
