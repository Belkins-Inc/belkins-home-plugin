---
name: persona-design
description: Defines who to write to inside a target company — the project's persona library (name, job titles, description) and each strategy's persona ladder with its per-company caps. Use when a project has no personas, when a segment or strategy needs people the library does not cover, when contact searches return the wrong roles, or when setting which personas a strategy reaches and how many per company.
---

# Persona design

A **persona is a named set of job titles** that contacts are searched and judged by. Personas live
in a project-level library (`bh personas`); strategies pick from it, in priority order. Titles never
live in segments — a segment is which companies, a persona is which people.

## Read first

- `bh brief` — the brief's "Target people" (who decides, champions, blocks; titles), rules, decisions.
- `bh personas` — the library, with each persona's titles and description. Reuse before you add.
- `bh hypothesis list` — ideas about who buys and where each stands; a persona may exist to test one.
- Which roles actually replied and met, when there is history:

  ```
  bh sql "select p.name, count(distinct e.id) as enrolled,
      count(distinct e.id) filter (where e.stop_reason = 'replied') as replied,
      count(distinct m.id) as meetings
    from enrollments e join personas p on p.id = e.persona_id
    join strategies s on s.id = e.strategy_id
    left join meetings m on m.contact_id = e.contact_id
    where s.project_id = @project
    group by p.name"
  ```

## Procedure

1. **Decide the people from the brief**, not from habit: who owns the problem the client removes,
   who signs, who would champion it. One persona per distinct group of people — a CFO and a
   Controller who read the same letter are one persona; a CFO and a Head of Support are two.
2. **Check the library.** If an existing persona addresses these people, use it (extend its titles
   if needed). A set that is close but not identical is the existing persona extended, not a second
   row: duplicates split every report and make "which persona worked" unanswerable.
3. **Write the title list** — see "Title lists" below and
   [references/title-lists.md](references/title-lists.md).
4. **Write the description** — two to four sentences, plain prose, that let someone judging a job
   title tell whether it belongs: seniority, function, what these people are accountable for, and
   how titles vary by company size or region. It qualifies titles and nothing else: no pains, no
   offer, no "how to convince them" — that is the strategy's angle per persona.
5. **Count it before saving.** A persona nobody has counted is a guess. Generect's lead count is
   free — send the whole title list in one call, with the segment's country:

   ```
   bh call generect POST /search/database/leads/count/ --segment <seg> --body '{
     "job_titles": ["Head of Support", "VP Customer Support", "…"],
     "company_locations": ["United States"]}'
   ```

   Count it twice when the segment has industries: once on the country alone, once with
   `company_industries` added (children listed — industries are not expanded on leads, see
   [generect](../providers/references/generect.md)). The first number says whether the people
   exist; the gap between the two, whether the titles are self-qualifying (below). A title that counts almost
   nothing is invented — replace it with the spelling people use. Write the counts and the date
   into `--hints`, which `bh personas` returns ("US 1,697 on title alone, 2026-09-24"), and into
   the decision note (step 8).
6. **Save it:**

   ```
   bh persona upsert --name "Support leader" \
     --titles "Head of Support|VP Customer Support|Director of Customer Experience|…" \
     --excluded-titles "Assistant|Intern|Coordinator|Specialist" \
     --seniorities "C-level|VP|Head|Director" --departments "Customer Support" \
     --hints "LinkedIn; team pages rarely list them" \
     --body "<description>"
   ```

   `upsert` matches by name; a field left out keeps its value, so extending the titles is one flag.
   A flag passed replaces that whole list — pass the full list, not the additions. Lists split on
   `|` (a title may contain a comma); with no `|` in the value they split on commas.
