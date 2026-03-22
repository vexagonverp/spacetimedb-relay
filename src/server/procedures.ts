/**
 * Procedure factory for the relay queue delivery.
 *
 * The deliver procedure runs in three phases to satisfy SpacetimeDB's
 * constraint that HTTP requests cannot happen inside a transaction:
 *
 *   Phase 1 (tx):  Read the pending message + active consumers, bump attempts.
 *   Phase 2 (no tx): HTTP POST to each consumer.
 *   Phase 3 (tx):  Update message status + write delivery log entries.
 */

import type {
  TypeBuilders,
  SpacetimeSchema,
  QueueAccessors,
  MessageStatus,
  ConsumerDeliveryResult,
} from './types';

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface DeliverFactory {
  (spacetimedb: SpacetimeSchema): any;
}

export function makeDeliverFactory(
  t: TypeBuilders,
  accessors: QueueAccessors,
  maxRetries: number,
): DeliverFactory {
  return (spacetimedb) =>
    spacetimedb.procedure(
      { messageId: t.u64() },
      t.string(),
      (ctx: any, { messageId }: { messageId: bigint }) =>
        deliverMessage(ctx, accessors, maxRetries, messageId),
    );
}

// ---------------------------------------------------------------------------
// Core delivery logic
// ---------------------------------------------------------------------------

interface ConsumerRow {
  id: bigint;
  consumerName: string;
  webhookUrl: string;
  headers?: string;
  active: boolean;
}

interface MessageRow {
  id: bigint;
  payload: string;
  status: string;
  attempts: bigint;
  deliveredAt?: any;
}

function deliverMessage(
  ctx: any,
  acc: QueueAccessors,
  maxRetries: number,
  messageId: bigint,
): string {
  // --- Phase 1: read inside transaction ---
  const { message, consumers } = readPhase(ctx, acc, messageId);

  if (!message) {
    return fail('Message not found');
  }
  if (message.status !== 'pending') {
    return fail(`Message status is '${message.status}', expected 'pending'`);
  }
  if (consumers.length === 0) {
    return fail('No active consumers registered');
  }

  // --- Phase 2: HTTP POST outside transaction ---
  const results = httpPhase(ctx, message, consumers);

  // --- Phase 3: persist results inside transaction ---
  const allSuccess = results.every((r) => r.success);
  writePhase(ctx, acc, messageId, results, allSuccess, maxRetries);

  return JSON.stringify({
    ok: allSuccess,
    status: allSuccess ? 'delivered' : 'retry',
    results: results.map(({ consumerId: _id, ...rest }) => rest),
  });
}

// ---------------------------------------------------------------------------
// Phase 1 — transactional read
// ---------------------------------------------------------------------------

interface ReadResult {
  message: MessageRow | null;
  consumers: ConsumerRow[];
}

function readPhase(ctx: any, acc: QueueAccessors, messageId: bigint): ReadResult {
  let message: MessageRow | null = null;
  const consumers: ConsumerRow[] = [];

  ctx.withTx((tx: any) => {
    message = tx.db[acc.queue].id.find(messageId) ?? null;

    for (const c of tx.db[acc.consumer].iter()) {
      if (c.active) consumers.push(c);
    }

    // Bump attempt counter
    if (message && message.status === 'pending') {
      const updated = { ...message, attempts: message.attempts + 1n };
      tx.db[acc.queue].id.update(updated);
      message = updated;
    }
  });

  return { message, consumers };
}

// ---------------------------------------------------------------------------
// Phase 2 — HTTP delivery (no transaction)
// ---------------------------------------------------------------------------

interface InternalDeliveryResult extends ConsumerDeliveryResult {
  consumerId: bigint;
}

function httpPhase(
  ctx: any,
  message: MessageRow,
  consumers: ConsumerRow[],
): InternalDeliveryResult[] {
  const results: InternalDeliveryResult[] = [];

  for (const consumer of consumers) {
    results.push(deliverToConsumer(ctx, message, consumer));
  }

  return results;
}

function deliverToConsumer(
  ctx: any,
  message: MessageRow,
  consumer: ConsumerRow,
): InternalDeliveryResult {
  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (consumer.headers) {
      Object.assign(headers, JSON.parse(consumer.headers));
    }

    const response = ctx.http.fetch(consumer.webhookUrl, {
      method: 'POST',
      headers,
      body: message.payload,
    });

    const statusCode: number = response.status ?? 200;
    const success = statusCode >= 200 && statusCode < 300;

    return {
      consumerId: consumer.id,
      consumer: consumer.consumerName,
      success,
      statusCode,
      error: success ? undefined : `HTTP ${statusCode}`,
    };
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    return {
      consumerId: consumer.id,
      consumer: consumer.consumerName,
      success: false,
      error: errorMessage,
    };
  }
}

// ---------------------------------------------------------------------------
// Phase 3 — transactional write
// ---------------------------------------------------------------------------

function writePhase(
  ctx: any,
  acc: QueueAccessors,
  messageId: bigint,
  results: InternalDeliveryResult[],
  allSuccess: boolean,
  maxRetries: number,
): void {
  ctx.withTx((tx: any) => {
    const msg = tx.db[acc.queue].id.find(messageId);
    if (!msg) return;

    const finalStatus: MessageStatus = allSuccess
      ? 'delivered'
      : msg.attempts >= BigInt(maxRetries)
        ? 'failed'
        : 'pending'; // stays pending for retry

    tx.db[acc.queue].id.update({
      ...msg,
      status: finalStatus,
      deliveredAt: allSuccess ? tx.timestamp : msg.deliveredAt,
      lastError: allSuccess
        ? undefined
        : JSON.stringify(results.filter((r) => !r.success)),
    });

    // Write delivery log entries
    for (const result of results) {
      tx.db[acc.delivery].insert({
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
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fail(error: string): string {
  return JSON.stringify({ ok: false, error });
}
