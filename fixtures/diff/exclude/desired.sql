-- vs current: one EXCLUDE with a WHERE clause and a deferrable one, so both the
-- predicate and the deferrability axis of `ConstraintPayload` are on the wire.

CREATE TABLE public.bookings (
  id      bigint NOT NULL PRIMARY KEY,
  room    integer NOT NULL,
  during  tstzrange NOT NULL,
  cancelled boolean NOT NULL DEFAULT false,
  CONSTRAINT bookings_no_overlap
    EXCLUDE USING gist (during WITH &&) WHERE (NOT cancelled),
  CONSTRAINT bookings_room_unique_span
    EXCLUDE USING gist (during WITH &&) DEFERRABLE INITIALLY DEFERRED
);
