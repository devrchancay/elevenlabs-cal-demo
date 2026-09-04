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

export function readConfig(search: string = window.location.search): AppConfig {
  const params = new URLSearchParams(search);

  const agentId = (params.get('agent') ?? import.meta.env.VITE_ELEVENLABS_AGENT_ID ?? '').trim();
  const backendUrl = trimTrailingSlash(
    (params.get('backend') ?? import.meta.env.VITE_BACKEND_URL ?? '').trim(),
  );

  return {
    agentId,
    backendUrl,
    configured: agentId.length > 0,
  };
}
