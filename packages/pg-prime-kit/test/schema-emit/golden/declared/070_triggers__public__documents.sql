-- pg-prime:declared triggers public.documents
-- pg-prime:tier R
-- pg-prime:object trigger public.documents.pgprime_set_updated_at sha256:f5642ac69a91bd59c36237a50f67a6fe89165a8be96a72aaa8a2f025608368c5

CREATE OR REPLACE TRIGGER "pgprime_set_updated_at" BEFORE UPDATE ON "public"."documents"
  FOR EACH ROW EXECUTE FUNCTION "public"."pgprime_set_updated_at"();

COMMENT ON TRIGGER "pgprime_set_updated_at" ON "public"."documents" IS 'pg-prime:declared sha256:f5642ac69a91bd59c36237a50f67a6fe89165a8be96a72aaa8a2f025608368c5';
