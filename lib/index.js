// Single entry point for the bundle. build.mjs turns this into ARCH_LIB; main.js
// falls back to requiring lib/ from disk when ARCH_LIB is undefined, which is
// what keeps the repo runnable unbuilt.
module.exports = {
  ...require('./naming.js'),
  ...require('./convert.js'),
};
