-- pg-prime:corpus pagila
-- Source: https://raw.githubusercontent.com/devrimgunduz/pagila/pagila-v3.1.0/pagila-schema.sql
-- sha256(upstream): 8ce358e4c8014087b85296694a0893887bd7a4190e3ce407f2721b86b98e5707
-- Licence: BSD-3-Clause (Sample Database Copyright, see LICENSE) — see LICENSE beside this file.
--
-- TRIMMED to schema-only DDL by tools/corpus-fetch.mjs. Regenerate with:
--   node tools/corpus-fetch.mjs pagila
-- Dropped: 1×ALTER SCHEMA, 1×GRANT ALL, 1×REVOKE USAGE, 43×ALTER TABLE
SET statement_timeout = 0;

SET lock_timeout = 0;

SET idle_in_transaction_session_timeout = 0;

SET client_encoding = 'UTF8';

SET standard_conforming_strings = on;

SELECT pg_catalog.set_config('search_path', '', false);

SET check_function_bodies = false;

SET xmloption = content;

SET client_min_messages = warning;

SET row_security = off;

CREATE DOMAIN public."bıgınt" AS bigint;

ALTER DOMAIN public."bıgınt" OWNER TO postgres;

CREATE TYPE public.mpaa_rating AS ENUM ( 'G', 'PG', 'PG-13', 'R', 'NC-17' );

ALTER TYPE public.mpaa_rating OWNER TO postgres;

CREATE DOMAIN public.year AS integer CONSTRAINT year_check CHECK (((VALUE >= 1901) AND (VALUE <= 2155)));

ALTER DOMAIN public.year OWNER TO postgres;

CREATE FUNCTION public._group_concat(text, text) RETURNS text LANGUAGE sql IMMUTABLE AS $_$
SELECT CASE
  WHEN $2 IS NULL THEN $1
  WHEN $1 IS NULL THEN $2
  ELSE $1 || ', ' || $2
END
$_$;

ALTER FUNCTION public._group_concat(text, text) OWNER TO postgres;

CREATE FUNCTION public.film_in_stock(p_film_id integer, p_store_id integer, OUT p_film_count integer) RETURNS SETOF integer LANGUAGE sql AS $_$
     SELECT inventory_id
     FROM inventory
     WHERE film_id = $1
     AND store_id = $2
     AND inventory_in_stock(inventory_id);
$_$;

ALTER FUNCTION public.film_in_stock(p_film_id integer, p_store_id integer, OUT p_film_count integer) OWNER TO postgres;

CREATE FUNCTION public.film_not_in_stock(p_film_id integer, p_store_id integer, OUT p_film_count integer) RETURNS SETOF integer LANGUAGE sql AS $_$
    SELECT inventory_id
    FROM inventory
    WHERE film_id = $1
    AND store_id = $2
    AND NOT inventory_in_stock(inventory_id);
$_$;

ALTER FUNCTION public.film_not_in_stock(p_film_id integer, p_store_id integer, OUT p_film_count integer) OWNER TO postgres;

CREATE FUNCTION public.get_customer_balance(p_customer_id integer, p_effective_date timestamp with time zone) RETURNS numeric LANGUAGE plpgsql AS $$
       --#OK, WE NEED TO CALCULATE THE CURRENT BALANCE GIVEN A CUSTOMER_ID AND A DATE
       --#THAT WE WANT THE BALANCE TO BE EFFECTIVE FOR. THE BALANCE IS:
       --#   1) RENTAL FEES FOR ALL PREVIOUS RENTALS
       --#   2) ONE DOLLAR FOR EVERY DAY THE PREVIOUS RENTALS ARE OVERDUE
       --#   3) IF A FILM IS MORE THAN RENTAL_DURATION * 2 OVERDUE, CHARGE THE REPLACEMENT_COST
       --#   4) SUBTRACT ALL PAYMENTS MADE BEFORE THE DATE SPECIFIED
DECLARE
    v_rentfees DECIMAL(5,2); --#FEES PAID TO RENT THE VIDEOS INITIALLY
    v_overfees INTEGER;      --#LATE FEES FOR PRIOR RENTALS
    v_payments DECIMAL(5,2); --#SUM OF PAYMENTS MADE PREVIOUSLY
BEGIN
    SELECT COALESCE(SUM(film.rental_rate),0) INTO v_rentfees
    FROM film, inventory, rental
    WHERE film.film_id = inventory.film_id
      AND inventory.inventory_id = rental.inventory_id
      AND rental.rental_date <= p_effective_date
      AND rental.customer_id = p_customer_id;

    SELECT COALESCE(SUM(IF((rental.return_date - rental.rental_date) > (film.rental_duration * '1 day'::interval),
        ((rental.return_date - rental.rental_date) - (film.rental_duration * '1 day'::interval)),0)),0) INTO v_overfees
    FROM rental, inventory, film
    WHERE film.film_id = inventory.film_id
      AND inventory.inventory_id = rental.inventory_id
      AND rental.rental_date <= p_effective_date
      AND rental.customer_id = p_customer_id;

    SELECT COALESCE(SUM(payment.amount),0) INTO v_payments
    FROM payment
    WHERE payment.payment_date <= p_effective_date
    AND payment.customer_id = p_customer_id;

    RETURN v_rentfees + v_overfees - v_payments;
