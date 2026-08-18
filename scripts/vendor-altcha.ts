import { copyFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";

// The official ALTCHA widget is vendored into public/vendor rather than loaded
// from a CDN, so the page still contacts no third party and the content
// security policy needs no external origin. Re-run after bumping the package.
const root = "node_modules/altcha";
const pkg = JSON.parse(readFileSync(`${root}/package.json`, "utf8")) as { version: string };

mkdirSync("public/vendor", { recursive: true });
copyFileSync(`${root}/dist/main/altcha.min.js`, "public/vendor/altcha.min.js");
copyFileSync(`${root}/dist/themes/business.min.css`, "public/vendor/altcha-business.min.css");

// The widget's built-in workers are built from blob: URLs, which would force a
// `worker-src blob:` exception into the content security policy. ALTCHA ships
// the same worker code as standalone files, so they are vendored and served
// same origin instead, and registered over the defaults in public/altcha.js.
for (const algorithm of ["pbkdf2", "sha"]) {
  copyFileSync(`${root}/dist/workers/${algorithm}.js`, `public/vendor/altcha-${algorithm}.worker.js`);
}
for (const name of ["LICENSE", "LICENSE.md", "LICENSE.txt"]) {
  if (existsSync(`${root}/${name}`)) {
    copyFileSync(`${root}/${name}`, "public/vendor/altcha.LICENSE");
    break;
  }
}
process.stdout.write(`vendored altcha ${pkg.version} into public/vendor\n`);
