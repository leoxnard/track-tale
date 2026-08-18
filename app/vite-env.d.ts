/// <reference types="vite/client" />

/**
 * Names the analytics vars so `import.meta.env` is typed rather than `any`.
 * Optional on purpose: unset is the normal state locally, and the code has to
 * keep type-checking as if it were.
 */
interface ImportMetaEnv {
  readonly VITE_UMAMI_SRC?: string;
  readonly VITE_UMAMI_WEBSITE_ID?: string;
  readonly VITE_UMAMI_DOMAINS?: string;
}