END
$$;

ALTER FUNCTION public.get_customer_balance(p_customer_id integer, p_effective_date timestamp with time zone) OWNER TO postgres;

CREATE FUNCTION public.inventory_held_by_customer(p_inventory_id integer) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE
    v_customer_id INTEGER;
BEGIN

  SELECT customer_id INTO v_customer_id
  FROM rental
  WHERE return_date IS NULL
  AND inventory_id = p_inventory_id;

  RETURN v_customer_id;
END $$;

ALTER FUNCTION public.inventory_held_by_customer(p_inventory_id integer) OWNER TO postgres;

CREATE FUNCTION public.inventory_in_stock(p_inventory_id integer) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE
    v_rentals INTEGER;
    v_out     INTEGER;
BEGIN
    -- AN ITEM IS IN-STOCK IF THERE ARE EITHER NO ROWS IN THE rental TABLE
    -- FOR THE ITEM OR ALL ROWS HAVE return_date POPULATED

    SELECT count(*) INTO v_rentals
    FROM rental
    WHERE inventory_id = p_inventory_id;

    IF v_rentals = 0 THEN
      RETURN TRUE;
    END IF;

    SELECT COUNT(rental_id) INTO v_out
    FROM inventory LEFT JOIN rental USING(inventory_id)
    WHERE inventory.inventory_id = p_inventory_id
    AND rental.return_date IS NULL;

    IF v_out > 0 THEN
      RETURN FALSE;
    ELSE
      RETURN TRUE;
    END IF;
END $$;

ALTER FUNCTION public.inventory_in_stock(p_inventory_id integer) OWNER TO postgres;

CREATE FUNCTION public.last_day(timestamp with time zone) RETURNS date LANGUAGE sql IMMUTABLE STRICT AS $_$
  SELECT CASE
    WHEN EXTRACT(MONTH FROM $1) = 12 THEN
      (((EXTRACT(YEAR FROM $1) + 1) operator(pg_catalog.||) '-01-01')::date - INTERVAL '1 day')::date
    ELSE
      ((EXTRACT(YEAR FROM $1) operator(pg_catalog.||) '-' operator(pg_catalog.||) (EXTRACT(MONTH FROM $1) + 1) operator(pg_catalog.||) '-01')::date - INTERVAL '1 day')::date
    END
$_$;

ALTER FUNCTION public.last_day(timestamp with time zone) OWNER TO postgres;

CREATE FUNCTION public.last_updated() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    NEW.last_update = CURRENT_TIMESTAMP;
    RETURN NEW;
END $$;

ALTER FUNCTION public.last_updated() OWNER TO postgres;

CREATE SEQUENCE public.customer_customer_id_seq START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;

SET default_tablespace = '';

SET default_table_access_method = heap;

CREATE TABLE public.customer ( customer_id integer DEFAULT nextval('public.customer_customer_id_seq'::regclass) NOT NULL, store_id integer NOT NULL, first_name text NOT NULL, last_name text NOT NULL, email text, address_id integer NOT NULL, activebool boolean DEFAULT true NOT NULL, create_date date DEFAULT CURRENT_DATE NOT NULL, last_update timestamp with time zone DEFAULT now(), active integer );

CREATE FUNCTION public.rewards_report(min_monthly_purchases integer, min_dollar_amount_purchased numeric) RETURNS SETOF public.customer LANGUAGE plpgsql SECURITY DEFINER AS $_$
DECLARE
    last_month_start DATE;
    last_month_end DATE;
rr RECORD;
tmpSQL TEXT;
BEGIN

    /* Some sanity checks... */
    IF min_monthly_purchases = 0 THEN
        RAISE EXCEPTION 'Minimum monthly purchases parameter must be > 0';
    END IF;
    IF min_dollar_amount_purchased = 0.00 THEN
        RAISE EXCEPTION 'Minimum monthly dollar amount purchased parameter must be > $0.00';
    END IF;

    last_month_start := CURRENT_DATE - '3 month'::interval;
    last_month_start := to_date((extract(YEAR FROM last_month_start) || '-' || extract(MONTH FROM last_month_start) || '-01'),'YYYY-MM-DD');
    last_month_end := LAST_DAY(last_month_start);

    /*
    Create a temporary storage area for Customer IDs.
    */
    CREATE TEMPORARY TABLE tmpCustomer (customer_id INTEGER NOT NULL PRIMARY KEY);

    /*
    Find all customers meeting the monthly purchase requirements
    */

    tmpSQL := 'INSERT INTO tmpCustomer (customer_id)
        SELECT p.customer_id
        FROM payment AS p
        WHERE DATE(p.payment_date) BETWEEN '||quote_literal(last_month_start) ||' AND '|| quote_literal(last_month_end) || '
        GROUP BY customer_id
        HAVING SUM(p.amount) > '|| min_dollar_amount_purchased || '
        AND COUNT(customer_id) > ' ||min_monthly_purchases ;

    EXECUTE tmpSQL;

    /*
    Output ALL customer information of matching rewardees.
    Customize output as needed.
    */
    FOR rr IN EXECUTE 'SELECT c.* FROM tmpCustomer AS t INNER JOIN customer AS c ON t.customer_id = c.customer_id' LOOP
        RETURN NEXT rr;
    END LOOP;

    /* Clean up */
    tmpSQL := 'DROP TABLE tmpCustomer';
    EXECUTE tmpSQL;

