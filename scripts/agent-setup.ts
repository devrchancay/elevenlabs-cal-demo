/**
 * Prepares the agent configuration so the CLI can apply it.
 *
 * It does the two things that would otherwise have to be clicked through in the
 * dashboard:
 *
 *   setup  · stores TOOLS_SHARED_SECRET in the ElevenLabs Secrets Manager and
 *            writes the secret id and the public URL into the tool configs.
 *   link   · after `elevenlabs tools push`, copies the tool ids into the
 *            agent's `tool_ids`.
 *
 * Usage:
 *   pnpm agent:setup
 *   cd agent && elevenlabs tools push
 *   pnpm agent:link
 *   cd agent && elevenlabs agents push
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { ROOT, colors, loadDotEnv, requireEnv } from './lib/config.js';

loadDotEnv();

const AGENT_DIR = resolve(ROOT, 'agent');
const AGENT_CONFIG = 'agent_configs/agendador.json';
const API = 'https://api.elevenlabs.io/v1';

/** Which backend route each tool points at. */
const TOOL_PATHS: Record<string, string> = {
  'tool_configs/check_availability.json': '/tools/availability',
  'tool_configs/book_appointment.json': '/tools/book',
};

function readJson<T>(relative: string): T {
  return JSON.parse(readFileSync(resolve(AGENT_DIR, relative), 'utf8')) as T;
}

function writeJson(relative: string, value: unknown): void {
  writeFileSync(resolve(AGENT_DIR, relative), `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

interface SecretListItem {
  secret_id: string;
  name: string;
}

/** Reuses the secret if one already exists under that name, otherwise creates it. */
async function ensureSecret(apiKey: string, name: string, value: string): Promise<string> {
  const listRes = await fetch(`${API}/convai/secrets`, { headers: { 'xi-api-key': apiKey } });

  if (listRes.ok) {
    const body = (await listRes.json()) as { secrets?: SecretListItem[] };
    const existing = body.secrets?.find((secret) => secret.name === name);
    if (existing) {
      console.log(colors.dim(`  secret "${name}" already existed -> ${existing.secret_id}`));
      console.log(
        colors.warn(
          '  If you rotated TOOLS_SHARED_SECRET, delete that secret in the dashboard and rerun this.',
        ),
      );
      return existing.secret_id;
    }
  }

  const res = await fetch(`${API}/convai/secrets`, {
    method: 'POST',
    headers: { 'xi-api-key': apiKey, 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'new', name, value }),
  });

  if (!res.ok) {
    console.error(colors.err(`\n[x] Could not create the secret: HTTP ${res.status}`));
    console.error(await res.text());
    process.exit(1);
  }

  const created = (await res.json()) as { secret_id: string };
  console.log(colors.ok(`  secret "${name}" created -> ${created.secret_id}`));
  return created.secret_id;
}

async function setup(): Promise<void> {
  const apiKey = requireEnv('ELEVENLABS_API_KEY', 'Found in the ElevenLabs dashboard.');
  const secret = requireEnv('TOOLS_SHARED_SECRET');
  const baseUrl = requireEnv(
    'PUBLIC_BASE_URL',
    'The public backend URL, for example https://my-service.up.railway.app',
  ).replace(/\/+$/, '');

  if (!baseUrl.startsWith('https://')) {
    console.error(colors.err('\n[x] PUBLIC_BASE_URL must be https. The tools reject http.\n'));
    process.exit(1);
  }

  console.log(colors.bold('\n1. ElevenLabs Secrets Manager'));
  const secretId = await ensureSecret(apiKey, 'TOOLS_SHARED_SECRET', secret);

  console.log(colors.bold('\n2. tool configs'));
  for (const [file, path] of Object.entries(TOOL_PATHS)) {
    const config = readJson<{
      api_schema: { url: string; request_headers: Record<string, unknown> };
    }>(file);

    config.api_schema.url = `${baseUrl}${path}`;
    config.api_schema.request_headers.Authorization = { secret_id: secretId };

    writeJson(file, config);
    console.log(colors.ok(`  ${file} -> ${config.api_schema.url}`));
  }

  console.log(colors.bold('\nDone. Next steps:'));
  console.log('  cd agent && elevenlabs tools push');
  console.log('  pnpm agent:link');
  console.log('  cd agent && elevenlabs agents push\n');
}

interface ToolsRegistry {
  tools: { type: string; config: string; id: string | null }[];
}

function link(): void {
  const registry = readJson<ToolsRegistry>('tools.json');
  const missingId = registry.tools.filter((tool) => !tool.id);

  if (missingId.length > 0) {
    console.error(
      colors.err(
        `\n[x] ${missingId.length} tool(s) still have no id. Run first: cd agent && elevenlabs tools push\n`,
      ),
    );
    process.exit(1);
  }

  const toolIds = registry.tools.map((tool) => tool.id as string);

  const agent = readJson<{
    conversation_config: { agent: { prompt: { tool_ids: string[] } } };
  }>(AGENT_CONFIG);

  agent.conversation_config.agent.prompt.tool_ids = toolIds;
  writeJson(AGENT_CONFIG, agent);

  console.log(colors.ok(`\n[ok] tool_ids written into ${AGENT_CONFIG}:`));
  for (const id of toolIds) console.log(`  ${id}`);
  console.log('\nNext step:\n  cd agent && elevenlabs agents push\n');
}

const command = process.argv[2] ?? 'setup';

if (command === 'link') {
  link();
} else if (command === 'setup') {
  await setup();
} else {
  console.error(`Unknown command: ${command}. Use "setup" or "link".`);
  process.exit(1);
}
