// @arcium-hq/client does `import anchor from "@anchor-lang/core"` (CJS default); the browser build has no default export.
// @ts-ignore no types for the deep path; types come from "@anchor-lang/core" itself
import * as anchor from "@anchor-lang/core/dist/browser/index.js";
// @ts-ignore
export * from "@anchor-lang/core/dist/browser/index.js";
export default anchor;
