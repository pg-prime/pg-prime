CREATE TABLE public.accounts (
  id bigint NOT NULL,
  CONSTRAINT accounts_pkey PRIMARY KEY (id)
);

CREATE TABLE public.sites (
  id        bigint NOT NULL,
  tenant_id bigint NOT NULL,
  CONSTRAINT sites_pkey PRIMARY KEY (id),
  CONSTRAINT sites_tenant_fkey FOREIGN KEY (tenant_id) REFERENCES public.accounts (id)
);
