\restrict dbmate

-- Dumped from database version 18.4
-- Dumped by pg_dump version 18.4

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
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
-- Name: actor_via; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.actor_via AS ENUM (
    'web',
    'session',
    'scheduled_agent',
    'engine'
);


--
-- Name: count_copy_test_sent(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.count_copy_test_sent() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  perform count_daily_send((new.sent_at at time zone 'UTC')::date, 'mailbox', new.mailbox_id::text);
  return null;
end
$$;


--
-- Name: count_daily_send(date, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.count_daily_send(p_day date, p_scope text, p_key text) RETURNS void
    LANGUAGE sql
    AS $$
  insert into daily_sends (day, scope, key, sent) values (p_day, p_scope, p_key, 1)
  on conflict (day, scope, key) do update set sent = daily_sends.sent + 1
$$;


--
-- Name: count_message_sent(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.count_message_sent() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare
  d date := (new.sent_at at time zone 'UTC')::date;
  r record;
begin
  select e.mailbox_id, e.linkedin_account_id, e.sender_id, st.id as strategy_id, st.project_id,
         coalesce(mb.project_id, la.project_id) as channel_project
    into r
    from enrollments e
    join strategies st on st.id = e.strategy_id
    left join mailboxes mb on mb.id = e.mailbox_id
    left join linkedin_accounts la on la.id = e.linkedin_account_id
   where e.id = new.enrollment_id;
  if not found or new.sent_at is null then
    return null;
  end if;
  if new.channel = 'email' then
    if r.mailbox_id is not null then
      perform count_daily_send(d, 'mailbox', r.mailbox_id::text);
    end if;
    if new.to_address like '%@%' then
      perform count_daily_send(d, 'recipient_domain',
        r.project_id::text || ':' || lower(split_part(new.to_address, '@', 2)));
    end if;
  elsif r.linkedin_account_id is not null then
    perform count_daily_send(d, new.channel, r.linkedin_account_id::text);
  end if;
  if new.position = 1 then
    perform count_daily_send(d, 'strategy_first', r.strategy_id::text);
  end if;
  if r.channel_project is null then
    perform count_daily_send(d, 'shared_sender', r.project_id::text || ':' || r.sender_id::text);
  end if;
  return null;
end
$$;


--
-- Name: count_placement_sent(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.count_placement_sent() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  perform count_daily_send((new.sent_at at time zone 'UTC')::date, 'mailbox', new.mailbox_id::text);
  return null;
end
$$;


--
-- Name: count_warmup_sent(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.count_warmup_sent() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if new.sent_at is not null then
    perform count_daily_send((new.sent_at at time zone 'UTC')::date, 'mailbox', new.mailbox_id::text);
  end if;
  return null;
end
$$;


--
-- Name: ensure_event_partitions(integer, timestamp with time zone); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ensure_event_partitions(p_ahead integer DEFAULT 3, p_from timestamp with time zone DEFAULT now()) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $_$
declare
  first_month date := date_trunc('month', p_from at time zone 'UTC')::date;
  m           date;
  lo          timestamptz;
  hi          timestamptz;
  part        text;
  created     integer := 0;
begin
  -- Creating a partition takes a lock on events that waits for writers; better to give up and try
  -- tomorrow (there are months to spare) than to hold every writer behind a long queue.
  perform set_config('lock_timeout', '5s', true);
  for m in
    select (first_month + make_interval(months => i))::date
      from generate_series(0, greatest(p_ahead, 0)) as i
    union
    select distinct date_trunc('month', at at time zone 'UTC')::date from events_default
    order by 1
  loop
    part := 'events_' || to_char(m, 'YYYY_MM');
    continue when to_regclass('public.' || part) is not null;
    lo := m::timestamp at time zone 'UTC';
    hi := (m + interval '1 month')::timestamp at time zone 'UTC';
    if exists (select 1 from events_default where at >= lo and at < hi) then
      -- Rows the net caught: moved into a table of their own, which then becomes the month's
      -- partition (attaching checks the rows fit, and that none is left behind in the default).
      lock table events_default in access exclusive mode;
      execute format('create table public.%I (like public.events including defaults including constraints)', part);
      execute format(
        'with moved as (delete from public.events_default where at >= $1 and at < $2 returning *) '
        'insert into public.%I select * from moved', part) using lo, hi;
      execute format('alter table public.events attach partition public.%I for values from (%L) to (%L)',
                     part, lo, hi);
    else
      execute format('create table public.%I partition of public.events for values from (%L) to (%L)',
                     part, lo, hi);
    end if;
    if exists (select 1 from pg_roles where rolname = 'bhn_reader') then
      execute format('grant select on public.%I to bhn_reader', part);
    end if;
    created := created + 1;
  end loop;
  return created;
end $_$;


--
-- Name: esp_of_company(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.esp_of_company() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  new.esp := (select esp from mail_domains where domain = new.domain);
  return new;
end
$$;


--
-- Name: esp_of_contact(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.esp_of_contact() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  new.esp := case
    when new.email is null then null
    else (select esp from mail_domains where domain = split_part(new.email::text, '@', 2))
  end;
  return new;
end
$$;


--
-- Name: replan_on_company(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.replan_on_company() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  update enrollments e
     set planned_until = null, next_message_id = null, replan_at = clock_timestamp()
    from contacts c
   where c.id = e.contact_id and c.company_id = new.id and e.status = 'active';
  return null;
end
$$;


--
-- Name: replan_on_contact(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.replan_on_contact() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  update enrollments
     set planned_until = null, next_message_id = null, replan_at = clock_timestamp()
   where contact_id = new.id and status = 'active';
  return null;
end
$$;


--
-- Name: replan_on_enrollment(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.replan_on_enrollment() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if (old.status, old.starts_at, old.paused_until, old.mailbox_id, old.linkedin_account_id, old.contact_id)
     is distinct from
     (new.status, new.starts_at, new.paused_until, new.mailbox_id, new.linkedin_account_id, new.contact_id)
  then
    new.planned_until := null;
    new.next_message_id := null;
    new.replan_at := clock_timestamp();
  end if;
  return new;
end
$$;


--
-- Name: replan_on_messages_inserted(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.replan_on_messages_inserted() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  update enrollments
     set planned_until = null, next_message_id = null, replan_at = clock_timestamp()
   where id in (select enrollment_id from inserted);
  return null;
end
$$;


--
-- Name: replan_on_messages_updated(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.replan_on_messages_updated() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  update enrollments
     set planned_until = null, next_message_id = null, replan_at = clock_timestamp()
   where id in (
     select n.enrollment_id
       from after_rows n join before_rows o on o.id = n.id
      where (o.status, o.accepted_at, o.sent_at, o.written_at)
            is distinct from (n.status, n.accepted_at, n.sent_at, n.written_at));
  return null;
end
$$;


--
-- Name: replan_on_project(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.replan_on_project() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  update enrollments e
     set planned_until = null, next_message_id = null, replan_at = clock_timestamp()
    from strategies s
   where s.id = e.strategy_id and s.project_id = new.id and e.status = 'active';
  return null;
end
$$;


--
-- Name: replan_on_strategy(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.replan_on_strategy() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  update enrollments
     set planned_until = null, next_message_id = null, replan_at = clock_timestamp()
   where strategy_id = new.id and status = 'active';
  return null;
end
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: address_checks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.address_checks (
    id uuid DEFAULT uuidv7() NOT NULL,
    contact_id uuid NOT NULL,
    address public.citext NOT NULL,
    provider text NOT NULL,
    reason text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    provider_ref text,
    requested_at timestamp with time zone DEFAULT now() NOT NULL,
    result_at timestamp with time zone,
    requested_by uuid,
    requested_via public.actor_via NOT NULL,
    CONSTRAINT address_checks_reason_check CHECK ((reason = ANY (ARRAY['bounce_replacement'::text, 'catch_all'::text, 'new_contact'::text]))),
    CONSTRAINT address_checks_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'valid'::text, 'invalid'::text, 'risky'::text, 'unknown'::text])))
);


--
-- Name: address_replacements; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.address_replacements (
    contact_id uuid NOT NULL,
    previous jsonb NOT NULL,
    actor_user_id uuid NOT NULL,
    actor_via public.actor_via NOT NULL,
    effective_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: agent_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_runs (
    id uuid DEFAULT uuidv7() NOT NULL,
    project_id uuid NOT NULL,
    status text DEFAULT 'queued'::text NOT NULL,
    work jsonb DEFAULT '{}'::jsonb NOT NULL,
    requested_by uuid,
    prompt text NOT NULL,
    model text,
    budget_usd numeric(12,6) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    started_at timestamp with time zone,
    heartbeat_at timestamp with time zone,
    finished_at timestamp with time zone,
    cost_usd numeric(12,6),
    input_tokens bigint,
    output_tokens bigint,
    turns bigint,
    summary text,
    transcript jsonb,
    error text,
    priority bigint DEFAULT 1 NOT NULL,
    work_keys text[] DEFAULT '{}'::text[] NOT NULL,
    oldest_waiting_at timestamp with time zone,
    kind text DEFAULT 'work'::text NOT NULL,
    reply_id uuid,
    CONSTRAINT agent_runs_kind_check CHECK ((kind = ANY (ARRAY['work'::text, 'rewrite'::text]))),
    CONSTRAINT agent_runs_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'running'::text, 'succeeded'::text, 'failed'::text, 'cancelled'::text])))
);


--
-- Name: api_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.api_tokens (
    id uuid DEFAULT uuidv7() NOT NULL,
    user_id uuid NOT NULL,
    kind text DEFAULT 'person'::text NOT NULL,
    name text NOT NULL,
    token_hash bytea NOT NULL,
    last_used_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    revoked_at timestamp with time zone,
    revoke_at timestamp with time zone,
    revoke_by uuid,
    revoke_via public.actor_via,
    CONSTRAINT api_tokens_kind_check CHECK ((kind = ANY (ARRAY['person'::text, 'scheduled_agent'::text])))
);


--
-- Name: calendar_offers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.calendar_offers (
    calendar_id uuid NOT NULL,
    starts_at timestamp with time zone NOT NULL,
    minutes bigint NOT NULL,
    CONSTRAINT calendar_offers_minutes_check CHECK (((minutes >= 10) AND (minutes <= 480)))
);


--
-- Name: calendars; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.calendars (
    id uuid DEFAULT uuidv7() NOT NULL,
    project_id uuid NOT NULL,
    provider text NOT NULL,
    external_id text NOT NULL,
    name text NOT NULL,
    owner_name text,
    owner_email public.citext NOT NULL,
    credential bytea,
    event_type text,
    timezone text NOT NULL,
    meeting_minutes integer DEFAULT 30 NOT NULL,
    priority integer DEFAULT 1 NOT NULL,
    synced_at timestamp with time zone,
    probed_at timestamp with time zone,
    disconnected_at timestamp with time zone,
    disconnected_reason text,
    archived_at timestamp with time zone,
    connected_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    sender_id uuid,
    CONSTRAINT calendars_calcom_check CHECK (((provider <> 'calcom'::text) OR ((event_type IS NOT NULL) AND (sender_id IS NOT NULL)))),
    CONSTRAINT calendars_check2 CHECK (((disconnected_at IS NULL) = (disconnected_reason IS NULL))),
    CONSTRAINT calendars_meeting_minutes_check CHECK (((meeting_minutes >= 10) AND (meeting_minutes <= 180))),
    CONSTRAINT calendars_provider_check CHECK (((provider = 'calcom'::text) OR ((provider = ANY (ARRAY['google'::text, 'microsoft'::text, 'calendly'::text])) AND (archived_at IS NOT NULL))))
);


--
-- Name: meeting_slots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.meeting_slots (
    id uuid DEFAULT uuidv7() NOT NULL,
    project_id uuid NOT NULL,
    thread_id uuid NOT NULL,
    calendar_id uuid NOT NULL,
    reply_id uuid,
    starts_at timestamp with time zone NOT NULL,
    minutes integer DEFAULT 30 NOT NULL,
    "position" integer NOT NULL,
    status text DEFAULT 'offered'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT meeting_slots_status_check CHECK ((status = ANY (ARRAY['offered'::text, 'accepted'::text, 'released'::text])))
);


--
-- Name: meetings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.meetings (
    id uuid DEFAULT uuidv7() NOT NULL,
    project_id uuid NOT NULL,
    contact_id uuid NOT NULL,
    thread_id uuid,
    calendar_id uuid NOT NULL,
    slot_id uuid,
    strategy_id uuid,
    segment_id uuid,
    persona_id uuid,
    scheduled_at timestamp with time zone NOT NULL,
    minutes integer DEFAULT 30 NOT NULL,
    lead_timezone text,
    status text DEFAULT 'scheduled'::text NOT NULL,
    rescheduled_from uuid,
    provider_event_id text,
    invite_sent_at timestamp with time zone,
    calendar_error text,
    calendar_synced_at timestamp with time zone,
    outcome text,
    client_feedback text,
    feedback_at timestamp with time zone,
    outcome_by uuid,
    outcome_via public.actor_via,
    notes text,
    booked_by uuid,
    booked_via public.actor_via NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    cancel_at timestamp with time zone,
    cancel_reason text,
    cancel_by uuid,
    cancel_via public.actor_via,
    CONSTRAINT meetings_check CHECK (((outcome IS NULL) OR (status = 'held'::text))),
    CONSTRAINT meetings_outcome_check CHECK ((outcome = ANY (ARRAY['qualified'::text, 'not_qualified'::text, 'opportunity'::text, 'won'::text, 'lost'::text]))),
    CONSTRAINT meetings_status_check CHECK ((status = ANY (ARRAY['scheduled'::text, 'held'::text, 'no_show'::text, 'cancelled'::text, 'rescheduled'::text])))
);


--
-- Name: calendar_free_slots; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.calendar_free_slots AS
 SELECT c.id AS calendar_id,
    c.project_id,
    c.priority,
    o.starts_at,
    (o.starts_at + make_interval(mins => (o.minutes)::integer)) AS ends_at,
    c.timezone
   FROM (public.calendars c
     JOIN public.calendar_offers o ON ((o.calendar_id = c.id)))
  WHERE ((c.archived_at IS NULL) AND (c.disconnected_at IS NULL) AND (o.starts_at > now()) AND (NOT (EXISTS ( SELECT 1
           FROM public.meetings m
          WHERE ((m.calendar_id = c.id) AND (m.status = 'scheduled'::text) AND (tstzrange(m.scheduled_at, (m.scheduled_at + make_interval(mins => m.minutes))) && tstzrange(o.starts_at, (o.starts_at + make_interval(mins => (o.minutes)::integer)))))))) AND (NOT (EXISTS ( SELECT 1
           FROM public.meeting_slots ms
          WHERE ((ms.calendar_id = c.id) AND (ms.status = ANY (ARRAY['offered'::text, 'accepted'::text])) AND (tstzrange(ms.starts_at, (ms.starts_at + make_interval(mins => ms.minutes))) && tstzrange(o.starts_at, (o.starts_at + make_interval(mins => (o.minutes)::integer)))))))));


--
-- Name: channel_invites; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.channel_invites (
    id uuid DEFAULT uuidv7() NOT NULL,
    token_hash bytea NOT NULL,
    channel text NOT NULL,
    project_id uuid NOT NULL,
    sender_id uuid NOT NULL,
    created_by uuid NOT NULL,
    created_via public.actor_via NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    used_at timestamp with time zone,
    revoked_at timestamp with time zone,
    CONSTRAINT channel_invites_channel_check CHECK ((channel = ANY (ARRAY['calendar'::text, 'linkedin'::text])))
);


--
-- Name: cli_logins; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cli_logins (
    id uuid DEFAULT uuidv7() NOT NULL,
    device_hash bytea NOT NULL,
    user_code text NOT NULL,
    client_name text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    approved_by uuid,
    approved_at timestamp with time zone,
    token_id uuid,
    claimed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT cli_logins_check CHECK (((approved_by IS NULL) = (approved_at IS NULL))),
    CONSTRAINT cli_logins_check1 CHECK (((claimed_at IS NULL) OR (approved_at IS NOT NULL)))
);


--
-- Name: client_questions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.client_questions (
    id uuid DEFAULT uuidv7() NOT NULL,
    project_id uuid NOT NULL,
    question text NOT NULL,
    context text,
    status text DEFAULT 'open'::text NOT NULL,
    asked_at timestamp with time zone,
    answer text,
    answered_at timestamp with time zone,
    created_by uuid,
    created_via public.actor_via NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT client_questions_check CHECK (((status <> 'answered'::text) OR (answer IS NOT NULL))),
    CONSTRAINT client_questions_status_check CHECK ((status = ANY (ARRAY['open'::text, 'asked'::text, 'answered'::text, 'dropped'::text])))
);


--
-- Name: client_reports; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.client_reports (
    id uuid DEFAULT uuidv7() NOT NULL,
    project_id uuid NOT NULL,
    period_start date NOT NULL,
    period_end date NOT NULL,
    url text NOT NULL,
    figures jsonb DEFAULT '{}'::jsonb NOT NULL,
    built_by uuid,
    built_via public.actor_via NOT NULL,
    built_at timestamp with time zone DEFAULT now() NOT NULL,
    sent_at timestamp with time zone,
    CONSTRAINT client_reports_check CHECK ((period_end >= period_start))
);


--
-- Name: companies; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.companies (
    id uuid DEFAULT uuidv7() NOT NULL,
    project_id uuid NOT NULL,
    domain public.citext NOT NULL,
    name text,
    linkedin_url text,
    industry text,
    employee_count integer,
    country text,
    timezone text,
    facts jsonb DEFAULT '{}'::jsonb NOT NULL,
    source text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    esp text
);


--
-- Name: contacts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.contacts (
    id uuid DEFAULT uuidv7() NOT NULL,
    project_id uuid NOT NULL,
    company_id uuid,
    first_name text,
    last_name text,
    title text,
    email public.citext,
    email_status text,
    email_verified_at timestamp with time zone,
    linkedin_url text,
    linkedin_provider_id text,
    country text,
    timezone text,
    facts jsonb DEFAULT '{}'::jsonb NOT NULL,
    source text,
    referred_by_contact_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    archived_at timestamp with time zone,
    departed_at timestamp with time zone,
    departed_by uuid,
    departed_via public.actor_via,
    esp text,
    CONSTRAINT contacts_check CHECK (((email IS NOT NULL) OR (linkedin_url IS NOT NULL))),
    CONSTRAINT contacts_email_status_check CHECK ((email_status = ANY (ARRAY['valid'::text, 'catch_all'::text, 'invalid'::text, 'bounced'::text, 'unknown'::text])))
);


--
-- Name: copy_tests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.copy_tests (
    id uuid DEFAULT uuidv7() NOT NULL,
    message_id uuid NOT NULL,
    mailbox_id uuid NOT NULL,
    to_address public.citext NOT NULL,
    subject text NOT NULL,
    rfc_message_id text NOT NULL,
    sent_by uuid NOT NULL,
    sent_via public.actor_via NOT NULL,
    sent_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: daily_sends; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.daily_sends (
    day date NOT NULL,
    scope text NOT NULL,
    key text NOT NULL,
    sent integer DEFAULT 0 NOT NULL,
    CONSTRAINT daily_sends_scope_check CHECK ((scope = ANY (ARRAY['mailbox'::text, 'linkedin_invite'::text, 'linkedin_message'::text, 'strategy_first'::text, 'recipient_domain'::text, 'shared_sender'::text])))
)
WITH (fillfactor='70', autovacuum_vacuum_scale_factor='0.02', autovacuum_analyze_scale_factor='0.02');


--
-- Name: dnc; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dnc (
    id uuid DEFAULT uuidv7() NOT NULL,
    project_id uuid,
    kind text NOT NULL,
    value public.citext NOT NULL,
    reason text NOT NULL,
    note text,
    created_by uuid,
    created_via public.actor_via NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    removed_at timestamp with time zone,
    CONSTRAINT dnc_kind_check CHECK ((kind = ANY (ARRAY['email'::text, 'domain'::text]))),
    CONSTRAINT dnc_reason_check CHECK ((reason = ANY (ARRAY['unsubscribed'::text, 'complaint'::text, 'bounced'::text, 'competitor'::text, 'existing_customer'::text, 'client_request'::text, 'other'::text])))
);


--
-- Name: domains; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.domains (
    id uuid DEFAULT uuidv7() NOT NULL,
    domain public.citext NOT NULL,
    spf_ok boolean,
    dkim_ok boolean,
    dmarc_ok boolean,
    details jsonb DEFAULT '{}'::jsonb NOT NULL,
    checked_at timestamp with time zone,
    project_id uuid,
    status text DEFAULT 'external'::text NOT NULL,
    registrar text,
    supplier text,
    supplier_domain_id text,
    order_key uuid,
    cost_cents integer,
    registered_at timestamp with time zone,
    expires_at timestamp with time zone,
    redirect_to text,
    failure text,
    bought_by uuid,
    bought_via public.actor_via,
    auto_renew boolean DEFAULT true NOT NULL,
    tenant_id uuid,
    dkim_started_at timestamp with time zone,
    organisation_id uuid,
    alerted text,
    CONSTRAINT domains_bought_check CHECK (((status = 'external'::text) OR (bought_by IS NOT NULL))),
    CONSTRAINT domains_one_owner CHECK ((num_nonnulls(project_id, organisation_id) <= 1)),
    CONSTRAINT domains_registrar_check CHECK (((registrar IS NULL) OR (registrar = ANY (ARRAY['porkbun'::text])))),
    CONSTRAINT domains_status_check CHECK ((status = ANY (ARRAY['external'::text, 'approved'::text, 'buying'::text, 'registered'::text, 'attaching'::text, 'ready'::text, 'failed'::text, 'released'::text]))),
    CONSTRAINT domains_supplier_check CHECK (((supplier IS NULL) OR (supplier = ANY (ARRAY['zapmail'::text, 'workspace'::text]))))
);


--
-- Name: enrollments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.enrollments (
    id uuid DEFAULT uuidv7() NOT NULL,
    strategy_id uuid NOT NULL,
    contact_id uuid NOT NULL,
    segment_id uuid NOT NULL,
    persona_id uuid NOT NULL,
    plan_id uuid,
    kind text DEFAULT 'first'::text NOT NULL,
    follows_enrollment_id uuid,
    starts_at timestamp with time zone,
    status text DEFAULT 'active'::text NOT NULL,
    stop_reason text,
    paused_until timestamp with time zone,
    pause_reason text,
    stuck_reason text,
    stuck_since timestamp with time zone,
    sender_id uuid NOT NULL,
    mailbox_id uuid,
    linkedin_account_id uuid,
    current_step integer DEFAULT 0 NOT NULL,
    enrolled_by uuid,
    enrolled_via public.actor_via NOT NULL,
    ended_by uuid,
    ended_via public.actor_via,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    ended_at timestamp with time zone,
    start_offset_days integer,
    stuck_code text,
    stuck_step integer,
    next_message_id uuid,
    next_due_at timestamp with time zone,
    planned_until timestamp with time zone,
    replan_at timestamp with time zone,
    CONSTRAINT enrollments_check CHECK (((status = 'stopped'::text) = (stop_reason IS NOT NULL))),
    CONSTRAINT enrollments_check1 CHECK (((status <> 'scheduled'::text) OR (starts_at IS NOT NULL))),
    CONSTRAINT enrollments_check2 CHECK (((kind = 'first'::text) OR (follows_enrollment_id IS NOT NULL))),
    CONSTRAINT enrollments_check3 CHECK (((status = 'paused'::text) = (pause_reason IS NOT NULL))),
    CONSTRAINT enrollments_kind_check CHECK ((kind = ANY (ARRAY['first'::text, 're_engagement'::text, 'referral'::text]))),
    CONSTRAINT enrollments_pause_reason_check CHECK ((pause_reason = ANY (ARRAY['out_of_office'::text, 'company_meeting'::text, 'manual'::text, 'held_back'::text]))),
    CONSTRAINT enrollments_status_check CHECK ((status = ANY (ARRAY['scheduled'::text, 'active'::text, 'paused'::text, 'completed'::text, 'stopped'::text]))),
    CONSTRAINT enrollments_stop_reason_check CHECK ((stop_reason = ANY (ARRAY['replied'::text, 'unsubscribed'::text, 'dnc'::text, 'no_channel_left'::text, 'sender_gone'::text, 'manual'::text, 'wrong_person'::text]))),
    CONSTRAINT enrollments_stuck_code_check CHECK ((stuck_code = ANY (ARRAY['no_copy'::text, 'linkedin_not_configured'::text, 'mailbox_disconnected'::text, 'linkedin_disconnected'::text, 'other'::text]))),
    CONSTRAINT enrollments_stuck_code_with_reason CHECK ((((stuck_code IS NULL) = (stuck_reason IS NULL)) AND ((stuck_step IS NULL) OR (stuck_code IS NOT NULL))))
)
WITH (fillfactor='85', autovacuum_vacuum_scale_factor='0.02', autovacuum_analyze_scale_factor='0.02');


--
-- Name: messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.messages (
    id uuid DEFAULT uuidv7() NOT NULL,
    enrollment_id uuid NOT NULL,
    step_id uuid,
    "position" integer NOT NULL,
    channel text NOT NULL,
    delay_days integer DEFAULT 0 NOT NULL,
    anchor text DEFAULT 'previous_step'::text NOT NULL,
    condition text,
    max_wait_days integer DEFAULT 10 NOT NULL,
    resend_of uuid,
    status text DEFAULT 'needs_copy'::text NOT NULL,
    subject text,
    body text,
    angle text,
    written_by uuid,
    written_via public.actor_via,
    written_at timestamp with time zone,
    skip_reason text,
    due_at timestamp with time zone,
    claimed_until timestamp with time zone,
    attempts integer DEFAULT 0 NOT NULL,
    retry_at timestamp with time zone,
    last_error text,
    rfc_message_id text,
    to_address text,
    provider_message_id text,
    thread_id uuid,
    sent_at timestamp with time zone,
    accepted_at timestamp with time zone,
    bounced_at timestamp with time zone,
    bounce_kind text,
    bounce_class text,
    skip_code text,
    CONSTRAINT messages_anchor_check CHECK ((anchor = ANY (ARRAY['previous_step'::text, 'invite_accepted'::text]))),
    CONSTRAINT messages_bounce_class_check CHECK ((bounce_class = ANY (ARRAY['no_such_user'::text, 'mailbox_full'::text, 'temporary'::text, 'blocked'::text, 'other'::text]))),
    CONSTRAINT messages_bounce_kind_check CHECK ((bounce_kind = ANY (ARRAY['hard'::text, 'soft'::text]))),
    CONSTRAINT messages_channel_check CHECK ((channel = ANY (ARRAY['email'::text, 'linkedin_invite'::text, 'linkedin_message'::text]))),
    CONSTRAINT messages_check CHECK (((status = ANY (ARRAY['needs_copy'::text, 'cancelled'::text, 'skipped'::text])) OR (body IS NOT NULL))),
    CONSTRAINT messages_check1 CHECK (((channel <> 'email'::text) OR (status = ANY (ARRAY['needs_copy'::text, 'cancelled'::text, 'skipped'::text])) OR (subject IS NOT NULL))),
    CONSTRAINT messages_check2 CHECK (((channel <> 'linkedin_invite'::text) OR (length(body) <= 300))),
    CONSTRAINT messages_condition_check CHECK ((condition = ANY (ARRAY['invite_accepted'::text, 'invite_not_accepted'::text]))),
    CONSTRAINT messages_position_check CHECK (("position" >= 1)),
    CONSTRAINT messages_skip_code_check CHECK ((skip_code = ANY (ARRAY['replied'::text, 'bounced'::text, 'unsubscribed'::text, 'dnc'::text, 'no_email'::text, 'not_allowlisted'::text, 'no_linkedin_account'::text, 'no_linkedin_profile'::text, 'already_connected'::text, 'not_connected'::text, 'no_invitation'::text, 'invitation_accepted'::text, 'invitation_not_sent'::text, 'invitation_not_accepted'::text, 'wrong_person'::text, 'other'::text]))),
    CONSTRAINT messages_skip_code_with_reason CHECK (((skip_code IS NULL) = (skip_reason IS NULL))),
    CONSTRAINT messages_status_check CHECK ((status = ANY (ARRAY['needs_copy'::text, 'ready'::text, 'sending'::text, 'sent'::text, 'failed'::text, 'skipped'::text, 'cancelled'::text])))
)
WITH (fillfactor='90', autovacuum_vacuum_scale_factor='0.02', autovacuum_analyze_scale_factor='0.02');


--
-- Name: thread_messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.thread_messages (
    id uuid DEFAULT uuidv7() NOT NULL,
    thread_id uuid NOT NULL,
    direction text NOT NULL,
    kind text NOT NULL,
    message_id uuid,
    reply_to_message_id uuid,
    from_address text,
    to_addresses text[],
    subject text,
    body_text text,
    rfc_message_id text,
    provider_message_id text NOT NULL,
    headers jsonb DEFAULT '{}'::jsonb NOT NULL,
    sent_at timestamp with time zone NOT NULL,
    triaged_at timestamp with time zone,
    classification text,
    classification_note text,
    follow_up_on date,
    triaged_by uuid,
    triaged_via public.actor_via,
    reply_id uuid,
    CONSTRAINT thread_messages_classification_check CHECK ((classification = ANY (ARRAY['interested'::text, 'meeting'::text, 'question'::text, 'not_now'::text, 'referral'::text, 'not_interested'::text, 'unsubscribe'::text, 'wrong_person'::text, 'acknowledgement'::text, 'out_of_office'::text, 'other'::text]))),
    CONSTRAINT thread_messages_direction_check CHECK ((direction = ANY (ARRAY['in'::text, 'out'::text]))),
    CONSTRAINT thread_messages_kind_check CHECK ((kind = ANY (ARRAY['reply'::text, 'auto_reply'::text, 'bounce'::text, 'outreach'::text, 'manual'::text])))
);


--
-- Name: threads; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.threads (
    id uuid DEFAULT uuidv7() NOT NULL,
    project_id uuid NOT NULL,
    channel text NOT NULL,
    mailbox_id uuid,
    linkedin_account_id uuid,
    provider_thread_id text NOT NULL,
    contact_id uuid,
    enrollment_id uuid,
    subject text,
    status text DEFAULT 'open'::text NOT NULL,
    assigned_to uuid,
    last_message_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT threads_channel_check CHECK ((channel = ANY (ARRAY['email'::text, 'linkedin'::text]))),
    CONSTRAINT threads_check CHECK (((channel = 'email'::text) = (mailbox_id IS NOT NULL))),
    CONSTRAINT threads_status_check CHECK ((status = ANY (ARRAY['open'::text, 'waiting'::text, 'closed'::text])))
);


--
-- Name: enrollment_outcomes; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.enrollment_outcomes AS
 SELECT id AS enrollment_id,
    strategy_id,
    segment_id,
    persona_id,
    (EXISTS ( SELECT 1
           FROM public.messages m
          WHERE ((m.enrollment_id = e.id) AND (m.status = 'sent'::text)))) AS contacted,
    (EXISTS ( SELECT 1
           FROM (public.threads t
             JOIN public.thread_messages tm ON ((tm.thread_id = t.id)))
          WHERE ((t.enrollment_id = e.id) AND (tm.direction = 'in'::text) AND (tm.kind = 'reply'::text)))) AS replied,
    (EXISTS ( SELECT 1
           FROM (public.threads t
             JOIN public.thread_messages tm ON ((tm.thread_id = t.id)))
          WHERE ((t.enrollment_id = e.id) AND (tm.direction = 'in'::text) AND (tm.kind = 'reply'::text) AND (tm.classification = ANY (ARRAY['interested'::text, 'meeting'::text, 'question'::text, 'referral'::text]))))) AS positive,
    (EXISTS ( SELECT 1
           FROM (public.meetings mt
             LEFT JOIN public.threads t ON ((t.id = mt.thread_id)))
          WHERE ((mt.contact_id = e.contact_id) AND (mt.strategy_id = e.strategy_id) AND (mt.status = ANY (ARRAY['scheduled'::text, 'held'::text])) AND ((t.enrollment_id IS NULL) OR (t.enrollment_id = e.id))))) AS meeting
   FROM public.enrollments e;


--
-- Name: event_types; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.event_types (
    type text NOT NULL,
    emitted_by text NOT NULL,
    description text NOT NULL,
    CONSTRAINT event_types_emitted_by_check CHECK ((emitted_by = ANY (ARRAY['engine'::text, 'agent'::text, 'person'::text, 'any'::text])))
);


--
-- Name: events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.events (
    id bigint CONSTRAINT events_id_not_null1 NOT NULL,
    project_id uuid CONSTRAINT events_project_id_not_null1 NOT NULL,
    at timestamp with time zone DEFAULT now() CONSTRAINT events_at_not_null1 NOT NULL,
    type text CONSTRAINT events_type_not_null1 NOT NULL,
    actor_via public.actor_via DEFAULT 'engine'::public.actor_via CONSTRAINT events_actor_via_not_null1 NOT NULL,
    actor_user_id uuid,
    summary text,
    strategy_id uuid,
    segment_id uuid,
    enrollment_id uuid,
    contact_id uuid,
    mailbox_id uuid,
    meeting_id uuid,
    task_id uuid,
    data jsonb DEFAULT '{}'::jsonb CONSTRAINT events_data_not_null1 NOT NULL,
    CONSTRAINT events_check CHECK (((actor_via = 'engine'::public.actor_via) OR (actor_user_id IS NOT NULL)))
)
PARTITION BY RANGE (at);


--
-- Name: events_default; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.events_default (
    id bigint CONSTRAINT events_id_not_null1 NOT NULL,
    project_id uuid CONSTRAINT events_project_id_not_null1 NOT NULL,
    at timestamp with time zone DEFAULT now() CONSTRAINT events_at_not_null1 NOT NULL,
    type text CONSTRAINT events_type_not_null1 NOT NULL,
    actor_via public.actor_via DEFAULT 'engine'::public.actor_via CONSTRAINT events_actor_via_not_null1 NOT NULL,
    actor_user_id uuid,
    summary text,
    strategy_id uuid,
    segment_id uuid,
    enrollment_id uuid,
    contact_id uuid,
    mailbox_id uuid,
    meeting_id uuid,
    task_id uuid,
    data jsonb DEFAULT '{}'::jsonb CONSTRAINT events_data_not_null1 NOT NULL,
    CONSTRAINT events_check CHECK (((actor_via = 'engine'::public.actor_via) OR (actor_user_id IS NOT NULL)))
);


--
-- Name: events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.events ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: project_goals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.project_goals (
    project_id uuid NOT NULL,
    month date NOT NULL,
    meetings_target integer NOT NULL,
    counts text DEFAULT 'qualified'::text NOT NULL,
    set_by uuid,
    set_at timestamp with time zone DEFAULT now() NOT NULL,
    meetings_done bigint,
    done_by uuid,
    done_at timestamp with time zone,
    CONSTRAINT project_goals_counts_check CHECK ((counts = ANY (ARRAY['held'::text, 'qualified'::text]))),
    CONSTRAINT project_goals_meetings_done_check CHECK ((meetings_done >= 0)),
    CONSTRAINT project_goals_meetings_target_check CHECK ((meetings_target > 0)),
    CONSTRAINT project_goals_month_check CHECK ((EXTRACT(day FROM month) = (1)::numeric))
);


--
-- Name: goal_progress; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.goal_progress AS
 SELECT g.project_id,
    g.month,
    g.meetings_target,
    g.counts,
    count(m.id) FILTER (WHERE ((m.status = 'held'::text) AND ((g.counts = 'held'::text) OR (m.outcome = ANY (ARRAY['qualified'::text, 'opportunity'::text, 'won'::text]))))) AS achieved,
    count(m.id) FILTER (WHERE (m.status = 'scheduled'::text)) AS scheduled
   FROM (public.project_goals g
     LEFT JOIN public.meetings m ON (((m.project_id = g.project_id) AND (m.scheduled_at >= g.month) AND (m.scheduled_at < (g.month + '1 mon'::interval)))))
  GROUP BY g.project_id, g.month, g.meetings_target, g.counts;


--
-- Name: hypotheses; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.hypotheses (
    id uuid DEFAULT uuidv7() NOT NULL,
    project_id uuid NOT NULL,
    claim text NOT NULL,
    evidence text,
    status text DEFAULT 'proposed'::text NOT NULL,
    segment_id uuid,
    persona_id uuid,
    strategy_id uuid,
    metric text,
    threshold text,
    testing_by uuid,
    testing_at timestamp with time zone,
    verdict text,
    verdict_at timestamp with time zone,
    created_by uuid,
    created_via public.actor_via NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    updated_via public.actor_via,
    updated_at timestamp with time zone,
    CONSTRAINT hypotheses_status_check CHECK ((status = ANY (ARRAY['proposed'::text, 'testing'::text, 'confirmed'::text, 'rejected'::text, 'parked'::text]))),
    CONSTRAINT hypotheses_testing_check CHECK (((status <> 'testing'::text) OR ((metric IS NOT NULL) AND (threshold IS NOT NULL) AND (testing_at IS NOT NULL)))),
    CONSTRAINT hypotheses_verdict_check CHECK (((status <> ALL (ARRAY['confirmed'::text, 'rejected'::text])) OR ((verdict IS NOT NULL) AND (verdict_at IS NOT NULL))))
);


--
-- Name: inbox_queue; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.inbox_queue AS
 SELECT tm.id AS thread_message_id,
    tm.thread_id,
    t.project_id,
    tm.kind,
    tm.sent_at,
    (now() - tm.sent_at) AS waiting,
    tm.body_text,
    ct.id AS contact_id,
    ct.first_name,
    ct.last_name,
    ct.title,
    co.name AS company,
    co.domain,
    t.enrollment_id,
    e.strategy_id,
    ( SELECT m.angle
           FROM public.messages m
          WHERE (m.id = tm.reply_to_message_id)) AS replied_to_angle
   FROM ((((public.thread_messages tm
     JOIN public.threads t ON ((t.id = tm.thread_id)))
     LEFT JOIN public.contacts ct ON ((ct.id = t.contact_id)))
     LEFT JOIN public.companies co ON ((co.id = ct.company_id)))
     LEFT JOIN public.enrollments e ON ((e.id = t.enrollment_id)))
  WHERE ((tm.direction = 'in'::text) AND (tm.kind = 'reply'::text) AND (tm.triaged_at IS NULL));


--
-- Name: linkedin_accounts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.linkedin_accounts (
    id uuid DEFAULT uuidv7() NOT NULL,
    project_id uuid,
    sender_id uuid NOT NULL,
    unipile_account_id text NOT NULL,
    profile_url text,
    premium boolean DEFAULT false NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    daily_invite_limit integer DEFAULT 15 NOT NULL,
    daily_message_limit integer DEFAULT 40 NOT NULL,
    delay_min_seconds integer DEFAULT 60 NOT NULL,
    delay_max_seconds integer DEFAULT 300 NOT NULL,
    next_action_at timestamp with time zone,
    read_cursor jsonb,
    read_at timestamp with time zone,
    read_error text,
    disconnected_reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    connected_by uuid,
    provider_id text,
    status_changed_at timestamp with time zone DEFAULT now() NOT NULL,
    proxy_country text,
    CONSTRAINT linkedin_accounts_proxy_country_check CHECK ((proxy_country ~ '^[A-Z]{2}$'::text)),
    CONSTRAINT linkedin_accounts_status_check CHECK ((status = ANY (ARRAY['active'::text, 'paused'::text, 'disconnected'::text, 'archived'::text])))
);


--
-- Name: mail_domains; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mail_domains (
    domain public.citext NOT NULL,
    esp text NOT NULL,
    mx text[] DEFAULT '{}'::text[] NOT NULL,
    checked_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT mail_domains_esp_check CHECK ((esp ~ '^[a-z0-9_]+$'::text))
);


--
-- Name: mailbox_orders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mailbox_orders (
    id uuid DEFAULT uuidv7() NOT NULL,
    project_id uuid,
    domain_id uuid NOT NULL,
    supplier text NOT NULL,
    first_name text NOT NULL,
    last_name text NOT NULL,
    username text NOT NULL,
    supplier_mailbox_id text,
    mailbox_id uuid,
    status text DEFAULT 'ordered'::text NOT NULL,
    failure text,
    attempts integer DEFAULT 0 NOT NULL,
    ordered_by uuid NOT NULL,
    ordered_via public.actor_via NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    settled_at timestamp with time zone,
    sender_id uuid,
    CONSTRAINT mailbox_orders_mailbox_check CHECK (((mailbox_id IS NOT NULL) = (status = 'connected'::text))),
    CONSTRAINT mailbox_orders_owner CHECK (((project_id IS NOT NULL) OR (sender_id IS NOT NULL))),
    CONSTRAINT mailbox_orders_settled_check CHECK (((settled_at IS NULL) = ((status <> 'connected'::text) AND (status <> 'failed'::text)))),
    CONSTRAINT mailbox_orders_status_check CHECK ((status = ANY (ARRAY['ordered'::text, 'creating'::text, 'created'::text, 'connecting'::text, 'connected'::text, 'failed'::text]))),
    CONSTRAINT mailbox_orders_supplier_check CHECK ((supplier = ANY (ARRAY['zapmail'::text, 'workspace'::text])))
);


--
-- Name: mailboxes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mailboxes (
    id uuid DEFAULT uuidv7() NOT NULL,
    project_id uuid,
    sender_id uuid NOT NULL,
    domain_id uuid,
    provider text NOT NULL,
    address public.citext NOT NULL,
    credential bytea,
    credential_expires_at timestamp with time zone,
    status text DEFAULT 'active'::text NOT NULL,
    daily_limit integer DEFAULT 30 NOT NULL,
    delay_min_seconds integer DEFAULT 60 NOT NULL,
    delay_max_seconds integer DEFAULT 300 NOT NULL,
    warmed boolean DEFAULT false NOT NULL,
    sending_days integer DEFAULT 0 NOT NULL,
    last_sending_day date,
    next_send_at timestamp with time zone,
    read_cursor jsonb,
    read_at timestamp with time zone,
    read_error text,
    disconnected_reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    connected_by uuid,
    probed_at timestamp with time zone,
    status_changed_at timestamp with time zone DEFAULT now() NOT NULL,
    tenant_id uuid,
    read_claimed_until timestamp with time zone,
    read_wanted_at timestamp with time zone,
    push_expires_at timestamp with time zone,
    push_target text,
    push_error text,
    push_attempted_at timestamp with time zone,
    push_subscription_id text,
    push_client_state_hash text,
    CONSTRAINT mailboxes_check CHECK ((delay_min_seconds <= delay_max_seconds)),
    CONSTRAINT mailboxes_daily_limit_check CHECK (((daily_limit >= 1) AND (daily_limit <= 200))),
    CONSTRAINT mailboxes_provider_check CHECK ((provider = ANY (ARRAY['google'::text, 'microsoft'::text, 'smtp'::text]))),
    CONSTRAINT mailboxes_status_check CHECK ((status = ANY (ARRAY['active'::text, 'paused'::text, 'disconnected'::text, 'archived'::text])))
)
WITH (fillfactor='70', autovacuum_vacuum_scale_factor='0.05', autovacuum_analyze_scale_factor='0.05');


--
-- Name: model_calls; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.model_calls (
    id uuid DEFAULT uuidv7() NOT NULL,
    project_id uuid,
    at timestamp with time zone DEFAULT now() NOT NULL,
    purpose text NOT NULL,
    model text NOT NULL,
    prompt_version text NOT NULL,
    thread_message_id uuid,
    input_tokens bigint,
    output_tokens bigint,
    cost_usd numeric(12,6),
    duration_ms bigint,
    error text,
    CONSTRAINT model_calls_purpose_check CHECK ((purpose = 'reply_classification'::text))
);


--
-- Name: named_colleagues; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.named_colleagues (
    id uuid DEFAULT uuidv7() NOT NULL,
    thread_message_id uuid NOT NULL,
    follows_enrollment_id uuid NOT NULL,
    contact_id uuid NOT NULL,
    classification text NOT NULL,
    status text DEFAULT 'waiting'::text NOT NULL,
    reason text,
    enrollment_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    settled_at timestamp with time zone,
    address public.citext NOT NULL,
    CONSTRAINT named_colleagues_check CHECK (((status = 'waiting'::text) = (settled_at IS NULL))),
    CONSTRAINT named_colleagues_check1 CHECK (((status = 'dropped'::text) = (reason IS NOT NULL))),
    CONSTRAINT named_colleagues_check2 CHECK (((status = 'written'::text) = (enrollment_id IS NOT NULL))),
    CONSTRAINT named_colleagues_classification_check CHECK ((classification = ANY (ARRAY['out_of_office'::text, 'referral'::text]))),
    CONSTRAINT named_colleagues_status_check CHECK ((status = ANY (ARRAY['waiting'::text, 'written'::text, 'dropped'::text])))
);


--
-- Name: organisation_members; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.organisation_members (
    organisation_id uuid NOT NULL,
    user_id uuid NOT NULL,
    role text DEFAULT 'member'::text NOT NULL,
    added_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT organisation_members_role_check CHECK ((role = ANY (ARRAY['admin'::text, 'member'::text])))
);


--
-- Name: organisations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.organisations (
    id uuid DEFAULT uuidv7() NOT NULL,
    slug text NOT NULL,
    name text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT organisations_slug_check CHECK ((slug ~ '^[a-z0-9][a-z0-9-]{1,48}$'::text))
);


--
-- Name: personas; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.personas (
    id uuid DEFAULT uuidv7() NOT NULL,
    project_id uuid NOT NULL,
    name text NOT NULL,
    description text,
    titles text[] DEFAULT '{}'::text[] NOT NULL,
    excluded_titles text[] DEFAULT '{}'::text[] NOT NULL,
    seniorities text[] DEFAULT '{}'::text[] NOT NULL,
    departments text[] DEFAULT '{}'::text[] NOT NULL,
    search_hints text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: strategy_contacts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.strategy_contacts (
    strategy_id uuid NOT NULL,
    contact_id uuid NOT NULL,
    persona_id uuid,
    status text NOT NULL,
    reason text,
    decided_by uuid,
    decided_via public.actor_via NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT strategy_contacts_check CHECK (((status <> ALL (ARRAY['held'::text, 'rejected'::text])) OR (reason IS NOT NULL))),
    CONSTRAINT strategy_contacts_status_check CHECK ((status = ANY (ARRAY['candidate'::text, 'held'::text, 'rejected'::text, 'enrolled'::text])))
);


--
-- Name: strategy_personas; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.strategy_personas (
    id uuid DEFAULT uuidv7() NOT NULL,
    strategy_id uuid NOT NULL,
    persona_id uuid NOT NULL,
    "position" integer NOT NULL,
    max_per_company integer,
    angle text,
    CONSTRAINT strategy_personas_position_check CHECK (("position" >= 1))
);


--
-- Name: persona_usage; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.persona_usage AS
 SELECT id AS persona_id,
    project_id,
    name,
    ( SELECT count(*) AS count
           FROM public.strategy_personas sp
          WHERE (sp.persona_id = p.id)) AS strategies,
    ( SELECT count(*) AS count
           FROM public.strategy_contacts sc
          WHERE ((sc.persona_id = p.id) AND (sc.status = 'candidate'::text))) AS candidates,
    ( SELECT count(*) AS count
           FROM public.enrollments e
          WHERE (e.persona_id = p.id)) AS enrolled,
    ( SELECT count(*) AS count
           FROM public.enrollment_outcomes o
          WHERE ((o.persona_id = p.id) AND o.contacted)) AS contacted,
    ( SELECT count(*) AS count
           FROM public.enrollment_outcomes o
          WHERE ((o.persona_id = p.id) AND o.replied)) AS replied,
    ( SELECT count(*) AS count
           FROM public.enrollment_outcomes o
          WHERE ((o.persona_id = p.id) AND o.positive)) AS positive,
    ( SELECT count(*) AS count
           FROM public.enrollment_outcomes o
          WHERE ((o.persona_id = p.id) AND o.meeting)) AS meetings,
    ( SELECT max(e.created_at) AS max
           FROM public.enrollments e
          WHERE (e.persona_id = p.id)) AS last_enrolled_at,
    ( SELECT count(*) AS count
           FROM public.strategy_contacts sc
          WHERE ((sc.persona_id = p.id) AND (sc.status = 'held'::text))) AS reserve
   FROM public.personas p;


--
-- Name: placement_notes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.placement_notes (
    id uuid DEFAULT uuidv7() NOT NULL,
    test_id uuid NOT NULL,
    mailbox_id uuid NOT NULL,
    seed_id uuid NOT NULL,
    environment text NOT NULL,
    subject text NOT NULL,
    rfc_message_id text NOT NULL,
    status text NOT NULL,
    error text,
    sent_at timestamp with time zone DEFAULT now() NOT NULL,
    verdict text,
    folders text[],
    scores jsonb DEFAULT '{}'::jsonb NOT NULL,
    verdict_at timestamp with time zone,
    CONSTRAINT placement_notes_status_check CHECK ((status = ANY (ARRAY['sent'::text, 'failed'::text]))),
    CONSTRAINT placement_notes_verdict_check CHECK ((verdict = ANY (ARRAY['inbox'::text, 'tab'::text, 'spam'::text, 'quarantined'::text, 'rejected'::text, 'missing'::text])))
);


--
-- Name: placement_seeds; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.placement_seeds (
    id uuid DEFAULT uuidv7() NOT NULL,
    environment text NOT NULL,
    provider text NOT NULL,
    address public.citext NOT NULL,
    credential bytea,
    credential_expires_at timestamp with time zone,
    status text DEFAULT 'active'::text NOT NULL,
    status_changed_at timestamp with time zone DEFAULT now() NOT NULL,
    disconnected_reason text,
    connected_by uuid NOT NULL,
    connected_via public.actor_via NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT placement_seeds_environment_check CHECK ((environment = ANY (ARRAY['google'::text, 'm365'::text, 'm365_defender'::text, 'm365_proofpoint'::text]))),
    CONSTRAINT placement_seeds_provider_check CHECK ((provider = ANY (ARRAY['google'::text, 'microsoft'::text]))),
    CONSTRAINT placement_seeds_status_check CHECK ((status = ANY (ARRAY['active'::text, 'suspect'::text, 'disconnected'::text, 'archived'::text])))
);


--
-- Name: placement_tests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.placement_tests (
    id uuid DEFAULT uuidv7() NOT NULL,
    mailbox_id uuid NOT NULL,
    requested_by uuid,
    requested_via public.actor_via NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: project_exclusions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.project_exclusions (
    id uuid DEFAULT uuidv7() NOT NULL,
    project_id uuid NOT NULL,
    kind text NOT NULL,
    value text NOT NULL,
    note text,
    created_by uuid,
    created_via public.actor_via NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    removed_at timestamp with time zone,
    CONSTRAINT project_exclusions_kind_check CHECK ((kind = ANY (ARRAY['country'::text, 'country_outside'::text, 'industry'::text, 'business_model'::text, 'employees_below'::text, 'employees_above'::text, 'rating_above'::text, 'other'::text])))
);


--
-- Name: project_members; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.project_members (
    project_id uuid NOT NULL,
    user_id uuid NOT NULL,
    role text DEFAULT 'member'::text NOT NULL,
    added_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT project_members_role_check CHECK ((role = ANY (ARRAY['owner'::text, 'member'::text])))
);


--
-- Name: project_notes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.project_notes (
    id uuid DEFAULT uuidv7() NOT NULL,
    project_id uuid NOT NULL,
    strategy_id uuid,
    segment_id uuid,
    kind text NOT NULL,
    title text NOT NULL,
    body text,
    author_id uuid,
    author_via public.actor_via NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    superseded_at timestamp with time zone,
    CONSTRAINT project_notes_kind_check CHECK ((kind = ANY (ARRAY['decision'::text, 'insight'::text, 'client_feedback'::text, 'rule'::text, 'todo'::text])))
);


--
-- Name: project_senders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.project_senders (
    project_id uuid NOT NULL,
    sender_id uuid NOT NULL,
    title text,
    signature text,
    daily_share integer,
    since date DEFAULT CURRENT_DATE NOT NULL,
    added_by uuid NOT NULL,
    added_via public.actor_via NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    signature_html text,
    CONSTRAINT project_senders_daily_share_check CHECK (((daily_share IS NULL) OR ((daily_share >= 1) AND (daily_share <= 200))))
);


--
-- Name: projects; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.projects (
    id uuid DEFAULT uuidv7() NOT NULL,
    name text NOT NULL,
    slug text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    brief text,
    timezone text DEFAULT 'UTC'::text NOT NULL,
    daily_domain_cap integer DEFAULT 3 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    agent_enabled boolean DEFAULT false NOT NULL,
    agent_enabled_by uuid,
    organisation_id uuid CONSTRAINT projects_organisation_id_not_null1 NOT NULL,
    slack_channel_id text,
    slack_channel text,
    slack_channel_set_by uuid,
    slack_channel_set_via public.actor_via,
    warmup_enabled boolean DEFAULT false NOT NULL,
    warmup_enabled_by uuid,
    warmup_seed_types text[],
    warmup_seed_types_by uuid,
    warmup_seed_types_via public.actor_via,
    setup_skipped text[] DEFAULT '{}'::text[] NOT NULL,
    setup_skipped_by uuid,
    setup_skipped_via public.actor_via,
    warmup_enabled_via public.actor_via,
    CONSTRAINT projects_daily_domain_cap_check CHECK (((daily_domain_cap >= 1) AND (daily_domain_cap <= 50))),
    CONSTRAINT projects_setup_skipped_check CHECK ((setup_skipped <@ ARRAY['rules'::text, 'linkedin'::text, 'agent'::text])),
    CONSTRAINT projects_slack_channel_check CHECK (((slack_channel_id IS NULL) = (slack_channel IS NULL))),
    CONSTRAINT projects_status_check CHECK ((status = ANY (ARRAY['active'::text, 'paused'::text, 'archived'::text]))),
    CONSTRAINT projects_warmup_seed_types_check CHECK (((warmup_seed_types IS NULL) OR ((cardinality(warmup_seed_types) > 0) AND (warmup_seed_types <@ ARRAY['gmail'::text, 'gsuite'::text, 'outlook'::text, 'yahoo'::text, 'aol'::text]))))
);


--
-- Name: provider_calls; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.provider_calls (
    id uuid DEFAULT uuidv7() NOT NULL,
    project_id uuid,
    at timestamp with time zone DEFAULT now() NOT NULL,
    provider text NOT NULL,
    method text NOT NULL,
    endpoint text NOT NULL,
    params jsonb DEFAULT '{}'::jsonb NOT NULL,
    request_hash text NOT NULL,
    status_code integer,
    error text,
    duration_ms integer,
    results integer,
    search_id uuid,
    strategy_id uuid,
    segment_id uuid,
    source_id uuid,
    company_id uuid,
    contact_id uuid,
    user_id uuid,
    via public.actor_via NOT NULL,
    cost_usd numeric(12,6),
    response jsonb,
    credits numeric,
    credits_left numeric
);


--
-- Name: provider_credit_prices; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.provider_credit_prices (
    provider text NOT NULL,
    usd_per_credit numeric(12,6) NOT NULL,
    set_by uuid NOT NULL,
    set_via public.actor_via NOT NULL,
    set_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT provider_credit_prices_usd_per_credit_check CHECK ((usd_per_credit > (0)::numeric))
);


--
-- Name: replies; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.replies (
    id uuid DEFAULT uuidv7() NOT NULL,
    thread_id uuid NOT NULL,
    status text DEFAULT 'draft'::text NOT NULL,
    body text NOT NULL,
    sender_id uuid,
    note text,
    approve_by timestamp with time zone,
    send_at timestamp with time zone,
    drafted_by uuid,
    drafted_via public.actor_via NOT NULL,
    approved_by uuid,
    approved_via public.actor_via,
    approved_at timestamp with time zone,
    claimed_until timestamp with time zone,
    attempts integer DEFAULT 0 NOT NULL,
    last_error text,
    rfc_message_id text,
    sent_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    previous_id uuid,
    asked text,
    notified_at timestamp with time zone,
    last_nudged_at timestamp with time zone,
    nudges integer DEFAULT 0 NOT NULL,
    slack_ref text,
    template_id uuid,
    cc text[] DEFAULT '{}'::text[] NOT NULL,
    CONSTRAINT replies_check CHECK (((status <> ALL (ARRAY['approved'::text, 'sending'::text, 'sent'::text])) OR (approved_at IS NOT NULL))),
    CONSTRAINT replies_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'approved'::text, 'sending'::text, 'sent'::text, 'failed'::text, 'discarded'::text, 'superseded'::text])))
);


--
-- Name: reply_templates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.reply_templates (
    id uuid DEFAULT uuidv7() NOT NULL,
    strategy_id uuid NOT NULL,
    classification text NOT NULL,
    body text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    approved_by uuid NOT NULL,
    approved_via public.actor_via NOT NULL,
    approved_at timestamp with time zone DEFAULT now() NOT NULL,
    archived_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    cc text[] DEFAULT '{}'::text[] NOT NULL,
    subject text,
    CONSTRAINT reply_templates_archived_check CHECK (((status = 'archived'::text) = (archived_at IS NOT NULL))),
    CONSTRAINT reply_templates_status_check CHECK ((status = ANY (ARRAY['active'::text, 'archived'::text]))),
    CONSTRAINT reply_templates_subject_check CHECK (((classification = ANY (ARRAY['out_of_office'::text, 'referral'::text])) = (subject IS NOT NULL)))
);


--
-- Name: schema_migrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.schema_migrations (
    version character varying NOT NULL
);


--
-- Name: searches; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.searches (
    id uuid DEFAULT uuidv7() NOT NULL,
    project_id uuid NOT NULL,
    kind text NOT NULL,
    source_id uuid,
    segment_id uuid,
    strategy_id uuid,
    company_id uuid,
    provider text NOT NULL,
    query jsonb NOT NULL,
    cursor text,
    results integer DEFAULT 0 NOT NULL,
    new_records integer DEFAULT 0 NOT NULL,
    duplicates integer DEFAULT 0 NOT NULL,
    note text,
    ran_by uuid,
    ran_at timestamp with time zone DEFAULT now() NOT NULL,
    cost_usd numeric(12,6) DEFAULT 0 NOT NULL,
    CONSTRAINT searches_check CHECK (((kind <> 'companies'::text) OR (source_id IS NOT NULL))),
    CONSTRAINT searches_check1 CHECK (((kind <> 'contacts'::text) OR (strategy_id IS NOT NULL))),
    CONSTRAINT searches_kind_check CHECK ((kind = ANY (ARRAY['companies'::text, 'contacts'::text])))
);


--
-- Name: segment_companies; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.segment_companies (
    segment_id uuid NOT NULL,
    company_id uuid NOT NULL,
    source_id uuid,
    search_id uuid,
    signal jsonb DEFAULT '{}'::jsonb NOT NULL,
    status text DEFAULT 'new'::text NOT NULL,
    reason text,
    checked_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    question_id uuid,
    evidence jsonb DEFAULT '[]'::jsonb NOT NULL,
    exclusion_id uuid,
    CONSTRAINT segment_companies_check CHECK (((status <> 'disqualified'::text) OR (reason IS NOT NULL))),
    CONSTRAINT segment_companies_qualified_reason_check CHECK (((status <> 'qualified'::text) OR (reason IS NOT NULL))),
    CONSTRAINT segment_companies_question_check CHECK (((question_id IS NULL) OR (status = 'new'::text))),
    CONSTRAINT segment_companies_status_check CHECK ((status = ANY (ARRAY['new'::text, 'qualified'::text, 'disqualified'::text])))
);


--
-- Name: segment_company_verdicts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.segment_company_verdicts (
    id bigint NOT NULL,
    segment_id uuid NOT NULL,
    company_id uuid NOT NULL,
    status text NOT NULL,
    reason text,
    judged_by uuid,
    judged_via public.actor_via NOT NULL,
    judged_at timestamp with time zone DEFAULT now() NOT NULL,
    evidence jsonb DEFAULT '[]'::jsonb NOT NULL,
    exclusion_id uuid,
    search_id uuid,
    CONSTRAINT segment_company_verdicts_status_check CHECK ((status = ANY (ARRAY['new'::text, 'qualified'::text, 'disqualified'::text])))
);


--
-- Name: segment_company_verdicts_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.segment_company_verdicts ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.segment_company_verdicts_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: segment_sources; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.segment_sources (
    id uuid DEFAULT uuidv7() NOT NULL,
    segment_id uuid NOT NULL,
    kind text NOT NULL,
    name text NOT NULL,
    query jsonb DEFAULT '{}'::jsonb NOT NULL,
    instructions text,
    provider text,
    estimated_companies integer,
    cursor text,
    status text DEFAULT 'active'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT segment_sources_kind_check CHECK ((kind = ANY (ARRAY['linkedin'::text, 'trustpilot'::text, 'web'::text, 'directory'::text, 'import'::text]))),
    CONSTRAINT segment_sources_status_check CHECK ((status = ANY (ARRAY['active'::text, 'paused'::text, 'exhausted'::text])))
);


--
-- Name: segment_usage; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.segment_usage AS
SELECT
    NULL::uuid AS segment_id,
    NULL::uuid AS project_id,
    NULL::text AS name,
    NULL::text AS status,
    NULL::integer AS estimated_companies,
    NULL::bigint AS companies_found,
    NULL::bigint AS qualified,
    NULL::bigint AS disqualified,
    NULL::bigint AS not_yet_judged,
    NULL::numeric AS qualified_pct,
    NULL::bigint AS active_sources,
    NULL::bigint AS searches,
    NULL::timestamp with time zone AS last_search_at,
    NULL::bigint AS waiting_on_client;


--
-- Name: segments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.segments (
    id uuid DEFAULT uuidv7() NOT NULL,
    project_id uuid NOT NULL,
    name text NOT NULL,
    definition text,
    criteria jsonb DEFAULT '{}'::jsonb NOT NULL,
    estimated_companies integer,
    status text DEFAULT 'active'::text NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT segments_status_check CHECK ((status = ANY (ARRAY['active'::text, 'paused'::text, 'exhausted'::text, 'archived'::text])))
);


--
-- Name: sender_images; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sender_images (
    id uuid DEFAULT uuidv7() NOT NULL,
    sender_id uuid NOT NULL,
    content_type text NOT NULL,
    data bytea NOT NULL,
    created_by uuid NOT NULL,
    created_via public.actor_via NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT sender_images_content_type_check CHECK ((content_type = ANY (ARRAY['image/png'::text, 'image/jpeg'::text, 'image/gif'::text]))),
    CONSTRAINT sender_images_size_check CHECK ((octet_length(data) <= 102400))
);


--
-- Name: senders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.senders (
    id uuid DEFAULT uuidv7() NOT NULL,
    project_id uuid,
    name text NOT NULL,
    title text,
    signature text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    organisation_id uuid,
    signature_html text,
    CONSTRAINT senders_owner_check CHECK ((num_nonnulls(project_id, organisation_id) = 1))
);


--
-- Name: sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sessions (
    id uuid DEFAULT uuidv7() NOT NULL,
    user_id uuid NOT NULL,
    token_hash bytea NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: slack_posts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.slack_posts (
    id uuid DEFAULT uuidv7() NOT NULL,
    project_id uuid,
    channel_id text NOT NULL,
    channel text NOT NULL,
    ts text NOT NULL,
    thread_ts text,
    text text NOT NULL,
    posted_by uuid NOT NULL,
    posted_via public.actor_via NOT NULL,
    posted_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: slack_workspaces; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.slack_workspaces (
    id uuid DEFAULT uuidv7() NOT NULL,
    team_id text NOT NULL,
    team_name text NOT NULL,
    bot_user_id text NOT NULL,
    bot_token text NOT NULL,
    scopes text NOT NULL,
    connected_by uuid NOT NULL,
    connected_via public.actor_via NOT NULL,
    connected_at timestamp with time zone DEFAULT now() NOT NULL,
    disconnected_at timestamp with time zone,
    disconnected_reason text,
    CONSTRAINT slack_workspaces_check CHECK (((disconnected_at IS NULL) = (disconnected_reason IS NULL)))
);


--
-- Name: source_usage; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.source_usage AS
SELECT
    NULL::uuid AS source_id,
    NULL::uuid AS segment_id,
    NULL::text AS kind,
    NULL::text AS name,
    NULL::text AS status,
    NULL::integer AS estimated_companies,
    NULL::bigint AS companies_found,
    NULL::bigint AS qualified,
    NULL::bigint AS disqualified,
    NULL::bigint AS searches,
    NULL::numeric AS search_cost_usd,
    NULL::timestamp with time zone AS last_search_at;


--
-- Name: spend; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.spend (
    id bigint NOT NULL,
    project_id uuid NOT NULL,
    at timestamp with time zone DEFAULT now() NOT NULL,
    provider text NOT NULL,
    operation text NOT NULL,
    units numeric DEFAULT 1 NOT NULL,
    strategy_id uuid,
    segment_id uuid,
    search_id uuid,
    provider_call_id uuid,
    company_id uuid,
    contact_id uuid,
    actor_user_id uuid,
    data jsonb DEFAULT '{}'::jsonb NOT NULL,
    cost_usd numeric(12,6) DEFAULT 0 NOT NULL,
    CONSTRAINT spend_operation_check CHECK ((operation = ANY (ARRAY['company_search'::text, 'contact_search'::text, 'email_find'::text, 'verification'::text, 'enrichment'::text, 'llm'::text, 'subscription'::text, 'data_purchase'::text, 'infrastructure'::text, 'other'::text])))
);


--
-- Name: spend_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.spend ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.spend_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: stalled_enrollments; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.stalled_enrollments AS
 SELECT id AS enrollment_id,
    strategy_id,
    contact_id,
    status,
    current_step,
    stuck_reason,
    stuck_since,
    paused_until,
    pause_reason,
    stuck_code,
    stuck_step
   FROM public.enrollments e
  WHERE ((stuck_reason IS NOT NULL) OR ((status = 'paused'::text) AND ((paused_until IS NULL) OR (paused_until < now()))));


--
-- Name: strategies; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.strategies (
    id uuid DEFAULT uuidv7() NOT NULL,
    project_id uuid NOT NULL,
    name text NOT NULL,
    status text DEFAULT 'draft'::text NOT NULL,
    brief text,
    send_days smallint[] DEFAULT '{1,2,3,4,5}'::smallint[] NOT NULL,
    window_start time without time zone DEFAULT '09:00:00'::time without time zone NOT NULL,
    window_end time without time zone DEFAULT '17:00:00'::time without time zone NOT NULL,
    daily_limit integer,
    max_per_company integer DEFAULT 2 NOT NULL,
    target_active integer,
    start_spread_days integer DEFAULT 3 NOT NULL,
    company_stagger_days integer DEFAULT 2 NOT NULL,
    catch_all_policy text DEFAULT 'hold'::text NOT NULL,
    launched_at timestamp with time zone,
    launched_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    active_since timestamp with time zone,
    CONSTRAINT strategies_catch_all_policy_check CHECK ((catch_all_policy = ANY (ARRAY['hold'::text, 'linkedin_only'::text, 'send'::text]))),
    CONSTRAINT strategies_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'active'::text, 'paused'::text, 'archived'::text])))
);


--
-- Name: strategy_companies; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.strategy_companies (
    strategy_id uuid NOT NULL,
    company_id uuid NOT NULL,
    segment_id uuid NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    contacts_found integer DEFAULT 0 NOT NULL,
    searched_at timestamp with time zone,
    excluded boolean DEFAULT false NOT NULL,
    exclusion_reason text,
    exclusion_decided_by uuid,
    exclusion_decided_via public.actor_via,
    exclusion_decided_at timestamp with time zone,
    CONSTRAINT strategy_companies_exclusion_check CHECK (((NOT excluded) OR ((exclusion_reason IS NOT NULL) AND (exclusion_decided_via IS NOT NULL)))),
    CONSTRAINT strategy_companies_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'contacts_found'::text, 'no_match'::text, 'enrolled'::text, 'exhausted'::text])))
);


