# Context the copy queue does not carry

`bh copy queue` carries each lead's `kind`, `followsEnrollmentId`, `signal`, `timezone`,
`referredBy` and `strategyBrief`. What it does not carry — the earlier conversation, and which
strategies have re-engagements due — comes from `bh sql` (one select, no trailing semicolon).

## The earlier conversation (referral and re-engagement)

```sql
select t.id as thread_id, t.channel, t.subject, t.last_message_at
from threads t where t.enrollment_id = '<followsEnrollmentId>'
```

Then `bh thread <thread_id>` for the whole conversation. For a referral, the referrer's reply is in
their thread (the referrer's enrollment is `followsEnrollmentId`).

## Re-engagements due for copy in the next days (server agent's work)

```sql
select e.id as enrollment_id, e.strategy_id, e.starts_at, c.first_name, c.last_name, co.name as company
from enrollments e
join strategies s on s.id = e.strategy_id
join contacts c on c.id = e.contact_id
left join companies co on co.id = c.company_id
where s.project_id = @project and e.kind = 're_engagement' and e.status = 'scheduled'
  and e.starts_at < now() + interval '3 days'
  and exists (select 1 from messages m where m.enrollment_id = e.id and m.status = 'needs_copy')
```

Then `bh copy queue <strategy-id>` finds their message ids.

## A lead's whole plan as written so far

```sql
select m.id, m.position, m.channel, m.condition, m.status, m.subject, m.body, m.angle
from messages m where m.enrollment_id = '<enrollment-id>' order by m.position
```
