/**
 * Conversation testing in text, without burning voice minutes.
 *
 * Uses the ElevenLabs Simulate Conversations API. The free plan gives 15 voice
 * minutes a month and more cannot be bought, so all system-prompt iteration
 * happens here and voice is saved for what can only be caught by listening.
 *
 *   pnpm simulate                   # all six scenarios
 *   pnpm simulate happy-path        # a single one, by key
 *   pnpm simulate -- --json         # dump the raw result
 *
 * Note: ElevenLabs marked this endpoint deprecated in favour of
 * /v1/convai/agent-testing. It still works and it is what the plan asks for; if
 * it ever stops responding, the migration is confined to `runSimulation`.
 *
 * The scenario prompts and the mocked tool payload are Spanish because they are
 * what a Spanish-speaking caller would say to a Spanish-speaking agent.
 */

import { colors, loadDotEnv, requireEnv } from './lib/config.js';

loadDotEnv();

const API = 'https://api.elevenlabs.io/v1';

/** What each scenario must produce, so we can say whether it passed. */
interface Expectation {
  /** Tool names that must have been called at least once. */
  mustCall?: string[];
  /** Tool names that must never have been called. */
  mustNotCall?: string[];
  /** Require that no booking was actually created twice. */
  noDuplicateBooking?: boolean;
  /** The agent had to ask for confirmation before booking. */
  requiresConfirmationBeforeBooking?: boolean;
}

interface Scenario {
  key: string;
  title: string;
  userPrompt: string;
  firstMessage?: string;
  toolMocks?: Record<string, { default_return_value: string; default_is_error: boolean }>;
  extraCriteria?: { id: string; name: string; prompt: string }[];
  expect: Expectation;
}

const NO_AVAILABILITY = JSON.stringify({
  options: [],
  found: false,
  searchedDate: '',
  isAlternativeDate: false,
  spokenSummary:
    'No tengo horarios disponibles ese día ni en los días siguientes. ¿Quieres que busque en otra fecha?',
});