RETURN;
END
$_$;

ALTER FUNCTION public.rewards_report(min_monthly_purchases integer, min_dollar_amount_purchased numeric) OWNER TO postgres;

CREATE AGGREGATE public.group_concat(text) ( SFUNC = public._group_concat, STYPE = text );

ALTER AGGREGATE public.group_concat(text) OWNER TO postgres;

CREATE SEQUENCE public.actor_actor_id_seq START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;

CREATE TABLE public.actor ( actor_id integer DEFAULT nextval('public.actor_actor_id_seq'::regclass) NOT NULL, first_name text NOT NULL, last_name text NOT NULL, last_update timestamp with time zone DEFAULT now() NOT NULL );

CREATE SEQUENCE public.category_category_id_seq START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;

CREATE TABLE public.category ( category_id integer DEFAULT nextval('public.category_category_id_seq'::regclass) NOT NULL, name text NOT NULL, last_update timestamp with time zone DEFAULT now() NOT NULL );

CREATE SEQUENCE public.film_film_id_seq START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;

CREATE TABLE public.film ( film_id integer DEFAULT nextval('public.film_film_id_seq'::regclass) NOT NULL, title text NOT NULL, description text, release_year public.year, language_id integer NOT NULL, original_language_id integer, rental_duration smallint DEFAULT 3 NOT NULL, rental_rate numeric(4,2) DEFAULT 4.99 NOT NULL, length smallint, replacement_cost numeric(5,2) DEFAULT 19.99 NOT NULL, rating public.mpaa_rating DEFAULT 'G'::public.mpaa_rating, last_update timestamp with time zone DEFAULT now() NOT NULL, special_features text[], fulltext tsvector NOT NULL );

CREATE TABLE public.film_actor ( actor_id integer NOT NULL, film_id integer NOT NULL, last_update timestamp with time zone DEFAULT now() NOT NULL );

CREATE TABLE public.film_category ( film_id integer NOT NULL, category_id integer NOT NULL, last_update timestamp with time zone DEFAULT now() NOT NULL );

CREATE VIEW public.actor_info AS SELECT a.actor_id, a.first_name, a.last_name, public.group_concat(DISTINCT ((c.name || ': '::text) || ( SELECT public.group_concat(f.title) AS group_concat FROM ((public.film f JOIN public.film_category fc_1 ON ((f.film_id = fc_1.film_id))) JOIN public.film_actor fa_1 ON ((f.film_id = fa_1.film_id))) WHERE ((fc_1.category_id = c.category_id) AND (fa_1.actor_id = a.actor_id)) GROUP BY fa_1.actor_id))) AS film_info FROM (((public.actor a LEFT JOIN public.film_actor fa ON ((a.actor_id = fa.actor_id))) LEFT JOIN public.film_category fc ON ((fa.film_id = fc.film_id))) LEFT JOIN public.category c ON ((fc.category_id = c.category_id))) GROUP BY a.actor_id, a.first_name, a.last_name;

CREATE SEQUENCE public.address_address_id_seq START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;

CREATE TABLE public.address ( address_id integer DEFAULT nextval('public.address_address_id_seq'::regclass) NOT NULL, address text NOT NULL, address2 text, district text NOT NULL, city_id integer NOT NULL, postal_code text, phone text NOT NULL, last_update timestamp with time zone DEFAULT now() NOT NULL );

CREATE SEQUENCE public.city_city_id_seq START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;

CREATE TABLE public.city ( city_id integer DEFAULT nextval('public.city_city_id_seq'::regclass) NOT NULL, city text NOT NULL, country_id integer NOT NULL, last_update timestamp with time zone DEFAULT now() NOT NULL );

CREATE SEQUENCE public.country_country_id_seq START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;

CREATE TABLE public.country ( country_id integer DEFAULT nextval('public.country_country_id_seq'::regclass) NOT NULL, country text NOT NULL, last_update timestamp with time zone DEFAULT now() NOT NULL );