--
-- Name: strategy_persona_usage; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.strategy_persona_usage AS
 SELECT strategy_id,
    persona_id,
    ( SELECT count(*) AS count
           FROM public.strategy_contacts sc
          WHERE ((sc.strategy_id = sp.strategy_id) AND (sc.persona_id = sp.persona_id) AND (sc.status = 'candidate'::text))) AS candidates,
    ( SELECT count(*) AS count
           FROM public.enrollments e
          WHERE ((e.strategy_id = sp.strategy_id) AND (e.persona_id = sp.persona_id))) AS enrolled,
    ( SELECT count(*) AS count
           FROM public.enrollment_outcomes o
          WHERE ((o.strategy_id = sp.strategy_id) AND (o.persona_id = sp.persona_id) AND o.contacted)) AS contacted,
    ( SELECT count(*) AS count
           FROM public.enrollment_outcomes o
          WHERE ((o.strategy_id = sp.strategy_id) AND (o.persona_id = sp.persona_id) AND o.replied)) AS replied,
    ( SELECT count(*) AS count
           FROM public.enrollment_outcomes o
          WHERE ((o.strategy_id = sp.strategy_id) AND (o.persona_id = sp.persona_id) AND o.positive)) AS positive,
    ( SELECT count(*) AS count
           FROM public.enrollment_outcomes o
          WHERE ((o.strategy_id = sp.strategy_id) AND (o.persona_id = sp.persona_id) AND o.meeting)) AS meetings,
    ( SELECT count(*) AS count
           FROM public.strategy_contacts sc
          WHERE ((sc.strategy_id = sp.strategy_id) AND (sc.persona_id = sp.persona_id) AND (sc.status = 'held'::text))) AS reserve
   FROM public.strategy_personas sp;


