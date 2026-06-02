/**
 * Single source of truth for the CLI's runtime version string.
 *
 * Kept in sync with `package.json` `version`. We don't dynamically import the
 * package.json because the bundler-style tsconfig + Node ESM combo makes JSON
 * imports awkward, and a hand-bumped constant is fine for a CLI whose version
 * is also pinned by npm install.
 */
export const CLI_VERSION = "0.1.0-beta.4";