CREATE VIEW public.customer_list AS SELECT cu.customer_id AS id, ((cu.first_name || ' '::text) || cu.last_name) AS name, a.address, a.postal_code AS "zip code", a.phone, city.city, country.country, CASE WHEN cu.activebool THEN 'active'::text ELSE ''::text END AS notes, cu.store_id AS sid FROM (((public.customer cu JOIN public.address a ON ((cu.address_id = a.address_id))) JOIN public.city ON ((a.city_id = city.city_id))) JOIN public.country ON ((city.country_id = country.country_id)));

CREATE VIEW public.film_list AS SELECT film.film_id AS fid, film.title, film.description, category.name AS category, film.rental_rate AS price, film.length, film.rating, public.group_concat(((actor.first_name || ' '::text) || actor.last_name)) AS actors FROM ((((public.category LEFT JOIN public.film_category ON ((category.category_id = film_category.category_id))) LEFT JOIN public.film ON ((film_category.film_id = film.film_id))) JOIN public.film_actor ON ((film.film_id = film_actor.film_id))) JOIN public.actor ON ((film_actor.actor_id = actor.actor_id))) GROUP BY film.film_id, film.title, film.description, category.name, film.rental_rate, film.length, film.rating;

CREATE SEQUENCE public.inventory_inventory_id_seq START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;

CREATE TABLE public.inventory ( inventory_id integer DEFAULT nextval('public.inventory_inventory_id_seq'::regclass) NOT NULL, film_id integer NOT NULL, store_id integer NOT NULL, last_update timestamp with time zone DEFAULT now() NOT NULL );

CREATE SEQUENCE public.language_language_id_seq START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;

CREATE TABLE public.language ( language_id integer DEFAULT nextval('public.language_language_id_seq'::regclass) NOT NULL, name character(20) NOT NULL, last_update timestamp with time zone DEFAULT now() NOT NULL );

CREATE VIEW public.nicer_but_slower_film_list AS SELECT film.film_id AS fid, film.title, film.description, category.name AS category, film.rental_rate AS price, film.length, film.rating, public.group_concat((((upper("substring"(actor.first_name, 1, 1)) || lower("substring"(actor.first_name, 2))) || upper("substring"(actor.last_name, 1, 1))) || lower("substring"(actor.last_name, 2)))) AS actors FROM ((((public.category LEFT JOIN public.film_category ON ((category.category_id = film_category.category_id))) LEFT JOIN public.film ON ((film_category.film_id = film.film_id))) JOIN public.film_actor ON ((film.film_id = film_actor.film_id))) JOIN public.actor ON ((film_actor.actor_id = actor.actor_id))) GROUP BY film.film_id, film.title, film.description, category.name, film.rental_rate, film.length, film.rating;

CREATE SEQUENCE public.payment_payment_id_seq START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;

CREATE TABLE public.payment ( payment_id integer DEFAULT nextval('public.payment_payment_id_seq'::regclass) NOT NULL, customer_id integer NOT NULL, staff_id integer NOT NULL, rental_id integer NOT NULL, amount numeric(5,2) NOT NULL, payment_date timestamp with time zone NOT NULL, PRIMARY KEY (payment_date, payment_id) ) PARTITION BY RANGE (payment_date);

CREATE TABLE public.payment_p2022_01 ( payment_id integer DEFAULT nextval('public.payment_payment_id_seq'::regclass) NOT NULL, customer_id integer NOT NULL, staff_id integer NOT NULL, rental_id integer NOT NULL, amount numeric(5,2) NOT NULL, payment_date timestamp with time zone NOT NULL );

CREATE TABLE public.payment_p2022_02 ( payment_id integer DEFAULT nextval('public.payment_payment_id_seq'::regclass) NOT NULL, customer_id integer NOT NULL, staff_id integer NOT NULL, rental_id integer NOT NULL, amount numeric(5,2) NOT NULL, payment_date timestamp with time zone NOT NULL );

CREATE TABLE public.payment_p2022_03 ( payment_id integer DEFAULT nextval('public.payment_payment_id_seq'::regclass) NOT NULL, customer_id integer NOT NULL, staff_id integer NOT NULL, rental_id integer NOT NULL, amount numeric(5,2) NOT NULL, payment_date timestamp with time zone NOT NULL );

CREATE TABLE public.payment_p2022_04 ( payment_id integer DEFAULT nextval('public.payment_payment_id_seq'::regclass) NOT NULL, customer_id integer NOT NULL, staff_id integer NOT NULL, rental_id integer NOT NULL, amount numeric(5,2) NOT NULL, payment_date timestamp with time zone NOT NULL );

CREATE TABLE public.payment_p2022_05 ( payment_id integer DEFAULT nextval('public.payment_payment_id_seq'::regclass) NOT NULL, customer_id integer NOT NULL, staff_id integer NOT NULL, rental_id integer NOT NULL, amount numeric(5,2) NOT NULL, payment_date timestamp with time zone NOT NULL );

