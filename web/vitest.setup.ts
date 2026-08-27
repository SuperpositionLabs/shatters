/**
 * Adds the jest-dom matchers used by the component suites.
 *
 * Loaded for every file, including the node-environment crypto tests: the
 * import is inert without a DOM and keeping one setup file avoids a second
 * vitest config.
 */
import "@testing-library/jest-dom/vitest";

// jsdom implements no layout, so scrollIntoView does not exist. Stubbing it
// here rather than guarding in the component keeps a jsdom gap out of
// production code.
if (typeof Element !== "undefined" && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => undefined;
}
