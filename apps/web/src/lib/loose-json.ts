/**
 * Server JSON the web app reads without a declared shape (learning ledger, diagnostics envelopes, instrument search,
 * test fixtures). Every field read from it is treated as optional at the point of use. This is the one place the
 * `any` type is allowed; new code should declare a real interface instead of using this.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type LooseJson = any;
