-- A table rename whose dependents live on ANOTHER table: the FK in `sites` names
-- `tenants`, and the PK's auto-generated name follows the table.

CREATE TABLE public.tenants (
  id bigint NOT NULL,
  CONSTRAINT tenants_pkey PRIMARY KEY (id)
);

CREATE TABLE public.sites (
  id        bigint NOT NULL,
  tenant_id bigint NOT NULL,
  CONSTRAINT sites_pkey PRIMARY KEY (id),
  CONSTRAINT sites_tenant_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants (id)
);
