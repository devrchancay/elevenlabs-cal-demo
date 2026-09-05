/**
 * Where the page gets its two settings from.
 *
 * Build-time values come from Vite env vars (`VITE_*` in `.env`). Query string
 * overrides exist so the deployed page can be pointed at a different agent or a
 * local backend without a rebuild, which is what you want while testing.
 */

export interface AppConfig {
  agentId: string;
  backendUrl: string;
  /** False when the agent id is still missing, so the UI can say so. */
  configured: boolean;
}

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

/**
 * Adds the scheme when it is missing.
 *
 * `elevenlabs-agent-web-production.up.railway.app` pasted into a hosting
 * dashboard is not an absolute URL: `${backendUrl}/agent/context` turns it into
 * a path relative to the page, the request goes to the static host instead of
 * the backend, and the only symptom is a 404 on a URL with the two hosts glued
 * together. Assume https, which is the only scheme the deployed page can use
 * anyway.
 *
 * An empty value is left alone: it means "same origin", which is how the page
 * runs behind a single reverse proxy.
 */
function withScheme(url: string): string {
  if (url.length === 0 || /^[a-z][a-z0-9+.-]*:\/\//i.test(url)) return url;
  return `https://${url}`;
}

export function readConfig(search: string = window.location.search): AppConfig {
  const params = new URLSearchParams(search);

  const agentId = (params.get('agent') ?? import.meta.env.VITE_ELEVENLABS_AGENT_ID ?? '').trim();
  const backendUrl = trimTrailingSlash(
    withScheme((params.get('backend') ?? import.meta.env.VITE_BACKEND_URL ?? '').trim()),
  );

  return {
    agentId,
    backendUrl,
    configured: agentId.length > 0,
  };
}