--
-- Name: strategy_plans; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.strategy_plans (
    id uuid DEFAULT uuidv7() NOT NULL,
    strategy_id uuid NOT NULL,
    name text NOT NULL,
    applies_when text NOT NULL,
    CONSTRAINT strategy_plans_applies_when_check CHECK ((applies_when = ANY (ARRAY['email_and_linkedin'::text, 'email_only'::text, 'linkedin_only'::text])))
);


--
-- Name: strategy_segments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.strategy_segments (
    strategy_id uuid NOT NULL,
    segment_id uuid NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    CONSTRAINT strategy_segments_status_check CHECK ((status = ANY (ARRAY['active'::text, 'paused'::text])))
);


--
-- Name: strategy_segment_usage; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.strategy_segment_usage AS
 SELECT strategy_id,
    segment_id,
    status,
    ( SELECT count(*) AS count
           FROM public.segment_companies sc
          WHERE ((sc.segment_id = ss.segment_id) AND (sc.status = 'qualified'::text))) AS qualified_companies,
    ( SELECT count(*) AS count
           FROM public.strategy_companies stc
          WHERE ((stc.strategy_id = ss.strategy_id) AND (stc.segment_id = ss.segment_id) AND (stc.status <> 'pending'::text))) AS companies_worked,
    ( SELECT count(*) AS count
           FROM public.segment_companies sc
          WHERE ((sc.segment_id = ss.segment_id) AND (sc.status = 'qualified'::text) AND (NOT (EXISTS ( SELECT 1
                   FROM public.strategy_companies stc
                  WHERE ((stc.strategy_id = ss.strategy_id) AND (stc.company_id = sc.company_id) AND ((stc.status <> 'pending'::text) OR stc.excluded))))))) AS companies_left,
    ( SELECT count(*) AS count
           FROM public.enrollments e
          WHERE ((e.strategy_id = ss.strategy_id) AND (e.segment_id = ss.segment_id))) AS enrolled,
    ( SELECT count(*) AS count
           FROM public.enrollment_outcomes o
          WHERE ((o.strategy_id = ss.strategy_id) AND (o.segment_id = ss.segment_id) AND o.replied)) AS replied,
    ( SELECT count(*) AS count
           FROM public.enrollment_outcomes o
          WHERE ((o.strategy_id = ss.strategy_id) AND (o.segment_id = ss.segment_id) AND o.positive)) AS positive,
    ( SELECT count(*) AS count
           FROM public.enrollment_outcomes o
          WHERE ((o.strategy_id = ss.strategy_id) AND (o.segment_id = ss.segment_id) AND o.meeting)) AS meetings,
    ( SELECT count(*) AS count
           FROM public.meetings m
          WHERE ((m.strategy_id = ss.strategy_id) AND (m.segment_id = ss.segment_id) AND (m.outcome = ANY (ARRAY['qualified'::text, 'opportunity'::text, 'won'::text])))) AS good_meetings,
    ( SELECT COALESCE(sum(sp.cost_usd), (0)::numeric) AS "coalesce"
           FROM public.spend sp
          WHERE ((sp.strategy_id = ss.strategy_id) AND (sp.segment_id = ss.segment_id))) AS spend_usd,
    ( SELECT count(*) AS count
           FROM public.strategy_companies stc
          WHERE ((stc.strategy_id = ss.strategy_id) AND (stc.segment_id = ss.segment_id) AND stc.excluded)) AS companies_excluded
   FROM public.strategy_segments ss;


