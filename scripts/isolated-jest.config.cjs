// The native SWC stack detector requires host /proc access. Keep the sandbox
// closed and use the already-installed Babel transformer for isolated tests.
const original = require("../jest.config.cjs");
module.exports = async () => ({
  ...(await original()),
  rootDir: require("node:path").resolve(__dirname, ".."),
  transform: {
    "^.+\\.(js|jsx|ts|tsx|mjs)$": ["babel-jest", {
      excludeJestPreset: true,
      presets: ["next/babel"],
      plugins: [require.resolve("./isolated-jest-hoist.cjs")],
    }],
  },
});
