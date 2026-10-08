import { describe, expect, it } from 'vitest'
import { createMockPool } from '@pg-prime/testing'
import { defineSchema, pgPrime } from 'pg-prime'
import type { RawQuery } from 'pg-prime'
import { colsOf } from '../../src/define.js'
import { defineSchedule } from '../../src/index.js'
import { advance, claim, due, pickup, trigger, wakeIn } from '../../src/sql/claim.js'
import { expire, gate, retain, unclaimed } from '../../src/sql/maintenance.js'
import { finish, heartbeat, markCancelling } from '../../src/sql/runs.js'
import * as S from '../../src/sql/schedules.js'
import { tables } from '../../src/sql/tables.js'

const db = pgPrime({ pool: createMockPool(), schema: defineSchema({}) })
const t = tables('pgprime_cron')
const at = new Date('2026-01-01T00:00:00Z')
const k1 = (decided: 'missed' | 'enqueued' | null) =>
  claim(db, t, {
    name: 'a',
    expect: at,
    fire: at,
    decided,
    missed: 0,
    next: at,
    leaseMs: 1,
    instance: 'i',
    payload: null,
  })
const cols = colsOf(defineSchedule('a', { everyMs: 1000 }, { handler: async () => {} }))
const upsert = { name: 'a', cols, hash: 'h', source: 'code' as const, next: at, anchor: at }

const statements: Record<string, RawQuery> = {
  Q1: due(db, t, ['a']),
  wakeIn: wakeIn(db, t, ['a']),
  'K1 handler': k1(null),
  'K1 missed': k1('missed'),
  'K1 enqueued': k1('enqueued'),
  advance: advance(db, t, 'a', at, null),
  T1: trigger(db, t, { name: 'a', instance: 'i', payload: null, channel: 'c' }),
  T2: pickup(db, t, { mine: ['a'], limit: 1, leaseMs: 1, instance: 'i' }),
  heartbeat: heartbeat(db, t, [{ id: 1n, token: 'x' }], 1),
  F1: finish(db, t, {
    id: 1n,
    token: 'x',
    state: 'succeeded',
    error: null,
    result: null,
    attempts: 1,
  }),
  markCancelling: markCancelling(db, t, 1n, 'x'),
  'maintenance gate': gate(db, t, 1),
  'maintenance expire': expire(db, t),
  'maintenance retain': retain(db, t),
  'maintenance unclaimed': unclaimed(db, t, 1),
  'sync upsert': S.upsert(db, t, upsert, true),
  'api insert': S.upsert(db, t, upsert, false),
  remove: S.remove(db, t, 'a', false),
}

describe('statement goldens', () => {
  for (const [name, q] of Object.entries(statements)) {
    it(name, () => expect(q.sql.replace(/\s+/g, ' ').trim()).toMatchSnapshot())
  }
})

// Two data-modifying CTEs of one statement must never target the same row (15 §0.5 rule 6).
describe('no statement modifies one table twice', () => {
  for (const [name, q] of Object.entries(statements)) {
    it(name, () => {
      const targets = [
        ...q.sql.matchAll(/\b(?:insert into|update|delete from)\s+("[^"]+"\."[^"]+")/gi),
      ].map((m) => m[1])
      expect(new Set(targets).size).toBe(targets.length)
    })
  }
})