--
-- Name: strategy_senders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.strategy_senders (
    strategy_id uuid NOT NULL,
    sender_id uuid NOT NULL
);


--
-- Name: strategy_steps; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.strategy_steps (
    id uuid DEFAULT uuidv7() NOT NULL,
    plan_id uuid NOT NULL,
    "position" integer NOT NULL,
    channel text NOT NULL,
    delay_days integer DEFAULT 3 NOT NULL,
    anchor text DEFAULT 'previous_step'::text NOT NULL,
    condition text,
    max_wait_days integer DEFAULT 10 NOT NULL,
    new_thread boolean DEFAULT false NOT NULL,
    guidance text,
    hypothesis text,
    CONSTRAINT strategy_steps_anchor_check CHECK ((anchor = ANY (ARRAY['previous_step'::text, 'invite_accepted'::text]))),
    CONSTRAINT strategy_steps_channel_check CHECK ((channel = ANY (ARRAY['email'::text, 'linkedin_invite'::text, 'linkedin_message'::text]))),
    CONSTRAINT strategy_steps_condition_check CHECK ((condition = ANY (ARRAY['invite_accepted'::text, 'invite_not_accepted'::text]))),
    CONSTRAINT strategy_steps_delay_days_check CHECK ((delay_days >= 0)),
    CONSTRAINT strategy_steps_position_check CHECK (("position" >= 1))
);


--
-- Name: system_mail_domains; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.system_mail_domains (
    id uuid DEFAULT uuidv7() NOT NULL,
    domain public.citext NOT NULL,
    resend_id text NOT NULL,
    status text NOT NULL,
    records jsonb DEFAULT '[]'::jsonb NOT NULL,
    dns_written_at timestamp with time zone,
    verified_at timestamp with time zone,
    checked_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid NOT NULL,
    created_via public.actor_via NOT NULL
);


--
-- Name: system_mail_messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.system_mail_messages (
    id uuid DEFAULT uuidv7() NOT NULL,
    project_id uuid,
    domain_id uuid NOT NULL,
    "from" text NOT NULL,
    "to" text[] NOT NULL,
    subject text NOT NULL,
    resend_id text,
    status text DEFAULT 'sending'::text NOT NULL,
    error text,
    sent_by uuid NOT NULL,
    sent_via public.actor_via NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    settled_at timestamp with time zone,
    CONSTRAINT system_mail_messages_check CHECK (((status = 'sending'::text) = (settled_at IS NULL))),
    CONSTRAINT system_mail_messages_check1 CHECK (((status = 'sent'::text) = (resend_id IS NOT NULL))),
    CONSTRAINT system_mail_messages_status_check CHECK ((status = ANY (ARRAY['sending'::text, 'sent'::text, 'failed'::text]))),
    CONSTRAINT system_mail_messages_to_check CHECK (((cardinality("to") >= 1) AND (cardinality("to") <= 50)))
);


--
-- Name: tasks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tasks (
    id uuid DEFAULT uuidv7() NOT NULL,
    project_id uuid NOT NULL,
    title text NOT NULL,
    body text,
    assignee_id uuid NOT NULL,
    priority text DEFAULT 'normal'::text NOT NULL,
    due_at timestamp with time zone,
    done_when text,
    status text DEFAULT 'open'::text NOT NULL,
    thread_id uuid,
    meeting_id uuid,
    strategy_id uuid,
    mailbox_id uuid,
    calendar_id uuid,
    question_id uuid,
    notified_at timestamp with time zone,
    last_nudged_at timestamp with time zone,
    nudges integer DEFAULT 0 NOT NULL,
    slack_ref text,
    created_by uuid,
    created_via public.actor_via NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    closed_at timestamp with time zone,
    closed_via public.actor_via,
    close_note text,
    segment_id uuid,
    signal text,
    domain_id uuid,
    closed_by uuid,
    close_posted_for timestamp with time zone,
    CONSTRAINT tasks_check CHECK (((status = 'open'::text) = (closed_at IS NULL))),
    CONSTRAINT tasks_priority_check CHECK ((priority = ANY (ARRAY['normal'::text, 'urgent'::text]))),
    CONSTRAINT tasks_signal_check CHECK (((signal IS NULL) OR ((signal = ANY (ARRAY['pipeline'::text, 'health'::text, 'stalled'::text])) AND (strategy_id IS NOT NULL)))),
    CONSTRAINT tasks_status_check CHECK ((status = ANY (ARRAY['open'::text, 'done'::text, 'cancelled'::text])))
);


--
-- Name: tool_alerts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tool_alerts (
    tool text NOT NULL,
    since timestamp with time zone DEFAULT now() NOT NULL,
    posted_at timestamp with time zone,
    slack_ref text
);


--
-- Name: tool_balances; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tool_balances (
    id uuid DEFAULT uuidv7() NOT NULL,
    tool text NOT NULL,
    at timestamp with time zone DEFAULT now() NOT NULL,
    unit text NOT NULL,
    balance numeric,
    plan numeric,
    error text,
    CONSTRAINT tool_balances_read_check CHECK (((balance IS NULL) <> (error IS NULL))),
    CONSTRAINT tool_balances_unit_check CHECK ((unit = ANY (ARRAY['credits'::text, 'usd'::text])))
);


--
-- Name: tool_limits; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tool_limits (
    tool text NOT NULL,
    alert_below numeric,
    set_by uuid NOT NULL,
    set_via public.actor_via NOT NULL,
    set_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT tool_limits_alert_below_check CHECK (((alert_below IS NULL) OR (alert_below >= (0)::numeric)))
);


--
-- Name: triage_holds; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.triage_holds (
    thread_message_id uuid NOT NULL,
    verdict jsonb NOT NULL,
    previous jsonb NOT NULL,
    actor_user_id uuid NOT NULL,
    actor_via public.actor_via NOT NULL,
    effective_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    id uuid DEFAULT uuidv7() NOT NULL,
    email public.citext NOT NULL,
    name text NOT NULL,
    is_admin boolean DEFAULT false NOT NULL,
    slack_user_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    disabled_at timestamp with time zone
);


--
-- Name: warmup_profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.warmup_profiles (
    id uuid DEFAULT uuidv7() NOT NULL,
    mailbox_id uuid NOT NULL,
    provider text NOT NULL,
    external_id text,
    from_name text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    last_error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT warmup_profiles_provider_check CHECK ((provider = ANY (ARRAY['warmupip'::text]))),
    CONSTRAINT warmup_profiles_status_check CHECK ((status = ANY (ARRAY['active'::text, 'paused'::text, 'failed'::text])))
);


--
-- Name: warmup_seeds; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.warmup_seeds (
    id uuid DEFAULT uuidv7() NOT NULL,
    provider text NOT NULL,
    address public.citext NOT NULL,
    first_name text,
    last_name text,
    seed_type text NOT NULL,
    fetched_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT warmup_seeds_provider_check CHECK ((provider = ANY (ARRAY['warmupip'::text]))),
    CONSTRAINT warmup_seeds_seed_type_check CHECK ((seed_type = ANY (ARRAY['gmail'::text, 'gsuite'::text, 'outlook'::text, 'yahoo'::text, 'aol'::text, 'seznam'::text, 'zoho'::text, 'icloud'::text, 'other'::text])))
);


--
-- Name: warmup_sends; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.warmup_sends (
    id uuid DEFAULT uuidv7() NOT NULL,
    mailbox_id uuid NOT NULL,
    seed_id uuid,
    seed_address public.citext NOT NULL,
    seed_type text NOT NULL,
    subject text NOT NULL,
    rfc_message_id text,
    status text DEFAULT 'sent'::text NOT NULL,
    error text,
    sent_at timestamp with time zone DEFAULT now() NOT NULL,
    placement text,
    tab_category text,
    placement_at timestamp with time zone,
    CONSTRAINT warmup_sends_placement_check CHECK ((placement = ANY (ARRAY['inbox'::text, 'spam'::text, 'tabs'::text]))),
    CONSTRAINT warmup_sends_status_check CHECK ((status = ANY (ARRAY['sent'::text, 'failed'::text])))
);


--
-- Name: workspace_tenants; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspace_tenants (
    id uuid DEFAULT uuidv7() NOT NULL,
    name text NOT NULL,
    admin_email public.citext NOT NULL,
    key bytea NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    max_domains integer DEFAULT 500 NOT NULL,
    created_by uuid NOT NULL,
    created_via public.actor_via NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    console_session bytea,
    console_state text DEFAULT 'none'::text NOT NULL,
    console_signed_in_at timestamp with time zone,
    console_seen_at timestamp with time zone,
    console_error text,
    console_alerted_at timestamp with time zone,
    console_login bytea,
    console_login_failed_at timestamp with time zone,
    CONSTRAINT workspace_tenants_console_state_check CHECK ((console_state = ANY (ARRAY['none'::text, 'live'::text, 'expired'::text]))),
    CONSTRAINT workspace_tenants_max_domains_check CHECK (((max_domains >= 1) AND (max_domains <= 600))),
    CONSTRAINT workspace_tenants_status_check CHECK ((status = ANY (ARRAY['active'::text, 'paused'::text])))
);


