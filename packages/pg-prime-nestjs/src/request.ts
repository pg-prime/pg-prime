import { SetMetadata } from '@nestjs/common'
import type {
  CallHandler,
  CustomDecorator,
  ExecutionContext,
  NestInterceptor,
} from '@nestjs/common'
import type { Reflector } from '@nestjs/core'
import type { Settings, TransactionHost } from '@pg-prime/context'
import { Observable, finalize, from, lastValueFrom, switchMap } from 'rxjs'
import type { Subscription } from 'rxjs'

export type RequestTxMode = 'never' | 'whenSettings' | 'always'

export interface RequestOptions {
  /** The request's settings, e.g. from the auth result a guard attached. */
  settings?(ctx: ExecutionContext): Settings | undefined | Promise<Settings | undefined>
  /** Default `'whenSettings'`: a transaction exactly when the settings are non-empty. */
  transaction?: RequestTxMode | ((ctx: ExecutionContext) => boolean | Promise<boolean>)
}

const MODE = 'pg-prime:request-transaction'

/** Overrides the module's request transaction mode for a controller or resolver; the handler's wins. */
export function RequestTransaction(mode: RequestTxMode): CustomDecorator {
  return SetMetadata(MODE, mode)
}

export class RequestInterceptor implements NestInterceptor {
  constructor(
    private readonly host: TransactionHost,
    private readonly reflector: Reflector,
    private readonly request: RequestOptions | undefined,
  ) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (!this.request && !this.host.pinned) return next.handle()
    return from(this.resolve(ctx)).pipe(
      switchMap(({ settings, tx }) => {
        const { host } = this
        if (tx) {
          const label = `${ctx.getClass().name}.${ctx.getHandler().name}`
          return host.request({ settings, transaction: { retry: false, label } }, () =>
            lastValueFrom(next.handle(), { defaultValue: undefined }),
          )
        }
        // The scope (under a pin, a savepoint) lasts until the stream ends or is unsubscribed.
        return new Observable((sub) => {
          let inner: Subscription | undefined
          const run = () =>
            new Promise<void>((resolve, reject) => {
              if (sub.closed) return resolve()
              inner = next
                .handle()
                .pipe(finalize(resolve))
                .subscribe({ next: (v) => sub.next(v), error: reject })
            })
          host.request({ settings }, run).then(
            () => sub.complete(),
            (e: unknown) => sub.error(e),
          )
          return () => inner?.unsubscribe()
        })
      }),
    )
  }

  private async resolve(ctx: ExecutionContext): Promise<{ settings: Settings; tx: boolean }> {
    const { request } = this
    if (!request) return { settings: {}, tx: false }
    const settings = (await request.settings?.(ctx)) ?? {}
    const mode =
      this.reflector.getAllAndOverride<RequestTxMode | undefined>(MODE, [
        ctx.getHandler(),
        ctx.getClass(),
      ]) ??
      request.transaction ??
      'whenSettings'
    const tx =
      typeof mode === 'function'
        ? await mode(ctx)
        : mode === 'always' || (mode === 'whenSettings' && Object.keys(settings).length > 0)
    return { settings, tx }
  }
}
