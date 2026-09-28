# Queries for a running strategy (`bh sql`, read-only)

`bh sql` wraps the text as `select * from (<query>) q`: one select, no trailing semicolon, 10 s
timeout, 200 rows unless `--limit`.

## Leads in flight vs target

```sql
select s.name, s.target_active,
       count(e.id) filter (where e.status in ('active','paused','scheduled')) as live,
       count(e.id) filter (where e.status = 'completed') as completed,
       count(e.id) filter (where e.status = 'stopped') as stopped
from strategies s left join enrollments e on e.strategy_id = s.id
where s.id = '<strategy-id>' group by s.id
```

## What is left to enroll

```sql
select * from strategy_segment_usage where strategy_id = '<strategy-id>'
```

```sql
select sc.status, count(*) from strategy_contacts sc
where sc.strategy_id = '<strategy-id>' group by sc.status
```

Candidates ready to enroll (fit, not yet enrolled):

```sql
select sc.contact_id, sc.persona_id, c.first_name, c.last_name, c.title, co.name as company
from strategy_contacts sc join contacts c on c.id = sc.contact_id
left join companies co on co.id = c.company_id
where sc.strategy_id = '<strategy-id>' and sc.status = 'candidate'
```

## Stuck leads

```sql
select se.* from stalled_enrollments se where se.strategy_id = '<strategy-id>'
```

`stuck_code = 'no_copy'` (step `stuck_step` has no copy) → write it now (copywriting skill).

## Health (read over at least ~100 sends before judging)

```sql
select
  count(*) filter (where m.sent_at is not null)                             as sent,
  count(*) filter (where m.bounce_kind = 'hard')                            as hard_bounces,
  round(100.0 * count(*) filter (where m.bounce_kind = 'hard')
        / nullif(count(*) filter (where m.sent_at is not null), 0), 1)      as hard_bounce_pct,
  (select count(*) from enrollments e2 where e2.strategy_id = '<strategy-id>'
     and e2.stop_reason in ('unsubscribed','dnc'))                          as unsubscribed,
  (select count(distinct t.enrollment_id) from threads t
     join thread_messages tm on tm.thread_id = t.id
     join enrollments e3 on e3.id = t.enrollment_id
    where e3.strategy_id = '<strategy-id>' and tm.direction = 'in' and tm.kind = 'reply') as replied
from messages m join enrollments e on e.id = m.enrollment_id
where e.strategy_id = '<strategy-id>'
```

Thresholds: hard bounces ≥ 3% of sent; unsubscribes and complaints ≥ 2% of leads reached; zero
replies after 200 sent. Crossing one is a signal for a person, with the figures.

## What works, by angle and step

```sql
select m.position, m.angle, count(*) filter (where m.sent_at is not null) as sent,
       count(distinct tm.thread_id) as replies
from messages m join enrollments e on e.id = m.enrollment_id
left join thread_messages tm on tm.reply_to_message_id = m.id and tm.direction = 'in' and tm.kind = 'reply'
where e.strategy_id = '<strategy-id>'
group by m.position, m.angle order by m.position, replies desc
```

## Replies by channel

What the channel choice is made from: per channel, the leads reached, the invites accepted and the
leads who replied, across every strategy in the project. Compare replies per lead reached; for
LinkedIn also replies per accepted invite.

```sql
with sent as (
  select e.id as enrollment_id, case when m.channel = 'email' then 'email' else 'linkedin' end as channel,
         bool_or(m.channel = 'linkedin_invite' and m.accepted_at is not null) as accepted
  from messages m join enrollments e on e.id = m.enrollment_id
  join strategies s on s.id = e.strategy_id
  where s.project_id = @project and m.sent_at is not null
  group by 1, 2
), replied as (
  select distinct t.enrollment_id, t.channel from threads t
  join thread_messages tm on tm.thread_id = t.id and tm.direction = 'in' and tm.kind = 'reply'
)
select s.channel, count(*) as reached, count(*) filter (where s.accepted) as accepted,
       count(r.enrollment_id) as replied
from sent s left join replied r on r.enrollment_id = s.enrollment_id and r.channel = s.channel
group by s.channel
```

Too few leads reached for a rate (a few dozen) → the client's previous outreach decides, and the
note says so.
