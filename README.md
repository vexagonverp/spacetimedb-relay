# spacetimedb-relay

Push-based message queue for [SpacetimeDB](https://spacetimedb.com). Enqueue messages in your module, and SpacetimeDB delivers them to registered webhook consumers via HTTP POST using [procedures](https://spacetimedb.com/docs/functions/procedures).

```
Producer (reducer) ──> Queue Table ──> Deliver (procedure) ──> HTTP POST ──> Consumer API
```

## Install

```bash
npm install spacetimedb-relay
```

Requires `spacetimedb ^2.0.0` as a peer dependency.

## Quick Start

In your SpacetimeDB module (`src/index.ts`):

```typescript
import { schema, table, t } from 'spacetimedb/server';
import { createQueue } from 'spacetimedb-relay/server';

// 1. Create a queue
const orderQueue = createQueue('order', t);
const q = orderQueue.tables;

// 2. Register queue tables in your schema
const spacetimedb = schema({
  order_queue:    table(q.queue.options,    q.queue.columns),
  order_consumer: table(q.consumer.options, q.consumer.columns),
  order_delivery: table(q.delivery.options, q.delivery.columns),

  // your own tables...
});
export default spacetimedb;

// 3. Export queue reducers & procedure (required for SpacetimeDB to register them)
export const enqueue_order       = orderQueue.enqueue(spacetimedb);
export const register_consumer   = orderQueue.registerConsumer(spacetimedb);
export const unregister_consumer = orderQueue.unregisterConsumer(spacetimedb);
export const deliver_order       = orderQueue.deliver(spacetimedb);
```

### Enqueue from your own reducers

```typescript
export const place_order = spacetimedb.reducer(
  { item: t.string(), quantity: t.u64() },
  (ctx, { item, quantity }) => {
    const row = ctx.db.order.insert({ id: 0n, item, quantity, ... });

    // Enqueue a message for delivery
    orderQueue.insertMessage(ctx, JSON.stringify({
      event: 'order.placed',
      orderId: row.id.toString(),
      item,
    }));
  }
);
```

### Register a consumer & deliver

```bash
# Register a webhook endpoint
spacetime call my-module register_consumer -- '"my-service"' '"https://api.example.com/webhook"' 'null'

# Deliver a pending message (HTTP POSTs to all active consumers)
spacetime call my-module deliver_order -- '1'
# → {"ok":true,"status":"delivered","results":[{"consumer":"my-service","success":true,"statusCode":200}]}
```

## How It Works

`createQueue(name, t)` generates config for **3 tables** and **4 exported functions**:

### Tables

| Table | Purpose |
|-------|---------|
| `{name}_queue` | Messages with status tracking (`pending` → `delivered` / `failed`) |
| `{name}_consumer` | Registered webhook endpoints |
| `{name}_delivery` | Per-consumer delivery log |

### Functions

| Export | Type | Purpose |
|--------|------|---------|
| `enqueue` | Reducer | Insert a pending message |
| `registerConsumer` | Reducer | Register a webhook URL |
| `unregisterConsumer` | Reducer | Remove a consumer |
| `deliver` | **Procedure** | Read message → HTTP POST to consumers → log results |

### Delivery Flow

The `deliver` procedure runs in three phases to satisfy SpacetimeDB's constraint that HTTP requests cannot happen inside a transaction:

1. **Read phase** (transaction) — Load the pending message and active consumers, bump attempt counter
2. **HTTP phase** (no transaction) — POST the payload to each consumer's webhook URL
3. **Write phase** (transaction) — Update message status, write delivery log entries

Failed deliveries stay `pending` until `maxRetries` is reached (default: 3), then move to `failed`.

## API

### `createQueue(name, t, options?)`

| Param | Type | Description |
|-------|------|-------------|
| `name` | `string` | Queue name prefix (e.g. `'order'` → tables `order_queue`, `order_consumer`, `order_delivery`) |
| `t` | `typeof t` | The `t` type-builder from your `spacetimedb/server` import |
| `options.public` | `boolean` | Make queue tables visible to clients. Default: `true` |
| `options.maxRetries` | `number` | Max delivery attempts before marking as failed. Default: `3` |

Returns a `QueueHandle` with:

- **`tables`** — `{ queue, consumer, delivery }` configs to pass to `table()`
- **`insertMessage(ctx, payload)`** — Insert a message from any reducer
- **`enqueue(spacetimedb)`** — Creates enqueue reducer
- **`registerConsumer(spacetimedb)`** — Creates register-consumer reducer
- **`unregisterConsumer(spacetimedb)`** — Creates unregister-consumer reducer
- **`deliver(spacetimedb)`** — Creates deliver procedure
- **`accessors`** — Table accessor names on `ctx.db`

## Queue Table Schema

### `{name}_queue`

| Column | Type | Description |
|--------|------|-------------|
| `id` | `u64` | Auto-increment primary key |
| `payload` | `string` | JSON message payload |
| `status` | `string` | `'pending'` / `'delivered'` / `'failed'` |
| `enqueuedAt` | `timestamp` | When the message was created |
| `deliveredAt` | `timestamp?` | When delivery succeeded |
| `attempts` | `u64` | Number of delivery attempts |
| `lastError` | `string?` | Last error details (JSON) |

### `{name}_consumer`

| Column | Type | Description |
|--------|------|-------------|
| `id` | `u64` | Auto-increment primary key |
| `consumerName` | `string` | Unique consumer name |
| `webhookUrl` | `string` | HTTP endpoint to POST to |
| `headers` | `string?` | Extra headers as JSON (e.g. auth tokens) |
| `active` | `bool` | Whether the consumer receives deliveries |
| `registeredBy` | `identity` | Who registered this consumer |
| `registeredAt` | `timestamp` | When registered |

### `{name}_delivery`

| Column | Type | Description |
|--------|------|-------------|
| `id` | `u64` | Auto-increment primary key |
| `messageId` | `u64` | References queue message |
| `consumerId` | `u64` | References consumer |
| `status` | `string` | `'success'` / `'failed'` |
| `statusCode` | `u64?` | HTTP response status code |
| `error` | `string?` | Error message if failed |
| `deliveredAt` | `timestamp` | When delivery was attempted |

## Example

See [examples/order](./examples/order) for a complete order queue example.

## License

MIT
