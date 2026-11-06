-- Smart Sales CRM — reference schema (PostgreSQL 16), generated with pg_dump --schema-only from a database
-- created by running all Knex migrations in db/migrations (head: 20261106051818_phase3_7_channel_ops.js).
-- The supported way to create/upgrade a database is the migrations (npm run db:prepare or npm run migrate).
-- This file is for review and for tools that need plain SQL. Roles referenced: sscrm_app (application role).
-- Loading it does NOT fill knex_migrations; if you load it, do not also run the migrations on that database.
-- It contains no data: required seed rows (permission catalog, platform_settings id=1) are inserted by the migrations.

--
-- PostgreSQL database dump
--

\restrict 2DdeENUEjprhDCQymrw2fYfNq7Is23b55u38supalKq86iaIVfMeXSpM5HFL0qr


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

--
-- Name: citext; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS citext WITH SCHEMA public;


--
-- Name: EXTENSION citext; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION citext IS 'data type for case-insensitive character strings';


--
-- Name: app_channel_lookup(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.app_channel_lookup(p_id uuid) RETURNS TABLE(channel_id uuid, company_id uuid, provider text, status text)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
      SELECT c.id, c.company_id, c.provider, c.status FROM channels c WHERE c.id = p_id
    $$;


--
-- Name: app_channel_route(text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.app_channel_route(p_provider text, p_external text) RETURNS TABLE(channel_id uuid, company_id uuid, provider text, status text)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
      SELECT c.id, c.company_id, c.provider, c.status FROM channels c
      WHERE c.provider = p_provider AND c.external_account_id = p_external AND c.status <> 'disconnected'
    $$;


--
-- Name: app_channels_for_maintenance(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.app_channels_for_maintenance() RETURNS TABLE(channel_id uuid, company_id uuid, provider text, status text, expires_at timestamp with time zone)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
      SELECT c.id, c.company_id, c.provider, c.status, cc.expires_at
      FROM channels c LEFT JOIN channel_credentials cc ON cc.channel_id = c.id
      WHERE c.status <> 'disconnected'
        AND (c.status IN ('needs_reconnect', 'error') OR (cc.expires_at IS NOT NULL AND cc.expires_at < now() + interval '10 days'))
      ORDER BY c.id LIMIT 5000
    $$;


--
-- Name: app_channels_for_meta_user(text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.app_channels_for_meta_user(p_provider text, p_user text) RETURNS TABLE(channel_id uuid, company_id uuid)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
      SELECT c.id, c.company_id FROM channels c
      WHERE c.provider = p_provider AND c.status <> 'disconnected'
        AND (c.external_meta->>'metaUserId' = p_user OR (p_provider = 'instagram' AND c.external_account_id = p_user))
    $$;


--
-- Name: app_current_company(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.app_current_company() RETURNS uuid
    LANGUAGE sql STABLE
    AS $$ SELECT NULLIF(current_setting('app.company_id', true), '')::uuid $$;


--
-- Name: app_current_user_id(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.app_current_user_id() RETURNS uuid
    LANGUAGE sql STABLE
    AS $$ SELECT NULLIF(current_setting('app.user_id', true), '')::uuid $$;


--
-- Name: app_in_definer(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.app_in_definer() RETURNS boolean
    LANGUAGE sql STABLE
    AS $$ SELECT current_user <> session_user $$;


--
-- Name: app_is_platform_admin(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.app_is_platform_admin() RETURNS boolean
    LANGUAGE sql STABLE
    AS $$ SELECT COALESCE(current_setting('app.platform_admin', true), '') = 'on' $$;


--
-- Name: app_is_system(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.app_is_system() RETURNS boolean
    LANGUAGE sql STABLE
    AS $$ SELECT COALESCE(current_setting('app.system', true), '') = 'on' $$;


--
-- Name: app_outbox_fail_stuck(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.app_outbox_fail_stuck() RETURNS integer
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
      WITH s AS (
        UPDATE messages SET status = 'failed', error_code = 'send.unknown_outcome'
        WHERE direction = 'out' AND status = 'sending' AND updated_at < now() - interval '10 minutes'
        RETURNING 1
      ) SELECT count(*)::int FROM s
    $$;


--
-- Name: app_outbox_stale(integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.app_outbox_stale(p_limit integer) RETURNS TABLE(message_id uuid, company_id uuid)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
      SELECT m.id, m.company_id FROM messages m
      -- Retries back off for at most 4 minutes (message.send retryDelayMax), so a queued row untouched
      -- for 5 minutes has lost its job. Re-sending is safe: the worker claims only "queued" rows.
      WHERE m.direction = 'out' AND m.status = 'queued' AND m.updated_at < now() - interval '5 minutes'
      ORDER BY m.updated_at LIMIT LEAST(GREATEST(p_limit, 1), 1000)
    $$;


--
-- Name: app_user_external_membership_count(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.app_user_external_membership_count(p_user uuid, p_company uuid) RETURNS integer
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT count(*)::int FROM company_memberships m WHERE m.user_id = p_user AND m.company_id <> p_company $$;


--
-- Name: app_user_id_by_email(public.citext); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.app_user_id_by_email(p_email public.citext) RETURNS uuid
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT u.id FROM users u WHERE u.email = p_email $$;


--
-- Name: app_user_is_platform_admin(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.app_user_is_platform_admin(p_user uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT COALESCE((SELECT u.is_platform_admin FROM users u WHERE u.id = p_user), false) $$;


--
-- Name: auth_user_for_login(public.citext); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auth_user_for_login(p_email public.citext) RETURNS TABLE(id uuid, password_hash text, status text)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT u.id, u.password_hash, u.status FROM users u WHERE u.email = p_email $$;


--
-- Name: users_guard_platform_flag(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.users_guard_platform_flag() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      IF NEW.is_platform_admin IS DISTINCT FROM OLD.is_platform_admin AND NOT app_is_platform_admin() THEN
        RAISE EXCEPTION 'only platform admins can change is_platform_admin' USING ERRCODE = '42501';
      END IF;
      NEW.updated_at := now();
      RETURN NEW;
    END $$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: audit_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.audit_logs (
    id bigint NOT NULL,
    company_id uuid,
    actor_user_id uuid,
    actor_email text,
    action text NOT NULL,
    entity_type text,
    entity_id text,
    before jsonb,
    after jsonb,
    ip text,
    user_agent text,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

ALTER TABLE ONLY public.audit_logs FORCE ROW LEVEL SECURITY;


--
-- Name: audit_logs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.audit_logs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: audit_logs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.audit_logs_id_seq OWNED BY public.audit_logs.id;


--
-- Name: auth_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_tokens (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    token_hash text NOT NULL,
    purpose text NOT NULL,
    user_id uuid NOT NULL,
    company_id uuid,
    created_by uuid,
    expires_at timestamp with time zone NOT NULL,
    used_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT auth_tokens_purpose_chk CHECK ((purpose = ANY (ARRAY['invite'::text, 'password_reset'::text])))
);


--
-- Name: channel_credentials; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.channel_credentials (
    channel_id uuid NOT NULL,
    company_id uuid NOT NULL,
    ciphertext text NOT NULL,
    key_id text,
    scopes jsonb,
    expires_at timestamp with time zone,
    refreshed_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

ALTER TABLE ONLY public.channel_credentials FORCE ROW LEVEL SECURITY;


--
-- Name: channel_oauth_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.channel_oauth_sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    user_id uuid NOT NULL,
    provider text NOT NULL,
    ciphertext text NOT NULL,
    accounts jsonb DEFAULT '[]'::jsonb NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

ALTER TABLE ONLY public.channel_oauth_sessions FORCE ROW LEVEL SECURITY;


--
-- Name: channels; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.channels (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    provider text NOT NULL,
    status text DEFAULT 'connecting'::text NOT NULL,
    display_name text NOT NULL,
    external_account_id text,
    external_meta jsonb DEFAULT '{}'::jsonb NOT NULL,
    connected_by uuid,
    connected_at timestamp with time zone,
    disconnected_at timestamp with time zone,
    last_inbound_at timestamp with time zone,
    last_outbound_at timestamp with time zone,
    last_health_check_at timestamp with time zone,
    last_error text,
    last_error_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT channels_provider_chk CHECK ((provider ~ '^[a-z][a-z0-9_]{1,30}$'::text)),
    CONSTRAINT channels_status_chk CHECK ((status = ANY (ARRAY['connecting'::text, 'active'::text, 'needs_reconnect'::text, 'error'::text, 'disconnected'::text])))
);

ALTER TABLE ONLY public.channels FORCE ROW LEVEL SECURITY;


--
-- Name: companies; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.companies (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    slug public.citext NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    email text,
    phone text,
    country text,
    address text,
    business_type text,
    timezone text DEFAULT 'UTC'::text NOT NULL,
    currency character varying(3) DEFAULT 'USD'::character varying NOT NULL,
    default_locale text DEFAULT 'en'::text NOT NULL,
    suspended_at timestamp with time zone,
    suspension_reason text,
    created_by uuid,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    outbound_paused boolean DEFAULT false NOT NULL,
    outbound_daily_limit integer,
    CONSTRAINT companies_currency_chk CHECK (((currency)::text ~ '^[A-Z]{3}$'::text)),
    CONSTRAINT companies_locale_chk CHECK ((default_locale = ANY (ARRAY['ar'::text, 'en'::text]))),
    CONSTRAINT companies_status_chk CHECK ((status = ANY (ARRAY['pending'::text, 'active'::text, 'suspended'::text])))
);

ALTER TABLE ONLY public.companies FORCE ROW LEVEL SECURITY;


--
-- Name: company_branding; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.company_branding (
    company_id uuid NOT NULL,
    display_name text,
    logo_url text,
    primary_color character varying(7),
    secondary_color character varying(7),
    accent_color character varying(7),
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

ALTER TABLE ONLY public.company_branding FORCE ROW LEVEL SECURITY;


--
-- Name: company_memberships; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.company_memberships (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    user_id uuid NOT NULL,
    role_id uuid NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    job_title text,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT memberships_status_chk CHECK ((status = ANY (ARRAY['active'::text, 'inactive'::text])))
);

ALTER TABLE ONLY public.company_memberships FORCE ROW LEVEL SECURITY;


--
-- Name: company_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.company_settings (
    company_id uuid NOT NULL,
    tax_rate numeric(6,3) DEFAULT '0'::numeric NOT NULL,
    shipping_fee numeric(12,2) DEFAULT '0'::numeric NOT NULL,
    auto_reply_enabled boolean DEFAULT false NOT NULL,
    quick_replies jsonb DEFAULT '[]'::jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

ALTER TABLE ONLY public.company_settings FORCE ROW LEVEL SECURITY;


--
-- Name: contact_identities; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.contact_identities (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    contact_id uuid NOT NULL,
    channel_id uuid NOT NULL,
    provider text NOT NULL,
    external_user_id text NOT NULL,
    profile jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

ALTER TABLE ONLY public.contact_identities FORCE ROW LEVEL SECURITY;


--
-- Name: contacts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.contacts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    display_name text NOT NULL,
    phone text,
    email text,
    notes text,
    tags jsonb DEFAULT '[]'::jsonb NOT NULL,
    status text DEFAULT 'new'::text NOT NULL,
    first_contact_at timestamp with time zone,
    last_contact_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

ALTER TABLE ONLY public.contacts FORCE ROW LEVEL SECURITY;


--
-- Name: conversation_assignments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.conversation_assignments (
    id bigint NOT NULL,
    company_id uuid NOT NULL,
    conversation_id uuid NOT NULL,
    from_membership_id uuid,
    to_membership_id uuid,
    assigned_by_user_id uuid,
    reason text,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

ALTER TABLE ONLY public.conversation_assignments FORCE ROW LEVEL SECURITY;


--
-- Name: conversation_assignments_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.conversation_assignments_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: conversation_assignments_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.conversation_assignments_id_seq OWNED BY public.conversation_assignments.id;


--
-- Name: conversations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.conversations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    channel_id uuid NOT NULL,
    contact_id uuid NOT NULL,
    identity_id uuid NOT NULL,
    status text DEFAULT 'open'::text NOT NULL,
    priority text DEFAULT 'normal'::text NOT NULL,
    assigned_membership_id uuid,
    unread_count integer DEFAULT 0 NOT NULL,
    last_message_preview text,
    last_message_at timestamp with time zone,
    last_inbound_at timestamp with time zone,
    last_outbound_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT conversations_priority_chk CHECK ((priority = ANY (ARRAY['low'::text, 'normal'::text, 'high'::text, 'urgent'::text]))),
    CONSTRAINT conversations_status_chk CHECK ((status = ANY (ARRAY['open'::text, 'pending'::text, 'closed'::text])))
);

ALTER TABLE ONLY public.conversations FORCE ROW LEVEL SECURITY;


--
-- Name: knex_migrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.knex_migrations (
    id integer NOT NULL,
    name character varying(255),
    batch integer,
    migration_time timestamp with time zone
);


--
-- Name: knex_migrations_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.knex_migrations_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: knex_migrations_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.knex_migrations_id_seq OWNED BY public.knex_migrations.id;


--
-- Name: knex_migrations_lock; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.knex_migrations_lock (
    index integer NOT NULL,
    is_locked integer
);


--
-- Name: knex_migrations_lock_index_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.knex_migrations_lock_index_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: knex_migrations_lock_index_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.knex_migrations_lock_index_seq OWNED BY public.knex_migrations_lock.index;


--
-- Name: messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.messages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    conversation_id uuid NOT NULL,
    channel_id uuid NOT NULL,
    direction text NOT NULL,
    sender_type text NOT NULL,
    sender_membership_id uuid,
    type text DEFAULT 'text'::text NOT NULL,
    body text,
    attachments jsonb DEFAULT '[]'::jsonb NOT NULL,
    external_message_id text,
    client_message_id text,
    status text NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    error_code text,
    error_message text,
    sent_at timestamp with time zone,
    delivered_at timestamp with time zone,
    read_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    template jsonb,
    CONSTRAINT messages_direction_chk CHECK ((direction = ANY (ARRAY['in'::text, 'out'::text]))),
    CONSTRAINT messages_sender_chk CHECK ((sender_type = ANY (ARRAY['contact'::text, 'member'::text, 'system'::text]))),
    CONSTRAINT messages_status_chk CHECK ((status = ANY (ARRAY['received'::text, 'queued'::text, 'sending'::text, 'sent'::text, 'delivered'::text, 'read'::text, 'failed'::text]))),
    CONSTRAINT messages_type_chk CHECK ((type = ANY (ARRAY['text'::text, 'image'::text, 'file'::text, 'audio'::text, 'video'::text, 'sticker'::text, 'location'::text, 'template'::text, 'unsupported'::text])))
);

ALTER TABLE ONLY public.messages FORCE ROW LEVEL SECURITY;


--
-- Name: meta_data_deletions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.meta_data_deletions (
    code text NOT NULL,
    provider text NOT NULL,
    status text DEFAULT 'completed'::text NOT NULL,
    channels_affected integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

ALTER TABLE ONLY public.meta_data_deletions FORCE ROW LEVEL SECURITY;


--
-- Name: notifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notifications (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid,
    user_id uuid NOT NULL,
    type text NOT NULL,
    data jsonb DEFAULT '{}'::jsonb NOT NULL,
    dedupe_key text,
    read_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

ALTER TABLE ONLY public.notifications FORCE ROW LEVEL SECURITY;


--
-- Name: payments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    subscription_id uuid,
    amount numeric(12,2) NOT NULL,
    currency character varying(3) NOT NULL,
    paid_at timestamp with time zone NOT NULL,
    method text NOT NULL,
    reference text,
    notes text,
    provider text DEFAULT 'manual'::text NOT NULL,
    provider_reference text,
    period_start timestamp with time zone,
    period_end timestamp with time zone,
    recorded_by uuid,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT payments_amount_chk CHECK ((amount > (0)::numeric)),
    CONSTRAINT payments_method_chk CHECK ((method = ANY (ARRAY['cash'::text, 'bank_transfer'::text, 'card'::text, 'mobile_wallet'::text, 'other'::text])))
);

ALTER TABLE ONLY public.payments FORCE ROW LEVEL SECURITY;


--
-- Name: permissions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.permissions (
    key text NOT NULL,
    category text NOT NULL,
    sort integer DEFAULT 0 NOT NULL
);


--
-- Name: plans; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.plans (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    key text NOT NULL,
    name jsonb NOT NULL,
    description jsonb DEFAULT '{}'::jsonb NOT NULL,
    billing_interval text NOT NULL,
    duration_days integer,
    price numeric(12,2) DEFAULT '0'::numeric NOT NULL,
    currency character varying(3) DEFAULT 'USD'::character varying NOT NULL,
    trial_days integer DEFAULT 0 NOT NULL,
    max_employees integer,
    max_channels integer,
    features jsonb DEFAULT '[]'::jsonb NOT NULL,
    is_active boolean DEFAULT false NOT NULL,
    is_public boolean DEFAULT true NOT NULL,
    sort integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    allowed_providers jsonb,
    CONSTRAINT plans_currency_chk CHECK (((currency)::text ~ '^[A-Z]{3}$'::text)),
    CONSTRAINT plans_custom_duration_chk CHECK (((billing_interval <> 'custom'::text) OR (duration_days > 0))),
    CONSTRAINT plans_interval_chk CHECK ((billing_interval = ANY (ARRAY['month'::text, 'year'::text, 'custom'::text]))),
    CONSTRAINT plans_limits_chk CHECK ((((max_employees IS NULL) OR (max_employees > 0)) AND ((max_channels IS NULL) OR (max_channels >= 0)) AND (trial_days >= 0))),
    CONSTRAINT plans_price_chk CHECK ((price >= (0)::numeric))
);

ALTER TABLE ONLY public.plans FORCE ROW LEVEL SECURITY;


--
-- Name: platform_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.platform_settings (
    id smallint DEFAULT '1'::smallint NOT NULL,
    app_name text DEFAULT 'Smart Sales CRM'::text NOT NULL,
    tagline jsonb DEFAULT '{}'::jsonb NOT NULL,
    logo_url text,
    favicon_url text,
    primary_color character varying(7) DEFAULT '#4f46e5'::character varying NOT NULL,
    secondary_color character varying(7) DEFAULT '#0f172a'::character varying NOT NULL,
    accent_color character varying(7) DEFAULT '#f59e0b'::character varying NOT NULL,
    font_family text DEFAULT 'Cairo'::text NOT NULL,
    default_theme text DEFAULT 'system'::text NOT NULL,
    default_locale text DEFAULT 'en'::text NOT NULL,
    login_heading jsonb DEFAULT '{}'::jsonb NOT NULL,
    login_subheading jsonb DEFAULT '{}'::jsonb NOT NULL,
    registration_heading jsonb DEFAULT '{}'::jsonb NOT NULL,
    registration_subheading jsonb DEFAULT '{}'::jsonb NOT NULL,
    support_email text,
    support_phone text,
    website_url text,
    updated_by uuid,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    expired_access_policy text DEFAULT 'read_only'::text NOT NULL,
    registration_enabled boolean DEFAULT true NOT NULL,
    CONSTRAINT platform_expired_policy_chk CHECK ((expired_access_policy = ANY (ARRAY['read_only'::text, 'block'::text]))),
    CONSTRAINT platform_locale_chk CHECK ((default_locale = ANY (ARRAY['ar'::text, 'en'::text]))),
    CONSTRAINT platform_settings_singleton CHECK ((id = 1)),
    CONSTRAINT platform_theme_chk CHECK ((default_theme = ANY (ARRAY['light'::text, 'dark'::text, 'system'::text])))
);

ALTER TABLE ONLY public.platform_settings FORCE ROW LEVEL SECURITY;


--
-- Name: registration_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.registration_requests (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_name text NOT NULL,
    business_type text,
    country text,
    company_phone text,
    owner_name text NOT NULL,
    owner_email public.citext NOT NULL,
    owner_phone text,
    plan_id uuid,
    locale text DEFAULT 'en'::text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    message_to_applicant text,
    internal_note text,
    reviewed_by uuid,
    reviewed_at timestamp with time zone,
    company_id uuid,
    ip text,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT registration_locale_chk CHECK ((locale = ANY (ARRAY['ar'::text, 'en'::text]))),
    CONSTRAINT registration_status_chk CHECK ((status = ANY (ARRAY['pending'::text, 'info_requested'::text, 'approved'::text, 'rejected'::text])))
);

ALTER TABLE ONLY public.registration_requests FORCE ROW LEVEL SECURITY;


--
-- Name: role_permissions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.role_permissions (
    company_id uuid NOT NULL,
    role_id uuid NOT NULL,
    permission_key text NOT NULL
);

ALTER TABLE ONLY public.role_permissions FORCE ROW LEVEL SECURITY;


--
-- Name: roles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.roles (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    key text NOT NULL,
    name text,
    description text,
    is_system boolean DEFAULT false NOT NULL,
    is_owner boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

ALTER TABLE ONLY public.roles FORCE ROW LEVEL SECURITY;


--
-- Name: sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sessions (
    id text NOT NULL,
    user_id uuid NOT NULL,
    company_id uuid,
    csrf_token text NOT NULL,
    ip text,
    user_agent text,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    last_seen_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    kind text DEFAULT 'company'::text NOT NULL,
    CONSTRAINT sessions_kind_chk CHECK ((kind = ANY (ARRAY['company'::text, 'platform'::text])))
);


--
-- Name: socket_io_attachments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.socket_io_attachments (
    id bigint NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    payload bytea
);


--
-- Name: socket_io_attachments_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.socket_io_attachments_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: socket_io_attachments_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.socket_io_attachments_id_seq OWNED BY public.socket_io_attachments.id;


--
-- Name: subscriptions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.subscriptions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    plan_id uuid NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    billing_interval text NOT NULL,
    price numeric(12,2) DEFAULT '0'::numeric NOT NULL,
    currency character varying(3) NOT NULL,
    is_trial boolean DEFAULT false NOT NULL,
    starts_at timestamp with time zone,
    ends_at timestamp with time zone,
    cancelled_at timestamp with time zone,
    notes text,
    updated_by uuid,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT subscriptions_active_dates_chk CHECK (((status <> 'active'::text) OR ((starts_at IS NOT NULL) AND (ends_at IS NOT NULL)))),
    CONSTRAINT subscriptions_dates_chk CHECK (((ends_at IS NULL) OR (starts_at IS NULL) OR (ends_at > starts_at))),
    CONSTRAINT subscriptions_interval_chk CHECK ((billing_interval = ANY (ARRAY['month'::text, 'year'::text, 'custom'::text]))),
    CONSTRAINT subscriptions_status_chk CHECK ((status = ANY (ARRAY['pending'::text, 'active'::text, 'expired'::text, 'suspended'::text, 'cancelled'::text])))
);

ALTER TABLE ONLY public.subscriptions FORCE ROW LEVEL SECURITY;


--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    email public.citext NOT NULL,
    name text NOT NULL,
    phone text,
    password_hash text,
    is_platform_admin boolean DEFAULT false NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    locale text,
    theme text,
    last_login_at timestamp with time zone,
    password_changed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT users_locale_chk CHECK (((locale IS NULL) OR (locale = ANY (ARRAY['ar'::text, 'en'::text])))),
    CONSTRAINT users_status_chk CHECK ((status = ANY (ARRAY['active'::text, 'disabled'::text, 'invited'::text]))),
    CONSTRAINT users_theme_chk CHECK (((theme IS NULL) OR (theme = ANY (ARRAY['light'::text, 'dark'::text, 'system'::text]))))
);

ALTER TABLE ONLY public.users FORCE ROW LEVEL SECURITY;


--
-- Name: webhook_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.webhook_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    provider text NOT NULL,
    endpoint_key text,
    event_key text NOT NULL,
    event_type text,
    external_account_id text,
    payload jsonb NOT NULL,
    status text DEFAULT 'received'::text NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    last_error text,
    company_id uuid,
    channel_id uuid,
    received_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    processing_started_at timestamp with time zone,
    processed_at timestamp with time zone,
    CONSTRAINT webhook_events_key_len_chk CHECK (((char_length(event_key) >= 1) AND (char_length(event_key) <= 300))),
    CONSTRAINT webhook_events_status_chk CHECK ((status = ANY (ARRAY['received'::text, 'processing'::text, 'processed'::text, 'ignored'::text, 'failed'::text])))
);

ALTER TABLE ONLY public.webhook_events FORCE ROW LEVEL SECURITY;


--
-- Name: audit_logs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_logs ALTER COLUMN id SET DEFAULT nextval('public.audit_logs_id_seq'::regclass);


--
-- Name: conversation_assignments id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversation_assignments ALTER COLUMN id SET DEFAULT nextval('public.conversation_assignments_id_seq'::regclass);


--
-- Name: knex_migrations id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.knex_migrations ALTER COLUMN id SET DEFAULT nextval('public.knex_migrations_id_seq'::regclass);


--
-- Name: knex_migrations_lock index; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.knex_migrations_lock ALTER COLUMN index SET DEFAULT nextval('public.knex_migrations_lock_index_seq'::regclass);


--
-- Name: socket_io_attachments id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.socket_io_attachments ALTER COLUMN id SET DEFAULT nextval('public.socket_io_attachments_id_seq'::regclass);


--
-- Name: audit_logs audit_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_logs
    ADD CONSTRAINT audit_logs_pkey PRIMARY KEY (id);


--
-- Name: auth_tokens auth_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_tokens
    ADD CONSTRAINT auth_tokens_pkey PRIMARY KEY (id);


--
-- Name: auth_tokens auth_tokens_token_hash_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_tokens
    ADD CONSTRAINT auth_tokens_token_hash_unique UNIQUE (token_hash);


--
-- Name: channel_credentials channel_credentials_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channel_credentials
    ADD CONSTRAINT channel_credentials_pkey PRIMARY KEY (channel_id);


--
-- Name: channel_oauth_sessions channel_oauth_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channel_oauth_sessions
    ADD CONSTRAINT channel_oauth_sessions_pkey PRIMARY KEY (id);


--
-- Name: channels channels_company_id_id_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channels
    ADD CONSTRAINT channels_company_id_id_unique UNIQUE (company_id, id);


--
-- Name: channels channels_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channels
    ADD CONSTRAINT channels_pkey PRIMARY KEY (id);


--
-- Name: companies companies_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.companies
    ADD CONSTRAINT companies_pkey PRIMARY KEY (id);


--
-- Name: companies companies_slug_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.companies
    ADD CONSTRAINT companies_slug_unique UNIQUE (slug);


--
-- Name: company_branding company_branding_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.company_branding
    ADD CONSTRAINT company_branding_pkey PRIMARY KEY (company_id);


--
-- Name: company_memberships company_memberships_company_id_user_id_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.company_memberships
    ADD CONSTRAINT company_memberships_company_id_user_id_unique UNIQUE (company_id, user_id);


--
-- Name: company_memberships company_memberships_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.company_memberships
    ADD CONSTRAINT company_memberships_pkey PRIMARY KEY (id);


--
-- Name: company_settings company_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.company_settings
    ADD CONSTRAINT company_settings_pkey PRIMARY KEY (company_id);


--
-- Name: contact_identities contact_identities_channel_id_external_user_id_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contact_identities
    ADD CONSTRAINT contact_identities_channel_id_external_user_id_unique UNIQUE (channel_id, external_user_id);


--
-- Name: contact_identities contact_identities_company_id_id_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contact_identities
    ADD CONSTRAINT contact_identities_company_id_id_unique UNIQUE (company_id, id);


--
-- Name: contact_identities contact_identities_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contact_identities
    ADD CONSTRAINT contact_identities_pkey PRIMARY KEY (id);


--
-- Name: contacts contacts_company_id_id_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contacts
    ADD CONSTRAINT contacts_company_id_id_unique UNIQUE (company_id, id);


--
-- Name: contacts contacts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contacts
    ADD CONSTRAINT contacts_pkey PRIMARY KEY (id);


--
-- Name: conversation_assignments conversation_assignments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversation_assignments
    ADD CONSTRAINT conversation_assignments_pkey PRIMARY KEY (id);


--
-- Name: conversations conversations_channel_id_identity_id_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversations
    ADD CONSTRAINT conversations_channel_id_identity_id_unique UNIQUE (channel_id, identity_id);


--
-- Name: conversations conversations_company_id_id_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversations
    ADD CONSTRAINT conversations_company_id_id_unique UNIQUE (company_id, id);


--
-- Name: conversations conversations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversations
    ADD CONSTRAINT conversations_pkey PRIMARY KEY (id);


--
-- Name: knex_migrations_lock knex_migrations_lock_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.knex_migrations_lock
    ADD CONSTRAINT knex_migrations_lock_pkey PRIMARY KEY (index);


--
-- Name: knex_migrations knex_migrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.knex_migrations
    ADD CONSTRAINT knex_migrations_pkey PRIMARY KEY (id);


--
-- Name: messages messages_company_id_id_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_company_id_id_unique UNIQUE (company_id, id);


--
-- Name: messages messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_pkey PRIMARY KEY (id);


--
-- Name: meta_data_deletions meta_data_deletions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meta_data_deletions
    ADD CONSTRAINT meta_data_deletions_pkey PRIMARY KEY (code);


--
-- Name: notifications notifications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_pkey PRIMARY KEY (id);


--
-- Name: notifications notifications_user_id_dedupe_key_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_user_id_dedupe_key_unique UNIQUE (user_id, dedupe_key);


--
-- Name: payments payments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payments
    ADD CONSTRAINT payments_pkey PRIMARY KEY (id);


--
-- Name: permissions permissions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.permissions
    ADD CONSTRAINT permissions_pkey PRIMARY KEY (key);


--
-- Name: plans plans_key_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plans
    ADD CONSTRAINT plans_key_unique UNIQUE (key);


--
-- Name: plans plans_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plans
    ADD CONSTRAINT plans_pkey PRIMARY KEY (id);


--
-- Name: platform_settings platform_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_settings
    ADD CONSTRAINT platform_settings_pkey PRIMARY KEY (id);


--
-- Name: registration_requests registration_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.registration_requests
    ADD CONSTRAINT registration_requests_pkey PRIMARY KEY (id);


--
-- Name: role_permissions role_permissions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.role_permissions
    ADD CONSTRAINT role_permissions_pkey PRIMARY KEY (role_id, permission_key);


--
-- Name: roles roles_company_id_id_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.roles
    ADD CONSTRAINT roles_company_id_id_unique UNIQUE (company_id, id);


--
-- Name: roles roles_company_id_key_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.roles
    ADD CONSTRAINT roles_company_id_key_unique UNIQUE (company_id, key);


--
-- Name: roles roles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.roles
    ADD CONSTRAINT roles_pkey PRIMARY KEY (id);


--
-- Name: sessions sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_pkey PRIMARY KEY (id);


--
-- Name: socket_io_attachments socket_io_attachments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.socket_io_attachments
    ADD CONSTRAINT socket_io_attachments_pkey PRIMARY KEY (id);


--
-- Name: subscriptions subscriptions_company_id_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscriptions
    ADD CONSTRAINT subscriptions_company_id_unique UNIQUE (company_id);


--
-- Name: subscriptions subscriptions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscriptions
    ADD CONSTRAINT subscriptions_pkey PRIMARY KEY (id);


--
-- Name: users users_email_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_unique UNIQUE (email);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: webhook_events webhook_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.webhook_events
    ADD CONSTRAINT webhook_events_pkey PRIMARY KEY (id);


--
-- Name: webhook_events webhook_events_provider_event_key_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.webhook_events
    ADD CONSTRAINT webhook_events_provider_event_key_unique UNIQUE (provider, event_key);


--
-- Name: audit_logs_company_id_created_at_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_logs_company_id_created_at_index ON public.audit_logs USING btree (company_id, created_at);


--
-- Name: auth_tokens_user_id_purpose_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX auth_tokens_user_id_purpose_index ON public.auth_tokens USING btree (user_id, purpose);


--
-- Name: channels_company_id_status_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX channels_company_id_status_index ON public.channels USING btree (company_id, status);


--
-- Name: channels_live_account_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX channels_live_account_uq ON public.channels USING btree (provider, external_account_id) WHERE ((status <> 'disconnected'::text) AND (external_account_id IS NOT NULL));


--
-- Name: company_memberships_user_id_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX company_memberships_user_id_index ON public.company_memberships USING btree (user_id);


--
-- Name: contacts_company_id_last_contact_at_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX contacts_company_id_last_contact_at_index ON public.contacts USING btree (company_id, last_contact_at);


--
-- Name: conversation_assignments_conversation_id_created_at_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX conversation_assignments_conversation_id_created_at_index ON public.conversation_assignments USING btree (conversation_id, created_at);


--
-- Name: conversations_company_id_assigned_membership_id_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX conversations_company_id_assigned_membership_id_index ON public.conversations USING btree (company_id, assigned_membership_id);


--
-- Name: conversations_company_id_status_last_message_at_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX conversations_company_id_status_last_message_at_index ON public.conversations USING btree (company_id, status, last_message_at);


--
-- Name: messages_client_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX messages_client_uq ON public.messages USING btree (conversation_id, client_message_id) WHERE (client_message_id IS NOT NULL);


--
-- Name: messages_conversation_id_created_at_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX messages_conversation_id_created_at_index ON public.messages USING btree (conversation_id, created_at);


--
-- Name: messages_external_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX messages_external_uq ON public.messages USING btree (channel_id, external_message_id) WHERE (external_message_id IS NOT NULL);


--
-- Name: messages_outbox_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX messages_outbox_idx ON public.messages USING btree (status, created_at) WHERE ((direction = 'out'::text) AND (status = ANY (ARRAY['queued'::text, 'sending'::text])));


--
-- Name: notifications_user_id_created_at_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX notifications_user_id_created_at_index ON public.notifications USING btree (user_id, created_at);


--
-- Name: payments_company_id_paid_at_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX payments_company_id_paid_at_index ON public.payments USING btree (company_id, paid_at);


--
-- Name: registration_requests_status_created_at_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX registration_requests_status_created_at_index ON public.registration_requests USING btree (status, created_at);


--
-- Name: sessions_expires_at_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sessions_expires_at_index ON public.sessions USING btree (expires_at);


--
-- Name: sessions_user_id_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sessions_user_id_index ON public.sessions USING btree (user_id);


--
-- Name: subscriptions_status_ends_at_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX subscriptions_status_ends_at_index ON public.subscriptions USING btree (status, ends_at);


--
-- Name: webhook_events_company_id_received_at_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX webhook_events_company_id_received_at_index ON public.webhook_events USING btree (company_id, received_at);


--
-- Name: webhook_events_status_received_at_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX webhook_events_status_received_at_index ON public.webhook_events USING btree (status, received_at);


--
-- Name: users users_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER users_guard BEFORE UPDATE ON public.users FOR EACH ROW EXECUTE FUNCTION public.users_guard_platform_flag();


--
-- Name: auth_tokens auth_tokens_company_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_tokens
    ADD CONSTRAINT auth_tokens_company_id_foreign FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: auth_tokens auth_tokens_user_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_tokens
    ADD CONSTRAINT auth_tokens_user_id_foreign FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: channel_credentials channel_credentials_company_id_channel_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channel_credentials
    ADD CONSTRAINT channel_credentials_company_id_channel_id_foreign FOREIGN KEY (company_id, channel_id) REFERENCES public.channels(company_id, id) ON DELETE CASCADE;


--
-- Name: channel_oauth_sessions channel_oauth_sessions_company_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channel_oauth_sessions
    ADD CONSTRAINT channel_oauth_sessions_company_id_foreign FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: channels channels_company_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channels
    ADD CONSTRAINT channels_company_id_foreign FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: company_branding company_branding_company_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.company_branding
    ADD CONSTRAINT company_branding_company_id_foreign FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: company_memberships company_memberships_company_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.company_memberships
    ADD CONSTRAINT company_memberships_company_id_foreign FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: company_memberships company_memberships_company_id_role_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.company_memberships
    ADD CONSTRAINT company_memberships_company_id_role_id_foreign FOREIGN KEY (company_id, role_id) REFERENCES public.roles(company_id, id);


--
-- Name: company_memberships company_memberships_user_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.company_memberships
    ADD CONSTRAINT company_memberships_user_id_foreign FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: company_settings company_settings_company_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.company_settings
    ADD CONSTRAINT company_settings_company_id_foreign FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: contact_identities contact_identities_company_id_channel_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contact_identities
    ADD CONSTRAINT contact_identities_company_id_channel_id_foreign FOREIGN KEY (company_id, channel_id) REFERENCES public.channels(company_id, id) ON DELETE CASCADE;


--
-- Name: contact_identities contact_identities_company_id_contact_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contact_identities
    ADD CONSTRAINT contact_identities_company_id_contact_id_foreign FOREIGN KEY (company_id, contact_id) REFERENCES public.contacts(company_id, id) ON DELETE CASCADE;


--
-- Name: contacts contacts_company_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contacts
    ADD CONSTRAINT contacts_company_id_foreign FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: conversation_assignments conversation_assignments_company_id_conversation_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversation_assignments
    ADD CONSTRAINT conversation_assignments_company_id_conversation_id_foreign FOREIGN KEY (company_id, conversation_id) REFERENCES public.conversations(company_id, id) ON DELETE CASCADE;


--
-- Name: conversations conversations_assigned_membership_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversations
    ADD CONSTRAINT conversations_assigned_membership_id_foreign FOREIGN KEY (assigned_membership_id) REFERENCES public.company_memberships(id) ON DELETE SET NULL;


--
-- Name: conversations conversations_company_id_channel_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversations
    ADD CONSTRAINT conversations_company_id_channel_id_foreign FOREIGN KEY (company_id, channel_id) REFERENCES public.channels(company_id, id) ON DELETE CASCADE;


--
-- Name: conversations conversations_company_id_contact_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversations
    ADD CONSTRAINT conversations_company_id_contact_id_foreign FOREIGN KEY (company_id, contact_id) REFERENCES public.contacts(company_id, id) ON DELETE CASCADE;


--
-- Name: conversations conversations_company_id_identity_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversations
    ADD CONSTRAINT conversations_company_id_identity_id_foreign FOREIGN KEY (company_id, identity_id) REFERENCES public.contact_identities(company_id, id) ON DELETE CASCADE;


--
-- Name: messages messages_company_id_channel_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_company_id_channel_id_foreign FOREIGN KEY (company_id, channel_id) REFERENCES public.channels(company_id, id) ON DELETE CASCADE;


--
-- Name: messages messages_company_id_conversation_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_company_id_conversation_id_foreign FOREIGN KEY (company_id, conversation_id) REFERENCES public.conversations(company_id, id) ON DELETE CASCADE;


--
-- Name: notifications notifications_company_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_company_id_foreign FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: notifications notifications_user_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_user_id_foreign FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: payments payments_company_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payments
    ADD CONSTRAINT payments_company_id_foreign FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: payments payments_subscription_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payments
    ADD CONSTRAINT payments_subscription_id_foreign FOREIGN KEY (subscription_id) REFERENCES public.subscriptions(id) ON DELETE SET NULL;


--
-- Name: registration_requests registration_requests_company_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.registration_requests
    ADD CONSTRAINT registration_requests_company_id_foreign FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE SET NULL;


--
-- Name: registration_requests registration_requests_plan_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.registration_requests
    ADD CONSTRAINT registration_requests_plan_id_foreign FOREIGN KEY (plan_id) REFERENCES public.plans(id) ON DELETE SET NULL;


--
-- Name: role_permissions role_permissions_company_id_role_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.role_permissions
    ADD CONSTRAINT role_permissions_company_id_role_id_foreign FOREIGN KEY (company_id, role_id) REFERENCES public.roles(company_id, id) ON DELETE CASCADE;


--
-- Name: role_permissions role_permissions_permission_key_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.role_permissions
    ADD CONSTRAINT role_permissions_permission_key_foreign FOREIGN KEY (permission_key) REFERENCES public.permissions(key) ON DELETE CASCADE;


--
-- Name: roles roles_company_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.roles
    ADD CONSTRAINT roles_company_id_foreign FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: sessions sessions_company_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_company_id_foreign FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE SET NULL;


--
-- Name: sessions sessions_user_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_user_id_foreign FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: subscriptions subscriptions_company_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscriptions
    ADD CONSTRAINT subscriptions_company_id_foreign FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: subscriptions subscriptions_plan_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscriptions
    ADD CONSTRAINT subscriptions_plan_id_foreign FOREIGN KEY (plan_id) REFERENCES public.plans(id);


--
-- Name: audit_logs audit_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY audit_insert ON public.audit_logs FOR INSERT WITH CHECK (((company_id IS NULL) OR (company_id = public.app_current_company()) OR public.app_is_platform_admin()));


--
-- Name: audit_logs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;

--
-- Name: audit_logs audit_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY audit_select ON public.audit_logs FOR SELECT USING (((company_id = public.app_current_company()) OR public.app_is_platform_admin()));


--
-- Name: channel_credentials; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.channel_credentials ENABLE ROW LEVEL SECURITY;

--
-- Name: channel_credentials channel_credentials_definer_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY channel_credentials_definer_read ON public.channel_credentials FOR SELECT USING (public.app_in_definer());


--
-- Name: channel_oauth_sessions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.channel_oauth_sessions ENABLE ROW LEVEL SECURITY;

--
-- Name: channels; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.channels ENABLE ROW LEVEL SECURITY;

--
-- Name: channels channels_definer_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY channels_definer_read ON public.channels FOR SELECT USING (public.app_in_definer());


--
-- Name: companies; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.companies ENABLE ROW LEVEL SECURITY;

--
-- Name: companies companies_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY companies_delete ON public.companies FOR DELETE USING (public.app_is_platform_admin());


--
-- Name: companies companies_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY companies_insert ON public.companies FOR INSERT WITH CHECK (public.app_is_platform_admin());


--
-- Name: companies companies_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY companies_select ON public.companies FOR SELECT USING (((id = public.app_current_company()) OR public.app_is_platform_admin() OR (id IN ( SELECT m.company_id
   FROM public.company_memberships m
  WHERE (m.user_id = public.app_current_user_id())))));


--
-- Name: companies companies_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY companies_update ON public.companies FOR UPDATE USING (((id = public.app_current_company()) OR public.app_is_platform_admin())) WITH CHECK (((id = public.app_current_company()) OR public.app_is_platform_admin()));


--
-- Name: company_branding; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.company_branding ENABLE ROW LEVEL SECURITY;

--
-- Name: company_memberships; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.company_memberships ENABLE ROW LEVEL SECURITY;

--
-- Name: company_settings; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.company_settings ENABLE ROW LEVEL SECURITY;

--
-- Name: contact_identities; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.contact_identities ENABLE ROW LEVEL SECURITY;

--
-- Name: contacts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.contacts ENABLE ROW LEVEL SECURITY;

--
-- Name: conversation_assignments; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.conversation_assignments ENABLE ROW LEVEL SECURITY;

--
-- Name: conversations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.conversations ENABLE ROW LEVEL SECURITY;

--
-- Name: company_memberships memberships_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY memberships_select ON public.company_memberships FOR SELECT USING (((company_id = public.app_current_company()) OR (user_id = public.app_current_user_id()) OR public.app_is_platform_admin() OR public.app_in_definer()));


--
-- Name: company_memberships memberships_write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY memberships_write ON public.company_memberships USING (((company_id = public.app_current_company()) OR public.app_is_platform_admin())) WITH CHECK (((company_id = public.app_current_company()) OR public.app_is_platform_admin()));


--
-- Name: messages; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;

--
-- Name: messages messages_definer_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY messages_definer_read ON public.messages FOR SELECT USING (public.app_in_definer());


--
-- Name: messages messages_definer_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY messages_definer_update ON public.messages FOR UPDATE USING (public.app_in_definer()) WITH CHECK (public.app_in_definer());


--
-- Name: meta_data_deletions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.meta_data_deletions ENABLE ROW LEVEL SECURITY;

--
-- Name: notifications; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;

--
-- Name: notifications notifications_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY notifications_insert ON public.notifications FOR INSERT WITH CHECK (public.app_is_platform_admin());


--
-- Name: notifications notifications_insert_channel; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY notifications_insert_channel ON public.notifications FOR INSERT WITH CHECK (((current_setting('app.system'::text, true) = 'on'::text) AND (company_id = public.app_current_company()) AND (type = ANY (ARRAY['channel_needs_attention'::text, 'channel_token_expiring'::text]))));


--
-- Name: notifications notifications_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY notifications_read ON public.notifications FOR SELECT USING ((public.app_is_platform_admin() OR ((user_id = public.app_current_user_id()) AND (company_id = public.app_current_company()))));


--
-- Name: notifications notifications_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY notifications_update ON public.notifications FOR UPDATE USING (((user_id = public.app_current_user_id()) AND (company_id = public.app_current_company()))) WITH CHECK (((user_id = public.app_current_user_id()) AND (company_id = public.app_current_company())));


--
-- Name: payments; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.payments ENABLE ROW LEVEL SECURITY;

--
-- Name: payments payments_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY payments_read ON public.payments FOR SELECT USING (((company_id = public.app_current_company()) OR public.app_is_platform_admin()));


--
-- Name: payments payments_write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY payments_write ON public.payments FOR INSERT WITH CHECK (public.app_is_platform_admin());


--
-- Name: plans; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.plans ENABLE ROW LEVEL SECURITY;

--
-- Name: plans plans_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY plans_read ON public.plans FOR SELECT USING (true);


--
-- Name: plans plans_write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY plans_write ON public.plans USING (public.app_is_platform_admin()) WITH CHECK (public.app_is_platform_admin());


--
-- Name: platform_settings; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.platform_settings ENABLE ROW LEVEL SECURITY;

--
-- Name: platform_settings platform_settings_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY platform_settings_read ON public.platform_settings FOR SELECT USING (true);


--
-- Name: platform_settings platform_settings_write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY platform_settings_write ON public.platform_settings FOR UPDATE USING (public.app_is_platform_admin()) WITH CHECK (public.app_is_platform_admin());


--
-- Name: registration_requests registration_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY registration_read ON public.registration_requests FOR SELECT USING (public.app_is_platform_admin());


--
-- Name: registration_requests; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.registration_requests ENABLE ROW LEVEL SECURITY;

--
-- Name: registration_requests registration_submit; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY registration_submit ON public.registration_requests FOR INSERT WITH CHECK ((public.app_is_platform_admin() OR ((status = 'pending'::text) AND (company_id IS NULL) AND (reviewed_by IS NULL))));


--
-- Name: registration_requests registration_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY registration_update ON public.registration_requests FOR UPDATE USING (public.app_is_platform_admin()) WITH CHECK (public.app_is_platform_admin());


--
-- Name: role_permissions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.role_permissions ENABLE ROW LEVEL SECURITY;

--
-- Name: roles; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.roles ENABLE ROW LEVEL SECURITY;

--
-- Name: subscriptions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.subscriptions ENABLE ROW LEVEL SECURITY;

--
-- Name: subscriptions subscriptions_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY subscriptions_read ON public.subscriptions FOR SELECT USING (((company_id = public.app_current_company()) OR public.app_is_platform_admin()));


--
-- Name: subscriptions subscriptions_write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY subscriptions_write ON public.subscriptions USING (public.app_is_platform_admin()) WITH CHECK (public.app_is_platform_admin());


--
-- Name: meta_data_deletions system_only; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY system_only ON public.meta_data_deletions USING (((current_setting('app.system'::text, true) = 'on'::text) OR public.app_is_platform_admin())) WITH CHECK (((current_setting('app.system'::text, true) = 'on'::text) OR public.app_is_platform_admin()));


--
-- Name: channel_credentials tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.channel_credentials USING (((company_id = public.app_current_company()) OR public.app_is_platform_admin())) WITH CHECK (((company_id = public.app_current_company()) OR public.app_is_platform_admin()));


--
-- Name: channel_oauth_sessions tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.channel_oauth_sessions USING (((company_id = public.app_current_company()) AND (user_id = public.app_current_user_id()))) WITH CHECK (((company_id = public.app_current_company()) AND (user_id = public.app_current_user_id())));


--
-- Name: channels tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.channels USING (((company_id = public.app_current_company()) OR public.app_is_platform_admin())) WITH CHECK (((company_id = public.app_current_company()) OR public.app_is_platform_admin()));


--
-- Name: company_branding tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.company_branding USING (((company_id = public.app_current_company()) OR public.app_is_platform_admin())) WITH CHECK (((company_id = public.app_current_company()) OR public.app_is_platform_admin()));


--
-- Name: company_settings tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.company_settings USING (((company_id = public.app_current_company()) OR public.app_is_platform_admin())) WITH CHECK (((company_id = public.app_current_company()) OR public.app_is_platform_admin()));


--
-- Name: contact_identities tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.contact_identities USING (((company_id = public.app_current_company()) OR public.app_is_platform_admin())) WITH CHECK (((company_id = public.app_current_company()) OR public.app_is_platform_admin()));


--
-- Name: contacts tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.contacts USING (((company_id = public.app_current_company()) OR public.app_is_platform_admin())) WITH CHECK (((company_id = public.app_current_company()) OR public.app_is_platform_admin()));


--
-- Name: conversation_assignments tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.conversation_assignments USING (((company_id = public.app_current_company()) OR public.app_is_platform_admin())) WITH CHECK (((company_id = public.app_current_company()) OR public.app_is_platform_admin()));


--
-- Name: conversations tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.conversations USING (((company_id = public.app_current_company()) OR public.app_is_platform_admin())) WITH CHECK (((company_id = public.app_current_company()) OR public.app_is_platform_admin()));


--
-- Name: messages tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.messages USING (((company_id = public.app_current_company()) OR public.app_is_platform_admin())) WITH CHECK (((company_id = public.app_current_company()) OR public.app_is_platform_admin()));


--
-- Name: role_permissions tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.role_permissions USING (((company_id = public.app_current_company()) OR public.app_is_platform_admin())) WITH CHECK (((company_id = public.app_current_company()) OR public.app_is_platform_admin()));


--
-- Name: roles tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.roles USING (((company_id = public.app_current_company()) OR public.app_is_platform_admin())) WITH CHECK (((company_id = public.app_current_company()) OR public.app_is_platform_admin()));


--
-- Name: users; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;

--
-- Name: users users_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY users_delete ON public.users FOR DELETE USING (public.app_is_platform_admin());


--
-- Name: users users_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY users_insert ON public.users FOR INSERT WITH CHECK ((((public.app_current_company() IS NOT NULL) OR public.app_is_platform_admin()) AND ((is_platform_admin = false) OR public.app_is_platform_admin())));


--
-- Name: users users_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY users_select ON public.users FOR SELECT USING (((id = public.app_current_user_id()) OR public.app_is_platform_admin() OR public.app_in_definer() OR (id IN ( SELECT m.user_id
   FROM public.company_memberships m
  WHERE (m.company_id = public.app_current_company())))));


--
-- Name: users users_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY users_update ON public.users FOR UPDATE USING (((id = public.app_current_user_id()) OR public.app_is_platform_admin() OR (id IN ( SELECT m.user_id
   FROM public.company_memberships m
  WHERE (m.company_id = public.app_current_company())))));


--
-- Name: webhook_events; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.webhook_events ENABLE ROW LEVEL SECURITY;

--
-- Name: webhook_events webhook_events_system; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY webhook_events_system ON public.webhook_events USING ((public.app_is_system() OR public.app_is_platform_admin())) WITH CHECK ((public.app_is_system() OR public.app_is_platform_admin()));


--
-- Name: SCHEMA public; Type: ACL; Schema: -; Owner: -
--

GRANT USAGE ON SCHEMA public TO sscrm_app;


--
-- Name: FUNCTION app_channel_lookup(p_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.app_channel_lookup(p_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.app_channel_lookup(p_id uuid) TO sscrm_app;


--
-- Name: FUNCTION app_channel_route(p_provider text, p_external text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.app_channel_route(p_provider text, p_external text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.app_channel_route(p_provider text, p_external text) TO sscrm_app;


--
-- Name: FUNCTION app_channels_for_maintenance(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.app_channels_for_maintenance() FROM PUBLIC;
GRANT ALL ON FUNCTION public.app_channels_for_maintenance() TO sscrm_app;


--
-- Name: FUNCTION app_channels_for_meta_user(p_provider text, p_user text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.app_channels_for_meta_user(p_provider text, p_user text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.app_channels_for_meta_user(p_provider text, p_user text) TO sscrm_app;


--
-- Name: FUNCTION app_outbox_fail_stuck(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.app_outbox_fail_stuck() FROM PUBLIC;
GRANT ALL ON FUNCTION public.app_outbox_fail_stuck() TO sscrm_app;


--
-- Name: FUNCTION app_outbox_stale(p_limit integer); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.app_outbox_stale(p_limit integer) FROM PUBLIC;
GRANT ALL ON FUNCTION public.app_outbox_stale(p_limit integer) TO sscrm_app;


--
-- Name: FUNCTION app_user_external_membership_count(p_user uuid, p_company uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.app_user_external_membership_count(p_user uuid, p_company uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.app_user_external_membership_count(p_user uuid, p_company uuid) TO sscrm_app;


--
-- Name: FUNCTION app_user_id_by_email(p_email public.citext); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.app_user_id_by_email(p_email public.citext) FROM PUBLIC;
GRANT ALL ON FUNCTION public.app_user_id_by_email(p_email public.citext) TO sscrm_app;


--
-- Name: FUNCTION app_user_is_platform_admin(p_user uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.app_user_is_platform_admin(p_user uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.app_user_is_platform_admin(p_user uuid) TO sscrm_app;


--
-- Name: FUNCTION auth_user_for_login(p_email public.citext); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.auth_user_for_login(p_email public.citext) FROM PUBLIC;
GRANT ALL ON FUNCTION public.auth_user_for_login(p_email public.citext) TO sscrm_app;


--
-- Name: TABLE audit_logs; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT ON TABLE public.audit_logs TO sscrm_app;


--
-- Name: SEQUENCE audit_logs_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,USAGE ON SEQUENCE public.audit_logs_id_seq TO sscrm_app;


--
-- Name: TABLE auth_tokens; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.auth_tokens TO sscrm_app;


--
-- Name: TABLE channel_credentials; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.channel_credentials TO sscrm_app;


--
-- Name: TABLE channel_oauth_sessions; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE ON TABLE public.channel_oauth_sessions TO sscrm_app;


--
-- Name: TABLE channels; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.channels TO sscrm_app;


--
-- Name: TABLE companies; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.companies TO sscrm_app;


--
-- Name: TABLE company_branding; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.company_branding TO sscrm_app;


--
-- Name: TABLE company_memberships; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.company_memberships TO sscrm_app;


--
-- Name: TABLE company_settings; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.company_settings TO sscrm_app;


--
-- Name: TABLE contact_identities; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.contact_identities TO sscrm_app;


--
-- Name: TABLE contacts; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.contacts TO sscrm_app;


--
-- Name: TABLE conversation_assignments; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT ON TABLE public.conversation_assignments TO sscrm_app;


--
-- Name: SEQUENCE conversation_assignments_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,USAGE ON SEQUENCE public.conversation_assignments_id_seq TO sscrm_app;


--
-- Name: TABLE conversations; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.conversations TO sscrm_app;


--
-- Name: TABLE knex_migrations; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.knex_migrations TO sscrm_app;


--
-- Name: SEQUENCE knex_migrations_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,USAGE ON SEQUENCE public.knex_migrations_id_seq TO sscrm_app;


--
-- Name: TABLE knex_migrations_lock; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.knex_migrations_lock TO sscrm_app;


--
-- Name: SEQUENCE knex_migrations_lock_index_seq; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,USAGE ON SEQUENCE public.knex_migrations_lock_index_seq TO sscrm_app;


--
-- Name: TABLE messages; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.messages TO sscrm_app;


--
-- Name: TABLE meta_data_deletions; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT ON TABLE public.meta_data_deletions TO sscrm_app;


--
-- Name: TABLE notifications; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.notifications TO sscrm_app;


--
-- Name: TABLE payments; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT ON TABLE public.payments TO sscrm_app;


--
-- Name: TABLE permissions; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.permissions TO sscrm_app;


--
-- Name: TABLE plans; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.plans TO sscrm_app;


--
-- Name: TABLE platform_settings; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,UPDATE ON TABLE public.platform_settings TO sscrm_app;


--
-- Name: TABLE registration_requests; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.registration_requests TO sscrm_app;


--
-- Name: TABLE role_permissions; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.role_permissions TO sscrm_app;


--
-- Name: TABLE roles; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.roles TO sscrm_app;


--
-- Name: TABLE sessions; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.sessions TO sscrm_app;


--
-- Name: TABLE socket_io_attachments; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE ON TABLE public.socket_io_attachments TO sscrm_app;


--
-- Name: SEQUENCE socket_io_attachments_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,USAGE ON SEQUENCE public.socket_io_attachments_id_seq TO sscrm_app;


--
-- Name: TABLE subscriptions; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.subscriptions TO sscrm_app;


--
-- Name: TABLE users; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.users TO sscrm_app;


--
-- Name: TABLE webhook_events; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.webhook_events TO sscrm_app;


--
-- PostgreSQL database dump complete
--

\unrestrict 2DdeENUEjprhDCQymrw2fYfNq7Is23b55u38supalKq86iaIVfMeXSpM5HFL0qr

