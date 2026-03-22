import { schema, table, t } from 'spacetimedb/server';
import { createQueue } from 'spacetimedb-relay/server';

// --- Queue setup ---
const orderQueue = createQueue('order', t);
const q = orderQueue.tables;

// --- Schema ---
const spacetimedb = schema({
  // Queue tables — user calls table() so SpacetimeDB bundler can see them
  order_queue:    table(q.queue.options,    q.queue.columns),
  order_consumer: table(q.consumer.options, q.consumer.columns),
  order_delivery: table(q.delivery.options, q.delivery.columns),

  // Your own tables
  order: table(
    {
      name: 'order',
      public: true,
      indexes: [
        { accessor: 'order_customer_id', algorithm: 'btree' as const, columns: ['customerId'] },
      ],
    },
    {
      id: t.u64().primaryKey().autoInc(),
      customerId: t.identity(),
      item: t.string(),
      quantity: t.u64(),
      status: t.string(),
      createdAt: t.timestamp(),
    }
  ),
});
export default spacetimedb;

// --- Lifecycle ---

export const init = spacetimedb.init(_ctx => {});
export const onConnect = spacetimedb.clientConnected(_ctx => {});
export const onDisconnect = spacetimedb.clientDisconnected(_ctx => {});

// --- Queue exports ---

export const enqueue_order = orderQueue.enqueue(spacetimedb);
export const register_consumer = orderQueue.registerConsumer(spacetimedb);
export const unregister_consumer = orderQueue.unregisterConsumer(spacetimedb);
export const deliver_order = orderQueue.deliver(spacetimedb);

// --- Order reducers ---

export const place_order = spacetimedb.reducer(
  { item: t.string(), quantity: t.u64() },
  (ctx, { item, quantity }) => {
    const row = ctx.db.order.insert({
      id: 0n,
      customerId: ctx.sender,
      item,
      quantity,
      status: 'placed',
      createdAt: ctx.timestamp,
    });

    orderQueue.insertMessage(
      ctx,
      JSON.stringify({
        event: 'order.placed',
        orderId: row.id.toString(),
        item,
        quantity: quantity.toString(),
        customerId: ctx.sender.toHexString(),
      })
    );
  }
);

export const update_order_status = spacetimedb.reducer(
  { orderId: t.u64(), status: t.string() },
  (ctx, { orderId, status }) => {
    const order = ctx.db.order.id.find(orderId);
    if (!order) throw new Error('Order not found');

    ctx.db.order.id.update({ ...order, status });

    orderQueue.insertMessage(
      ctx,
      JSON.stringify({
        event: `order.${status}`,
        orderId: orderId.toString(),
        item: order.item,
        status,
        customerId: order.customerId.toHexString(),
      })
    );
  }
);