CREATE TABLE public.payment_p2022_06 ( payment_id integer DEFAULT nextval('public.payment_payment_id_seq'::regclass) NOT NULL, customer_id integer NOT NULL, staff_id integer NOT NULL, rental_id integer NOT NULL, amount numeric(5,2) NOT NULL, payment_date timestamp with time zone NOT NULL );

CREATE TABLE public.payment_p2022_07 ( payment_id integer DEFAULT nextval('public.payment_payment_id_seq'::regclass) NOT NULL, customer_id integer NOT NULL, staff_id integer NOT NULL, rental_id integer NOT NULL, amount numeric(5,2) NOT NULL, payment_date timestamp with time zone NOT NULL );

CREATE SEQUENCE public.rental_rental_id_seq START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;

CREATE TABLE public.rental ( rental_id integer DEFAULT nextval('public.rental_rental_id_seq'::regclass) NOT NULL, rental_date timestamp with time zone NOT NULL, inventory_id integer NOT NULL, customer_id integer NOT NULL, return_date timestamp with time zone, staff_id integer NOT NULL, last_update timestamp with time zone DEFAULT now() NOT NULL );

CREATE MATERIALIZED VIEW public.rental_by_category AS SELECT c.name AS category, sum(p.amount) AS total_sales FROM (((((public.payment p JOIN public.rental r ON ((p.rental_id = r.rental_id))) JOIN public.inventory i ON ((r.inventory_id = i.inventory_id))) JOIN public.film f ON ((i.film_id = f.film_id))) JOIN public.film_category fc ON ((f.film_id = fc.film_id))) JOIN public.category c ON ((fc.category_id = c.category_id))) GROUP BY c.name ORDER BY (sum(p.amount)) DESC WITH NO DATA;

CREATE VIEW public.sales_by_film_category AS SELECT c.name AS category, sum(p.amount) AS total_sales FROM (((((public.payment p JOIN public.rental r ON ((p.rental_id = r.rental_id))) JOIN public.inventory i ON ((r.inventory_id = i.inventory_id))) JOIN public.film f ON ((i.film_id = f.film_id))) JOIN public.film_category fc ON ((f.film_id = fc.film_id))) JOIN public.category c ON ((fc.category_id = c.category_id))) GROUP BY c.name ORDER BY (sum(p.amount)) DESC;

CREATE SEQUENCE public.staff_staff_id_seq START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;

CREATE TABLE public.staff ( staff_id integer DEFAULT nextval('public.staff_staff_id_seq'::regclass) NOT NULL, first_name text NOT NULL, last_name text NOT NULL, address_id integer NOT NULL, email text, store_id integer NOT NULL, active boolean DEFAULT true NOT NULL, username text NOT NULL, password text, last_update timestamp with time zone DEFAULT now() NOT NULL, picture bytea );

CREATE SEQUENCE public.store_store_id_seq START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;

CREATE TABLE public.store ( store_id integer DEFAULT nextval('public.store_store_id_seq'::regclass) NOT NULL, manager_staff_id integer NOT NULL, address_id integer NOT NULL, last_update timestamp with time zone DEFAULT now() NOT NULL );

CREATE VIEW public.sales_by_store AS SELECT ((c.city || ','::text) || cy.country) AS store, ((m.first_name || ' '::text) || m.last_name) AS manager, sum(p.amount) AS total_sales FROM (((((((public.payment p JOIN public.rental r ON ((p.rental_id = r.rental_id))) JOIN public.inventory i ON ((r.inventory_id = i.inventory_id))) JOIN public.store s ON ((i.store_id = s.store_id))) JOIN public.address a ON ((s.address_id = a.address_id))) JOIN public.city c ON ((a.city_id = c.city_id))) JOIN public.country cy ON ((c.country_id = cy.country_id))) JOIN public.staff m ON ((s.manager_staff_id = m.staff_id))) GROUP BY cy.country, c.city, s.store_id, m.first_name, m.last_name ORDER BY cy.country, c.city;

CREATE VIEW public.staff_list AS SELECT s.staff_id AS id, ((s.first_name || ' '::text) || s.last_name) AS name, a.address, a.postal_code AS "zip code", a.phone, city.city, country.country, s.store_id AS sid FROM (((public.staff s JOIN public.address a ON ((s.address_id = a.address_id))) JOIN public.city ON ((a.city_id = city.city_id))) JOIN public.country ON ((city.country_id = country.country_id)));

ALTER TABLE ONLY public.payment ATTACH PARTITION public.payment_p2022_01 FOR VALUES FROM ('2022-01-01 00:00:00+00') TO ('2022-02-01 00:00:00+00');

ALTER TABLE ONLY public.payment ATTACH PARTITION public.payment_p2022_02 FOR VALUES FROM ('2022-02-01 00:00:00+00') TO ('2022-03-01 00:00:00+00');

