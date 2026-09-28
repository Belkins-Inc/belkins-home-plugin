# `bh sql` recipes for orientation

`bh sql` is not scoped to the project. Every recipe filters with `@project`, which `bh sql` replaces
with the current project's id (quoted); run them as `bh sql "<query>"` — double quotes for the shell,
single quotes for SQL strings inside. One `select` per
call, read-only, 10 s timeout, 200 rows by default (`--limit` up to 1000; `truncated: true` means
there were more). Money columns are `*_usd`.

## Inbox — `inbox_queue`

Replies waiting for triage, oldest first, with who and what they answered:

```sql
select thread_message_id, thread_id, waiting, first_name, last_name, title, company, domain,
       strategy_id, replied_to_angle, left(body_text, 300) as body
from inbox_queue where project_id = @project order by sent_at
```

`bh inbox` shows the same queue with the engine's classification; use it to work the queue.

## Leads not moving — `stalled_enrollments`

```sql
select se.*, c.email, c.first_name, co.domain
from stalled_enrollments se
join strategies s on s.id = se.strategy_id
join contacts c on c.id = se.contact_id
left join companies co on co.id = c.company_id
where s.project_id = @project order by se.stuck_since nulls last
```

`stuck_code` (set by the engine: `no_copy` with `stuck_step`, `linkedin_not_configured`,
`mailbox_disconnected`, `linkedin_disconnected`, `other`) says why; `stuck_reason` keeps the details. A `paused` row with
`paused_until` in the past or null is a pause nobody resumed (e.g. `company_meeting` waiting for a
meeting outcome).

## Goal — `goal_progress`

```sql
select month, meetings_target, counts, achieved, scheduled
from goal_progress where project_id = @project order by month desc limit 3
```

`counts = 'qualified'` counts only held meetings with outcome qualified / opportunity / won.

## Strategies × segments — `strategy_segment_usage`

What each strategy has taken out of each segment and what it produced:

```sql
select st.name as strategy, sg.name as segment, u.status, u.qualified_companies, u.companies_worked,
       u.companies_left, u.enrolled, u.replied, u.positive, u.meetings, u.good_meetings, u.spend_usd
from strategy_segment_usage u
join strategies st on st.id = u.strategy_id
join segments sg on sg.id = u.segment_id
where st.project_id = @project
```

`companies_left` near zero → the segment needs more sourcing (or a new segment) before the strategy
runs dry; the engine will only open a task when it does.

## Segments — `segment_usage`

```sql
select name, status, estimated_companies, companies_found, qualified, disqualified, not_yet_judged,
       waiting_on_client, qualified_pct, active_sources, searches, last_search_at
from segment_usage where project_id = @project
```

`not_yet_judged` > 0 → companies found and not decided; `waiting_on_client` of them are held on an
open client question, the rest wait on a fact (the engine opens a judging task for them after two
days). `qualified_pct` is qualified against the
estimated market.

## Sources — `source_usage`

```sql
select sg.name as segment, u.kind, u.name, u.status, u.estimated_companies, u.companies_found,
       u.qualified, u.disqualified, u.searches, u.search_cost_usd, u.last_search_at
from source_usage u join segments sg on sg.id = u.segment_id
where sg.project_id = @project order by sg.name, u.name
```

Cost per qualified company = `search_cost_usd / nullif(qualified, 0)`: the number that says which
source to keep paying for. `bh sources` shows the same with each source's query and cursor.

## Recent activity

```sql
select at, type, actor_via, summary, data
from events where project_id = @project order by at desc limit 50
```

Hand-overs only: add `and type = 'agent.session'`.

## Spend

```sql
select provider, count(*) as calls, sum(cost_usd) as usd
from provider_calls where project_id = @project and at > now() - interval '30 days'
group by provider order by usd desc nulls last
```

`bh spend` gives this month's totals by provider.

## Earlier searches (before any paid call)

```sql
select s.ran_at, s.provider, s.query, s.cursor, s.results, s.new_records, s.cost_usd, so.name as source
from searches s left join segment_sources so on so.id = s.source_id
where s.project_id = @project order by s.ran_at desc limit 50
```

Same request already paid for:

```sql
select at, provider, endpoint, params, results, cost_usd
from provider_calls where project_id = @project and endpoint like '%<fragment>%' order by at desc
```
