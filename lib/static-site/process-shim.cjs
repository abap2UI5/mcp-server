// The `process` of the static build: the browser polyfill plus the stdout an
// ABAP WRITE reaches (@abaplint/runtime writes to process.stdout).
const process = require('process/browser');

if (!process.stdout) process.stdout = { write: (chunk) => console.log(String(chunk).replace(/\n$/, '')) };
if (!process.stderr) process.stderr = { write: (chunk) => console.warn(String(chunk).replace(/\n$/, '')) };
module.exports = process;
