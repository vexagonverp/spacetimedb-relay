import { table, t } from 'spacetimedb/server';

// --- Helpers ---

function toCamelCase(str: string): string {
  return str.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

// --- Types ---

export interface QueueOptions {
  /** Make queue tables publicly visible to all clients (default: true) */
  public?: boolean;
  /** Maximum delivery attempts before marking as failed (default: 3) */
  maxRetries?: number;
}

export interface QueueHandle {
  /** Spread into schema(): e.g. schema({ ...queue.tables }) */
  tables: Record<string, ReturnType<typeof table>>;

  /** Insert a message into the queue from within a reducer ctx */
  insertMessage(ctx: any, payload: string): void;

  /** Creates the enqueue reducer. Export the return value. */
  enqueue(spacetimedb: any): any;

  /** Creates the register_consumer reducer. Export the return value. */
  registerConsumer(spacetimedb: any): any;

  /** Creates the unregister_consumer reducer. Export the return value. */
  unregisterConsumer(spacetimedb: any): any;

  /** Creates the deliver procedure (HTTP push). Export the return value. */
  deliver(spacetimedb: any): any;

  /** Table accessor names for advanced usage */
  accessors: { queue: string; consumer: string; delivery: string };
}

// --- Main ---

/**
 * Creates a push-based message queue backed by SpacetimeDB tables.
 *
 * Usage in your SpacetimeDB module:
 * ```ts
 * import { createQueue } from 'spacetimedb-relay/server';
 *
 * const notifications = createQueue('notification');
 *
 * const spacetimedb = schema({
 *   ...notifications.tables,
 *   // your other tables...
 * });
 * export default spacetimedb;
 *
 * export const enqueue_notification   = notifications.enqueue(spacetimedb);
 * export const register_consumer      = notifications.registerConsumer(spacetimedb);
 * export const unregister_consumer    = notifications.unregisterConsumer(spacetimedb);
 * export const deliver_notification   = notifications.deliver(spacetimedb);
 * ```
 */
export function createQueue(name: string, options: QueueOptions = {}): QueueHandle {
  const { public: isPublic = true, maxRetries = 3 } = options;

  // Accessor names (camelCase of snake_case table names)
  const queueAccessor = toCamelCase(`${name}_queue`);
  const consumerAccessor = toCamelCase(`${name}_consumer`);
  const deliveryAccessor = toCamelCase(`${name}_delivery`);

  // --- Table definitions ---

  const queueTable = table(
    {
      name: `${name}_queue`,
      public: isPublic,
      indexes: [
        { accessor: `${name}_queue_status`, algorithm: 'btree' as const, columns: ['status'] },
      ],
    },
    {
      id: t.u64().primaryKey().autoInc(),
      payload: t.string(),
      status: t.string(), // 'pending' | 'delivered' | 'failed'
      enqueuedAt: t.timestamp(),
      deliveredAt: t.timestamp().optional(),
      attempts: t.u64(),
      lastError: t.string().optional(),
    }
  );

  const consumerTable = table(
    {
      name: `${name}_consumer`,
      public: isPublic,
    },
    {
      id: t.u64().primaryKey().autoInc(),
      name: t.string().unique(),
      webhookUrl: t.string(),
      headers: t.string().optional(), // JSON-encoded extra headers
      active: t.bool(),
      registeredBy: t.identity(),
      registeredAt: t.timestamp(),
    }
  );

  const deliveryTable = table(
    {
      name: `${name}_delivery`,
      public: isPublic,
      indexes: [
        { accessor: `${name}_delivery_message_id`, algorithm: 'btree' as const, columns: ['messageId'] },
        { accessor: `${name}_delivery_consumer_id`, algorithm: 'btree' as const, columns: ['consumerId'] },
      ],
    },
    {
      id: t.u64().primaryKey().autoInc(),
      messageId: t.u64(),
      consumerId: t.u64(),
      status: t.string(), // 'success' | 'failed'
      statusCode: t.u64().optional(),
      error: t.string().optional(),
      deliveredAt: t.timestamp(),
    }
  );

  // --- Tables object (spread into schema) ---

  const tables: Record<string, ReturnType<typeof table>> = {
    [queueAccessor]: queueTable,
    [consumerAccessor]: consumerTable,
    [deliveryAccessor]: deliveryTable,
  };

  // --- Direct insert helper (for use inside other reducers) ---

  function insertMessage(ctx: any, payload: string) {
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

  // --- Reducer/Procedure factories ---

  function enqueue(spacetimedb: any) {
    return spacetimedb.reducer(
      { payload: t.string() },
      (ctx: any, { payload }: { payload: string }) => {
        insertMessage(ctx, payload);
      }
    );
  }

  function registerConsumer(spacetimedb: any) {
    return spacetimedb.reducer(
      {
        name: t.string(),
        webhookUrl: t.string(),
        headers: t.string().optional(),
      },
      (ctx: any, args: { name: string; webhookUrl: string; headers?: string }) => {
        if (args.headers) {
          try {
            JSON.parse(args.headers);
          } catch {
            throw new Error('headers must be valid JSON');
          }
        }

        ctx.db[consumerAccessor].insert({
          id: 0n,
          name: args.name,
          webhookUrl: args.webhookUrl,
          headers: args.headers ?? undefined,
          active: true,
          registeredBy: ctx.sender,
          registeredAt: ctx.timestamp,
        });
      }
    );
  }

  function unregisterConsumer(spacetimedb: any) {
    return spacetimedb.reducer(
      { consumerId: t.u64() },
      (ctx: any, { consumerId }: { consumerId: bigint }) => {
        const consumer = ctx.db[consumerAccessor].id.find(consumerId);
        if (!consumer) throw new Error('Consumer not found');
        ctx.db[consumerAccessor].id.delete(consumerId);
      }
    );
  }

  function deliver(spacetimedb: any) {
    return spacetimedb.procedure(
      { messageId: t.u64() },
      t.string(), // JSON result summary
      (ctx: any, { messageId }: { messageId: bigint }) => {
        // Phase 1: Read message + active consumers (inside transaction)
        let message: any;
        let consumers: any[] = [];

        ctx.withTx((tx: any) => {
          message = tx.db[queueAccessor].id.find(messageId);
          for (const c of tx.db[consumerAccessor].iter()) {
            if (c.active) consumers.push(c);
          }

          // Bump attempt counter
          if (message && message.status === 'pending') {
            tx.db[queueAccessor].id.update({
              ...message,
              attempts: message.attempts + 1n,
            });
            message = { ...message, attempts: message.attempts + 1n };
          }
        });

        if (!message) {
          return JSON.stringify({ ok: false, error: 'Message not found' });
        }
        if (message.status !== 'pending') {
          return JSON.stringify({ ok: false, error: `Message status is '${message.status}', expected 'pending'` });
        }
        if (consumers.length === 0) {
          return JSON.stringify({ ok: false, error: 'No active consumers registered' });
        }

        // Phase 2: HTTP POST to each consumer (outside transaction)
        const results: Array<{
          consumerId: bigint;
          consumerName: string;
          success: boolean;
          statusCode?: number;
          error?: string;
        }> = [];

        for (const consumer of consumers) {
          try {
            const reqHeaders: Record<string, string> = {
              'Content-Type': 'application/json',
            };
            if (consumer.headers) {
              Object.assign(reqHeaders, JSON.parse(consumer.headers));
            }

            const response = ctx.http.fetch(consumer.webhookUrl, {
              method: 'POST',
              headers: reqHeaders,
              body: message.payload,
            });

            const statusCode: number = response.status ?? 200;
            const success = statusCode >= 200 && statusCode < 300;
            results.push({
              consumerId: consumer.id,
              consumerName: consumer.name,
              success,
              statusCode,
              error: success ? undefined : `HTTP ${statusCode}`,
            });
          } catch (err: any) {
            results.push({
              consumerId: consumer.id,
              consumerName: consumer.name,
              success: false,
              error: err?.message ?? String(err),
            });
          }
        }

        // Phase 3: Update message status + log deliveries (inside transaction)
        const allSuccess = results.every(r => r.success);

        ctx.withTx((tx: any) => {
          const msg = tx.db[queueAccessor].id.find(messageId);
          if (!msg) return;

          const finalStatus = allSuccess
            ? 'delivered'
            : msg.attempts >= BigInt(maxRetries)
              ? 'failed'
              : 'pending'; // stays pending for retry

          tx.db[queueAccessor].id.update({
            ...msg,
            status: finalStatus,
            deliveredAt: allSuccess ? tx.timestamp : msg.deliveredAt,
            lastError: allSuccess
              ? undefined
              : JSON.stringify(results.filter(r => !r.success)),
          });

          for (const result of results) {
            tx.db[deliveryAccessor].insert({
              id: 0n,
              messageId,
              consumerId: result.consumerId,
              status: result.success ? 'success' : 'failed',
              statusCode: result.statusCode != null ? BigInt(result.statusCode) : undefined,
              error: result.error ?? undefined,
              deliveredAt: tx.timestamp,
            });
          }
        });

        return JSON.stringify({
          ok: allSuccess,
          status: allSuccess ? 'delivered' : 'retry',
          results: results.map(r => ({
            consumer: r.consumerName,
            success: r.success,
            statusCode: r.statusCode,
            error: r.error,
          })),
        });
      }
    );
  }

  return {
    tables,
    insertMessage,
    enqueue,
    registerConsumer,
    unregisterConsumer,
    deliver,
    accessors: {
      queue: queueAccessor,
      consumer: consumerAccessor,
      delivery: deliveryAccessor,
    },
  };
}
