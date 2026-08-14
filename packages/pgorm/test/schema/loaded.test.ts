import { describe, expect, it } from 'vitest'
import { expectTypeOf } from 'expect-type'
import type { Loaded, Selectable } from '../../src/schema/index.js'
import { posts, users, type PostsH, type UserId, type UserPrefs, type UsersH } from './fixture.js'

type PostRow = Selectable<typeof posts>
type UserRow = Selectable<typeof users>

/** A function that DEMANDS a loaded relation. Zero runtime cost, zero casts. */
function notify(u: Loaded<UsersH, 'posts'>): string {
  return `${u.email}: ${u.posts.map((p) => p.title).join(', ')}`
}

/** A partial-column contract: a full row satisfies it, a narrower one does not. */
function shortName(u: Loaded<UsersH, never, 'id' | 'displayName'>): string {
  return u.displayName ?? String(u.id)
}

const post: PostRow = {
  id: 'p1',
  authorId: 'u1',
  title: 'hello',
  body: null,
  published: true,
  createdAt: new Date(0),
}

const fullUser = {
  id: 'u1' as UserId,
  email: 'a@b.c',
  displayName: 'Ada',
  age: 36,
  views: 0n,
  active: true,
  prefs: { theme: 'system', digest: 'weekly' } as UserPrefs,
  tags: ['x'],
  role: 'owner' as const,
  birthday: null,
  balance: '0.00',
  createdAt: new Date(0),
  updatedAt: new Date(0),
  seq: 1n,
  slug: 'ada',
}

describe('Loaded<> is a structural contract, not a brand', () => {
  it('accepts a conforming plain object literal with no cast', () => {
    // The literal is an ordinary object type — exactly what a query result is.
    expect(notify({ ...fullUser, posts: [post] })).toBe('a@b.c: hello')
  })

  it('shapes the relation from kind + opt', () => {
    expectTypeOf<Loaded<UsersH, 'posts'>['posts']>().toEqualTypeOf<PostRow[]>()
    expectTypeOf<Loaded<UsersH, 'latest'>['latest']>().toEqualTypeOf<PostRow | null>()
    // `one` (not `maybeOne`) is non-nullable
    expectTypeOf<Loaded<PostsH, 'author'>['author']>().toEqualTypeOf<UserRow>()
  })

  it('with no relation argument is exactly the select row', () => {
    expectTypeOf<Loaded<UsersH>>().toEqualTypeOf<UserRow>()
  })

  it('third parameter models partial-column load state', () => {
    expectTypeOf<Loaded<UsersH, never, 'id' | 'displayName'>>().toEqualTypeOf<{
      id: UserId
      displayName: string | null
    }>()
    // a full row satisfies a partial contract
    expect(shortName(fullUser)).toBe('Ada')
  })

  it('a relation-loaded value still satisfies the bare contract (width subtyping)', () => {
    expectTypeOf<Loaded<UsersH, 'posts'>>().toExtend<Loaded<UsersH>>()
    expectTypeOf<Loaded<UsersH>>().not.toExtend<Loaded<UsersH, 'posts'>>()
  })

  it('unloaded relations are absent, not branded-error-typed', () => {
    expectTypeOf<Loaded<UsersH>>().not.toHaveProperty('posts')
  })
})