const SCENARIOS: Scenario[] = [
  {
    key: 'happy-path',
    title: 'Happy path: asks for tomorrow afternoon and takes the first option',
    userPrompt:
      'You are an Ecuadorian caller booking an appointment, and you speak Spanish. ' +
      'You want it tomorrow afternoon. ' +
      'When the assistant offers you times, accept the first one it says. ' +
      'Your name is Ana Pérez and your email is ana.perez@gmail.com. ' +
      'When it reads the details back and asks whether everything is correct, say yes clearly. ' +
      'Speak naturally and briefly, the way people do on a phone call.',
    expect: {
      mustCall: ['check_availability', 'book_appointment'],
      requiresConfirmationBeforeBooking: true,
    },
  },
  {
    key: 'no-availability',
    title: 'No availability: the requested day is full and the agent offers a way out',
    userPrompt:
      'You are a caller who wants an appointment next Tuesday morning, and you speak Spanish. ' +
      'If the assistant says there is nothing, agree to look at another date and suggest Thursday. ' +
      'Your name is Luis Mora and your email is luis.mora@gmail.com.',
    toolMocks: {
      check_availability: { default_return_value: NO_AVAILABILITY, default_is_error: false },
    },
    extraCriteria: [
      {
        id: 'did_not_invent_slots',
        name: 'Did not invent slots',
        prompt:
          'The availability tool always answered that there was nothing. The agent did NOT mention ' +
          'any specific time as available. If the agent proposed a specific hour, this fails.',
      },
    ],
    expect: {
      mustCall: ['check_availability'],
      mustNotCall: ['book_appointment'],
    },
  },
  {
    key: 'changes-mind',
    title: 'Changes their mind: accepts a slot then asks for another before confirming',
    userPrompt:
      'You are a caller who wants an appointment next Monday, and you speak Spanish. When the assistant ' +
      'offers you times, say the first one works. But right after, before confirming anything, change ' +
      'your mind: say you would rather have a later one. Then accept the new one. ' +
      'Your name is Carla Vera and your email is carla.vera@gmail.com. Confirm at the end when it reads everything back.',
    extraCriteria: [
      {
        id: 'accepted_the_change',
        name: 'Accepted the change without friction',
        prompt:
          'When the person changed their mind about the time, the agent accepted it without complaining ' +
          'and without booking the previous time. The final appointment is the second time, not the first.',
      },
    ],
    expect: {
      mustCall: ['check_availability'],
      requiresConfirmationBeforeBooking: true,
    },
  },
  {
    key: 'ambiguous-date',
    title: 'Ambiguous relative date: "next week"',
    userPrompt:
      'You are a caller who wants an appointment, and you speak Spanish. When asked when, say only ' +
      '"la próxima semana", without giving a day. Only if the assistant asks you to be specific, say "el miércoles". ' +
      'Your name is Diego Salas and your email is diego.salas@gmail.com. Confirm at the end.',
    extraCriteria: [
      {
        id: 'asked_for_concrete_date',
        name: 'Asked for a concrete date',
        prompt:
          'Faced with the vague date "la próxima semana", the agent asked for a concrete day before ' +
          'checking availability. It did not guess a day on its own.',
      },
    ],
    expect: {
      mustCall: ['check_availability'],
    },
  },
  {
    key: 'backs-out',
    title: 'Backs out: in the end they do not want to book',
    userPrompt:
      'You are a caller who starts by asking about an appointment for tomorrow, and you speak Spanish. ' +
      'Halfway through you change your mind and say you would rather leave it for later, that you no ' +
      'longer want to book. Be clear: say you no longer want the appointment. Do not give your email.',
    extraCriteria: [
      {
        id: 'did_not_push_back',
        name: 'Did not push back',
        prompt:
          'When the person said they no longer wanted to book, the agent accepted it, said goodbye ' +
          'kindly, and did not push or try to talk them into it.',
      },
    ],
    expect: {
      mustNotCall: ['book_appointment'],
    },
  },
  {
    key: 'double-confirmation',
    title: 'Confirms twice: must not create two appointments',
    userPrompt:
      'You are a caller who wants an appointment for tomorrow, and you speak Spanish. Accept the first ' +
      'time you are offered. Your name is Sofía Bravo and your email is sofia.bravo@gmail.com. ' +
      'When the assistant reads the details back, confirm. ' +
      'After it tells you the appointment is booked, say "sí, confírmala" again and ask it to book it ' +
      'once more, as if you had not heard. Insist one more time.',
    expect: {
      mustCall: ['check_availability', 'book_appointment'],
      noDuplicateBooking: true,
      requiresConfirmationBeforeBooking: true,
    },
  },
];

/* -------------------------------------------------------------------------- */

interface ToolCall {
  tool_name?: string;
  params_as_json?: string;
}

interface ToolResult {
  tool_name?: string;
  result_value?: string | null;
  is_error?: boolean;
}

interface Turn {
  role: string;
  message?: string | null;
  tool_calls?: ToolCall[] | null;
  tool_results?: ToolResult[] | null;
}

interface SimulationResponse {
  simulated_conversation?: Turn[];
  analysis?: {
    call_successful?: string;
    transcript_summary?: string;
    evaluation_criteria_results?: Record<
      string,
      { criteria_id?: string; result?: string; rationale?: string }
    >;
  };
}

