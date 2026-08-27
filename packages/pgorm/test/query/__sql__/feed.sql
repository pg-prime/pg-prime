select "users"."id" as "id", "users"."email" as "email", "_r0"."v" as "postCount", "_r1"."v" as "revenue", rank() over (order by "_r1"."v" desc) as "revenueRank", "_r2"."v" as "latestPosts"
from "public"."users" as "users"
left join lateral (
  select count(*) as "v"
  from "public"."posts" as "posts"
  where "posts"."author_id" = "users"."id"
) as "_r0" on true
left join lateral (
  select coalesce(sum("posts"."amount"), 0) as "v"
  from "public"."posts" as "posts"
  where "posts"."author_id" = "users"."id"
) as "_r1" on true
left join lateral (
  select coalesce(json_agg("x"."o" order by "x"."k0" desc), '[]'::json) as "v"
  from (
    select json_build_object('id', "posts"."id"::text, 'title', "posts"."title", 'commentCount', "_r3"."v"::text, 'author', "_r4"."o") as "o", "posts"."created_at" as "k0"
    from "public"."posts" as "posts"
    left join lateral (
      select count(*) as "v"
      from "public"."comments" as "comments"
      where "comments"."post_id" = "posts"."id"
    ) as "_r3" on true
    left join lateral (
      select json_build_object('id', "users2"."id"::text, 'email', "users2"."email") as "o"
      from "public"."users" as "users2"
      where "users2"."id" = "posts"."author_id"
      limit 1
    ) as "_r4" on true
    where ("posts"."author_id" = "users"."id" and "posts"."published" is true)
    order by "posts"."created_at" desc
    limit $1
  ) as "x"
) as "_r2" on true
where exists (
  select 1 as "v"
  from "public"."posts" as "posts"
  where ("posts"."author_id" = "users"."id" and "posts"."published" is true)
)
order by "users"."created_at" desc
limit $2