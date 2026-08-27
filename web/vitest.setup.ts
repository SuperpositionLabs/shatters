/**
 * Adds the jest-dom matchers used by the component suites.
 *
 * Loaded for every file, including the node-environment crypto tests: the
 * import is inert without a DOM and keeping one setup file avoids a second
 * vitest config.
 */
import "@testing-library/jest-dom/vitest";