--
-- Name: events_default; Type: TABLE ATTACH; Schema: public; Owner: -
--

ALTER TABLE ONLY public.events ATTACH PARTITION public.events_default DEFAULT;


--
-- Name: address_checks address_checks_contact_id_address_provider_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.address_checks
    ADD CONSTRAINT address_checks_contact_id_address_provider_key UNIQUE (contact_id, address, provider);


--
-- Name: address_checks address_checks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.address_checks
    ADD CONSTRAINT address_checks_pkey PRIMARY KEY (id);


--
-- Name: address_replacements address_replacements_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.address_replacements
    ADD CONSTRAINT address_replacements_pkey PRIMARY KEY (contact_id);


--
-- Name: agent_runs agent_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_runs
    ADD CONSTRAINT agent_runs_pkey PRIMARY KEY (id);


--
-- Name: api_tokens api_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_tokens
    ADD CONSTRAINT api_tokens_pkey PRIMARY KEY (id);


--
-- Name: api_tokens api_tokens_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_tokens
    ADD CONSTRAINT api_tokens_token_hash_key UNIQUE (token_hash);


--
-- Name: calendar_offers calendar_offers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.calendar_offers
    ADD CONSTRAINT calendar_offers_pkey PRIMARY KEY (calendar_id, starts_at);


--
-- Name: calendars calendars_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.calendars
    ADD CONSTRAINT calendars_pkey PRIMARY KEY (id);


--
-- Name: channel_invites channel_invites_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channel_invites
    ADD CONSTRAINT channel_invites_pkey PRIMARY KEY (id);


--
-- Name: cli_logins cli_logins_device_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cli_logins
    ADD CONSTRAINT cli_logins_device_hash_key UNIQUE (device_hash);


--
-- Name: cli_logins cli_logins_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cli_logins
    ADD CONSTRAINT cli_logins_pkey PRIMARY KEY (id);


--
-- Name: cli_logins cli_logins_user_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cli_logins
    ADD CONSTRAINT cli_logins_user_code_key UNIQUE (user_code);


--
-- Name: client_questions client_questions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_questions
    ADD CONSTRAINT client_questions_pkey PRIMARY KEY (id);


--
-- Name: client_reports client_reports_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_reports
    ADD CONSTRAINT client_reports_pkey PRIMARY KEY (id);


--
-- Name: companies companies_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.companies
    ADD CONSTRAINT companies_pkey PRIMARY KEY (id);


--
-- Name: companies companies_project_id_domain_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.companies
    ADD CONSTRAINT companies_project_id_domain_key UNIQUE (project_id, domain);


--
-- Name: contacts contacts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contacts
    ADD CONSTRAINT contacts_pkey PRIMARY KEY (id);


--
-- Name: copy_tests copy_tests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.copy_tests
    ADD CONSTRAINT copy_tests_pkey PRIMARY KEY (id);


--
-- Name: daily_sends daily_sends_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.daily_sends
    ADD CONSTRAINT daily_sends_pkey PRIMARY KEY (day, scope, key);


--
-- Name: dnc dnc_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dnc
    ADD CONSTRAINT dnc_pkey PRIMARY KEY (id);


--
-- Name: domains domains_domain_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.domains
    ADD CONSTRAINT domains_domain_key UNIQUE (domain);


--
-- Name: domains domains_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.domains
    ADD CONSTRAINT domains_pkey PRIMARY KEY (id);


--
-- Name: enrollments enrollments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.enrollments
    ADD CONSTRAINT enrollments_pkey PRIMARY KEY (id);


--
-- Name: event_types event_types_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.event_types
    ADD CONSTRAINT event_types_pkey PRIMARY KEY (type);


--
-- Name: events events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.events
    ADD CONSTRAINT events_pkey PRIMARY KEY (id, at);


--
-- Name: events_default events_default_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.events_default
    ADD CONSTRAINT events_default_pkey PRIMARY KEY (id, at);


--
-- Name: hypotheses hypotheses_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hypotheses
    ADD CONSTRAINT hypotheses_pkey PRIMARY KEY (id);


--
-- Name: linkedin_accounts linkedin_accounts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.linkedin_accounts
    ADD CONSTRAINT linkedin_accounts_pkey PRIMARY KEY (id);


--
-- Name: linkedin_accounts linkedin_accounts_unipile_account_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.linkedin_accounts
    ADD CONSTRAINT linkedin_accounts_unipile_account_id_key UNIQUE (unipile_account_id);


--
-- Name: mail_domains mail_domains_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mail_domains
    ADD CONSTRAINT mail_domains_pkey PRIMARY KEY (domain);


--
-- Name: mailbox_orders mailbox_orders_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mailbox_orders
    ADD CONSTRAINT mailbox_orders_pkey PRIMARY KEY (id);


--
-- Name: mailboxes mailboxes_address_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mailboxes
    ADD CONSTRAINT mailboxes_address_key UNIQUE (address);


--
-- Name: mailboxes mailboxes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mailboxes
    ADD CONSTRAINT mailboxes_pkey PRIMARY KEY (id);


--
-- Name: meeting_slots meeting_slots_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meeting_slots
    ADD CONSTRAINT meeting_slots_pkey PRIMARY KEY (id);


--
-- Name: meetings meetings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meetings
    ADD CONSTRAINT meetings_pkey PRIMARY KEY (id);


--
-- Name: messages messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_pkey PRIMARY KEY (id);


--
-- Name: messages messages_rfc_message_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_rfc_message_id_key UNIQUE (rfc_message_id);


--
-- Name: model_calls model_calls_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.model_calls
    ADD CONSTRAINT model_calls_pkey PRIMARY KEY (id);


--
-- Name: named_colleagues named_colleagues_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.named_colleagues
    ADD CONSTRAINT named_colleagues_pkey PRIMARY KEY (id);


--
-- Name: named_colleagues named_colleagues_thread_message_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.named_colleagues
    ADD CONSTRAINT named_colleagues_thread_message_id_key UNIQUE (thread_message_id);


--
-- Name: organisation_members organisation_members_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organisation_members
    ADD CONSTRAINT organisation_members_pkey PRIMARY KEY (organisation_id, user_id);


--
-- Name: organisations organisations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organisations
    ADD CONSTRAINT organisations_pkey PRIMARY KEY (id);


--
-- Name: organisations organisations_slug_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organisations
    ADD CONSTRAINT organisations_slug_key UNIQUE (slug);


--
-- Name: personas personas_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.personas
    ADD CONSTRAINT personas_pkey PRIMARY KEY (id);


--
-- Name: personas personas_project_id_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.personas
    ADD CONSTRAINT personas_project_id_name_key UNIQUE (project_id, name);


--
-- Name: placement_notes placement_notes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.placement_notes
    ADD CONSTRAINT placement_notes_pkey PRIMARY KEY (id);


--
-- Name: placement_seeds placement_seeds_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.placement_seeds
    ADD CONSTRAINT placement_seeds_pkey PRIMARY KEY (id);


--
-- Name: placement_tests placement_tests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.placement_tests
    ADD CONSTRAINT placement_tests_pkey PRIMARY KEY (id);


--
-- Name: project_exclusions project_exclusions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_exclusions
    ADD CONSTRAINT project_exclusions_pkey PRIMARY KEY (id);


--
-- Name: project_exclusions project_exclusions_project_id_kind_value_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_exclusions
    ADD CONSTRAINT project_exclusions_project_id_kind_value_key UNIQUE (project_id, kind, value);


--
-- Name: project_goals project_goals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_goals
    ADD CONSTRAINT project_goals_pkey PRIMARY KEY (project_id, month);


--
-- Name: project_members project_members_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_members
    ADD CONSTRAINT project_members_pkey PRIMARY KEY (project_id, user_id);


--
-- Name: project_notes project_notes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_notes
    ADD CONSTRAINT project_notes_pkey PRIMARY KEY (id);


--
-- Name: project_senders project_senders_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_senders
    ADD CONSTRAINT project_senders_pkey PRIMARY KEY (project_id, sender_id);


--
-- Name: projects projects_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.projects
    ADD CONSTRAINT projects_pkey PRIMARY KEY (id);


--
-- Name: projects projects_slug_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.projects
    ADD CONSTRAINT projects_slug_key UNIQUE (slug);


--
-- Name: provider_calls provider_calls_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_calls
    ADD CONSTRAINT provider_calls_pkey PRIMARY KEY (id);


--
-- Name: provider_credit_prices provider_credit_prices_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_credit_prices
    ADD CONSTRAINT provider_credit_prices_pkey PRIMARY KEY (provider);


--
-- Name: replies replies_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.replies
    ADD CONSTRAINT replies_pkey PRIMARY KEY (id);


--
-- Name: replies replies_rfc_message_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.replies
    ADD CONSTRAINT replies_rfc_message_id_key UNIQUE (rfc_message_id);


--
-- Name: reply_templates reply_templates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reply_templates
    ADD CONSTRAINT reply_templates_pkey PRIMARY KEY (id);


--
-- Name: schema_migrations schema_migrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schema_migrations
    ADD CONSTRAINT schema_migrations_pkey PRIMARY KEY (version);


--
-- Name: searches searches_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.searches
    ADD CONSTRAINT searches_pkey PRIMARY KEY (id);


--
-- Name: segment_companies segment_companies_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.segment_companies
    ADD CONSTRAINT segment_companies_pkey PRIMARY KEY (segment_id, company_id);


--
-- Name: segment_company_verdicts segment_company_verdicts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.segment_company_verdicts
    ADD CONSTRAINT segment_company_verdicts_pkey PRIMARY KEY (id);


--
-- Name: segment_sources segment_sources_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.segment_sources
    ADD CONSTRAINT segment_sources_pkey PRIMARY KEY (id);


--
-- Name: segment_sources segment_sources_segment_id_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.segment_sources
    ADD CONSTRAINT segment_sources_segment_id_name_key UNIQUE (segment_id, name);


--
-- Name: segments segments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.segments
    ADD CONSTRAINT segments_pkey PRIMARY KEY (id);


--
-- Name: segments segments_project_id_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.segments
    ADD CONSTRAINT segments_project_id_name_key UNIQUE (project_id, name);


--
-- Name: sender_images sender_images_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sender_images
    ADD CONSTRAINT sender_images_pkey PRIMARY KEY (id);


--
-- Name: senders senders_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.senders
    ADD CONSTRAINT senders_pkey PRIMARY KEY (id);


--
-- Name: sessions sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_pkey PRIMARY KEY (id);


--
-- Name: sessions sessions_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_token_hash_key UNIQUE (token_hash);


--
-- Name: slack_posts slack_posts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.slack_posts
    ADD CONSTRAINT slack_posts_pkey PRIMARY KEY (id);


--
-- Name: slack_workspaces slack_workspaces_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.slack_workspaces
    ADD CONSTRAINT slack_workspaces_pkey PRIMARY KEY (id);


--
-- Name: slack_workspaces slack_workspaces_team_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.slack_workspaces
    ADD CONSTRAINT slack_workspaces_team_id_key UNIQUE (team_id);


--
-- Name: spend spend_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.spend
    ADD CONSTRAINT spend_pkey PRIMARY KEY (id);


--
-- Name: strategies strategies_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.strategies
    ADD CONSTRAINT strategies_pkey PRIMARY KEY (id);


--
-- Name: strategy_companies strategy_companies_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.strategy_companies
    ADD CONSTRAINT strategy_companies_pkey PRIMARY KEY (strategy_id, company_id);


--
-- Name: strategy_contacts strategy_contacts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.strategy_contacts
    ADD CONSTRAINT strategy_contacts_pkey PRIMARY KEY (strategy_id, contact_id);


--
-- Name: strategy_personas strategy_personas_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.strategy_personas
    ADD CONSTRAINT strategy_personas_pkey PRIMARY KEY (id);


--
-- Name: strategy_personas strategy_personas_strategy_id_persona_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.strategy_personas
    ADD CONSTRAINT strategy_personas_strategy_id_persona_id_key UNIQUE (strategy_id, persona_id);


--
-- Name: strategy_personas strategy_personas_strategy_id_position_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.strategy_personas
    ADD CONSTRAINT strategy_personas_strategy_id_position_key UNIQUE (strategy_id, "position");


--
-- Name: strategy_plans strategy_plans_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.strategy_plans
    ADD CONSTRAINT strategy_plans_pkey PRIMARY KEY (id);


--
-- Name: strategy_plans strategy_plans_strategy_id_applies_when_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.strategy_plans
    ADD CONSTRAINT strategy_plans_strategy_id_applies_when_key UNIQUE (strategy_id, applies_when);


--
-- Name: strategy_segments strategy_segments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.strategy_segments
    ADD CONSTRAINT strategy_segments_pkey PRIMARY KEY (strategy_id, segment_id);


--
-- Name: strategy_senders strategy_senders_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.strategy_senders
    ADD CONSTRAINT strategy_senders_pkey PRIMARY KEY (strategy_id, sender_id);


--
-- Name: strategy_steps strategy_steps_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.strategy_steps
    ADD CONSTRAINT strategy_steps_pkey PRIMARY KEY (id);


--
-- Name: strategy_steps strategy_steps_plan_id_position_condition_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.strategy_steps
    ADD CONSTRAINT strategy_steps_plan_id_position_condition_key UNIQUE (plan_id, "position", condition);


--
-- Name: system_mail_domains system_mail_domains_domain_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.system_mail_domains
    ADD CONSTRAINT system_mail_domains_domain_key UNIQUE (domain);


--
-- Name: system_mail_domains system_mail_domains_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.system_mail_domains
    ADD CONSTRAINT system_mail_domains_pkey PRIMARY KEY (id);


--
-- Name: system_mail_domains system_mail_domains_resend_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.system_mail_domains
    ADD CONSTRAINT system_mail_domains_resend_id_key UNIQUE (resend_id);


--
-- Name: system_mail_messages system_mail_messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.system_mail_messages
    ADD CONSTRAINT system_mail_messages_pkey PRIMARY KEY (id);


--
-- Name: tasks tasks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tasks
    ADD CONSTRAINT tasks_pkey PRIMARY KEY (id);


--
-- Name: thread_messages thread_messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.thread_messages
    ADD CONSTRAINT thread_messages_pkey PRIMARY KEY (id);


--
-- Name: thread_messages thread_messages_thread_id_provider_message_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.thread_messages
    ADD CONSTRAINT thread_messages_thread_id_provider_message_id_key UNIQUE (thread_id, provider_message_id);


--
-- Name: threads threads_channel_mailbox_id_linkedin_account_id_provider_thr_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.threads
    ADD CONSTRAINT threads_channel_mailbox_id_linkedin_account_id_provider_thr_key UNIQUE (channel, mailbox_id, linkedin_account_id, provider_thread_id);


--
-- Name: threads threads_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.threads
    ADD CONSTRAINT threads_pkey PRIMARY KEY (id);


--
-- Name: tool_alerts tool_alerts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tool_alerts
    ADD CONSTRAINT tool_alerts_pkey PRIMARY KEY (tool);


--
-- Name: tool_balances tool_balances_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tool_balances
    ADD CONSTRAINT tool_balances_pkey PRIMARY KEY (id);


--
-- Name: tool_limits tool_limits_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tool_limits
    ADD CONSTRAINT tool_limits_pkey PRIMARY KEY (tool);


--
-- Name: triage_holds triage_holds_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.triage_holds
    ADD CONSTRAINT triage_holds_pkey PRIMARY KEY (thread_message_id);


--
-- Name: users users_email_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_key UNIQUE (email);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: warmup_profiles warmup_profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.warmup_profiles
    ADD CONSTRAINT warmup_profiles_pkey PRIMARY KEY (id);


--
-- Name: warmup_seeds warmup_seeds_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.warmup_seeds
    ADD CONSTRAINT warmup_seeds_pkey PRIMARY KEY (id);


--
-- Name: warmup_sends warmup_sends_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.warmup_sends
    ADD CONSTRAINT warmup_sends_pkey PRIMARY KEY (id);


--
-- Name: workspace_tenants workspace_tenants_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_tenants
    ADD CONSTRAINT workspace_tenants_name_key UNIQUE (name);


--
-- Name: workspace_tenants workspace_tenants_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_tenants
    ADD CONSTRAINT workspace_tenants_pkey PRIMARY KEY (id);


--
-- Name: ix_events__project_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_events__project_at ON ONLY public.events USING btree (project_id, at DESC);


--
-- Name: events_default_project_id_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX events_default_project_id_at_idx ON public.events_default USING btree (project_id, at DESC);


--
-- Name: ix_events__strategy; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_events__strategy ON ONLY public.events USING btree (strategy_id, type, at) WHERE (strategy_id IS NOT NULL);


--
-- Name: events_default_strategy_id_type_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX events_default_strategy_id_type_at_idx ON public.events_default USING btree (strategy_id, type, at) WHERE (strategy_id IS NOT NULL);


--
-- Name: ix_address_checks__pending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_address_checks__pending ON public.address_checks USING btree (requested_at) WHERE (status = 'pending'::text);


--
-- Name: ix_address_replacements__effective; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_address_replacements__effective ON public.address_replacements USING btree (effective_at);


--
-- Name: ix_agent_runs__claim; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_agent_runs__claim ON public.agent_runs USING btree (priority, created_at) WHERE (status = 'queued'::text);


--
-- Name: ix_agent_runs__project_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_agent_runs__project_created ON public.agent_runs USING btree (project_id, created_at DESC);


--
-- Name: ix_channel_invites__sender; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_channel_invites__sender ON public.channel_invites USING btree (sender_id, channel);


--
-- Name: ix_companies__esp_unknown; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_companies__esp_unknown ON public.companies USING btree (domain) WHERE (esp IS NULL);


--
-- Name: ix_contacts__esp_unknown; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_contacts__esp_unknown ON public.contacts USING btree (email) WHERE ((esp IS NULL) AND (email IS NOT NULL));


--
-- Name: ix_copy_tests__mailbox; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_copy_tests__mailbox ON public.copy_tests USING btree (mailbox_id, sent_at DESC);


--
-- Name: ix_copy_tests__message; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_copy_tests__message ON public.copy_tests USING btree (message_id, sent_at DESC);


--
-- Name: ix_domains__expiring; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_domains__expiring ON public.domains USING btree (expires_at) WHERE ((expires_at IS NOT NULL) AND (status <> 'released'::text));


--
-- Name: ix_domains__organisation; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_domains__organisation ON public.domains USING btree (organisation_id) WHERE (organisation_id IS NOT NULL);


--
-- Name: ix_domains__project_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_domains__project_status ON public.domains USING btree (project_id, status) WHERE (project_id IS NOT NULL);


--
-- Name: ix_enrollments__mailbox; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_enrollments__mailbox ON public.enrollments USING btree (mailbox_id) WHERE (mailbox_id IS NOT NULL);


--
-- Name: ix_enrollments__next_due; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_enrollments__next_due ON public.enrollments USING btree (next_due_at) WHERE ((status = 'active'::text) AND (next_message_id IS NOT NULL));


--
-- Name: ix_enrollments__paused; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_enrollments__paused ON public.enrollments USING btree (paused_until) WHERE (status = 'paused'::text);


--
-- Name: ix_enrollments__scheduled; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_enrollments__scheduled ON public.enrollments USING btree (starts_at) WHERE (status = 'scheduled'::text);


--
-- Name: ix_enrollments__to_plan; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_enrollments__to_plan ON public.enrollments USING btree (planned_until NULLS FIRST) WHERE (status = 'active'::text);


--
-- Name: ix_hypotheses__project; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_hypotheses__project ON public.hypotheses USING btree (project_id, status);


--
-- Name: ix_mail_domains__checked; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_mail_domains__checked ON public.mail_domains USING btree (checked_at);


--
-- Name: ix_mailbox_orders__waiting; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_mailbox_orders__waiting ON public.mailbox_orders USING btree (status) WHERE (settled_at IS NULL);


--
-- Name: ix_meeting_slots__open; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_meeting_slots__open ON public.meeting_slots USING btree (project_id, starts_at) WHERE (status = ANY (ARRAY['offered'::text, 'accepted'::text]));