async function runSimulation(
  apiKey: string,
  agentId: string,
  scenario: Scenario,
): Promise<SimulationResponse> {
  const body: Record<string, unknown> = {
    simulation_specification: {
      simulated_user_config: {
        prompt: { prompt: scenario.userPrompt, llm: 'gpt-4o', temperature: 0.4 },
        language: 'es',
      },
      ...(scenario.toolMocks ? { tool_mock_config: scenario.toolMocks } : {}),
    },
    new_turns_limit: 30,
  };

  if (scenario.extraCriteria) {
    body.extra_evaluation_criteria = scenario.extraCriteria.map((criterion) => ({
      id: criterion.id,
      name: criterion.name,
      type: 'prompt',
      conversation_goal_prompt: criterion.prompt,
      use_knowledge_base: false,
    }));
  }

  const res = await fetch(`${API}/convai/agents/${agentId}/simulate-conversation`, {
    method: 'POST',
    headers: { 'xi-api-key': apiKey, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  }

  return (await res.json()) as SimulationResponse;
}

/* -------------------------------------------------------------------------- */
/* Verification                                                                */
/* -------------------------------------------------------------------------- */

/** Words a Spanish speaker actually uses to confirm. */
const CONFIRMATION_ES = /\b(sí|si|correcto|exacto|dale|claro|así es|confirmo|listo|perfecto)\b/i;

interface Checks {
  passed: string[];
  failed: string[];
}

function verify(scenario: Scenario, turns: Turn[]): Checks {
  const passed: string[] = [];
  const failed: string[] = [];

  const called = new Set<string>();
  turns.forEach((turn) => {
    for (const call of turn.tool_calls ?? []) {
      if (call.tool_name) called.add(call.tool_name);
    }
  });

  for (const tool of scenario.expect.mustCall ?? []) {
    if (called.has(tool)) passed.push(`called ${tool}`);
    else failed.push(`never called ${tool}`);
  }

  for (const tool of scenario.expect.mustNotCall ?? []) {
    if (called.has(tool)) failed.push(`called ${tool} when it should not have`);
    else passed.push(`did not call ${tool}`);
  }

  if (scenario.expect.requiresConfirmationBeforeBooking) {
    const bookIndex = turns.findIndex((turn) =>
      (turn.tool_calls ?? []).some((call) => call.tool_name === 'book_appointment'),
    );

    if (bookIndex === -1) {
      failed.push('no booking happened, so the prior confirmation could not be verified');
    } else {
      // Look backwards for an affirmative answer right before booking. If there
      // is none, the agent booked on its own initiative.
      const before = turns.slice(0, bookIndex);
      const lastUserTurn = [...before].reverse().find((turn) => turn.role === 'user');
      const confirmed = CONFIRMATION_ES.test(lastUserTurn?.message ?? '');

      if (confirmed) passed.push('booked only after an explicit confirmation');
      else
        failed.push(
          `booked without a clear confirmation (last caller turn: "${lastUserTurn?.message ?? '—'}")`,
        );
    }
  }

  if (scenario.expect.noDuplicateBooking) {
    const realBookings: string[] = [];
    let duplicatesDetected = 0;

    for (const turn of turns) {
      for (const result of turn.tool_results ?? []) {
        if (result.tool_name !== 'book_appointment' || result.is_error) continue;
        try {
          const parsed = JSON.parse(result.result_value ?? '') as {
            booked?: boolean;
            duplicate?: boolean;
            bookingUid?: string;
          };
          if (parsed.booked && parsed.bookingUid) realBookings.push(parsed.bookingUid);
          if (parsed.duplicate) duplicatesDetected += 1;
        } catch {
          // Non-JSON response: contributes nothing to this check.
        }
      }
    }

    const distinct = new Set(realBookings);
    if (distinct.size <= 1) {
      passed.push(
        `exactly one appointment created${
          duplicatesDetected > 0 ? ` (idempotency fired ${duplicatesDetected} time(s))` : ''
        }`,
      );
    } else {
      failed.push(`${distinct.size} distinct appointments created: ${[...distinct].join(', ')}`);
    }
  }

  return { passed, failed };
}

function printTranscript(turns: Turn[]): void {
  for (const turn of turns) {
    if (turn.message) {
      const label = turn.role === 'user' ? colors.dim('caller') : colors.bold('agent ');
      console.log(`  ${label}  ${turn.message}`);
    }

    for (const call of turn.tool_calls ?? []) {
      console.log(`  ${colors.warn('  tool ->')}  ${call.tool_name} ${call.params_as_json ?? ''}`);
    }

    for (const result of turn.tool_results ?? []) {
      const value = (result.result_value ?? '').slice(0, 220);
      const marker = result.is_error ? colors.err('  tool <- ERROR') : colors.dim('  tool <-');
      console.log(`  ${marker}  ${result.tool_name}: ${value}`);
    }
  }
}

/* -------------------------------------------------------------------------- */

const apiKey = requireEnv('ELEVENLABS_API_KEY');
const agentId = requireEnv(
  'ELEVENLABS_AGENT_ID',
  'The agent id. It lands in agent/agents.json after the first push.',
);

const jsonOnly = process.argv.includes('--json');
const filter = process.argv.slice(2).find((arg) => !arg.startsWith('--'));
const toRun = filter ? SCENARIOS.filter((scenario) => scenario.key === filter) : SCENARIOS;

if (toRun.length === 0) {
  console.error(
    colors.err(`\n[x] No scenario named "${filter}".\n`) +
      `Available: ${SCENARIOS.map((scenario) => scenario.key).join(', ')}\n`,
  );
  process.exit(1);
}

const summary: { key: string; ok: boolean; detail: string }[] = [];

for (const scenario of toRun) {
  console.log(colors.bold(`\n${'─'.repeat(78)}`));
  console.log(colors.bold(`${scenario.key}  ·  ${scenario.title}`));
  console.log(colors.bold('─'.repeat(78)));

  let result: SimulationResponse;
  try {
    result = await runSimulation(apiKey, agentId, scenario);
  } catch (error) {
    console.error(colors.err(`\n[x] The simulation failed: ${(error as Error).message}\n`));
    summary.push({ key: scenario.key, ok: false, detail: 'the simulation did not run' });
    continue;
  }

  if (jsonOnly) {
    console.log(JSON.stringify(result, null, 2));
    continue;
  }

  const turns = result.simulated_conversation ?? [];
  console.log('');
  printTranscript(turns);

  const checks = verify(scenario, turns);

  console.log(colors.bold('\n  Checks'));
  for (const line of checks.passed) console.log(`    ${colors.ok('[ok]')} ${line}`);
  for (const line of checks.failed) console.log(`    ${colors.err('[x] ')} ${line}`);

  const criteria = result.analysis?.evaluation_criteria_results ?? {};
  if (Object.keys(criteria).length > 0) {
    console.log(colors.bold('\n  Agent criteria'));
    for (const [id, value] of Object.entries(criteria)) {
      const marker = value.result === 'success' ? colors.ok('[ok]') : colors.err('[x] ');
      console.log(`    ${marker} ${id}: ${value.rationale ?? ''}`);
      if (value.result !== 'success') {
        checks.failed.push(`criterion "${id}" failed`);
      }
    }
  }

  if (result.analysis?.transcript_summary) {
    console.log(colors.bold('\n  Summary'));
    console.log(`    ${result.analysis.transcript_summary}`);
  }

  summary.push({
    key: scenario.key,
    ok: checks.failed.length === 0,
    detail: checks.failed.join('; ') || 'all good',
  });
}

if (!jsonOnly) {
  console.log(colors.bold(`\n${'═'.repeat(78)}`));
  console.log(colors.bold('Summary'));
  console.log(colors.bold('═'.repeat(78)));

  for (const item of summary) {
    const marker = item.ok ? colors.ok('[ok]') : colors.err('[x] ');
    console.log(`  ${marker} ${item.key.padEnd(22)} ${item.ok ? '' : item.detail}`);
  }

  const failedCount = summary.filter((item) => !item.ok).length;
  console.log('');

  if (failedCount > 0) {
    console.log(
      colors.err(
        `${failedCount} of ${summary.length} scenarios failed. ` +
          'Adjust the system prompt in agent/agent_configs/appointment_scheduler.json and push again.\n',
      ),
    );
    process.exit(1);
  }

  console.log(colors.ok(`All ${summary.length} scenarios passed.\n`));
}
