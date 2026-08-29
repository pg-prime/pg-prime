import { eq } from 'pg-prime'
import { db } from './db.js'

const [alice] = await db
  .insertInto(db.h.users)
  .values({ email: 'alice@example.com', name: 'Alice' })
  .returning((t) => ({ id: t.users.id, email: t.users.email }))
  .execute()

await db
  .insertInto(db.h.posts)
  .valuesMany([
    { authorId: alice!.id, title: 'Hello', body: 'first', published: true },
    { authorId: alice!.id, title: 'Draft', body: 'second', published: false },
  ])
  .execute()

const published = await db
  .from(db.h.posts, 'p')
  .innerJoin(db.h.users, 'a', (t) => eq(t.p.authorId, t.a.id))
  .where((t) => eq(t.p.published, true))
  .select((t) => ({ title: t.p.title, author: t.a.name }))
  .execute()

console.log(published) // [ { title: 'Hello', author: 'Alice' } ]