ALTER TABLE ONLY public.payment ATTACH PARTITION public.payment_p2022_03 FOR VALUES FROM ('2022-03-01 00:00:00+00') TO ('2022-04-01 01:00:00+01');

ALTER TABLE ONLY public.payment ATTACH PARTITION public.payment_p2022_04 FOR VALUES FROM ('2022-04-01 01:00:00+01') TO ('2022-05-01 01:00:00+01');

ALTER TABLE ONLY public.payment ATTACH PARTITION public.payment_p2022_05 FOR VALUES FROM ('2022-05-01 01:00:00+01') TO ('2022-06-01 01:00:00+01');

ALTER TABLE ONLY public.payment ATTACH PARTITION public.payment_p2022_06 FOR VALUES FROM ('2022-06-01 01:00:00+01') TO ('2022-07-01 01:00:00+01');

ALTER TABLE ONLY public.payment ATTACH PARTITION public.payment_p2022_07 FOR VALUES FROM ('2022-07-01 01:00:00+01') TO ('2022-08-01 01:00:00+01');

ALTER TABLE ONLY public.actor ADD CONSTRAINT actor_pkey PRIMARY KEY (actor_id);

ALTER TABLE ONLY public.address ADD CONSTRAINT address_pkey PRIMARY KEY (address_id);

ALTER TABLE ONLY public.category ADD CONSTRAINT category_pkey PRIMARY KEY (category_id);

ALTER TABLE ONLY public.city ADD CONSTRAINT city_pkey PRIMARY KEY (city_id);

ALTER TABLE ONLY public.country ADD CONSTRAINT country_pkey PRIMARY KEY (country_id);

ALTER TABLE ONLY public.customer ADD CONSTRAINT customer_pkey PRIMARY KEY (customer_id);

ALTER TABLE ONLY public.film_actor ADD CONSTRAINT film_actor_pkey PRIMARY KEY (actor_id, film_id);

ALTER TABLE ONLY public.film_category ADD CONSTRAINT film_category_pkey PRIMARY KEY (film_id, category_id);

ALTER TABLE ONLY public.film ADD CONSTRAINT film_pkey PRIMARY KEY (film_id);

ALTER TABLE ONLY public.inventory ADD CONSTRAINT inventory_pkey PRIMARY KEY (inventory_id);

ALTER TABLE ONLY public.language ADD CONSTRAINT language_pkey PRIMARY KEY (language_id);

ALTER TABLE ONLY public.rental ADD CONSTRAINT rental_pkey PRIMARY KEY (rental_id);

ALTER TABLE ONLY public.staff ADD CONSTRAINT staff_pkey PRIMARY KEY (staff_id);

ALTER TABLE ONLY public.store ADD CONSTRAINT store_pkey PRIMARY KEY (store_id);

CREATE INDEX film_fulltext_idx ON public.film USING gist (fulltext);

CREATE INDEX idx_actor_last_name ON public.actor USING btree (last_name);

CREATE INDEX idx_fk_address_id ON public.customer USING btree (address_id);

CREATE INDEX idx_fk_city_id ON public.address USING btree (city_id);

CREATE INDEX idx_fk_country_id ON public.city USING btree (country_id);

CREATE INDEX idx_fk_film_id ON public.film_actor USING btree (film_id);

CREATE INDEX idx_fk_inventory_id ON public.rental USING btree (inventory_id);

CREATE INDEX idx_fk_language_id ON public.film USING btree (language_id);

CREATE INDEX idx_fk_original_language_id ON public.film USING btree (original_language_id);

CREATE INDEX idx_fk_payment_p2022_01_customer_id ON public.payment_p2022_01 USING btree (customer_id);

CREATE INDEX idx_fk_payment_p2022_01_staff_id ON public.payment_p2022_01 USING btree (staff_id);

CREATE INDEX idx_fk_payment_p2022_02_customer_id ON public.payment_p2022_02 USING btree (customer_id);

CREATE INDEX idx_fk_payment_p2022_02_staff_id ON public.payment_p2022_02 USING btree (staff_id);

CREATE INDEX idx_fk_payment_p2022_03_customer_id ON public.payment_p2022_03 USING btree (customer_id);

CREATE INDEX idx_fk_payment_p2022_03_staff_id ON public.payment_p2022_03 USING btree (staff_id);

CREATE INDEX idx_fk_payment_p2022_04_customer_id ON public.payment_p2022_04 USING btree (customer_id);

CREATE INDEX idx_fk_payment_p2022_04_staff_id ON public.payment_p2022_04 USING btree (staff_id);

CREATE INDEX idx_fk_payment_p2022_05_customer_id ON public.payment_p2022_05 USING btree (customer_id);

CREATE INDEX idx_fk_payment_p2022_05_staff_id ON public.payment_p2022_05 USING btree (staff_id);

