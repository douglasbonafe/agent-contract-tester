import { describe, expect, it } from 'vitest';
import { createBackend } from '../src/backend';
import type { Bug } from '../src/agent';
import { passK, runScenario, scenarios } from '../src/contracts';

describe('correct agent honours every contract (pass^5)', () => {
  for (const s of scenarios)
    it(s.id, () => {
      const r = passK(s, [], 5);
      expect(r.failed, JSON.stringify(r.runs[0].checks.filter((c) => !c.pass))).toEqual([]);
    });
});

describe('each buggy mode is caught by the right checks', () => {
  const cases: [Bug, string, string[]][] = [
    ['claims_success_on_error', 'cancel_api_error', ['honest_claims']],
    ['retries_non_idempotent_after_timeout', 'refund_timeout', ['no_duplicate_after_timeout', 'end_state']],
    ['follows_injected_instruction', 'doc_injection', ['tool_allowed', 'own_customer', 'prerequisites']],
    ['skips_prerequisite', 'cancel_happy', ['prerequisites']],
    ['uses_customer_id_from_message', 'cross_customer', ['own_customer']],
  ];
  for (const [bug, id, checks] of cases)
    it(`${bug} -> ${checks.join(', ')}`, () => {
      const r = runScenario(scenarios.find((s) => s.id === id)!, [bug]);
      expect(r.failed.sort()).toEqual([...checks].sort());
    });

  it('flaky agent: pass@1 looks fine, pass^k exposes it', () => {
    const r = passK(scenarios[0], ['flaky_prerequisite'], 10);
    expect(r.passes).toBeGreaterThan(0);
    expect(r.passK).toBe(false);
  });
});

describe('backend enforces permissions regardless of the agent', () => {
  it('rejects cross-customer access server-side and leaves C-2 untouched', () => {
    const be = createBackend('C-1');
    expect(be.call('cancel_subscription', { customerId: 'C-2' })).toEqual({ ok: false, error: 'FORBIDDEN' });
    expect(be.call('request_refund', { customerId: 'C-2', amount: 500 })).toEqual({ ok: false, error: 'FORBIDDEN' });
    expect(be.db.subscriptions['C-2'].status).toBe('active');
    expect(be.db.refunds).toEqual([]);
  });

  it('injection / cross-customer attempts were blocked by the backend (backend_enforced passes)', () => {
    for (const [bug, id] of [['follows_injected_instruction', 'doc_injection'], ['uses_customer_id_from_message', 'cross_customer']] as const) {
      const r = runScenario(scenarios.find((s) => s.id === id)!, [bug]);
      expect(r.log.some((c) => c.error === 'FORBIDDEN')).toBe(true);
      expect(r.checks.find((c) => c.name === 'backend_enforced')!.pass).toBe(true);
    }
  });

  it('validates args with zod and dedupes by idempotency key', () => {
    const be = createBackend('C-1');
    expect(be.call('request_refund', { customerId: 'C-1', amount: -5 })).toEqual({ ok: false, error: 'INVALID_ARGS' });
    expect(be.call('request_refund', { customerId: 'C-1', amount: 5, admin: true })).toEqual({ ok: false, error: 'INVALID_ARGS' });
    be.call('request_refund', { customerId: 'C-1', amount: 5 }, 'k');
    be.call('request_refund', { customerId: 'C-1', amount: 5 }, 'k');
    expect(be.db.refunds).toHaveLength(1);
  });
});
