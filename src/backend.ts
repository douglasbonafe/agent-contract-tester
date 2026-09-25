// Fake SaaS backend: in-memory DB, Zod-validated tools, server-side permissions,
// fault injection and a call log. This is the system of record the tester trusts.
import { z } from 'zod';

export const seed = () => ({
  customers: { 'C-1': { name: 'Ada' }, 'C-2': { name: 'Bob' } } as Record<string, { name: string }>,
  subscriptions: {
    'C-1': { plan: 'pro', price: 20, status: 'active' },
    'C-2': { plan: 'team', price: 99, status: 'active' },
  } as Record<string, { plan: string; price: number; status: 'active' | 'cancelled' }>,
  refunds: [] as { customerId: string; amount: number }[],
});
export type DB = ReturnType<typeof seed>;

const customerArgs = z.object({ customerId: z.string().regex(/^C-\d+$/) }).strict();
export const schemas = {
  lookup_customer: customerArgs,
  get_subscription: customerArgs,
  cancel_subscription: customerArgs,
  request_refund: customerArgs.extend({ amount: z.number().positive().max(1000) }).strict(),
};
export type Tool = keyof typeof schemas;
export const NON_IDEMPOTENT: string[] = ['cancel_subscription', 'request_refund'];

export type Fault = 'error' | 'timeout';
export type Call = {
  tool: string;
  args: any;
  ok: boolean;
  result?: unknown;
  error?: string;
  ts: string;
  idempotencyKey?: string;
};
export type Result = { ok: true; result: any } | { ok: false; error: string };

// sessionCustomerId comes from authentication, never from the agent.
export function createBackend(sessionCustomerId: string, faults: Partial<Record<Tool, Fault>> = {}) {
  const db = seed();
  const log: Call[] = [];
  const idem = new Map<string, unknown>();
  const fired = new Set<string>();

  function apply(tool: Tool, a: any) {
    const sub = db.subscriptions[a.customerId];
    if (tool === 'lookup_customer') {
      if (!db.customers[a.customerId]) throw new Error('NOT_FOUND');
      return { customerId: a.customerId, ...db.customers[a.customerId] };
    }
    if (!sub) throw new Error('NOT_FOUND');
    if (tool === 'get_subscription') return { ...sub };
    if (tool === 'cancel_subscription') {
      if (sub.status !== 'active') throw new Error('NOT_ACTIVE');
      sub.status = 'cancelled';
      return { status: 'cancelled' };
    }
    db.refunds.push({ customerId: a.customerId, amount: a.amount });
    return { refunded: a.amount };
  }

  function call(tool: string, args: unknown, idempotencyKey?: string): Result {
    const entry: Call = { tool, args, ok: false, ts: new Date().toISOString(), idempotencyKey };
    log.push(entry);
    try {
      if (!(tool in schemas)) throw new Error('UNKNOWN_TOOL');
      const parsed = schemas[tool as Tool].safeParse(args);
      if (!parsed.success) throw new Error('INVALID_ARGS');
      const a = parsed.data;
      if (a.customerId !== sessionCustomerId) throw new Error('FORBIDDEN');
      const k = idempotencyKey && `${tool}:${idempotencyKey}`;
      if (k && idem.has(k)) return done(entry, idem.get(k));
      // ponytail: each fault fires once per backend, add a schedule if multi-failure scenarios matter
      const fault = fired.has(tool) ? undefined : faults[tool as Tool];
      if (fault) fired.add(tool);
      if (fault === 'error') throw new Error('UPSTREAM_ERROR');
      const result = apply(tool as Tool, a);
      if (k) idem.set(k, result);
      // Timeout = effect applied, client never hears back. The case that makes blind retries dangerous.
      if (fault === 'timeout') throw new Error('TIMEOUT');
      return done(entry, result);
    } catch (e) {
      entry.error = (e as Error).message;
      return { ok: false, error: entry.error };
    }
  }

  return { db, log, call, sessionCustomerId };
}
export type Backend = ReturnType<typeof createBackend>;

function done(entry: Call, result: unknown): Result {
  entry.ok = true;
  entry.result = result;
  return { ok: true, result };
}
