/**
 * Table configuration builders for the relay queue.
 *
 * Returns plain config objects — the user calls `table()` themselves
 * so the SpacetimeDB bundler can see the table definitions.
 */

import type { TypeBuilders, QueueTableConfigs, TableConfig, IndexConfig } from './types';

/**
 * Build the three table configs for a queue.
 *
 * @param name     Queue name prefix (e.g. `'order'` → tables `order_queue`, `order_consumer`, `order_delivery`)
 * @param t        The `t` type-builder from the caller's `spacetimedb/server`
 * @param isPublic Whether the tables are publicly visible to clients
 */
export function buildTableConfigs(
  name: string,
  t: TypeBuilders,
  isPublic: boolean,
): QueueTableConfigs {
  return {
    queue: buildQueueTable(name, t, isPublic),
    consumer: buildConsumerTable(name, t, isPublic),
    delivery: buildDeliveryTable(name, t, isPublic),
  };
}

// ---------------------------------------------------------------------------
// Individual table builders
// ---------------------------------------------------------------------------

function buildQueueTable(name: string, t: TypeBuilders, isPublic: boolean): TableConfig {
  return {
    options: {
      name: `${name}_queue`,
      public: isPublic,
      indexes: [
        idx(`${name}_queue_status`, ['status']),
      ],
    },
    columns: {
      id: t.u64().primaryKey().autoInc(),
      payload: t.string(),
      status: t.string(),           // MessageStatus: 'pending' | 'delivered' | 'failed'
      enqueuedAt: t.timestamp(),
      deliveredAt: t.timestamp().optional(),
      attempts: t.u64(),
      lastError: t.string().optional(),
    },
  };
}

function buildConsumerTable(name: string, t: TypeBuilders, isPublic: boolean): TableConfig {
  return {
    options: {
      name: `${name}_consumer`,
      public: isPublic,
    },
    columns: {
      id: t.u64().primaryKey().autoInc(),
      consumerName: t.string().unique(),
      webhookUrl: t.string(),
      headers: t.string().optional(), // JSON-encoded extra headers
      active: t.bool(),
      registeredBy: t.identity(),
      registeredAt: t.timestamp(),
    },
  };
}

function buildDeliveryTable(name: string, t: TypeBuilders, isPublic: boolean): TableConfig {
  return {
    options: {
      name: `${name}_delivery`,
      public: isPublic,
      indexes: [
        idx(`${name}_delivery_message_id`, ['messageId']),
        idx(`${name}_delivery_consumer_id`, ['consumerId']),
      ],
    },
    columns: {
      id: t.u64().primaryKey().autoInc(),
      messageId: t.u64(),
      consumerId: t.u64(),
      status: t.string(),            // DeliveryStatus: 'success' | 'failed'
      statusCode: t.u64().optional(),
      error: t.string().optional(),
      deliveredAt: t.timestamp(),
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function idx(accessor: string, columns: string[]): IndexConfig {
  return { accessor, algorithm: 'btree', columns };
}
