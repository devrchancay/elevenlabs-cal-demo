/**
 * Current date and time in the business timezone.
 *
 * Fetched from the backend on purpose rather than computed in the browser: the
 * visitor's clock may be in another timezone, and the agent has to reason about
 * the business day, not the visitor's. If the backend cannot be reached we fall
 * back to formatting the browser clock in the business zone, which is worse but
 * better than leaving the agent with no idea what day it is.
 *
 * The timezone comes back too, because the page formats appointment times with
 * it. Reading a slot in the visitor's own zone would show an hour the agent
 * never said.
 */

const BUSINESS_TIMEZONE = 'America/Guayaquil';

export interface AgentContext {
  /** Ready to hand to the agent as a dynamic variable. */
  currentDateTime: string;
  timeZone: string;
}

export async function fetchAgentContext(backendUrl: string): Promise<AgentContext> {
  if (backendUrl.length > 0) {
    try {
      const response = await fetch(`${backendUrl}/agent/context`, { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const data = (await response.json()) as { currentDateTime?: string; timeZone?: string };
      if (typeof data.currentDateTime === 'string' && data.currentDateTime.length > 0) {
        return {
          currentDateTime: data.currentDateTime,
          timeZone: typeof data.timeZone === 'string' && data.timeZone.length > 0
            ? data.timeZone
            : BUSINESS_TIMEZONE,
        };
      }
    } catch (error) {
      console.warn('Could not read /agent/context, falling back to the browser clock.', error);
    }
  }

  const formatter = new Intl.DateTimeFormat('es-EC', {
    timeZone: BUSINESS_TIMEZONE,
    dateStyle: 'full',
    timeStyle: 'short',
  });

  return {
    currentDateTime: `${formatter.format(new Date())} (hora de ${BUSINESS_TIMEZONE})`,
    timeZone: BUSINESS_TIMEZONE,
  };
}
