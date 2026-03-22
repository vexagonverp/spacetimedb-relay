/**
 * Reducer factories for the relay queue.
 *
 * Each factory takes a `spacetimedb` Schema instance and returns
 * a ReducerExport that the user must re-export from their module.
 */

import type { TypeBuilders, SpacetimeSchema, QueueAccessors } from './types';

// ---------------------------------------------------------------------------
// Enqueue
// ---------------------------------------------------------------------------

export interface EnqueueFactory {
  (spacetimedb: SpacetimeSchema): any;
}

export function makeEnqueueFactory(
  t: TypeBuilders,
  accessors: QueueAccessors,
): EnqueueFactory {
  return (spacetimedb) =>
    spacetimedb.reducer(
      { payload: t.string() },
      (ctx: any, { payload }: { payload: string }) => {
        insertMessageInto(ctx, accessors.queue, payload);
      },
    );
}

// ---------------------------------------------------------------------------
// Register consumer
// ---------------------------------------------------------------------------

export interface RegisterConsumerFactory {
  (spacetimedb: SpacetimeSchema): any;
}

interface RegisterConsumerArgs {
  consumerName: string;
  webhookUrl: string;
  headers?: string;
}

export function makeRegisterConsumerFactory(
  t: TypeBuilders,
  accessors: QueueAccessors,
): RegisterConsumerFactory {
  return (spacetimedb) =>
    spacetimedb.reducer(
      {
        consumerName: t.string(),
        webhookUrl: t.string(),
        headers: t.string().optional(),
      },
      (ctx: any, args: RegisterConsumerArgs) => {
        if (args.headers) {
          try {
            JSON.parse(args.headers);
          } catch {
            throw new Error('headers must be valid JSON');
          }
        }

        ctx.db[accessors.consumer].insert({
          id: 0n,
          consumerName: args.consumerName,
          webhookUrl: args.webhookUrl,
          headers: args.headers ?? undefined,
          active: true,
          registeredBy: ctx.sender,
          registeredAt: ctx.timestamp,
        });
      },
    );
}

// ---------------------------------------------------------------------------
// Unregister consumer
// ---------------------------------------------------------------------------

export interface UnregisterConsumerFactory {
  (spacetimedb: SpacetimeSchema): any;
}

export function makeUnregisterConsumerFactory(
  t: TypeBuilders,
  accessors: QueueAccessors,
): UnregisterConsumerFactory {
  return (spacetimedb) =>
    spacetimedb.reducer(
      { consumerId: t.u64() },
      (ctx: any, { consumerId }: { consumerId: bigint }) => {
        const consumer = ctx.db[accessors.consumer].id.find(consumerId);
        if (!consumer) throw new Error('Consumer not found');
        ctx.db[accessors.consumer].id.delete(consumerId);
      },
    );
}

// ---------------------------------------------------------------------------
// Insert helper (shared by enqueue reducer + user code)
// ---------------------------------------------------------------------------

/**
 * Insert a pending message into the queue table.
 * Usable from any reducer context or transaction context.
 */
export function insertMessageInto(
  ctx: any,
  queueAccessor: string,
  payload: string,
): void {
  ctx.db[queueAccessor].insert({
    id: 0n,
    payload,
    status: 'pending',
    enqueuedAt: ctx.timestamp,
    deliveredAt: undefined,
    attempts: 0n,
    lastError: undefined,
  });
}
