// The entry's life, end to end: bind a port the kernel chooses, tell the env
// where to find this process, then idle until the env ends the trial.
//
// The env is the only other party. MAKEFUN_ENV_URL is its origin; without one
// there is nobody to register with and nothing to serve, so the process stops
// before it starts. Registration is a single POST of {"port": N} to
// $MAKEFUN_ENV_URL/register — the env notes the caller's address together
// with N and reaches the server at that base from then on. The first
// registration wins: a 409 later is the env saying so, not a failure. After
// registering, the process polls GET $MAKEFUN_ENV_URL/done; the env answers
// {"done": false} while the suite runs and {"done": true} when it is over,
// and only then does the process close its server and exit 0.
//
// Both calls retry forever with a doubling pause (250 ms up to 2 s) whenever
// the env does not answer cleanly — it may still be starting — and each
// attempt gives up after 30 s. The two contract answers, 400 and 405 on
// register, are the exception: they mean this process spoke the protocol
// wrong, so it reports them and exits 1 instead of retrying.

import { createApp } from './app.ts';

/** Fatal protocol error: the env answered, and the answer ends the program. */
class ContractError extends Error {}

const envOrigin = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (envOrigin === '') {
  process.stderr.write('[entry] MAKEFUN_ENV_URL missing: no env to register with, exiting\n');
  process.exit(1);
}

const ATTEMPT_DEADLINE_MS = 30_000;
const FIRST_PAUSE_MS = 250;
const LONGEST_PAUSE_MS = 2_000;

const pause = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * Run `attempt` until it reports success, pausing longer after each failure.
 * A ContractError is never retried: it propagates and ends the program.
 */
async function untilDone(attempt: () => Promise<boolean>): Promise<void> {
  let wait = FIRST_PAUSE_MS;
  for (;;) {
    let finished = false;
    try {
      finished = await attempt();
    } catch (err) {
      if (err instanceof ContractError) throw err;
      finished = false; // the env is unreachable or still starting: try again
    }
    if (finished) return;
    await pause(wait);
    wait = Math.min(LONGEST_PAUSE_MS, wait * 2);
  }
}

/** One registration attempt: true once the env holds this process's port. */
async function registerOnce(port: number): Promise<boolean> {
  const res = await fetch(`${envOrigin}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ port }),
    signal: AbortSignal.timeout(ATTEMPT_DEADLINE_MS),
  });
  if (res.status === 200 || res.status === 409) return true;
  if (res.status === 400 || res.status === 405) {
    throw new ContractError(`register refused with HTTP ${res.status}: ${await res.text()}`);
  }
  return false;
}

/** One done poll: true only when the env's body says the trial is over. */
async function doneOnce(): Promise<boolean> {
  const res = await fetch(`${envOrigin}/done`, { signal: AbortSignal.timeout(ATTEMPT_DEADLINE_MS) });
  if (!res.ok) return false;
  const body = (await res.json()) as { done?: unknown };
  return body.done === true;
}

/** Bind, register, wait: everything this process exists to do. */
async function run(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => { resolve(); });
  });
  const bound = server.address();
  if (bound === null || typeof bound === 'string') {
    throw new Error('the server bound no ephemeral TCP port');
  }
  process.stdout.write(`[entry] serving on ephemeral port ${bound.port}\n`);

  await untilDone(() => registerOnce(bound.port));
  process.stdout.write('[entry] registered with the env; polling for done\n');

  await untilDone(doneOnce);
  server.close();
  process.stdout.write('[entry] the env said done; shutting down\n');
}

run().then(
  () => { process.exit(0); },
  (err: unknown) => {
    process.stderr.write(`[entry] ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  },
);