7. **Build the ladder in the strategy.** In the strategy file (`bh strategy create|update --file`),
   `personas` is the ladder in priority order — position 1 is tried first; the next is tried when a
   company has no one for the rung above:

   ```json
   {"maxPerCompany": 2,
    "personas": [
      {"personaId": "<id>", "maxPerCompany": 1, "angle": "what we say to this role"},
      {"personaId": "<id>", "angle": "…"}]}
   ```

   `maxPerCompany` on the strategy caps all enrolled contacts per company (default 2);
   `maxPerCompany` on a rung caps that persona (defaults to the strategy's). Keep the ladder to
   about four rungs. The angle per persona is where role-specific pain and argument go (the
   `strategy-and-plans` skill).
8. **A buyer that is not the main line is a hypothesis.** When the brief names one buyer and the
   evidence suggests another (operations leadership at carriers where the brief says procurement),
   the second persona is a test, not a new default:

   ```
   bh hypothesis add --persona <id> --claim "At <companies> <these people> buy, not <the main persona>" \
     --evidence "<replies, the client's words, counts>" \
     --metric "Reply rate of <persona> vs <the main persona>" --threshold "Higher after 200 sends each"
   ```

   The persona goes on a strategy's ladder only once a person has moved the hypothesis to
   `testing`; link the strategy that tests it (`bh hypothesis update <id> --strategy <id>`, a
   person while it runs).
9. **Record why.** `bh note add --kind decision --title "Personas for <strategy or segment>: <names>"
   --body "<why these, why this order, caps, the counts>"`, with `--strategy <id>` or `--segment <id>`
   when there is one (before a strategy exists, tie it to the segment).

## Title lists

- **Cover seniority deliberately.** Name the levels that own the problem: C-level / VP / Head /
  Director, and Manager or Lead only where the company size means they own it. In a 30-person
  company the owner may be "Support Lead"; in 5,000 it is a VP and a Manager there is too junior.
- **Spell the variants people actually use**: "Head of X", "X Director", "Director of X", "VP X", "VP
  of X", "X Lead", abbreviations ("CX", "CS", "RevOps"), synonyms of the function ("Customer
  Support", "Customer Service", "Customer Care", "Customer Experience"), and regional forms
  ("Managing Director" for a UK CEO, "Geschäftsführer" in DACH).
- **Say what does not belong**, in `--excluded-titles` and the description: Assistant, Intern, Coordinator, Specialist,
  Agent, Associate, "Executive Assistant to…", recruiters for the function, and look-alikes ("Sales
  Operations" is not "Sales", "Product Marketing" is not "Product").
- **One function per persona.** A list spanning Support and Finance is two personas.
- 8–25 titles is typical. Fewer misses people; more usually means two personas in one.
- Founders/CEOs are their own persona, used where companies are small enough that the founder owns
  the problem — usually as a lower rung, capped at 1.

## Self-qualifying titles

A title either names the market or it does not. "Data Center Operations Manager" exists only where
there is a data centre; "Director of Procurement" exists anywhere. The counts from step 5 tell them
apart:

- **Self-qualifying** — the count on title alone is small and nearly all of it is the market.
  Search these straight off the segment (no company named): the title does the company research.
  This is also how to reach a market with no industry to filter by.
- **Not self-qualifying** — the count on title alone is the whole economy. Reach these only
  company first, inside companies already qualified. A persona of such titles searched without a
  company filter is a list of strangers.

Measured for a data-centre client, US: Data Center Operations family 1,697; Data Center
Engineering and Critical Operations 596; Critical Facilities and Critical Environments 482.
Against them: Chief Engineer 36,129; Facilities Director and Plant Operations 29,218; the
Procurement family 27,102; Energy Manager and Director of Energy 20,014; COO, VP Operations and VP
Infrastructure 300,256. Say in the persona's `--hints` which kind it is, so the next session knows
how to search it.

## Judging people found

When a contact search returns people, judge each title against the persona's description, not by
keyword. People who do not fit a strategy: `bh stand <strategy-id> --contact <id> --status rejected
--reason "<title> — not <persona>"` so no session looks at them again; a fitting person held back
(e.g. a catch-all address) is `--status held`.

**Judge the role's territory, not only the company's country.** The country exclusion checks the
company; a person at an in-scope company can still cover somewhere the ICP does not. A title that
names a region outside it — Europe, EMEA, APAC, LATAM, Canada, Mexico, International — is
rejected for this strategy, with the title as the reason:
`--reason "Director of European Procurement — covers Europe, ICP is US"`. Seen at American
companies: Director of European Procurement, Procurement Director Europe, Transport Procurement
Manager Mexico, International Logistics Director — each passed every filter.

## Rights

A scheduled agent may edit personas; changing a live strategy's ladder should wait for a person's
session — note it or open a task.

## Common mistakes

- Pains, offers or tone in the description (they go in the strategy's angle).
- A new persona that duplicates one in the library with slightly different titles.
- Passing only the new titles to `--titles` — the list is replaced, and the old titles are gone.
- A title list of only one seniority, or only the most common spelling.
- Saving a persona with no count — or with titles written from job knowledge that count almost
  nothing.
- Searching a persona of titles that are not self-qualifying off the segment, with no company named.
- Passing a person whose title covers a region outside the ICP because the company is in scope.
- No cap on a CEO rung, so a small company gets the founder plus two managers.
- A second buyer written to as if it were settled, with no hypothesis saying how it will be judged.
