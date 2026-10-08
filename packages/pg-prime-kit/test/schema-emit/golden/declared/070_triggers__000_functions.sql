-- pg-prime:declared functions
-- pg-prime:tier R
-- pg-prime:object function public.pgprime_set_updated_at() sha256:5348140c300f83ccbe749cf838cb821b0dc75dc27e5e5b0eba480fb38353c490

CREATE OR REPLACE FUNCTION "public"."pgprime_set_updated_at"() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  NEW."updated_at" := now();
  RETURN NEW;
END
$$;

COMMENT ON FUNCTION "public"."pgprime_set_updated_at"() IS 'pg-prime:declared sha256:5348140c300f83ccbe749cf838cb821b0dc75dc27e5e5b0eba480fb38353c490';
