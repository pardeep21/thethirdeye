// Metro watches the server protocol file so mobile and server share one
// definition (apps/server/src/protocol.ts has zero imports for this reason).
const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");

const config = getDefaultConfig(__dirname);
config.watchFolders = [path.resolve(__dirname, "../server/src")];
module.exports = config;
