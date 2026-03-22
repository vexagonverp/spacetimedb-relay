/**
 * Type definitions for spacetimedb-relay queue library.
 *
 * Uses actual types from the SpacetimeDB SDK. The library declares
 * `spacetimedb` as a peerDependency so both library and user module
 * share the same SDK instance.
 */

import type {
  t as typeBuilders,
  ReducerCtx,
  ProcedureCtx,
  TransactionCtx,
} from 'spacetimedb/server';

// ---------------------------------------------------------------------------
// SDK type aliases
// ---------------------------------------------------------------------------

/** The `t` type-builder object from `spacetimedb/server`. */
export type TypeBuilders = typeof typeBuilders;

/**
 * Structural interface for the Schema object returned by `schema()`.
 *
 * We can't use `Schema<S>` directly because it's invariant in S —
 * a `Schema<{order: ...}>` isn't assignable to `Schema<any>`.
 * Instead we define only the methods the library calls.
 */
export interface SpacetimeSchema {
  reducer(...args: any[]): any;
  procedure(...args: any[]): any;
}

/** Re-export SDK context types for convenience. */
export type { ReducerCtx, ProcedureCtx, TransactionCtx };

// ---------------------------------------------------------------------------
// Queue configuration
// ---------------------------------------------------------------------------

/** Options passed to `createQueue()`. */
export interface QueueOptions {
  /** Make queue tables publicly visible to all clients. @default true */
  public?: boolean;
  /** Maximum delivery attempts before marking as `'failed'`. @default 3 */
  maxRetries?: number;
}

// ---------------------------------------------------------------------------
// Table configs — returned by createQueue().tables
// ---------------------------------------------------------------------------

export interface IndexConfig {
  accessor: string;
  algorithm: 'btree';
  columns: readonly string[];
}

/** The two arguments the user passes to `table(options, columns)`. */
export interface TableConfig {
  options: {
    name: string;
    public: boolean;
    indexes?: IndexConfig[];
  };
  columns: Record<string, any>;
}

export interface QueueTableConfigs {
  /** Message queue table config — pass to `table()`. */
  queue: TableConfig;
  /** Consumer registry table config — pass to `table()`. */
  consumer: TableConfig;
  /** Delivery log table config — pass to `table()`. */
  delivery: TableConfig;
}

// ---------------------------------------------------------------------------
// Message statuses
// ---------------------------------------------------------------------------

export type MessageStatus = 'pending' | 'delivered' | 'failed';
export type DeliveryStatus = 'success' | 'failed';

// ---------------------------------------------------------------------------
// Delivery result (returned by the deliver procedure)
// ---------------------------------------------------------------------------

export interface ConsumerDeliveryResult {
  consumer: string;
  success: boolean;
  statusCode?: number;
  error?: string;
}

export interface DeliveryResult {
  ok: boolean;
  status: 'delivered' | 'retry';
  results: ConsumerDeliveryResult[];
}

export interface DeliveryError {
  ok: false;
  error: string;
}

// ---------------------------------------------------------------------------
// Queue handle — the object returned by createQueue()
// ---------------------------------------------------------------------------

export interface QueueHandle {
  /** Table configs — pass each to `table()` in your `schema()` call. */
  tables: QueueTableConfigs;

  /**
   * Insert a message into the queue from within a reducer.
   *
   * @param ctx  The reducer context (`ctx` or `tx` in a procedure).
   * @param payload  JSON string payload.
   */
  insertMessage(ctx: ReducerCtx<any>, payload: string): void;

  /**
   * Creates an enqueue reducer.
   * The returned value must be exported from your module.
   */
  enqueue(spacetimedb: SpacetimeSchema): any;

  /**
   * Creates a register-consumer reducer.
   * The returned value must be exported from your module.
   */
  registerConsumer(spacetimedb: SpacetimeSchema): any;

  /**
   * Creates an unregister-consumer reducer.
   * The returned value must be exported from your module.
   */
  unregisterConsumer(spacetimedb: SpacetimeSchema): any;

  /**
   * Creates the deliver procedure (HTTP push to all active consumers).
   * The returned value must be exported from your module.
   */
  deliver(spacetimedb: SpacetimeSchema): any;

  /** Table accessor names on `ctx.db` (e.g. `order_queue`). */
  accessors: QueueAccessors;
}

export interface QueueAccessors {
  queue: string;
  consumer: string;
  delivery: string;
}
