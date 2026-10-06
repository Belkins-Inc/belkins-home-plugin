# TheirStack — companies by the jobs they post

Job postings from company sites, ATS boards and job boards, joined to firmographics. Use it when a
segment is defined by hiring: "100–1,000 employees with several open engineering roles". Base
`https://api.theirstack.com`; the key as `Authorization: Bearer …` (the engine adds it). OpenAPI:
`https://api.theirstack.com/openapi.json`.

## Cost

API credits: **3 per company** and **1 per job** in the answer; a search that matches nothing is free.
At the plan's $100 for 5,000 credits a month that is $0.06 a company, $0.02 a job. There is no free count:
a count returns one row and pays for it. `bh call theirstack GET /v0/billing/credit-balance` is free.

## Company search with a hiring filter

```sh
bh call theirstack POST /v1/companies/search --segment <seg> --source <src> --body-file /tmp/ts/count.json
```

```json
{
  "company_country_code_or": ["US"],
  "min_employee_count": 100,
  "max_employee_count": 1000,
  "industry_id_or": [4],
  "company_type": "direct_employer",
  "job_filters": {
    "posted_at_max_age_days": 60,
    "job_country_code_or": ["US"],
    "job_title_pattern_or": ["software engineer", "backend", "full ?stack", "machine learning", "\\bai\\b"],
    "job_title_pattern_not": ["sales", "account executive", "recruit", "marketing", "\\bintern\\b"]
  },
  "min_num_jobs_found": 2,
  "include_total_results": true,
  "limit": 1
}
```

- **Count first**: `include_total_results: true` with `limit: 1` → `metadata.total_companies` for 3
  credits. Then drop `include_total_results` (it slows every page) and page with `limit` 25 and
  `page` 0, 1, …
- `job_filters` takes the job search's filters and **needs a date filter** (`posted_at_max_age_days`,
  `posted_at_gte` or `posted_at_lte`). `min_num_jobs_found` is the threshold on matching jobs.
- `job_title_pattern_or` is regex, case-insensitive. A bare `ai` matches "Sales Manager (AI
  Native)" and "Technical Recruiter, AI/ML": always pair it with `job_title_pattern_not`.
- Industries are LinkedIn's codes: `GET /v0/catalog/industries` (free). 4 is Software Development;
  96 (IT Services and IT Consulting) is mostly outsourcers.
- Location: `company_country_code_or` (ISO2) and `company_location_pattern_or` (city). There is
  **no state or province filter** — take the country and exclude regions afterwards (the project's
  `country_outside` exclusion).
- `company_type: "direct_employer"` drops recruiting agencies; staffing and outsourcing firms that
  hire for themselves still come through — judge them.

## The answer

`data[]` is a company: `name`, `domain`, `linkedin_url`, `employee_count`, `country_code`, `city`,
`industry`, `long_description`, funding fields, `num_jobs_found` (jobs matching `job_filters`) and
`jobs_found[]` (each with `job_title`, `url`, `date_posted`). The job titles and their links are the
signal: put the count and two or three titles in the company's signal with the posting date.

## Watch for

- The results are sorted by `num_jobs_found`, largest first, so the first page is the heaviest
  hirers; regional skew in it (most of the top in one metro) is not the whole set.
- A repeat of the same body is refused (`repeated_request`); `bh call show <call-id>` reprints it.