--
-- Name: ix_meetings__cancel_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_meetings__cancel_at ON public.meetings USING btree (cancel_at) WHERE (cancel_at IS NOT NULL);


--
-- Name: ix_messages__claimed; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_messages__claimed ON public.messages USING btree (claimed_until) WHERE (status = 'sending'::text);


--
-- Name: ix_messages__due; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_messages__due ON public.messages USING btree (due_at) WHERE (status = 'ready'::text);


--
-- Name: ix_messages__enrollment; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_messages__enrollment ON public.messages USING btree (enrollment_id);


--
-- Name: ix_messages__needs_copy; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_messages__needs_copy ON public.messages USING btree (enrollment_id) WHERE (status = 'needs_copy'::text);


--
-- Name: ix_model_calls__project_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_model_calls__project_at ON public.model_calls USING btree (project_id, at);


--
-- Name: ix_named_colleagues__contact; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_named_colleagues__contact ON public.named_colleagues USING btree (contact_id);


--
-- Name: ix_named_colleagues__waiting; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_named_colleagues__waiting ON public.named_colleagues USING btree (created_at) WHERE (status = 'waiting'::text);


--
-- Name: ix_organisation_members__user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_organisation_members__user ON public.organisation_members USING btree (user_id);


--
-- Name: ix_placement_notes__pending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_placement_notes__pending ON public.placement_notes USING btree (sent_at) WHERE ((status = 'sent'::text) AND (verdict IS NULL));


--
-- Name: ix_placement_notes__seed; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_placement_notes__seed ON public.placement_notes USING btree (seed_id, sent_at DESC);


--
-- Name: ix_placement_notes__test; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_placement_notes__test ON public.placement_notes USING btree (test_id);


--
-- Name: ix_placement_tests__mailbox; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_placement_tests__mailbox ON public.placement_tests USING btree (mailbox_id, created_at DESC);


--
-- Name: ix_project_members__user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_project_members__user ON public.project_members USING btree (user_id);


--
-- Name: ix_project_notes__live; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_project_notes__live ON public.project_notes USING btree (project_id, kind) WHERE (superseded_at IS NULL);


--
-- Name: ix_project_senders__sender; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_project_senders__sender ON public.project_senders USING btree (sender_id);


--
-- Name: ix_projects__organisation; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_projects__organisation ON public.projects USING btree (organisation_id);


--
-- Name: ix_provider_calls__credits_left; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_provider_calls__credits_left ON public.provider_calls USING btree (provider, at DESC) WHERE (credits_left IS NOT NULL);


--
-- Name: ix_provider_calls__hash; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_provider_calls__hash ON public.provider_calls USING btree (request_hash, at);


--
-- Name: ix_provider_calls__project_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_provider_calls__project_at ON public.provider_calls USING btree (project_id, at);


--
-- Name: ix_searches__source; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_searches__source ON public.searches USING btree (source_id, ran_at) WHERE (source_id IS NOT NULL);


--
-- Name: ix_sender_images__sender; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_sender_images__sender ON public.sender_images USING btree (sender_id);


--
-- Name: ix_senders__organisation; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_senders__organisation ON public.senders USING btree (organisation_id) WHERE (organisation_id IS NOT NULL);


--
-- Name: ix_slack_posts__posted_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_slack_posts__posted_at ON public.slack_posts USING btree (posted_at DESC);


--
-- Name: ix_spend__project_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_spend__project_at ON public.spend USING btree (project_id, at);


--
-- Name: ix_system_mail_messages__created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_system_mail_messages__created_at ON public.system_mail_messages USING btree (created_at DESC);


--
-- Name: ix_system_mail_messages__domain; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_system_mail_messages__domain ON public.system_mail_messages USING btree (domain_id);


--
-- Name: ix_tasks__open; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_tasks__open ON public.tasks USING btree (project_id, due_at) WHERE (status = 'open'::text);


--
-- Name: ix_thread_messages__triage; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_thread_messages__triage ON public.thread_messages USING btree (sent_at) WHERE ((direction = 'in'::text) AND (kind = 'reply'::text) AND (triaged_at IS NULL));


--
-- Name: ix_triage_holds__effective; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_triage_holds__effective ON public.triage_holds USING btree (effective_at);


--
-- Name: ix_warmup_sends__mailbox_day; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_warmup_sends__mailbox_day ON public.warmup_sends USING btree (mailbox_id, sent_at DESC);


--
-- Name: ix_warmup_sends__seed; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_warmup_sends__seed ON public.warmup_sends USING btree (mailbox_id, seed_address);


--
-- Name: tool_balances_tool_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX tool_balances_tool_at_idx ON public.tool_balances USING btree (tool, at DESC);


--
-- Name: ux_agent_runs__one_live; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ux_agent_runs__one_live ON public.agent_runs USING btree (project_id) WHERE ((status = ANY (ARRAY['queued'::text, 'running'::text])) AND (kind = 'work'::text));


--
-- Name: ux_agent_runs__one_rewrite; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ux_agent_runs__one_rewrite ON public.agent_runs USING btree (reply_id) WHERE ((status = ANY (ARRAY['queued'::text, 'running'::text])) AND (kind = 'rewrite'::text));


--
-- Name: ux_calendars__live; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ux_calendars__live ON public.calendars USING btree (project_id, provider, external_id) WHERE (archived_at IS NULL);


--
-- Name: ux_channel_invites__token; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ux_channel_invites__token ON public.channel_invites USING btree (token_hash);


--
-- Name: ux_contacts__email; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ux_contacts__email ON public.contacts USING btree (project_id, email) WHERE (email IS NOT NULL);


--
-- Name: ux_contacts__linkedin; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ux_contacts__linkedin ON public.contacts USING btree (project_id, linkedin_url) WHERE (linkedin_url IS NOT NULL);


--
-- Name: ux_copy_tests__rfc; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ux_copy_tests__rfc ON public.copy_tests USING btree (rfc_message_id);


--
-- Name: ux_dnc__live; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ux_dnc__live ON public.dnc USING btree (COALESCE(project_id, '00000000-0000-0000-0000-000000000000'::uuid), kind, value) WHERE (removed_at IS NULL);


--
-- Name: ux_enrollments__one_live; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ux_enrollments__one_live ON public.enrollments USING btree (contact_id) WHERE (status = ANY (ARRAY['scheduled'::text, 'active'::text, 'paused'::text]));


--
-- Name: ux_linkedin_accounts__id_sender; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ux_linkedin_accounts__id_sender ON public.linkedin_accounts USING btree (id, sender_id);


--
-- Name: ux_mailbox_orders__address; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ux_mailbox_orders__address ON public.mailbox_orders USING btree (domain_id, lower(username));


--
-- Name: ux_mailboxes__id_sender; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ux_mailboxes__id_sender ON public.mailboxes USING btree (id, sender_id);


--
-- Name: ux_mailboxes__push_subscription_id; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ux_mailboxes__push_subscription_id ON public.mailboxes USING btree (push_subscription_id) WHERE (push_subscription_id IS NOT NULL);


--
-- Name: ux_meetings__calendar_slot; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ux_meetings__calendar_slot ON public.meetings USING btree (calendar_id, scheduled_at) WHERE (status = 'scheduled'::text);


--
-- Name: ux_messages__plan_step; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ux_messages__plan_step ON public.messages USING btree (enrollment_id, "position", COALESCE(condition, ''::text)) WHERE (resend_of IS NULL);


--
-- Name: ux_placement_notes__rfc; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ux_placement_notes__rfc ON public.placement_notes USING btree (rfc_message_id);


--
-- Name: ux_placement_seeds__address; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ux_placement_seeds__address ON public.placement_seeds USING btree (address);


--
-- Name: ux_project_members__one_owner; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ux_project_members__one_owner ON public.project_members USING btree (project_id) WHERE (role = 'owner'::text);


--
-- Name: ux_replies__one_draft; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ux_replies__one_draft ON public.replies USING btree (thread_id) WHERE (status = 'draft'::text);


--
-- Name: ux_reply_templates__one_active; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ux_reply_templates__one_active ON public.reply_templates USING btree (strategy_id, classification) WHERE (status = 'active'::text);


--
-- Name: ux_slack_workspaces__connected; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ux_slack_workspaces__connected ON public.slack_workspaces USING btree ((true)) WHERE (disconnected_at IS NULL);


--
-- Name: ux_tasks__open_segment; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ux_tasks__open_segment ON public.tasks USING btree (segment_id) WHERE ((status = 'open'::text) AND (segment_id IS NOT NULL));


--
-- Name: ux_tasks__open_signal; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ux_tasks__open_signal ON public.tasks USING btree (strategy_id, signal) WHERE ((status = 'open'::text) AND (signal IS NOT NULL));


--
-- Name: ux_threads__linkedin_chat; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ux_threads__linkedin_chat ON public.threads USING btree (linkedin_account_id, provider_thread_id) WHERE (channel = 'linkedin'::text);


--
-- Name: ux_warmup_profiles__mailbox; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ux_warmup_profiles__mailbox ON public.warmup_profiles USING btree (mailbox_id);


--
-- Name: ux_warmup_seeds__address; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ux_warmup_seeds__address ON public.warmup_seeds USING btree (provider, address);


--
-- Name: ux_warmup_sends__rfc; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ux_warmup_sends__rfc ON public.warmup_sends USING btree (rfc_message_id) WHERE (rfc_message_id IS NOT NULL);


--
-- Name: events_default_pkey; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.events_pkey ATTACH PARTITION public.events_default_pkey;


--
-- Name: events_default_project_id_at_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.ix_events__project_at ATTACH PARTITION public.events_default_project_id_at_idx;


--
-- Name: events_default_strategy_id_type_at_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.ix_events__strategy ATTACH PARTITION public.events_default_strategy_id_type_at_idx;


--
-- Name: segment_usage _RETURN; Type: RULE; Schema: public; Owner: -
--

CREATE OR REPLACE VIEW public.segment_usage AS
 SELECT sg.id AS segment_id,
    sg.project_id,
    sg.name,
    sg.status,
    sg.estimated_companies,
    count(sc.company_id) AS companies_found,
    count(sc.company_id) FILTER (WHERE (sc.status = 'qualified'::text)) AS qualified,
    count(sc.company_id) FILTER (WHERE (sc.status = 'disqualified'::text)) AS disqualified,
    count(sc.company_id) FILTER (WHERE (sc.status = 'new'::text)) AS not_yet_judged,
    round(((100.0 * (count(sc.company_id) FILTER (WHERE (sc.status = 'qualified'::text)))::numeric) / (NULLIF(sg.estimated_companies, 0))::numeric), 1) AS qualified_pct,
    ( SELECT count(*) AS count
           FROM public.segment_sources so
          WHERE ((so.segment_id = sg.id) AND (so.status = 'active'::text))) AS active_sources,
    ( SELECT count(*) AS count
           FROM public.searches s
          WHERE (s.segment_id = sg.id)) AS searches,
    ( SELECT max(s.ran_at) AS max
           FROM public.searches s
          WHERE (s.segment_id = sg.id)) AS last_search_at,
    count(sc.company_id) FILTER (WHERE ((sc.status = 'new'::text) AND (EXISTS ( SELECT 1
           FROM public.client_questions q
          WHERE ((q.id = sc.question_id) AND (q.status = ANY (ARRAY['open'::text, 'asked'::text]))))))) AS waiting_on_client
   FROM (public.segments sg
     LEFT JOIN public.segment_companies sc ON ((sc.segment_id = sg.id)))
  GROUP BY sg.id;


--
-- Name: source_usage _RETURN; Type: RULE; Schema: public; Owner: -
--

CREATE OR REPLACE VIEW public.source_usage AS
 SELECT so.id AS source_id,
    so.segment_id,
    so.kind,
    so.name,
    so.status,
    so.estimated_companies,
    count(sc.company_id) AS companies_found,
    count(sc.company_id) FILTER (WHERE (sc.status = 'qualified'::text)) AS qualified,
    count(sc.company_id) FILTER (WHERE (sc.status = 'disqualified'::text)) AS disqualified,
    ( SELECT count(*) AS count
           FROM public.searches s
          WHERE (s.source_id = so.id)) AS searches,
    ( SELECT COALESCE(sum(s.cost_usd), (0)::numeric) AS "coalesce"
           FROM public.searches s
          WHERE (s.source_id = so.id)) AS search_cost_usd,
    ( SELECT max(s.ran_at) AS max
           FROM public.searches s
          WHERE (s.source_id = so.id)) AS last_search_at
   FROM (public.segment_sources so
     LEFT JOIN public.segment_companies sc ON ((sc.source_id = so.id)))
  GROUP BY so.id;


--
-- Name: companies companies_esp_insert; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER companies_esp_insert BEFORE INSERT ON public.companies FOR EACH ROW EXECUTE FUNCTION public.esp_of_company();


--
-- Name: companies companies_esp_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER companies_esp_update BEFORE UPDATE OF domain ON public.companies FOR EACH ROW WHEN ((old.domain IS DISTINCT FROM new.domain)) EXECUTE FUNCTION public.esp_of_company();


--
-- Name: companies companies_replan; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER companies_replan AFTER UPDATE OF timezone ON public.companies FOR EACH ROW WHEN ((old.timezone IS DISTINCT FROM new.timezone)) EXECUTE FUNCTION public.replan_on_company();


--
-- Name: contacts contacts_esp_insert; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER contacts_esp_insert BEFORE INSERT ON public.contacts FOR EACH ROW EXECUTE FUNCTION public.esp_of_contact();


--
-- Name: contacts contacts_esp_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER contacts_esp_update BEFORE UPDATE OF email ON public.contacts FOR EACH ROW WHEN ((old.email IS DISTINCT FROM new.email)) EXECUTE FUNCTION public.esp_of_contact();


--
-- Name: contacts contacts_replan; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER contacts_replan AFTER UPDATE OF timezone ON public.contacts FOR EACH ROW WHEN ((old.timezone IS DISTINCT FROM new.timezone)) EXECUTE FUNCTION public.replan_on_contact();


--
-- Name: copy_tests copy_tests_count_sent; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER copy_tests_count_sent AFTER INSERT ON public.copy_tests FOR EACH ROW EXECUTE FUNCTION public.count_copy_test_sent();


--
-- Name: enrollments enrollments_replan; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER enrollments_replan BEFORE UPDATE ON public.enrollments FOR EACH ROW EXECUTE FUNCTION public.replan_on_enrollment();


--
-- Name: messages messages_count_sent_insert; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER messages_count_sent_insert AFTER INSERT ON public.messages FOR EACH ROW WHEN ((new.status = 'sent'::text)) EXECUTE FUNCTION public.count_message_sent();


--
-- Name: messages messages_count_sent_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER messages_count_sent_update AFTER UPDATE OF status ON public.messages FOR EACH ROW WHEN (((new.status = 'sent'::text) AND (old.status IS DISTINCT FROM 'sent'::text))) EXECUTE FUNCTION public.count_message_sent();


--
-- Name: messages messages_replan_insert; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER messages_replan_insert AFTER INSERT ON public.messages REFERENCING NEW TABLE AS inserted FOR EACH STATEMENT EXECUTE FUNCTION public.replan_on_messages_inserted();


--
-- Name: messages messages_replan_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER messages_replan_update AFTER UPDATE ON public.messages REFERENCING OLD TABLE AS before_rows NEW TABLE AS after_rows FOR EACH STATEMENT EXECUTE FUNCTION public.replan_on_messages_updated();


--
-- Name: placement_notes placement_notes_count_sent; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER placement_notes_count_sent AFTER INSERT ON public.placement_notes FOR EACH ROW WHEN ((new.status = 'sent'::text)) EXECUTE FUNCTION public.count_placement_sent();


--
-- Name: projects projects_replan; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER projects_replan AFTER UPDATE OF timezone ON public.projects FOR EACH ROW WHEN ((old.timezone IS DISTINCT FROM new.timezone)) EXECUTE FUNCTION public.replan_on_project();


--
-- Name: strategies strategies_replan; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER strategies_replan AFTER UPDATE OF status, send_days, window_start, window_end ON public.strategies FOR EACH ROW WHEN (((((old.status IS DISTINCT FROM new.status) OR (old.send_days IS DISTINCT FROM new.send_days)) OR (old.window_start IS DISTINCT FROM new.window_start)) OR (old.window_end IS DISTINCT FROM new.window_end))) EXECUTE FUNCTION public.replan_on_strategy();


--
-- Name: warmup_sends warmup_sends_count_sent_insert; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER warmup_sends_count_sent_insert AFTER INSERT ON public.warmup_sends FOR EACH ROW WHEN ((new.status = 'sent'::text)) EXECUTE FUNCTION public.count_warmup_sent();


--
-- Name: warmup_sends warmup_sends_count_sent_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER warmup_sends_count_sent_update AFTER UPDATE OF status ON public.warmup_sends FOR EACH ROW WHEN (((new.status = 'sent'::text) AND (old.status IS DISTINCT FROM 'sent'::text))) EXECUTE FUNCTION public.count_warmup_sent();


--
-- Name: address_checks address_checks_contact_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.address_checks
    ADD CONSTRAINT address_checks_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES public.contacts(id) ON DELETE CASCADE;


--
-- Name: address_checks address_checks_requested_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.address_checks
    ADD CONSTRAINT address_checks_requested_by_fkey FOREIGN KEY (requested_by) REFERENCES public.users(id);


--
-- Name: address_replacements address_replacements_actor_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.address_replacements
    ADD CONSTRAINT address_replacements_actor_user_id_fkey FOREIGN KEY (actor_user_id) REFERENCES public.users(id);


--
-- Name: address_replacements address_replacements_contact_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.address_replacements
    ADD CONSTRAINT address_replacements_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES public.contacts(id) ON DELETE CASCADE;


--
-- Name: agent_runs agent_runs_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_runs
    ADD CONSTRAINT agent_runs_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;


--
-- Name: agent_runs agent_runs_reply_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_runs
    ADD CONSTRAINT agent_runs_reply_id_fkey FOREIGN KEY (reply_id) REFERENCES public.replies(id);


--
-- Name: agent_runs agent_runs_requested_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_runs
    ADD CONSTRAINT agent_runs_requested_by_fkey FOREIGN KEY (requested_by) REFERENCES public.users(id);


--
-- Name: api_tokens api_tokens_revoke_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_tokens
    ADD CONSTRAINT api_tokens_revoke_by_fkey FOREIGN KEY (revoke_by) REFERENCES public.users(id);


--
-- Name: api_tokens api_tokens_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_tokens
    ADD CONSTRAINT api_tokens_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: calendar_offers calendar_offers_calendar_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.calendar_offers
    ADD CONSTRAINT calendar_offers_calendar_id_fkey FOREIGN KEY (calendar_id) REFERENCES public.calendars(id) ON DELETE CASCADE;


--
-- Name: calendars calendars_connected_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.calendars
    ADD CONSTRAINT calendars_connected_by_fkey FOREIGN KEY (connected_by) REFERENCES public.users(id);


--
-- Name: calendars calendars_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.calendars
    ADD CONSTRAINT calendars_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;


--
-- Name: calendars calendars_sender_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.calendars
    ADD CONSTRAINT calendars_sender_id_fkey FOREIGN KEY (sender_id) REFERENCES public.senders(id);


--
-- Name: channel_invites channel_invites_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channel_invites
    ADD CONSTRAINT channel_invites_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: channel_invites channel_invites_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channel_invites
    ADD CONSTRAINT channel_invites_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;


--
-- Name: channel_invites channel_invites_sender_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channel_invites
    ADD CONSTRAINT channel_invites_sender_id_fkey FOREIGN KEY (sender_id) REFERENCES public.senders(id) ON DELETE CASCADE;


--
-- Name: cli_logins cli_logins_approved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cli_logins
    ADD CONSTRAINT cli_logins_approved_by_fkey FOREIGN KEY (approved_by) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: cli_logins cli_logins_token_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cli_logins
    ADD CONSTRAINT cli_logins_token_id_fkey FOREIGN KEY (token_id) REFERENCES public.api_tokens(id) ON DELETE SET NULL;


--
-- Name: client_questions client_questions_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_questions
    ADD CONSTRAINT client_questions_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: client_questions client_questions_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_questions
    ADD CONSTRAINT client_questions_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;


--
-- Name: client_reports client_reports_built_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_reports
    ADD CONSTRAINT client_reports_built_by_fkey FOREIGN KEY (built_by) REFERENCES public.users(id);


--
-- Name: client_reports client_reports_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_reports
    ADD CONSTRAINT client_reports_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;


--
-- Name: companies companies_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.companies
    ADD CONSTRAINT companies_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;