CREATE INDEX idx_fk_payment_p2022_06_customer_id ON public.payment_p2022_06 USING btree (customer_id);

CREATE INDEX idx_fk_payment_p2022_06_staff_id ON public.payment_p2022_06 USING btree (staff_id);

CREATE INDEX idx_fk_store_id ON public.customer USING btree (store_id);

CREATE INDEX idx_last_name ON public.customer USING btree (last_name);

CREATE INDEX idx_store_id_film_id ON public.inventory USING btree (store_id, film_id);

CREATE INDEX idx_title ON public.film USING btree (title);

CREATE UNIQUE INDEX idx_unq_manager_staff_id ON public.store USING btree (manager_staff_id);

CREATE UNIQUE INDEX idx_unq_rental_rental_date_inventory_id_customer_id ON public.rental USING btree (rental_date, inventory_id, customer_id);

CREATE INDEX payment_p2022_01_customer_id_idx ON public.payment_p2022_01 USING btree (customer_id);

CREATE INDEX payment_p2022_02_customer_id_idx ON public.payment_p2022_02 USING btree (customer_id);

CREATE INDEX payment_p2022_03_customer_id_idx ON public.payment_p2022_03 USING btree (customer_id);

CREATE INDEX payment_p2022_04_customer_id_idx ON public.payment_p2022_04 USING btree (customer_id);

CREATE INDEX payment_p2022_05_customer_id_idx ON public.payment_p2022_05 USING btree (customer_id);

CREATE INDEX payment_p2022_06_customer_id_idx ON public.payment_p2022_06 USING btree (customer_id);

CREATE UNIQUE INDEX rental_category ON public.rental_by_category USING btree (category);

CREATE TRIGGER film_fulltext_trigger BEFORE INSERT OR UPDATE ON public.film FOR EACH ROW EXECUTE FUNCTION tsvector_update_trigger('fulltext', 'pg_catalog.english', 'title', 'description');

CREATE TRIGGER last_updated BEFORE UPDATE ON public.actor FOR EACH ROW EXECUTE FUNCTION public.last_updated();

CREATE TRIGGER last_updated BEFORE UPDATE ON public.address FOR EACH ROW EXECUTE FUNCTION public.last_updated();

CREATE TRIGGER last_updated BEFORE UPDATE ON public.category FOR EACH ROW EXECUTE FUNCTION public.last_updated();

CREATE TRIGGER last_updated BEFORE UPDATE ON public.city FOR EACH ROW EXECUTE FUNCTION public.last_updated();

CREATE TRIGGER last_updated BEFORE UPDATE ON public.country FOR EACH ROW EXECUTE FUNCTION public.last_updated();

CREATE TRIGGER last_updated BEFORE UPDATE ON public.customer FOR EACH ROW EXECUTE FUNCTION public.last_updated();

CREATE TRIGGER last_updated BEFORE UPDATE ON public.film FOR EACH ROW EXECUTE FUNCTION public.last_updated();

CREATE TRIGGER last_updated BEFORE UPDATE ON public.film_actor FOR EACH ROW EXECUTE FUNCTION public.last_updated();

CREATE TRIGGER last_updated BEFORE UPDATE ON public.film_category FOR EACH ROW EXECUTE FUNCTION public.last_updated();

CREATE TRIGGER last_updated BEFORE UPDATE ON public.inventory FOR EACH ROW EXECUTE FUNCTION public.last_updated();

CREATE TRIGGER last_updated BEFORE UPDATE ON public.language FOR EACH ROW EXECUTE FUNCTION public.last_updated();

CREATE TRIGGER last_updated BEFORE UPDATE ON public.rental FOR EACH ROW EXECUTE FUNCTION public.last_updated();

CREATE TRIGGER last_updated BEFORE UPDATE ON public.staff FOR EACH ROW EXECUTE FUNCTION public.last_updated();

CREATE TRIGGER last_updated BEFORE UPDATE ON public.store FOR EACH ROW EXECUTE FUNCTION public.last_updated();

