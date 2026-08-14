-- Multi-schema fixture.
--
-- Exercises the two halves of the schema lifecycle that a single-schema fixture
-- cannot: CREATE SCHEMA ordered before everything it contains, and — running
-- the same fixture backwards, toward an empty database — DROP ordered so that
-- a referencing table goes before its referent, a table before the enum its
-- column uses, and everything before its schema.

CREATE SCHEMA app;
CREATE SCHEMA billing;

CREATE TYPE app.plan_tier AS ENUM ('free', 'pro');

CREATE TABLE app.tenants (
  id   bigint        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  slug text          NOT NULL,
  tier app.plan_tier NOT NULL DEFAULT 'free',
  CONSTRAINT tenants_slug_key UNIQUE (slug)
);

-- a FOREIGN KEY across schemas: the drop order has to be derived from the
-- catalog edge, not from the (schema, name) sort order — `app.tenants` sorts
-- before `billing.invoices` and dropping it first fails
CREATE TABLE billing.invoices (
  id        bigint        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id bigint        NOT NULL REFERENCES app.tenants (id),
  amount    numeric(12,2) NOT NULL
);

CREATE INDEX invoices_tenant_idx ON billing.invoices (tenant_id);
