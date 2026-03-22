/**
 * spacetimedb-relay — push-based message queue for SpacetimeDB.
 *
 * `createQueue()` is the main entry point. It returns table configs,
 * reducer/procedure factories, and an `insertMessage` helper.
 *
 * @example
 * ```ts
 * import { schema, table, t } from 'spacetimedb/server';
 * import { createQueue } from 'spacetimedb-relay/server';
 *
 * const q = createQueue('order', t);
 *
 * const spacetimedb = schema({
 *   order_queue:    table(q.tables.queue.options,    q.tables.queue.columns),
 *   order_consumer: table(q.tables.consumer.options, q.tables.consumer.columns),
 *   order_delivery: table(q.tables.delivery.options, q.tables.delivery.columns),
 * });
 * export default spacetimedb;
 *
 * export const enqueue_order       = q.enqueue(spacetimedb);
 * export const register_consumer   = q.registerConsumer(spacetimedb);
 * export const unregister_consumer = q.unregisterConsumer(spacetimedb);
 * export const deliver_order       = q.deliver(spacetimedb);
 * ```
 */

import type {
  TypeBuilders,
  QueueOptions,
  QueueHandle,
  QueueAccessors,
} from './types';
import { buildTableConfigs } from './tables';
import {
  makeEnqueueFactory,
  makeRegisterConsumerFactory,
  makeUnregisterConsumerFactory,
  insertMessageInto,
} from './reducers';
import { makeDeliverFactory } from './procedures';

/**
 * Create a push-based message queue backed by SpacetimeDB tables.
 *
 * @param name     Queue name prefix (e.g. `'order'` → `order_queue`, `order_consumer`, `order_delivery`)
 * @param t        The `t` type-builder from your module's `spacetimedb/server` import
 * @param options  Optional configuration
 */
export function createQueue(
  name: string,
  t: TypeBuilders,
  options: QueueOptions = {},
): QueueHandle {
  const { public: isPublic = true, maxRetries = 3 } = options;

  const accessors: QueueAccessors = {
    queue: `${name}_queue`,
    consumer: `${name}_consumer`,
    delivery: `${name}_delivery`,
  };

  const tables = buildTableConfigs(name, t, isPublic);

  return {
    tables,

    insertMessage(ctx, payload) {
      insertMessageInto(ctx, accessors.queue, payload);
    },

    enqueue: makeEnqueueFactory(t, accessors),
    registerConsumer: makeRegisterConsumerFactory(t, accessors),
    unregisterConsumer: makeUnregisterConsumerFactory(t, accessors),
    deliver: makeDeliverFactory(t, accessors, maxRetries),

    accessors,
  };
}
