# Client report queries

Every query is one `select` for `bh sql "…"` (read-only, 10 s timeout, 200 rows by default — pass
`--limit`). `bh sql` is not scoped to the project: every query filters with `@project`, which `bh sql` replaces
with the current project's id. Replace `:from` and `:to` (inclusive `YYYY-MM-DD` days) before running; the period ends at
`:to::date + 1` so the last day counts whole. Keep the exact text of each query you used — it goes
into the report record (see SKILL.md, "Record").

Definitions the queries share, and the report states:

- **Contacted**: a person with at least one message sent in the period (any channel).
- **Replied**: a person with at least one inbound `kind = 'reply'` whose class is not
  `out_of_office`, `other` or null — a person counts once, however many times they wrote.
- **Positive**: a person with a reply classed `interested` or `meeting`.
- **Delivered**: sent and not bounced. Only email bounces; LinkedIn has acceptance instead.

## 1. Volume: sent, bounced, delivered, accepted

```sql
select m.channel,
       count(*) as sent,
       count(*) filter (where m.bounced_at is not null) as bounced,
       count(*) filter (where m.bounce_kind = 'hard') as hard_bounced,
       count(*) filter (where m.bounced_at is null) as delivered,
       count(*) filter (where m.accepted_at is not null) as invites_accepted
  from messages m
  join enrollments e on e.id = m.enrollment_id
  join strategies s on s.id = e.strategy_id
 where s.project_id = @project and m.sent_at >= ':from' and m.sent_at < ':to'::date + 1
 group by m.channel order by m.channel
```

## 2. The funnel: people contacted, replied, positive; companies reached

```sql
with sent as (
  select distinct e.contact_id, c.company_id
    from messages m
    join enrollments e on e.id = m.enrollment_id
    join strategies s on s.id = e.strategy_id
    join contacts c on c.id = e.contact_id
   where s.project_id = @project and m.sent_at >= ':from' and m.sent_at < ':to'::date + 1
), answered as (
  select t.contact_id,
         bool_or(tm.classification in ('interested', 'meeting')) as positive
    from thread_messages tm
    join threads t on t.id = tm.thread_id
   where t.project_id = @project and tm.direction = 'in' and tm.kind = 'reply'
     and tm.classification not in ('out_of_office', 'other')
     and tm.sent_at >= ':from' and tm.sent_at < ':to'::date + 1
   group by t.contact_id
)
select (select count(*) from sent) as people_contacted,
       (select count(distinct company_id) from sent) as companies_reached,
       count(a.contact_id) as people_replied,
       count(a.contact_id) filter (where a.positive) as people_positive,
       round(100.0 * count(a.contact_id) / nullif((select count(*) from sent), 0), 1) as reply_pct,
       round(100.0 * count(a.contact_id) filter (where a.positive)
             / nullif((select count(*) from sent), 0), 1) as positive_pct
  from answered a
```

A reply in the period from someone first contacted before it counts as a reply but not as
contacted; for a first report the period starts at launch, so the two agree. Say which in the
definitions line when they do not.

## 3. Replies by class

```sql
select coalesce(tm.classification, 'unclassified') as class,
       count(*) as messages,
       count(distinct t.contact_id) as people,
       count(*) filter (where tm.triaged_at is null) as untriaged
  from thread_messages tm
  join threads t on t.id = tm.thread_id
 where t.project_id = @project and tm.direction = 'in' and tm.kind in ('reply', 'auto_reply')
   and tm.sent_at >= ':from' and tm.sent_at < ':to'::date + 1
 group by 1 order by people desc
```

`untriaged` above zero means the engine's class has not been confirmed: run the `inbox-triage`
skill first, or say in the report that the split is provisional.

## 4. Meetings against the goal

```sql
select to_char(g.month, 'YYYY-MM') as month, g.meetings_target, g.counts, g.achieved, g.scheduled
  from goal_progress g
 where g.project_id = @project and g.month >= date_trunc('month', ':from'::date)
   and g.month <= ':to'::date
 order by g.month
```

`achieved` counts held meetings (`counts = 'held'`) or held ones rated qualified / opportunity / won
(`counts = 'qualified'`); `scheduled` are still ahead. No row means nobody set a goal — a person
does, with `bh goal set`; do not invent one from notes.

```sql
select m.scheduled_at, m.lead_timezone, m.status, m.outcome, m.client_feedback,
       c.first_name, c.last_name, c.title, co.name as company, co.country,
       s.name as strategy, sg.name as segment, pe.name as persona,
       m.rescheduled_from is not null as was_rescheduled
  from meetings m
  join contacts c on c.id = m.contact_id
  left join companies co on co.id = c.company_id
  left join strategies s on s.id = m.strategy_id
  left join segments sg on sg.id = m.segment_id
  left join personas pe on pe.id = m.persona_id
 where m.project_id = @project and m.scheduled_at >= ':from' and m.scheduled_at < ':to'::date + 1
   and m.status <> 'rescheduled'
 order by m.scheduled_at
```

A `rescheduled` row is history (the meeting that replaced it has `rescheduled_from`); counting it
double counts the meeting.

## 5. Per strategy and segment (since launch, not per period)

```sql
select s.name as strategy, sg.name as segment, u.status,
       u.qualified_companies, u.companies_worked, u.companies_left,
       u.enrolled, u.replied, u.positive, u.meetings, u.good_meetings, u.spend_usd,
       round(100.0 * u.replied / nullif(u.enrolled, 0), 1) as reply_pct,
       round(100.0 * u.positive / nullif(u.enrolled, 0), 1) as positive_pct
  from strategy_segment_usage u
  join strategies s on s.id = u.strategy_id
  join segments sg on sg.id = u.segment_id
 where s.project_id = @project
 order by s.name, sg.name
```

