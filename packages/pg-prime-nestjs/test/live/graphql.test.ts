import { ApolloDriver } from '@nestjs/apollo'
import type { ApolloDriverConfig } from '@nestjs/apollo'
import { Inject } from '@nestjs/common'
import type { ExecutionContext } from '@nestjs/common'
import { GqlExecutionContext, GraphQLModule, Query, ResolveField, Resolver } from '@nestjs/graphql'
import { createMockPool } from '@pg-prime/testing'
import { defineSchema, pgPrime } from 'pg-prime'
import { describe, expect, it } from 'vitest'
import { PgPrimeModule, TransactionHost } from '../../src/index.js'
import { TENANT, serve } from '../fixture.js'

@Resolver('Item')
class Items {
  constructor(@Inject(TransactionHost) readonly host: TransactionHost) {}
  @Query('item')
  item() {
    return { tenant: this.host.settings[TENANT] ?? null, tx: this.host.inTransaction }
  }
  @ResolveField('fieldTenant')
  fieldTenant() {
    return this.host.settings[TENANT] ?? null
  }
  @ResolveField('fieldTx')
  fieldTx() {
    return this.host.inTransaction
  }
}

const typeDefs = `
  type Query { item: Item }
  type Item { tenant: String, tx: Boolean, fieldTenant: String, fieldTx: Boolean }
`
const settings = (ctx: ExecutionContext) => {
  const t = GqlExecutionContext.create(ctx).getContext<{
    req: { headers: Record<string, string> }
  }>().req.headers['x-tenant']
  return t ? { [TENANT]: t } : undefined
}

async function query(fieldResolverEnhancers: 'interceptors'[]) {
  const { app } = await serve({
    imports: [
      PgPrimeModule.forRoot({
        db: pgPrime({ pool: createMockPool(), schema: defineSchema({}) }),
        request: { settings },
      }),
      GraphQLModule.forRoot<ApolloDriverConfig>({
        driver: ApolloDriver,
        typeDefs,
        fieldResolverEnhancers,
        context: ({ req }: { req: unknown }) => ({ req }),
      }),
    ],
    providers: [Items],
  })
  const res = await fetch(`${await app.getUrl()}/graphql`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-tenant': 't1' },
    body: JSON.stringify({ query: '{ item { tenant tx fieldTenant fieldTx } }' }),
  })
  await app.close()
  return ((await res.json()) as { data: { item: unknown } }).data.item
}

describe('GraphQL', () => {
  it('a query resolver is scoped; a field resolver is not by default', async () => {
    expect(await query([])).toEqual({ tenant: 't1', tx: true, fieldTenant: null, fieldTx: false })
  })

  it("with fieldResolverEnhancers: ['interceptors'] each field gets its own scope and transaction", async () => {
    expect(await query(['interceptors'])).toEqual({
      tenant: 't1',
      tx: true,
      fieldTenant: 't1',
      fieldTx: true,
    })
  })
})
