'use strict';

if (process.platform !== 'win32') {
  throw new Error('Forgeboard Windows durable filesystem authority is unavailable.');
}

// The platform build creates this Node-API binary before Windows tests or packaging.
// @ts-expect-error TypeScript cannot resolve a generated native addon.
module.exports = require('./build/Release/forgeboard_windows_durable_fs.node');
