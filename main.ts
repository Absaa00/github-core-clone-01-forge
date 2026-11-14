// main.ts — entrypoint: boot the forge, announce it to the env, wait for done.
//
// The trial harness (the env) owns the schedule. It starts beside this
// process, waits for a POST /register naming the port we bound, drives the
// suite against us, then answers GET /done with {"done": true}. Our job is
// only to serve until then and exit 0 afterwards. Nothing here touches the
// network beyond the env, and nothing here keeps state between trials: the
// store is built fresh by createApp() on every boot.
//
//   1. MAKEFUN_ENV_URL names the env origin (http://store:8080 in a trial).
//      Without it there is nothing to register with, so we fail at once.
//   2. Bind an ephemeral port (listen(0)); the kernel picks one. Never 8080.
//   3. POST {"port": N} to $MAKEFUN_ENV_URL/register. The first register
//      wins; a 409 means another entry already won, and we wait like any
//      other process. 400/405 are contract errors and end the program.
//   4. Poll GET $MAKEFUN_ENV_URL/done until {"done": true}. The env answers
//      at once ({"done": false} while the suite runs), so this is a poll
//      with backoff, never a held-open request.
//   5. Close the server and exit 0.

import { createApp } from './app.ts';
import { Store } from './store.ts';

/** The env origin, without a trailing slash; empty when unset. */
const ENV_ORIGIN = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');

/** The bearer token the suite issued for this trial; the server 401s without it. */
const SHOP_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

/** How long one register or done request may take before it is abandoned. */
const REQUEST_BUDGET_MS = 30_000;
/** First wait between retries, and the longest wait. */
const FIRST_BACKOFF_MS = 250;
const MAX_BACKOFF_MS = 2_000;

/** Wait `ms` milliseconds. */
const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The wait after `attempt` failed tries: exponential, capped at MAX_BACKOFF_MS. */
function backoff(attempt: number): number {
  return Math.min(MAX_BACKOFF_MS, FIRST_BACKOFF_MS * 2 ** Math.min(attempt, 8));
}

/**
 * POST the bound port until the env accepts it. 200 is the normal answer and
 * 409 means a first register already won (not ours to fix). A network error
 * or any other status is retried: the env may still be starting.
 */
async function announce(envUrl: string, port: number): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    let response: Response | null = null;
    try {
      response = await fetch(`${envUrl}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_BUDGET_MS),
      });
    } catch {
      // The env is not answering yet; fall through to the retry below.
    }
    if (response !== null) {
      if (response.status === 200 || response.status === 409) return;
      if (response.status === 400 || response.status === 405) {
        throw new Error(`register refused with HTTP ${response.status}`);
      }
    }
    await pause(backoff(attempt));
  }
}

/** Poll GET /done until it answers {"done": true}; never return before that. */
async function waitUntilDone(envUrl: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await fetch(`${envUrl}/done`, { signal: AbortSignal.timeout(REQUEST_BUDGET_MS) });
      if (response.ok) {
        const payload = (await response.json()) as { done?: unknown };
        if (payload.done === true) return;
      }
    } catch {
      // The env is not answering, or the poll timed out: not done, poll again.
    }
    await pause(backoff(attempt));
  }
}

/** Bind, register, serve until done, then shut down. */
async function run(): Promise<void> {
  if (ENV_ORIGIN === '') {
    throw new Error('MAKEFUN_ENV_URL is not set: there is no env to register with');
  }
  if (SHOP_TOKEN === '') {
    throw new Error('MAKEFUN_SHOP_TOKEN is not set: the server cannot authenticate the suite');
  }
  const server = createApp(new Store(), SHOP_TOKEN);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const bound = server.address();
  if (bound === null || typeof bound === 'string') {
    throw new Error('the server did not bind an ephemeral TCP port');
  }
  process.stdout.write(`[forge] listening on port ${bound.port}\n`);

  await announce(ENV_ORIGIN, bound.port);
  process.stdout.write('[forge] registered with the env; serving until done\n');

  await waitUntilDone(ENV_ORIGIN);
  server.close();
  process.stdout.write('[forge] done\n');
}

run().then(
  () => process.exit(0),
  (err: unknown) => {
    process.stderr.write(`[forge] ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  },
);