`replied`, `positive` and `meetings` are leads, counted by `enrollment_outcomes` as every screen
counts them: replied = wrote back, positive = interested, meeting, question or referral, meetings =
scheduled or held. `spend_usd` holds only spend tagged with both the strategy and the segment.

## 6. Per persona (or segment, country, sender): contacted, replied, positive

```sql
with sent as (
  select distinct e.id as enrollment_id, e.contact_id, pe.name as persona
    from messages m
    join enrollments e on e.id = m.enrollment_id
    join strategies s on s.id = e.strategy_id
    join personas pe on pe.id = e.persona_id
   where s.project_id = @project and m.sent_at >= ':from' and m.sent_at < ':to'::date + 1
), answered as (
  select t.enrollment_id, bool_or(tm.classification in ('interested', 'meeting')) as positive
    from thread_messages tm
    join threads t on t.id = tm.thread_id
   where tm.direction = 'in' and tm.kind = 'reply'
     and tm.classification not in ('out_of_office', 'other')
   group by t.enrollment_id
)
select s.persona,
       count(distinct s.contact_id) as contacted,
       count(distinct s.contact_id) filter (where a.enrollment_id is not null) as replied,
       count(distinct s.contact_id) filter (where a.positive) as positive
  from sent s left join answered a on a.enrollment_id = s.enrollment_id
 group by s.persona order by contacted desc
```

For another cut, swap the `persona` column: `sg.name` (join `segments sg on sg.id = e.segment_id`),
`co.country` (join `contacts c on c.id = e.contact_id`, `companies co on co.id = c.company_id`),
`se.name` (join `senders se on se.id = e.sender_id`).

## 7. Angles and steps by reply rate

Replies are attributed to the message they answer through `thread_messages.reply_to_message_id`
(set by the engine from `In-Reply-To`), so an angle is credited with the replies to its own message,
not to the lead's first touch.

```sql
with sent as (
  select m.angle, m.position, count(*) as sent
    from messages m
    join enrollments e on e.id = m.enrollment_id
    join strategies s on s.id = e.strategy_id
   where s.project_id = @project and m.sent_at >= ':from' and m.sent_at < ':to'::date + 1
     and m.channel = 'email'
   group by m.angle, m.position
), got as (
  select m.angle, m.position,
         count(distinct t.contact_id) as replied,
         count(distinct t.contact_id) filter (where tm.classification in ('interested', 'meeting')) as positive
    from thread_messages tm
    join threads t on t.id = tm.thread_id
    join messages m on m.id = tm.reply_to_message_id
   where tm.direction = 'in' and tm.kind = 'reply'
     and tm.classification not in ('out_of_office', 'other')
   group by m.angle, m.position
)
select coalesce(s.angle, '(no angle)') as angle, s.position as step, s.sent,
       coalesce(g.replied, 0) as replied, coalesce(g.positive, 0) as positive,
       round(100.0 * coalesce(g.replied, 0) / s.sent, 1) as reply_pct
  from sent s
  left join got g on g.angle is not distinct from s.angle and g.position = s.position
 order by positive desc, reply_pct desc
```

Replies the engine could not attribute (no `In-Reply-To` match) — say how many, so the angle table
is read with that gap in mind:

```sql
select count(*) filter (where tm.reply_to_message_id is null) as unattributed, count(*) as replies
  from thread_messages tm
  join threads t on t.id = tm.thread_id
 where t.project_id = @project and tm.direction = 'in' and tm.kind = 'reply'
   and tm.sent_at >= ':from' and tm.sent_at < ':to'::date + 1
```

## 8. Cost

```sql
select sp.operation, sp.provider, count(*) as rows, round(sum(sp.cost_usd), 2) as usd
  from spend sp
 where sp.project_id = @project and sp.at >= ':from' and sp.at < ':to'::date + 1
 group by rollup (sp.operation, sp.provider)
 order by sp.operation nulls last, sp.provider nulls last
```

`spend` is the single ledger: every `bh call` writes one row there with its `provider_call_id`, so
never add `provider_calls.cost_usd` on top. The reply classifier's model cost lives in
`model_calls.cost_usd` and is not in `spend`:

```sql
select count(*) as calls, round(sum(mc.cost_usd), 2) as usd
  from model_calls mc
 where mc.project_id = @project and mc.at >= ':from' and mc.at < ':to'::date + 1
```

`bh spend --from :from --to :to` gives the same ledger by provider without SQL.

## 9. Exclusions and removals in the period

```sql
select d.kind, d.value, d.reason, d.note, d.created_at
  from dnc d
 where d.project_id = @project and d.created_at >= ':from' and d.created_at < ':to'::date + 1
 order by d.created_at
```

## 10. Leads still in flight, and stalled

```sql
select e.status, e.pause_reason, count(*) as leads,
       count(*) filter (where se.enrollment_id is not null) as stalled
  from enrollments e
  join strategies s on s.id = e.strategy_id
  left join stalled_enrollments se on se.enrollment_id = e.id
 where s.project_id = @project and e.status in ('scheduled', 'active', 'paused')
 group by e.status, e.pause_reason order by e.status
```

## 11. Earlier reports

```sql
select r.period_start, r.period_end, r.url, r.sent_at, r.figures
  from client_reports r
 where r.project_id = @project
 order by r.period_end desc
```

Until `bh` can write `client_reports`, earlier reports are also in `bh note list --kind insight`
under titles starting "Client report".