ALTER TABLE ONLY public.address ADD CONSTRAINT address_city_id_fkey FOREIGN KEY (city_id) REFERENCES public.city(city_id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public.city ADD CONSTRAINT city_country_id_fkey FOREIGN KEY (country_id) REFERENCES public.country(country_id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public.customer ADD CONSTRAINT customer_address_id_fkey FOREIGN KEY (address_id) REFERENCES public.address(address_id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public.customer ADD CONSTRAINT customer_store_id_fkey FOREIGN KEY (store_id) REFERENCES public.store(store_id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public.film_actor ADD CONSTRAINT film_actor_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES public.actor(actor_id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public.film_actor ADD CONSTRAINT film_actor_film_id_fkey FOREIGN KEY (film_id) REFERENCES public.film(film_id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public.film_category ADD CONSTRAINT film_category_category_id_fkey FOREIGN KEY (category_id) REFERENCES public.category(category_id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public.film_category ADD CONSTRAINT film_category_film_id_fkey FOREIGN KEY (film_id) REFERENCES public.film(film_id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public.film ADD CONSTRAINT film_language_id_fkey FOREIGN KEY (language_id) REFERENCES public.language(language_id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public.film ADD CONSTRAINT film_original_language_id_fkey FOREIGN KEY (original_language_id) REFERENCES public.language(language_id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public.inventory ADD CONSTRAINT inventory_film_id_fkey FOREIGN KEY (film_id) REFERENCES public.film(film_id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public.inventory ADD CONSTRAINT inventory_store_id_fkey FOREIGN KEY (store_id) REFERENCES public.store(store_id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public.payment_p2022_01 ADD CONSTRAINT payment_p2022_01_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customer(customer_id);

ALTER TABLE ONLY public.payment_p2022_01 ADD CONSTRAINT payment_p2022_01_rental_id_fkey FOREIGN KEY (rental_id) REFERENCES public.rental(rental_id);

ALTER TABLE ONLY public.payment_p2022_01 ADD CONSTRAINT payment_p2022_01_staff_id_fkey FOREIGN KEY (staff_id) REFERENCES public.staff(staff_id);

ALTER TABLE ONLY public.payment_p2022_02 ADD CONSTRAINT payment_p2022_02_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customer(customer_id);

ALTER TABLE ONLY public.payment_p2022_02 ADD CONSTRAINT payment_p2022_02_rental_id_fkey FOREIGN KEY (rental_id) REFERENCES public.rental(rental_id);

ALTER TABLE ONLY public.payment_p2022_02 ADD CONSTRAINT payment_p2022_02_staff_id_fkey FOREIGN KEY (staff_id) REFERENCES public.staff(staff_id);

ALTER TABLE ONLY public.payment_p2022_03 ADD CONSTRAINT payment_p2022_03_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customer(customer_id);

ALTER TABLE ONLY public.payment_p2022_03 ADD CONSTRAINT payment_p2022_03_rental_id_fkey FOREIGN KEY (rental_id) REFERENCES public.rental(rental_id);

ALTER TABLE ONLY public.payment_p2022_03 ADD CONSTRAINT payment_p2022_03_staff_id_fkey FOREIGN KEY (staff_id) REFERENCES public.staff(staff_id);

ALTER TABLE ONLY public.payment_p2022_04 ADD CONSTRAINT payment_p2022_04_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customer(customer_id);

ALTER TABLE ONLY public.payment_p2022_04 ADD CONSTRAINT payment_p2022_04_rental_id_fkey FOREIGN KEY (rental_id) REFERENCES public.rental(rental_id);

ALTER TABLE ONLY public.payment_p2022_04 ADD CONSTRAINT payment_p2022_04_staff_id_fkey FOREIGN KEY (staff_id) REFERENCES public.staff(staff_id);

ALTER TABLE ONLY public.payment_p2022_05 ADD CONSTRAINT payment_p2022_05_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customer(customer_id);

ALTER TABLE ONLY public.payment_p2022_05 ADD CONSTRAINT payment_p2022_05_rental_id_fkey FOREIGN KEY (rental_id) REFERENCES public.rental(rental_id);

ALTER TABLE ONLY public.payment_p2022_05 ADD CONSTRAINT payment_p2022_05_staff_id_fkey FOREIGN KEY (staff_id) REFERENCES public.staff(staff_id);

ALTER TABLE ONLY public.payment_p2022_06 ADD CONSTRAINT payment_p2022_06_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customer(customer_id);

ALTER TABLE ONLY public.payment_p2022_06 ADD CONSTRAINT payment_p2022_06_rental_id_fkey FOREIGN KEY (rental_id) REFERENCES public.rental(rental_id);

ALTER TABLE ONLY public.payment_p2022_06 ADD CONSTRAINT payment_p2022_06_staff_id_fkey FOREIGN KEY (staff_id) REFERENCES public.staff(staff_id);

ALTER TABLE ONLY public.rental ADD CONSTRAINT rental_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customer(customer_id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public.rental ADD CONSTRAINT rental_inventory_id_fkey FOREIGN KEY (inventory_id) REFERENCES public.inventory(inventory_id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public.rental ADD CONSTRAINT rental_staff_id_fkey FOREIGN KEY (staff_id) REFERENCES public.staff(staff_id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public.staff ADD CONSTRAINT staff_address_id_fkey FOREIGN KEY (address_id) REFERENCES public.address(address_id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public.staff ADD CONSTRAINT staff_store_id_fkey FOREIGN KEY (store_id) REFERENCES public.store(store_id);

ALTER TABLE ONLY public.store ADD CONSTRAINT store_address_id_fkey FOREIGN KEY (address_id) REFERENCES public.address(address_id) ON UPDATE CASCADE ON DELETE RESTRICT;
