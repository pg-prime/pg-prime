/** The observability layer's internal barrel (design/07 §7). */

export { HookBus } from './bus.js'
export { nextQueryId, nextTxId } from './events.js'
export type {
  InternalEvent,
  NoticeEvent,
  PoolEvent,
  QueryEndEvent,
  QueryErrorEvent,
  QueryHooks,
  QueryOperation,
  QueryStartEvent,
  RetryEvent,
  TxEndEvent,
  TxStartEvent,
} from './events.js'
export { SEMCONV, spanAttributes, spanName } from './semconv.js'
export type { SpanAttributes, SpanContext } from './semconv.js'
export { queryErrorRecord, resolveLogOptions, shouldLog, slowQueryRecord } from './log.js'
export type { LogLevel, LogOptions, LogRecord, ResolvedLogOptions } from './log.js'
