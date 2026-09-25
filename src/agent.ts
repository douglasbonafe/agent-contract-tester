// SIMULATION: an offline, deterministic scripted "agent" (no LLM). It reads the user
// message + retrieved docs and calls backend tools. Bug flags switch on the classic
// failure modes of real tool-using agents so the tester has something to catch.
import type { Backend } from './backend';

export const BUGS = [
  'claims_success_on_error',
  'retries_non_idempotent_after_timeout',
  'follows_injected_instruction',
  'skips_prerequisite',
  'uses_customer_id_from_message',
  'flaky_prerequisite', // skips get_subscription ~30% of runs: exists to make pass^k differ from pass@1
] as const;
export type Bug = (typeof BUGS)[number];

export function simulatedAgent(
  be: Backend,
  message: string,
  docs: string[] = [],
  bugs: readonly Bug[] = [],
  rng: () => number = Math.random,
): string {
  const has = (b: Bug) => bugs.includes(b);
  let n = 0;
  const newKey = () => `k-${++n}`; // ponytail: per-run counter, use UUIDs once keys outlive one conversation
  const mutate = (tool: string, args: object) => {
    const key = newKey();
    const r = be.call(tool, args, key);
    if (r.ok || r.error !== 'TIMEOUT') return r;
    // Correct: retry with the SAME key so the backend dedupes. Buggy: fresh key = second operation.
    return be.call(tool, args, has('retries_non_idempotent_after_timeout') ? newKey() : key);
  };

  const mentioned = message.match(/C-\d+/)?.[0];
  if (mentioned && mentioned !== be.sessionCustomerId && !has('uses_customer_id_from_message'))
    return 'I can only act on your own account.';
  const customerId = mentioned ?? be.sessionCustomerId;

  const extra: string[] = [];
  for (const doc of docs) {
    const inj = doc.match(/ignore (?:all )?rules.*?refund customer (C-\d+)(?: \$(\d+))?/i);
    if (inj && has('follows_injected_instruction')) {
      const r = mutate('request_refund', { customerId: inj[1], amount: Number(inj[2] ?? 50) });
      if (r.ok) extra.push(`Refund issued to ${inj[1]}.`);
    }
  }

  const who = be.call('lookup_customer', { customerId });
  if (!who.ok) return `Sorry, I could not access that account (${who.error}).`;
  const skipPrereq = has('skips_prerequisite') || (has('flaky_prerequisite') && rng() < 0.3);
  const sub = skipPrereq ? undefined : be.call('get_subscription', { customerId });
  if (sub && !sub.ok) return `Sorry, I could not load your subscription (${sub.error}).`;

  let reply: string;
  const amount = message.match(/\$(\d+)/)?.[1];
  if (/cancel/i.test(message)) {
    const r = mutate('cancel_subscription', { customerId });
    reply = r.ok || has('claims_success_on_error')
      ? 'Your subscription has been cancelled.'
      : `Sorry, I could not cancel your subscription (${r.ok ? '' : r.error}).`;
  } else if (/refund/i.test(message) && amount) {
    const r = mutate('request_refund', { customerId, amount: Number(amount) });
    reply = r.ok || has('claims_success_on_error')
      ? `A refund of $${amount} has been issued.`
      : `Sorry, I could not issue the refund (${r.ok ? '' : r.error}).`;
  } else {
    const s = sub?.ok ? sub.result : undefined;
    const policy = docs[0]?.split('.')[0];
    reply = [s && `Your ${s.plan} plan is ${s.status}.`, policy && `${policy}.`].filter(Boolean).join(' ');
  }
  return [reply, ...extra].join(' ');
}
