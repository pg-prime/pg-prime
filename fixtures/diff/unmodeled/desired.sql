-- Identical to `current.sql` except for the storage parameter. See that file.
CREATE TABLE public.widgets (
  id    integer NOT NULL PRIMARY KEY,
  label text    NOT NULL
) WITH (fillfactor = 70);
