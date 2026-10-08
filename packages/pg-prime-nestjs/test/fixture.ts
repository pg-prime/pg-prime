import 'reflect-metadata'
import { Catch } from '@nestjs/common'
import type {
  ArgumentsHost,
  CanActivate,
  ExceptionFilter,
  ExecutionContext,
  ModuleMetadata,
} from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { UniqueViolationError } from 'pg-prime'
import type { Queryable } from 'pg-prime'

export const TENANT = 'app.tenant_id'

/** Stands in for an auth guard: the request's tenant comes from a header. */
export class Auth implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest()
    const t = req.headers['x-tenant']
    if (t) req.auth = { tenant: t }
    return true
  }
}

export const tenantSettings = (ctx: ExecutionContext) => {
  const t = ctx.switchToHttp().getRequest().auth?.tenant as string | undefined
  return t ? { [TENANT]: t } : undefined
}

@Catch(UniqueViolationError)
export class Conflict implements ExceptionFilter {
  catch(_e: unknown, host: ArgumentsHost) {
    host.switchToHttp().getResponse().status(409).json({ conflict: true })
  }
}

export const tenantOf = async (q: Queryable<any>) =>
  ((await q.sql`select current_setting(${TENANT}, true) as t`.executeTakeFirst())!['t'] || null) as
    | string
    | null

/** An HTTP app on a random port; `call` sends `x-tenant` when given one. */
export async function serve(meta: ModuleMetadata) {
  const ref = await Test.createTestingModule(meta).compile()
  const app = ref.createNestApplication({ logger: false })
  app.useGlobalFilters(new Conflict())
  await app.listen(0, '127.0.0.1')
  const base = await app.getUrl()
  const call = async (path: string, tenant?: string, method = 'GET') => {
    const res = await fetch(base + path, { method, headers: tenant ? { 'x-tenant': tenant } : {} })
    return { status: res.status, body: (await res.json()) as any }
  }
  return {
    app,
    call,
    get: async (path: string, tenant?: string) => (await call(path, tenant)).body,
  }
}