--
-- Name: contacts contacts_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contacts
    ADD CONSTRAINT contacts_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE SET NULL;


--
-- Name: contacts contacts_departed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contacts
    ADD CONSTRAINT contacts_departed_by_fkey FOREIGN KEY (departed_by) REFERENCES public.users(id);


--
-- Name: contacts contacts_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contacts
    ADD CONSTRAINT contacts_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;


--
-- Name: contacts contacts_referred_by_contact_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contacts
    ADD CONSTRAINT contacts_referred_by_contact_id_fkey FOREIGN KEY (referred_by_contact_id) REFERENCES public.contacts(id);


--
-- Name: copy_tests copy_tests_mailbox_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.copy_tests
    ADD CONSTRAINT copy_tests_mailbox_id_fkey FOREIGN KEY (mailbox_id) REFERENCES public.mailboxes(id) ON DELETE CASCADE;


--
-- Name: copy_tests copy_tests_message_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.copy_tests
    ADD CONSTRAINT copy_tests_message_id_fkey FOREIGN KEY (message_id) REFERENCES public.messages(id) ON DELETE CASCADE;


--
-- Name: copy_tests copy_tests_sent_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.copy_tests
    ADD CONSTRAINT copy_tests_sent_by_fkey FOREIGN KEY (sent_by) REFERENCES public.users(id);


--
-- Name: dnc dnc_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dnc
    ADD CONSTRAINT dnc_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: dnc dnc_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dnc
    ADD CONSTRAINT dnc_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;


--
-- Name: domains domains_bought_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.domains
    ADD CONSTRAINT domains_bought_by_fkey FOREIGN KEY (bought_by) REFERENCES public.users(id);


--
-- Name: domains domains_organisation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.domains
    ADD CONSTRAINT domains_organisation_id_fkey FOREIGN KEY (organisation_id) REFERENCES public.organisations(id) ON DELETE RESTRICT;


--
-- Name: domains domains_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.domains
    ADD CONSTRAINT domains_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE SET NULL;


--
-- Name: domains domains_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.domains
    ADD CONSTRAINT domains_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.workspace_tenants(id);


--
-- Name: enrollments enrollments_contact_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.enrollments
    ADD CONSTRAINT enrollments_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES public.contacts(id) ON DELETE CASCADE;


--
-- Name: enrollments enrollments_ended_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.enrollments
    ADD CONSTRAINT enrollments_ended_by_fkey FOREIGN KEY (ended_by) REFERENCES public.users(id);


--
-- Name: enrollments enrollments_enrolled_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.enrollments
    ADD CONSTRAINT enrollments_enrolled_by_fkey FOREIGN KEY (enrolled_by) REFERENCES public.users(id);


--
-- Name: enrollments enrollments_follows_enrollment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.enrollments
    ADD CONSTRAINT enrollments_follows_enrollment_id_fkey FOREIGN KEY (follows_enrollment_id) REFERENCES public.enrollments(id);


--
-- Name: enrollments enrollments_linkedin_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.enrollments
    ADD CONSTRAINT enrollments_linkedin_account_id_fkey FOREIGN KEY (linkedin_account_id) REFERENCES public.linkedin_accounts(id);


--
-- Name: enrollments enrollments_linkedin_is_the_senders; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.enrollments
    ADD CONSTRAINT enrollments_linkedin_is_the_senders FOREIGN KEY (linkedin_account_id, sender_id) REFERENCES public.linkedin_accounts(id, sender_id);


--
-- Name: enrollments enrollments_mailbox_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.enrollments
    ADD CONSTRAINT enrollments_mailbox_id_fkey FOREIGN KEY (mailbox_id) REFERENCES public.mailboxes(id);


--
-- Name: enrollments enrollments_mailbox_is_the_senders; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.enrollments
    ADD CONSTRAINT enrollments_mailbox_is_the_senders FOREIGN KEY (mailbox_id, sender_id) REFERENCES public.mailboxes(id, sender_id);


--
-- Name: enrollments enrollments_persona_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.enrollments
    ADD CONSTRAINT enrollments_persona_id_fkey FOREIGN KEY (persona_id) REFERENCES public.personas(id);


--
-- Name: enrollments enrollments_plan_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.enrollments
    ADD CONSTRAINT enrollments_plan_id_fkey FOREIGN KEY (plan_id) REFERENCES public.strategy_plans(id);


--
-- Name: enrollments enrollments_segment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.enrollments
    ADD CONSTRAINT enrollments_segment_id_fkey FOREIGN KEY (segment_id) REFERENCES public.segments(id);


--
-- Name: enrollments enrollments_sender_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.enrollments
    ADD CONSTRAINT enrollments_sender_id_fkey FOREIGN KEY (sender_id) REFERENCES public.senders(id);


--
-- Name: enrollments enrollments_strategy_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.enrollments
    ADD CONSTRAINT enrollments_strategy_id_fkey FOREIGN KEY (strategy_id) REFERENCES public.strategies(id) ON DELETE CASCADE;


--
-- Name: events events_actor_user_id_fkey1; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE public.events
    ADD CONSTRAINT events_actor_user_id_fkey1 FOREIGN KEY (actor_user_id) REFERENCES public.users(id);


--
-- Name: events events_project_id_fkey1; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE public.events
    ADD CONSTRAINT events_project_id_fkey1 FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;


--
-- Name: events events_type_fkey1; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE public.events
    ADD CONSTRAINT events_type_fkey1 FOREIGN KEY (type) REFERENCES public.event_types(type);


--
-- Name: hypotheses hypotheses_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hypotheses
    ADD CONSTRAINT hypotheses_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: hypotheses hypotheses_persona_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hypotheses
    ADD CONSTRAINT hypotheses_persona_id_fkey FOREIGN KEY (persona_id) REFERENCES public.personas(id) ON DELETE SET NULL;


--
-- Name: hypotheses hypotheses_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hypotheses
    ADD CONSTRAINT hypotheses_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;


--
-- Name: hypotheses hypotheses_segment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hypotheses
    ADD CONSTRAINT hypotheses_segment_id_fkey FOREIGN KEY (segment_id) REFERENCES public.segments(id) ON DELETE SET NULL;


--
-- Name: hypotheses hypotheses_strategy_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hypotheses
    ADD CONSTRAINT hypotheses_strategy_id_fkey FOREIGN KEY (strategy_id) REFERENCES public.strategies(id) ON DELETE SET NULL;


--
-- Name: hypotheses hypotheses_testing_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hypotheses
    ADD CONSTRAINT hypotheses_testing_by_fkey FOREIGN KEY (testing_by) REFERENCES public.users(id);


--
-- Name: hypotheses hypotheses_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hypotheses
    ADD CONSTRAINT hypotheses_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id);


--
-- Name: linkedin_accounts linkedin_accounts_connected_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.linkedin_accounts
    ADD CONSTRAINT linkedin_accounts_connected_by_fkey FOREIGN KEY (connected_by) REFERENCES public.users(id);


--
-- Name: linkedin_accounts linkedin_accounts_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.linkedin_accounts
    ADD CONSTRAINT linkedin_accounts_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;


--
-- Name: linkedin_accounts linkedin_accounts_sender_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.linkedin_accounts
    ADD CONSTRAINT linkedin_accounts_sender_id_fkey FOREIGN KEY (sender_id) REFERENCES public.senders(id);


--
-- Name: mailbox_orders mailbox_orders_domain_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mailbox_orders
    ADD CONSTRAINT mailbox_orders_domain_id_fkey FOREIGN KEY (domain_id) REFERENCES public.domains(id) ON DELETE CASCADE;


--
-- Name: mailbox_orders mailbox_orders_mailbox_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mailbox_orders
    ADD CONSTRAINT mailbox_orders_mailbox_id_fkey FOREIGN KEY (mailbox_id) REFERENCES public.mailboxes(id) ON DELETE SET NULL;


--
-- Name: mailbox_orders mailbox_orders_ordered_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mailbox_orders
    ADD CONSTRAINT mailbox_orders_ordered_by_fkey FOREIGN KEY (ordered_by) REFERENCES public.users(id);


--
-- Name: mailbox_orders mailbox_orders_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mailbox_orders
    ADD CONSTRAINT mailbox_orders_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;


--
-- Name: mailbox_orders mailbox_orders_sender_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mailbox_orders
    ADD CONSTRAINT mailbox_orders_sender_id_fkey FOREIGN KEY (sender_id) REFERENCES public.senders(id) ON DELETE SET NULL;


--
-- Name: mailboxes mailboxes_connected_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mailboxes
    ADD CONSTRAINT mailboxes_connected_by_fkey FOREIGN KEY (connected_by) REFERENCES public.users(id);


--
-- Name: mailboxes mailboxes_domain_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mailboxes
    ADD CONSTRAINT mailboxes_domain_id_fkey FOREIGN KEY (domain_id) REFERENCES public.domains(id);


--
-- Name: mailboxes mailboxes_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mailboxes
    ADD CONSTRAINT mailboxes_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;


--
-- Name: mailboxes mailboxes_sender_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mailboxes
    ADD CONSTRAINT mailboxes_sender_id_fkey FOREIGN KEY (sender_id) REFERENCES public.senders(id);


--
-- Name: mailboxes mailboxes_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mailboxes
    ADD CONSTRAINT mailboxes_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.workspace_tenants(id);


--
-- Name: meeting_slots meeting_slots_calendar_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meeting_slots
    ADD CONSTRAINT meeting_slots_calendar_id_fkey FOREIGN KEY (calendar_id) REFERENCES public.calendars(id);


--
-- Name: meeting_slots meeting_slots_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meeting_slots
    ADD CONSTRAINT meeting_slots_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;


--
-- Name: meeting_slots meeting_slots_reply_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meeting_slots
    ADD CONSTRAINT meeting_slots_reply_id_fkey FOREIGN KEY (reply_id) REFERENCES public.replies(id);


--
-- Name: meeting_slots meeting_slots_thread_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meeting_slots
    ADD CONSTRAINT meeting_slots_thread_id_fkey FOREIGN KEY (thread_id) REFERENCES public.threads(id) ON DELETE CASCADE;


--
-- Name: meetings meetings_booked_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meetings
    ADD CONSTRAINT meetings_booked_by_fkey FOREIGN KEY (booked_by) REFERENCES public.users(id);


--
-- Name: meetings meetings_calendar_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meetings
    ADD CONSTRAINT meetings_calendar_id_fkey FOREIGN KEY (calendar_id) REFERENCES public.calendars(id);


--
-- Name: meetings meetings_cancel_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meetings
    ADD CONSTRAINT meetings_cancel_by_fkey FOREIGN KEY (cancel_by) REFERENCES public.users(id);


--
-- Name: meetings meetings_contact_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meetings
    ADD CONSTRAINT meetings_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES public.contacts(id);


--
-- Name: meetings meetings_outcome_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meetings
    ADD CONSTRAINT meetings_outcome_by_fkey FOREIGN KEY (outcome_by) REFERENCES public.users(id);


--
-- Name: meetings meetings_persona_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meetings
    ADD CONSTRAINT meetings_persona_id_fkey FOREIGN KEY (persona_id) REFERENCES public.personas(id);


--
-- Name: meetings meetings_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meetings
    ADD CONSTRAINT meetings_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;


--
-- Name: meetings meetings_rescheduled_from_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meetings
    ADD CONSTRAINT meetings_rescheduled_from_fkey FOREIGN KEY (rescheduled_from) REFERENCES public.meetings(id);


--
-- Name: meetings meetings_segment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meetings
    ADD CONSTRAINT meetings_segment_id_fkey FOREIGN KEY (segment_id) REFERENCES public.segments(id);


--
-- Name: meetings meetings_slot_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meetings
    ADD CONSTRAINT meetings_slot_id_fkey FOREIGN KEY (slot_id) REFERENCES public.meeting_slots(id);


--
-- Name: meetings meetings_strategy_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meetings
    ADD CONSTRAINT meetings_strategy_id_fkey FOREIGN KEY (strategy_id) REFERENCES public.strategies(id);


--
-- Name: meetings meetings_thread_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meetings
    ADD CONSTRAINT meetings_thread_id_fkey FOREIGN KEY (thread_id) REFERENCES public.threads(id);


--
-- Name: messages messages_enrollment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_enrollment_id_fkey FOREIGN KEY (enrollment_id) REFERENCES public.enrollments(id) ON DELETE CASCADE;


--
-- Name: messages messages_resend_of_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_resend_of_fkey FOREIGN KEY (resend_of) REFERENCES public.messages(id);


--
-- Name: messages messages_step_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_step_id_fkey FOREIGN KEY (step_id) REFERENCES public.strategy_steps(id);


--
-- Name: messages messages_thread_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_thread_id_fkey FOREIGN KEY (thread_id) REFERENCES public.threads(id);


--
-- Name: messages messages_written_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_written_by_fkey FOREIGN KEY (written_by) REFERENCES public.users(id);


--
-- Name: model_calls model_calls_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.model_calls
    ADD CONSTRAINT model_calls_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;


--
-- Name: model_calls model_calls_thread_message_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.model_calls
    ADD CONSTRAINT model_calls_thread_message_id_fkey FOREIGN KEY (thread_message_id) REFERENCES public.thread_messages(id) ON DELETE SET NULL;


--
-- Name: named_colleagues named_colleagues_contact_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.named_colleagues
    ADD CONSTRAINT named_colleagues_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES public.contacts(id) ON DELETE CASCADE;


--
-- Name: named_colleagues named_colleagues_enrollment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.named_colleagues
    ADD CONSTRAINT named_colleagues_enrollment_id_fkey FOREIGN KEY (enrollment_id) REFERENCES public.enrollments(id);


--
-- Name: named_colleagues named_colleagues_follows_enrollment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.named_colleagues
    ADD CONSTRAINT named_colleagues_follows_enrollment_id_fkey FOREIGN KEY (follows_enrollment_id) REFERENCES public.enrollments(id) ON DELETE CASCADE;


--
-- Name: named_colleagues named_colleagues_thread_message_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.named_colleagues
    ADD CONSTRAINT named_colleagues_thread_message_id_fkey FOREIGN KEY (thread_message_id) REFERENCES public.thread_messages(id) ON DELETE CASCADE;


--
-- Name: organisation_members organisation_members_added_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organisation_members
    ADD CONSTRAINT organisation_members_added_by_fkey FOREIGN KEY (added_by) REFERENCES public.users(id);


--
-- Name: organisation_members organisation_members_organisation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organisation_members
    ADD CONSTRAINT organisation_members_organisation_id_fkey FOREIGN KEY (organisation_id) REFERENCES public.organisations(id) ON DELETE CASCADE;


--
-- Name: organisation_members organisation_members_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organisation_members
    ADD CONSTRAINT organisation_members_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: personas personas_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.personas
    ADD CONSTRAINT personas_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;


--
-- Name: placement_notes placement_notes_mailbox_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.placement_notes
    ADD CONSTRAINT placement_notes_mailbox_id_fkey FOREIGN KEY (mailbox_id) REFERENCES public.mailboxes(id) ON DELETE CASCADE;


--
-- Name: placement_notes placement_notes_seed_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.placement_notes
    ADD CONSTRAINT placement_notes_seed_id_fkey FOREIGN KEY (seed_id) REFERENCES public.placement_seeds(id);


--
-- Name: placement_notes placement_notes_test_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.placement_notes
    ADD CONSTRAINT placement_notes_test_id_fkey FOREIGN KEY (test_id) REFERENCES public.placement_tests(id) ON DELETE CASCADE;


--
-- Name: placement_seeds placement_seeds_connected_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.placement_seeds
    ADD CONSTRAINT placement_seeds_connected_by_fkey FOREIGN KEY (connected_by) REFERENCES public.users(id);


--
-- Name: placement_tests placement_tests_mailbox_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.placement_tests
    ADD CONSTRAINT placement_tests_mailbox_id_fkey FOREIGN KEY (mailbox_id) REFERENCES public.mailboxes(id) ON DELETE CASCADE;


--
-- Name: placement_tests placement_tests_requested_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.placement_tests
    ADD CONSTRAINT placement_tests_requested_by_fkey FOREIGN KEY (requested_by) REFERENCES public.users(id);


--
-- Name: project_exclusions project_exclusions_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_exclusions
    ADD CONSTRAINT project_exclusions_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: project_exclusions project_exclusions_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_exclusions
    ADD CONSTRAINT project_exclusions_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;


--
-- Name: project_goals project_goals_done_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_goals
    ADD CONSTRAINT project_goals_done_by_fkey FOREIGN KEY (done_by) REFERENCES public.users(id);


--
-- Name: project_goals project_goals_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_goals
    ADD CONSTRAINT project_goals_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;


--
-- Name: project_goals project_goals_set_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_goals
    ADD CONSTRAINT project_goals_set_by_fkey FOREIGN KEY (set_by) REFERENCES public.users(id);


--
-- Name: project_members project_members_added_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_members
    ADD CONSTRAINT project_members_added_by_fkey FOREIGN KEY (added_by) REFERENCES public.users(id);


--
-- Name: project_members project_members_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_members
    ADD CONSTRAINT project_members_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;


--
-- Name: project_members project_members_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_members
    ADD CONSTRAINT project_members_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: project_notes project_notes_author_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_notes
    ADD CONSTRAINT project_notes_author_id_fkey FOREIGN KEY (author_id) REFERENCES public.users(id);


--
-- Name: project_notes project_notes_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_notes
    ADD CONSTRAINT project_notes_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;


--
-- Name: project_notes project_notes_segment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_notes
    ADD CONSTRAINT project_notes_segment_id_fkey FOREIGN KEY (segment_id) REFERENCES public.segments(id);


--
-- Name: project_notes project_notes_strategy_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_notes
    ADD CONSTRAINT project_notes_strategy_id_fkey FOREIGN KEY (strategy_id) REFERENCES public.strategies(id);


--
-- Name: project_senders project_senders_added_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_senders
    ADD CONSTRAINT project_senders_added_by_fkey FOREIGN KEY (added_by) REFERENCES public.users(id);


--
-- Name: project_senders project_senders_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_senders
    ADD CONSTRAINT project_senders_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;


--
-- Name: project_senders project_senders_sender_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_senders
    ADD CONSTRAINT project_senders_sender_id_fkey FOREIGN KEY (sender_id) REFERENCES public.senders(id) ON DELETE CASCADE;


--
-- Name: projects projects_agent_enabled_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.projects
    ADD CONSTRAINT projects_agent_enabled_by_fkey FOREIGN KEY (agent_enabled_by) REFERENCES public.users(id);


--
-- Name: projects projects_organisation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.projects
    ADD CONSTRAINT projects_organisation_id_fkey FOREIGN KEY (organisation_id) REFERENCES public.organisations(id);


--
-- Name: projects projects_setup_skipped_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.projects
    ADD CONSTRAINT projects_setup_skipped_by_fkey FOREIGN KEY (setup_skipped_by) REFERENCES public.users(id);


--
-- Name: projects projects_slack_channel_set_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.projects
    ADD CONSTRAINT projects_slack_channel_set_by_fkey FOREIGN KEY (slack_channel_set_by) REFERENCES public.users(id);


--
-- Name: projects projects_warmup_enabled_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.projects
    ADD CONSTRAINT projects_warmup_enabled_by_fkey FOREIGN KEY (warmup_enabled_by) REFERENCES public.users(id);


--
-- Name: projects projects_warmup_seed_types_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.projects
    ADD CONSTRAINT projects_warmup_seed_types_by_fkey FOREIGN KEY (warmup_seed_types_by) REFERENCES public.users(id);


--
-- Name: provider_calls provider_calls_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_calls
    ADD CONSTRAINT provider_calls_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: provider_calls provider_calls_contact_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_calls
    ADD CONSTRAINT provider_calls_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES public.contacts(id);


--
-- Name: provider_calls provider_calls_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_calls
    ADD CONSTRAINT provider_calls_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;


--
-- Name: provider_calls provider_calls_search_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_calls
    ADD CONSTRAINT provider_calls_search_id_fkey FOREIGN KEY (search_id) REFERENCES public.searches(id);


--
-- Name: provider_calls provider_calls_segment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_calls
    ADD CONSTRAINT provider_calls_segment_id_fkey FOREIGN KEY (segment_id) REFERENCES public.segments(id);


--
-- Name: provider_calls provider_calls_source_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_calls
    ADD CONSTRAINT provider_calls_source_id_fkey FOREIGN KEY (source_id) REFERENCES public.segment_sources(id);


--
-- Name: provider_calls provider_calls_strategy_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_calls
    ADD CONSTRAINT provider_calls_strategy_id_fkey FOREIGN KEY (strategy_id) REFERENCES public.strategies(id);


