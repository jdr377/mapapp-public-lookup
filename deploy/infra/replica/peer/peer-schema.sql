CREATE SCHEMA public_publications;
REVOKE ALL ON SCHEMA public_publications FROM PUBLIC;
CREATE TABLE public_publications.capacity (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  max_rows integer NOT NULL DEFAULT 10000 CHECK (max_rows BETWEEN 1 AND 100000),
  max_bytes bigint NOT NULL DEFAULT 671088640 CHECK (max_bytes BETWEEN 1 AND 1073741824),
  retained_rows integer NOT NULL DEFAULT 0 CHECK (retained_rows BETWEEN 0 AND max_rows),
  retained_bytes bigint NOT NULL DEFAULT 0 CHECK (retained_bytes BETWEEN 0 AND max_bytes)
);
INSERT INTO public_publications.capacity(singleton) VALUES (true);
CREATE TABLE public_publications.roots (
  txid text PRIMARY KEY CHECK (txid ~ '^[0-9a-f]{64}$'),
  family text NOT NULL DEFAULT 'paid-root' CHECK (family IN ('paid-root','social','record')),
  delivery_source text NOT NULL DEFAULT 'explicit-public-evidence' CHECK (delivery_source IN ('explicit-public-evidence','stack-discovery')),
  atomic_beef bytea NOT NULL CHECK (octet_length(atomic_beef) BETWEEN 1 AND 16777216),
  evidence_hash text NOT NULL CHECK (evidence_hash ~ '^[0-9a-f]{64}$'),
  derived_post jsonb NOT NULL CHECK (jsonb_typeof(derived_post)='object' AND octet_length(derived_post::text)<=2097152),
  signer_evidence jsonb NOT NULL CHECK (jsonb_typeof(signer_evidence)='object' AND octet_length(signer_evidence::text)<=8192),
  payload_bytes bigint GENERATED ALWAYS AS (
    octet_length(atomic_beef)::bigint + octet_length(derived_post::text) + octet_length(signer_evidence::text)
  ) STORED,
  owns_projection boolean NOT NULL CHECK (NOT owns_projection)
);
-- Enforce row/payload admission transactionally, including concurrent inserts.
-- The capacity row is private admission state; source publication tables are not locked globally.
CREATE FUNCTION public_publications.account_roots() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    UPDATE public_publications.capacity SET retained_rows=retained_rows+1,
      retained_bytes=retained_bytes+NEW.payload_bytes WHERE singleton;
    IF NOT FOUND THEN RAISE EXCEPTION 'publication capacity missing' USING ERRCODE='55000'; END IF;
    RETURN NEW;
  ELSIF TG_OP='DELETE' THEN
    UPDATE public_publications.capacity SET retained_rows=retained_rows-1,
      retained_bytes=retained_bytes-OLD.payload_bytes WHERE singleton;
    RETURN OLD;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER roots_account AFTER INSERT OR DELETE ON public_publications.roots
  FOR EACH ROW EXECUTE FUNCTION public_publications.account_roots();
REVOKE ALL ON ALL TABLES IN SCHEMA public_publications FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public_publications FROM PUBLIC;
