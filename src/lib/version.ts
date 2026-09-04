/** Service version. Reported by /health so we know what is actually deployed. */
export const VERSION = process.env.APP_VERSION ?? '0.1.0';