--
-- Name: provider_calls provider_calls_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_calls
    ADD CONSTRAINT provider_calls_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: provider_credit_prices provider_credit_prices_set_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_credit_prices
    ADD CONSTRAINT provider_credit_prices_set_by_fkey FOREIGN KEY (set_by) REFERENCES public.users(id);


--
-- Name: replies replies_approved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.replies
    ADD CONSTRAINT replies_approved_by_fkey FOREIGN KEY (approved_by) REFERENCES public.users(id);


--
-- Name: replies replies_drafted_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.replies
    ADD CONSTRAINT replies_drafted_by_fkey FOREIGN KEY (drafted_by) REFERENCES public.users(id);


--
-- Name: replies replies_previous_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.replies
    ADD CONSTRAINT replies_previous_id_fkey FOREIGN KEY (previous_id) REFERENCES public.replies(id);


--
-- Name: replies replies_sender_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.replies
    ADD CONSTRAINT replies_sender_id_fkey FOREIGN KEY (sender_id) REFERENCES public.senders(id);


--
-- Name: replies replies_template_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.replies
    ADD CONSTRAINT replies_template_id_fkey FOREIGN KEY (template_id) REFERENCES public.reply_templates(id);


--
-- Name: replies replies_thread_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.replies
    ADD CONSTRAINT replies_thread_id_fkey FOREIGN KEY (thread_id) REFERENCES public.threads(id) ON DELETE CASCADE;


--
-- Name: reply_templates reply_templates_approved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reply_templates
    ADD CONSTRAINT reply_templates_approved_by_fkey FOREIGN KEY (approved_by) REFERENCES public.users(id);


--
-- Name: reply_templates reply_templates_strategy_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reply_templates
    ADD CONSTRAINT reply_templates_strategy_id_fkey FOREIGN KEY (strategy_id) REFERENCES public.strategies(id);


--
-- Name: searches searches_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.searches
    ADD CONSTRAINT searches_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: searches searches_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.searches
    ADD CONSTRAINT searches_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;


--
-- Name: searches searches_ran_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.searches
    ADD CONSTRAINT searches_ran_by_fkey FOREIGN KEY (ran_by) REFERENCES public.users(id);


--
-- Name: searches searches_segment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.searches
    ADD CONSTRAINT searches_segment_id_fkey FOREIGN KEY (segment_id) REFERENCES public.segments(id);


--
-- Name: searches searches_source_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.searches
    ADD CONSTRAINT searches_source_id_fkey FOREIGN KEY (source_id) REFERENCES public.segment_sources(id);


--
-- Name: searches searches_strategy_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.searches
    ADD CONSTRAINT searches_strategy_id_fkey FOREIGN KEY (strategy_id) REFERENCES public.strategies(id);


--
-- Name: segment_companies segment_companies_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.segment_companies
    ADD CONSTRAINT segment_companies_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: segment_companies segment_companies_exclusion_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.segment_companies
    ADD CONSTRAINT segment_companies_exclusion_id_fkey FOREIGN KEY (exclusion_id) REFERENCES public.project_exclusions(id);


--
-- Name: segment_companies segment_companies_question_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.segment_companies
    ADD CONSTRAINT segment_companies_question_id_fkey FOREIGN KEY (question_id) REFERENCES public.client_questions(id);


--
-- Name: segment_companies segment_companies_search_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.segment_companies
    ADD CONSTRAINT segment_companies_search_id_fkey FOREIGN KEY (search_id) REFERENCES public.searches(id) ON DELETE SET NULL;


--
-- Name: segment_companies segment_companies_segment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.segment_companies
    ADD CONSTRAINT segment_companies_segment_id_fkey FOREIGN KEY (segment_id) REFERENCES public.segments(id) ON DELETE CASCADE;


--
-- Name: segment_companies segment_companies_source_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.segment_companies
    ADD CONSTRAINT segment_companies_source_id_fkey FOREIGN KEY (source_id) REFERENCES public.segment_sources(id) ON DELETE SET NULL;


--
-- Name: segment_company_verdicts segment_company_verdicts_exclusion_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.segment_company_verdicts
    ADD CONSTRAINT segment_company_verdicts_exclusion_id_fkey FOREIGN KEY (exclusion_id) REFERENCES public.project_exclusions(id);


--
-- Name: segment_company_verdicts segment_company_verdicts_judged_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.segment_company_verdicts
    ADD CONSTRAINT segment_company_verdicts_judged_by_fkey FOREIGN KEY (judged_by) REFERENCES public.users(id);


--
-- Name: segment_company_verdicts segment_company_verdicts_search_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.segment_company_verdicts
    ADD CONSTRAINT segment_company_verdicts_search_id_fkey FOREIGN KEY (search_id) REFERENCES public.searches(id) ON DELETE SET NULL;


--
-- Name: segment_company_verdicts segment_company_verdicts_segment_id_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.segment_company_verdicts
    ADD CONSTRAINT segment_company_verdicts_segment_id_company_id_fkey FOREIGN KEY (segment_id, company_id) REFERENCES public.segment_companies(segment_id, company_id) ON DELETE CASCADE;


--
-- Name: segment_sources segment_sources_segment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.segment_sources
    ADD CONSTRAINT segment_sources_segment_id_fkey FOREIGN KEY (segment_id) REFERENCES public.segments(id) ON DELETE CASCADE;


--
-- Name: segments segments_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.segments
    ADD CONSTRAINT segments_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;


--
-- Name: sender_images sender_images_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sender_images
    ADD CONSTRAINT sender_images_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: sender_images sender_images_sender_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sender_images
    ADD CONSTRAINT sender_images_sender_id_fkey FOREIGN KEY (sender_id) REFERENCES public.senders(id) ON DELETE CASCADE;


--
-- Name: senders senders_organisation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.senders
    ADD CONSTRAINT senders_organisation_id_fkey FOREIGN KEY (organisation_id) REFERENCES public.organisations(id) ON DELETE CASCADE;


--
-- Name: senders senders_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.senders
    ADD CONSTRAINT senders_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;


--
-- Name: sessions sessions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: slack_posts slack_posts_posted_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.slack_posts
    ADD CONSTRAINT slack_posts_posted_by_fkey FOREIGN KEY (posted_by) REFERENCES public.users(id);


--
-- Name: slack_posts slack_posts_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.slack_posts
    ADD CONSTRAINT slack_posts_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id);


--
-- Name: slack_workspaces slack_workspaces_connected_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.slack_workspaces
    ADD CONSTRAINT slack_workspaces_connected_by_fkey FOREIGN KEY (connected_by) REFERENCES public.users(id);


--
-- Name: spend spend_actor_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.spend
    ADD CONSTRAINT spend_actor_user_id_fkey FOREIGN KEY (actor_user_id) REFERENCES public.users(id);


--
-- Name: spend spend_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.spend
    ADD CONSTRAINT spend_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: spend spend_contact_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.spend
    ADD CONSTRAINT spend_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES public.contacts(id);


--
-- Name: spend spend_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.spend
    ADD CONSTRAINT spend_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;


--
-- Name: spend spend_provider_call_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.spend
    ADD CONSTRAINT spend_provider_call_id_fkey FOREIGN KEY (provider_call_id) REFERENCES public.provider_calls(id);


--
-- Name: spend spend_search_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.spend
    ADD CONSTRAINT spend_search_id_fkey FOREIGN KEY (search_id) REFERENCES public.searches(id);


--
-- Name: spend spend_segment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.spend
    ADD CONSTRAINT spend_segment_id_fkey FOREIGN KEY (segment_id) REFERENCES public.segments(id);


--
-- Name: spend spend_strategy_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.spend
    ADD CONSTRAINT spend_strategy_id_fkey FOREIGN KEY (strategy_id) REFERENCES public.strategies(id);


--
-- Name: strategies strategies_launched_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.strategies
    ADD CONSTRAINT strategies_launched_by_fkey FOREIGN KEY (launched_by) REFERENCES public.users(id);


--
-- Name: strategies strategies_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.strategies
    ADD CONSTRAINT strategies_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;


--
-- Name: strategy_companies strategy_companies_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.strategy_companies
    ADD CONSTRAINT strategy_companies_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: strategy_companies strategy_companies_exclusion_decided_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.strategy_companies
    ADD CONSTRAINT strategy_companies_exclusion_decided_by_fkey FOREIGN KEY (exclusion_decided_by) REFERENCES public.users(id);


--
-- Name: strategy_companies strategy_companies_segment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.strategy_companies
    ADD CONSTRAINT strategy_companies_segment_id_fkey FOREIGN KEY (segment_id) REFERENCES public.segments(id);


--
-- Name: strategy_companies strategy_companies_strategy_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.strategy_companies
    ADD CONSTRAINT strategy_companies_strategy_id_fkey FOREIGN KEY (strategy_id) REFERENCES public.strategies(id) ON DELETE CASCADE;


--
-- Name: strategy_contacts strategy_contacts_contact_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.strategy_contacts
    ADD CONSTRAINT strategy_contacts_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES public.contacts(id) ON DELETE CASCADE;


--
-- Name: strategy_contacts strategy_contacts_decided_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.strategy_contacts
    ADD CONSTRAINT strategy_contacts_decided_by_fkey FOREIGN KEY (decided_by) REFERENCES public.users(id);


--
-- Name: strategy_contacts strategy_contacts_persona_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.strategy_contacts
    ADD CONSTRAINT strategy_contacts_persona_id_fkey FOREIGN KEY (persona_id) REFERENCES public.personas(id);


--
-- Name: strategy_contacts strategy_contacts_strategy_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.strategy_contacts
    ADD CONSTRAINT strategy_contacts_strategy_id_fkey FOREIGN KEY (strategy_id) REFERENCES public.strategies(id) ON DELETE CASCADE;


--
-- Name: strategy_personas strategy_personas_persona_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.strategy_personas
    ADD CONSTRAINT strategy_personas_persona_id_fkey FOREIGN KEY (persona_id) REFERENCES public.personas(id);


--
-- Name: strategy_personas strategy_personas_strategy_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.strategy_personas
    ADD CONSTRAINT strategy_personas_strategy_id_fkey FOREIGN KEY (strategy_id) REFERENCES public.strategies(id) ON DELETE CASCADE;


--
-- Name: strategy_plans strategy_plans_strategy_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.strategy_plans
    ADD CONSTRAINT strategy_plans_strategy_id_fkey FOREIGN KEY (strategy_id) REFERENCES public.strategies(id) ON DELETE CASCADE;


--
-- Name: strategy_segments strategy_segments_segment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.strategy_segments
    ADD CONSTRAINT strategy_segments_segment_id_fkey FOREIGN KEY (segment_id) REFERENCES public.segments(id);


--
-- Name: strategy_segments strategy_segments_strategy_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.strategy_segments
    ADD CONSTRAINT strategy_segments_strategy_id_fkey FOREIGN KEY (strategy_id) REFERENCES public.strategies(id) ON DELETE CASCADE;


--
-- Name: strategy_senders strategy_senders_sender_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.strategy_senders
    ADD CONSTRAINT strategy_senders_sender_id_fkey FOREIGN KEY (sender_id) REFERENCES public.senders(id);


--
-- Name: strategy_senders strategy_senders_strategy_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.strategy_senders
    ADD CONSTRAINT strategy_senders_strategy_id_fkey FOREIGN KEY (strategy_id) REFERENCES public.strategies(id) ON DELETE CASCADE;


--
-- Name: strategy_steps strategy_steps_plan_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.strategy_steps
    ADD CONSTRAINT strategy_steps_plan_id_fkey FOREIGN KEY (plan_id) REFERENCES public.strategy_plans(id) ON DELETE CASCADE;


--
-- Name: system_mail_domains system_mail_domains_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.system_mail_domains
    ADD CONSTRAINT system_mail_domains_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: system_mail_messages system_mail_messages_domain_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.system_mail_messages
    ADD CONSTRAINT system_mail_messages_domain_id_fkey FOREIGN KEY (domain_id) REFERENCES public.system_mail_domains(id);


--
-- Name: system_mail_messages system_mail_messages_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.system_mail_messages
    ADD CONSTRAINT system_mail_messages_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id);


--
-- Name: system_mail_messages system_mail_messages_sent_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.system_mail_messages
    ADD CONSTRAINT system_mail_messages_sent_by_fkey FOREIGN KEY (sent_by) REFERENCES public.users(id);


--
-- Name: tasks tasks_assignee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tasks
    ADD CONSTRAINT tasks_assignee_id_fkey FOREIGN KEY (assignee_id) REFERENCES public.users(id);


--
-- Name: tasks tasks_calendar_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tasks
    ADD CONSTRAINT tasks_calendar_id_fkey FOREIGN KEY (calendar_id) REFERENCES public.calendars(id);


--
-- Name: tasks tasks_closed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tasks
    ADD CONSTRAINT tasks_closed_by_fkey FOREIGN KEY (closed_by) REFERENCES public.users(id);


--
-- Name: tasks tasks_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tasks
    ADD CONSTRAINT tasks_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: tasks tasks_domain_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tasks
    ADD CONSTRAINT tasks_domain_id_fkey FOREIGN KEY (domain_id) REFERENCES public.domains(id) ON DELETE CASCADE;


--
-- Name: tasks tasks_mailbox_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tasks
    ADD CONSTRAINT tasks_mailbox_id_fkey FOREIGN KEY (mailbox_id) REFERENCES public.mailboxes(id);


--
-- Name: tasks tasks_meeting_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tasks
    ADD CONSTRAINT tasks_meeting_id_fkey FOREIGN KEY (meeting_id) REFERENCES public.meetings(id);


--
-- Name: tasks tasks_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tasks
    ADD CONSTRAINT tasks_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;


--
-- Name: tasks tasks_question_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tasks
    ADD CONSTRAINT tasks_question_id_fkey FOREIGN KEY (question_id) REFERENCES public.client_questions(id);


--
-- Name: tasks tasks_segment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tasks
    ADD CONSTRAINT tasks_segment_id_fkey FOREIGN KEY (segment_id) REFERENCES public.segments(id) ON DELETE CASCADE;


--
-- Name: tasks tasks_strategy_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tasks
    ADD CONSTRAINT tasks_strategy_id_fkey FOREIGN KEY (strategy_id) REFERENCES public.strategies(id);


--
-- Name: tasks tasks_thread_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tasks
    ADD CONSTRAINT tasks_thread_id_fkey FOREIGN KEY (thread_id) REFERENCES public.threads(id);


--
-- Name: thread_messages thread_messages_message_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.thread_messages
    ADD CONSTRAINT thread_messages_message_id_fkey FOREIGN KEY (message_id) REFERENCES public.messages(id);


--
-- Name: thread_messages thread_messages_reply_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.thread_messages
    ADD CONSTRAINT thread_messages_reply_id_fkey FOREIGN KEY (reply_id) REFERENCES public.replies(id);


--
-- Name: thread_messages thread_messages_reply_to_message_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.thread_messages
    ADD CONSTRAINT thread_messages_reply_to_message_id_fkey FOREIGN KEY (reply_to_message_id) REFERENCES public.messages(id);


--
-- Name: thread_messages thread_messages_thread_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.thread_messages
    ADD CONSTRAINT thread_messages_thread_id_fkey FOREIGN KEY (thread_id) REFERENCES public.threads(id) ON DELETE CASCADE;


--
-- Name: thread_messages thread_messages_triaged_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.thread_messages
    ADD CONSTRAINT thread_messages_triaged_by_fkey FOREIGN KEY (triaged_by) REFERENCES public.users(id);


--
-- Name: threads threads_assigned_to_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.threads
    ADD CONSTRAINT threads_assigned_to_fkey FOREIGN KEY (assigned_to) REFERENCES public.users(id);


--
-- Name: threads threads_contact_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.threads
    ADD CONSTRAINT threads_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES public.contacts(id);


--
-- Name: threads threads_enrollment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.threads
    ADD CONSTRAINT threads_enrollment_id_fkey FOREIGN KEY (enrollment_id) REFERENCES public.enrollments(id);


--
-- Name: threads threads_linkedin_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.threads
    ADD CONSTRAINT threads_linkedin_account_id_fkey FOREIGN KEY (linkedin_account_id) REFERENCES public.linkedin_accounts(id);


--
-- Name: threads threads_mailbox_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.threads
    ADD CONSTRAINT threads_mailbox_id_fkey FOREIGN KEY (mailbox_id) REFERENCES public.mailboxes(id);


--
-- Name: threads threads_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.threads
    ADD CONSTRAINT threads_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;


--
-- Name: tool_limits tool_limits_set_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tool_limits
    ADD CONSTRAINT tool_limits_set_by_fkey FOREIGN KEY (set_by) REFERENCES public.users(id);


--
-- Name: triage_holds triage_holds_actor_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.triage_holds
    ADD CONSTRAINT triage_holds_actor_user_id_fkey FOREIGN KEY (actor_user_id) REFERENCES public.users(id);


--
-- Name: triage_holds triage_holds_thread_message_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.triage_holds
    ADD CONSTRAINT triage_holds_thread_message_id_fkey FOREIGN KEY (thread_message_id) REFERENCES public.thread_messages(id) ON DELETE CASCADE;


--
-- Name: warmup_profiles warmup_profiles_mailbox_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.warmup_profiles
    ADD CONSTRAINT warmup_profiles_mailbox_id_fkey FOREIGN KEY (mailbox_id) REFERENCES public.mailboxes(id) ON DELETE CASCADE;


--
-- Name: warmup_sends warmup_sends_mailbox_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.warmup_sends
    ADD CONSTRAINT warmup_sends_mailbox_id_fkey FOREIGN KEY (mailbox_id) REFERENCES public.mailboxes(id) ON DELETE CASCADE;


--
-- Name: warmup_sends warmup_sends_seed_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.warmup_sends
    ADD CONSTRAINT warmup_sends_seed_id_fkey FOREIGN KEY (seed_id) REFERENCES public.warmup_seeds(id);


--
-- Name: workspace_tenants workspace_tenants_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_tenants
    ADD CONSTRAINT workspace_tenants_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- PostgreSQL database dump complete
--

\unrestrict dbmate


--
-- Dbmate schema migrations
--

INSERT INTO public.schema_migrations (version) VALUES
    ('20260923000000'),
    ('20260923120000'),
    ('20260923202630'),
    ('20260923225741'),
    ('20260923232457'),
    ('20260923233755'),
    ('20260924000432'),
    ('20260924000506'),
    ('20260924002204'),
    ('20260924004349'),
    ('20260924010522'),
    ('20260924011413'),
    ('20260924013324'),
    ('20260924022459'),
    ('20260924025729'),
    ('20260924030959'),
    ('20260924071229'),
    ('20260924091928'),
    ('20260924093612'),
    ('20260924094237'),
    ('20260924102843'),
    ('20260924105412'),
    ('20260924124012'),
    ('20260924124024'),
    ('20260924131230'),
    ('20260924165609'),
    ('20260924165745'),
    ('20260924175657'),
    ('20260924181259'),
    ('20260924182036'),
    ('20260924195935'),
    ('20260924231349'),
    ('20260924235917'),
    ('20260925114806'),
    ('20260925121101'),
    ('20260925122228'),
    ('20260925130439'),
    ('20260925130552'),
    ('20260925135117'),
    ('20260925140309'),
    ('20260925140900'),
    ('20260925141304'),
    ('20260925150000'),
    ('20260925150100'),
    ('20260925154242'),
    ('20260925154259'),
    ('20260925154433'),
    ('20260925165622'),
    ('20260926105043'),
    ('20260928093726'),
    ('20260928110000'),
    ('20260928120000'),
    ('20260928130000'),
    ('20260928135907'),
    ('20260928144558'),
    ('20260928152026'),
    ('20260928152037'),
    ('20260928152922'),
    ('20260928153058'),
    ('20260928163329'),
    ('20260928163330'),
    ('20260928164326'),
    ('20260928164532'),
    ('20260928170214'),
    ('20260928170353'),
    ('20260928213708'),
    ('20260928214915'),
    ('20260928235407'),
    ('20260929095310'),
    ('20260929101213'),
    ('20260929102650'),
    ('20260929121817'),
    ('20260929142338'),
    ('20260929142432'),
    ('20260929143742'),
    ('20260929153314'),
    ('20260930090900'),
    ('20260930100938'),
    ('20260930101205'),
    ('20260930105512'),
    ('20260930114508'),
    ('20260930122239'),
    ('20260930142050'),
    ('20260930153534'),
    ('20260930160852'),
    ('20260930183845');
