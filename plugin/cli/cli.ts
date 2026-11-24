#!/usr/bin/env node
// bh — the team's CLI for the engine's API (docs/decisions/tools.md). JSON out; errors verbatim.

import { readFile, writeFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { parseArgs } from 'node:util'

import { attachmentPath, saveNew } from './attachment.ts'
import { copyCheckParts, merge, refusedIn, sendRows, warnedIn } from './batch.ts'
import { consoleLogin, meetbotLogin } from './console-login.ts'
import { linkedinOpen } from './linkedin-chrome.ts'
import { BhError, call, callFile, callText } from './client.ts'
import { readDncCsv } from './csv.ts'
import {
  CONFIG_PATH,
  SESSION,
  type BhConfig,
  loadConfig,
  loadSavedConfig,
  loadSessionProject,
  saveConfig,
  saveSessionProject,
  type SessionPick,
} from './config.ts'
import {
  providerPath,
  readBlocks,
  readInput,
  readRows,
  readSecrets,
  readText,
  withImages,
} from './input.ts'
import { DEFAULT_API, startLogin, waitForLogin } from './login.ts'
import { OPTIONS } from './options.ts'
import { setup } from './setup.ts'
import { hasProjectToken, withProjectId } from './sql.ts'

/** Entries per page `bh dnc list` reads; the engine answers up to 5,000. */
const DNC_PAGE = 2000
/** Rows per dnc import or check request; the engine takes up to 10,000. */
const DNC_CHUNK = 5000

/** Companies and contacts per label request; the engine takes up to 1,000 of each. */
const LABEL_CHUNK = 1000

/** Messages per copy check request (the engine's cap), within its 8 MB body. */
const COPY_CHECK_MAX = 2000
const COPY_CHECK_BYTES = 6 * 1024 * 1024
/** The most messages one copy write takes: all of them or none, so bh does not split it. */
const COPY_WRITE_MAX = 500

type LabelAnswer = {
  label: { id: string; name: string }
  companies: number
  contacts: number
  unknown: { companies: string[]; contacts: string[] }
}

/** What `bh label add|remove` names: --company and --contact lists, and the rows of --file. */
async function labelTargets(o: { company?: string; contact?: string; file?: string }) {
  const list = (v: string | undefined) =>
    (v ?? '')
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean)
  const companies = list(o.company)
  const contacts = list(o.contact)
  for (const row of o.file ? await readRows(o.file) : []) {
    const r = row as { company?: unknown; contact?: unknown }
    if (typeof r.company === 'string') companies.push(r.company)
    else if (typeof r.contact === 'string') contacts.push(r.contact)
    else
      throw new BhError(
        `A row names neither a company nor a contact: ${JSON.stringify(row)}`,
        { hint: '[{"company":"acme.com"},{"contact":"ann@acme.com"}]' },
        2,
      )
  }
  if (!companies.length && !contacts.length)
    throw new BhError(
      'Name a company or a contact',
      { hint: 'bh label add Partner --company acme.com --contact ann@acme.com, or --file' },
      2,
    )
  return { companies, contacts }
}

/** The parts' answers as one. */
const mergeLabelAnswers = (answers: LabelAnswer[]): LabelAnswer => ({
  label: answers[0]!.label,
  companies: answers.reduce((n, a) => n + a.companies, 0),
  contacts: answers.reduce((n, a) => n + a.contacts, 0),
  unknown: {
    companies: answers.flatMap((a) => a.unknown.companies),
    contacts: answers.flatMap((a) => a.unknown.contacts),
  },
})

const USAGE = `bh <command> [options] — JSON out, errors verbatim.

Every command takes --api <url> (or BH_API) and --token <token|-> (or BH_TOKEN) over the saved
login, and --project <slug>. A secret flag given - is read from stdin, or asked with the typing
hidden at a terminal, so it stays out of the shell's history.

  setup [--dir <path>]                  once, after the plugin is installed: the working directory
                                         (~/work/belkins-home) and bh on your terminal's PATH
  login [--api <url>] [--no-browser]    connect: prints a link to approve in the browser (production by default);
                                         in a terminal it waits, elsewhere run bh login --wait after approving
  login --wait                           collect the token once the link is approved
  login [--api <url>] --token -         save a token made by hand, once the engine takes it: pasted at the
                                         prompt, or piped (op read '…' | bh login --token -)
  use [<project>]                       the project this Claude Code session acts on; with no slug, which one
                                         and why. Each session keeps its own and none is ever defaulted;
                                         outside a session, --project or BH_PROJECT; either beats bh use.
                                         Subagents share their session's pick: once it picked two projects,
                                         every command must name its own (--project or BH_PROJECT)
  whoami | health
  projects [--org <slug>] [--all] | project create <slug> --name <name> [--timezone <tz>] [--org <slug>] [--owner <user-id>]
  project members | project member <user-id> [--role owner|member] | project member remove <user-id>
  project move <slug> --org <org>        move a project and all it owns to another organisation (platform admin)
  project copy <from> <to> [--name <name>] [--dry-run]
                                         a new project of the same organisation with <from>'s setup: brief, personas,
                                         segments, companies and contacts with what providers found (emails checked,
                                         phones looked up: nothing is bought again), labels, do-not-contact, notes,
                                         hypotheses, strategies (as drafts) with plans and copy; never leads, senders,
                                         mailboxes, threads, meetings or tasks (bh behaviour projects). An admin of it
  project setup [--project <slug>]       the set-up checklist the web app's Setup shows: each step, done or not,
                                         and what is left before the first launch (also: bh setup status)
  project setup skip <step> [--undo]     go without an optional step (rules, linkedin, agent), or take it back up
                                         and answers the checklist (also: bh setup skip <step>; a person only)
  project archive [<slug>] [--undo]     off every list: its agent off, its open tasks cancelled; refused while a
                                         strategy is live; --undo makes it active again (its owner or an org admin)
  project remove <slug> [--dry-run]      delete a project that never worked for anyone, with its senders, mailboxes,
                                         placement tests, tasks and events, and the domains only it used (platform admin)
  orgs | org create <slug> --name <name> [--billing external|metered]   organisations you belong to (the platform admin: all); metered: a Dylan organisation of our own, for testing
  org billing <slug> external|stripe   external: billed outside the platform (the agencies); stripe is retired (platform admin)
  org rename <slug> [--slug <new>] [--name <new>]   a new slug or name (platform admin)
  org delete <slug> [--to <org>] [--dry-run]   delete an organisation its projects left, for good; its issues and
                                         erasures move to --to; --dry-run only counts (platform admin)
  org protections [<slug>]             whether the engine pauses its unhealthy strategies, its daily lead cap, today's count;
                                         with no slug, the organisation of the current project
  org autopause <slug> on|off          on: a strategy past a health limit is paused by the engine, not only flagged (platform admin)
  org lead-cap <slug> <n>|off          new leads its projects may enroll a day, UTC (platform admin)
  org approve <slug>                    let an organisation that signed itself up send and buy (platform admin)
  org erase <slug> [--email <e>] [--linkedin <url>] [--note <t>]   forget a person who asked, in every project of the
                                         organisation; only hashes stay, so it never writes to them again (its admin; final)
  org erasures <slug> [--limit <n>]     when people were erased and by whom, never who
  org leave <slug> [--reason <t>]      close a signed-up organisation's account: strategies paused, agents' keys revoked,
                                         tenants and domains let go, its personal data erased 30 days later (its admin; final)
  org leaving <slug>                   when it left, what is still waited on, when its data is erased
  org tier <slug> [--price <price_…>]   its platform tier and this month's leads; with --price, a Checkout link to subscribe
  org tier <slug> --grant <leads> --note <text>   a tier of that many new leads a month with no payment, until it
                                         subscribes (platform admin; a partner's before payments open)
  wallet [--org <slug>] [--limit <n>]   a signed-up organisation's balance and ledger, newest first
  wallet top-up <dollars> [--org <slug>]   a Checkout link that adds to the wallet once paid (its admin)
  wallet credit <dollars> --org <slug> --note <text>   money into the wallet with no payment, the note shown to the
                                         organisation in its history (platform admin; a partner's credit)
  company-details [--org <slug>]        the company behind a signed-up organisation, as Google and Pax8 (Microsoft) are told
                                         when they make its tenants; what each still needs, which are made with them (fixed)
  company-details set --legal-name <n> --website <acme.com> --phone <p> --address <street[; line 2]> --city <c>
       [--region <r>] --postal-code <p> --country <US> --first <n> --last <n> --email <e> [--contact-phone <p>] [--org <slug>]
                                         given once for both providers, until a provider's tenant is made with them; the
                                         contact receives the providers' notices: not on a domain being bought (its admin)
  google-org [--org <slug>]             its own Google Workspace organisation, where bought Google mailboxes live:
                                         made on the first Google domain bought; state, what it waits for, the terms link
  google-org details --company <legal name> --address <street[; line 2]> --city <c> [--region <r>]
       --postal-code <p> --country <US> --first <n> --last <n> --email <e> [--phone <p>] [--org <slug>]
                                         what Google is told about the company, its customer of record (its admin)
  microsoft-seeds                       Microsoft 365 tenants the engine makes through Pax8 (warm-up seeds, and the
                                         clients' sending tenants), how far each is and what holds it, the seed ceiling
                                         and the sending headroom (platform admin)
  microsoft-seeds make [<domain>] [--seeds <n>]   orders "Belkins Group NN" through Pax8 (Exchange Online
                                         (Plan 1), 12 seats unless said, a 1-year commitment) on an aged domain (none
                                         given: one held for these tenants; closeouts are paused), signs in as
                                         its first admin, sets the app up, connects the domain and hands it to
                                         warm-up on an egress with room (platform admin)
  microsoft-seeds make --for sending    orders "Belkins Mail NN" through Pax8 (Exchange Online (Plan 1), one seat, a
                                         1-year commitment), signs in as its first admin, sets the app up and puts it
                                         in the default pool as belkinsmailNN; its seats are bought there as mailboxes
                                         are ordered (platform admin)
  microsoft-seeds grow [--free-domains <n>]   the room the clients' Microsoft tenants have for more domains, and the
                                         free domains the engine keeps: below it the engine orders the next sending
                                         tenant itself, in your name; 0 stops it (platform admin)
  microsoft-seeds mailbox                makes PAX8_MAILBOX (where Pax8 writes new tenants' admin logins) if it is
                                         missing, and lists its last week's subjects, bodies never — but Gmail's
                                         forwarding confirmation's link and code (platform admin)
  microsoft-seeds update <ref> --retry   the console service signs in now, not after a refused sign-in's wait;
                                         <ref> is the number, the name (belkinsmailNN), the domain or the id (platform admin)
  google-org record <org> --customer-id <C0…>   Google's customer, made in Partner Sales Console: the engine gives
                                         the customer the terms link and carries on (platform admin)
  partner <org>                         a partner (Folderly): its Google service account, scopes, ceiling and the
                                         organisations it ordered; its Microsoft app, permissions, ceiling, Customer
                                         Agreement and tenants; its placement ceiling — through the partner API (platform admin)
  partner set <org> [--google-key -] [--google-scopes <url,…>] [--max-orgs <n>] [--max-orgs-day <n>|none]
       [--max-licences <n>]              makes the organisation a partner, or changes it: --google-key - reads its
                                         service account's JSON key from stdin; --max-orgs is how many organisations
                                         it may order in 30 days, --max-orgs-day in any 24 hours (none: no daily
                                         ceiling) (platform admin; docs/decisions/partner-tenants.md)
  partner set <org> [--microsoft-app <id>] [--microsoft-permissions <a,b>] [--max-tenants <n>]
       [--max-tenants-day <n>|none] [--max-seats <n>]   its Microsoft side: the multi-tenant app granted
                                         admin consent in each tenant, the Graph application permissions granted
                                         (Folderly Network's six unless said), how many tenants it may order in 30
                                         days and in any 24 hours, the seats one may hold (platform admin)
  partner placement <org> [--days <n>]  its placement tests day by day: tests, notes wanted and given, turned
                                         away for room or for its ceiling, where they landed (platform admin)
  partner set <org> --placement-notes <n>   its placement tests on our seeds: how many notes it may
                                         reserve in a UTC day (0 stops them) (platform admin;
                                         docs/decisions/partner-placement.md)
  partner agreement <org> --first-name <f> --last-name <l> --email <e> --note "<how it was given>"
                                         records, once, who of the partner accepted the Microsoft Customer
                                         Agreement, on their word: every Microsoft tenant it orders names them
                                         as the signatory (never a Belkins person) (platform admin)
  partner key <org> --email <e> [--name <n>]   a partner API key for one of its people (bh org add first),
                                         shown once (platform admin)
  google-orgs                           Google organisations of ours the engine makes as reseller, and how far each is
  google-orgs make --for seeds|sending|network [<domain>] [--company <name>] [--seeds <n>] [--licences <n>]
       [--key-from <tenant>] [--ip <address>]   buys the domain (none given: a picked new name; aged
                                         closeouts are paused since 2026-11-15) and Business
                                         Starter, signs in as its admin, grants delegation and DKIM, then makes it a
                                         seed organisation, a clients tenant in the default pool (sending) or a pod's
                                         tenant for the network, out of the pool and capped at 250 users (platform admin)
  google-orgs update <domain> [--ip <address>|none] [--retry]   the IP its admin signs in through; --retry: the
                                         console service tries now, not after a refused sign-in's wait (platform admin)
  google-orgs move <domain>             moves a ready seed organisation's seeds onto a new domain: buys one, has the
                                         console grant our delegation again, adds and verifies it, gives it DKIM, then
                                         renames each seed onto it (its mailbox and its circles stay); for one whose
                                         seeds' answers Gmail files as spam for its domain (platform admin)
  google-orgs grow [--free-users <n>]    the room the clients' Google tenants have, and the free users the engine keeps
                                         there by ordering sending organisations itself, one at a time, in your name;
                                         0 stops it. Domains whose mailboxes wait in a full tenant move to one with room
                                         by themselves (platform admin)
  org dialer <slug> <dialer-org-id>|new|none   link the organisation to its Belkins Dialer organization; new makes
                                         one of its own (an organisation made now gets one by itself) (platform admin)
  dialer | dialer snapshot <dialer-org-id>   the dialer's link, journals and inbox; a new journal mark after an expiry (platform admin)
  dialer users <dialer-org-id>          its people, their roles and workspaces: who can work a queue (platform admin)
  dialer queue <name> [--hours 08:00-18:00] --project <p>   makes the project's queue in its workspace and attaches its lists (platform admin)
  dialer key <dialer-org-id>            what our key opens there: scopes, writes, workspaces, expiry (platform admin)
  dialer read <dialer-org-id> <path[?query]>   reads what the dialer holds there, e.g. workspaces/<id>/numbers, coverage (platform admin)
  dialer invite <email,…> [--role operator|manager|admin] --project <p>   invites people to the project's dialer workspace
                                         (its organisation's admin); someone already in or invited is added to it;
                                         an admin joins the whole dialer organization (platform admin)
  dialer resend <email> --project <p>   sends the letter of their invitation to the project's workspace again
  dialer role <email> operator|manager|admin --project <p>   the role of someone already in the project's dialer
                                         organization; an admin sees every workspace there (platform admin, a person)
  dialer people --project <p>           who is in the project's dialer workspace, and who works its queue (its organisation's admin)
  dialer numbers buy <1-10> [--country US|CA|DE|…] [--type local|mobile] [--region NY] [--area-code 212] [--city <c>] --project <p>   caller numbers for the project's workspace, a month of rent each from the dialer budget; outside the US and Canada only under a bundle the dialer's operator mapped (platform admin, a person)
  dialer agents <email,…> --project <p>  who works the project's queue; replaces the set (its organisation's admin)
  dialer orgs                           the dialer organizations our key can see, and the organisation linked to each (platform admin)
  dialer workspaces <dialer-org-id>     its workspaces and their queues, and the project linked to each (platform admin)
  dialer link <workspace-id> [--queue <queue-id>] | dialer link none   link the project to a dialer workspace: its new
                                         call lists go there and are attached to the queue (platform admin)
  billing [--project <slug>]           the project's Stripe subscription, as Stripe last said it
  billing link <cus_…>                 link the project to its Stripe customer (a stripe organisation's project only)
  client-access | client-access add <email> | client-access remove <user-id>   who watches the project in the
                                         client app (a Stripe-billed organisation's projects only; a person only);
                                         clientApp.url is where the client signs in with a code mailed to them, and
                                         clientApp.signInMail says when that code would not be sent. Free for the
                                         client until Stripe is connected; then add needs an active subscription
  org members <org> | org add <org> --email <e> [--name <n>] [--role admin|member] [--no-invite] | org role <org> <user-id> --role admin|member | org remove <org> <user-id>
                                         someone new to it is mailed where and how to sign in (invited.sent; reason
                                         when it could not go: tell them by hand); --no-invite mails nothing
  org invite <org> <user-id>             mail a member again where and how to sign in (its admin; a person only)
  project update [--name <n>] [--timezone <tz>] [--domain-cap <n>] [--brief <text> | --brief-file <path>]   (a person only)
       [--reply-bcc a@x.com,b@y.com]     every answer in its email threads copies them without the lead seeing
                                         them ("" for nobody)
       [--reply-cc a@x.com]              every answer in its email threads copies them in the open, besides the
                                         lead's reply-all ("" for nobody); steps of a plan copy nobody
       [--lead-cost-alert <usd>|off]     a task opens while the last 30 days cost more than this per verified
                                         enrolled lead (new projects: 0.05)
       [--max-live-per-company <n>|off]  people of one company live at once across all its strategies (default 3);
                                         enroll skips the next one; a strategy whose own cap at the company is
                                         larger fills its own; off: each strategy's own caps alone
       [--copy-allow <term>,<term>]      products and brands its copy quotes as written ("seamless tubing"): bh
                                         copy check's hype, phrase and spelling rules leave them alone ("" for none)
       [--seed-hold on|off]              on (default): outreach from its own mailboxes to Google or Microsoft stops
                                         by itself while their domain's seed notes there go to spam; off: it goes
                                         on, the ladder only stops climbing, and holding is yours (bh placement)
       [--pairing-wait <days>|off]       send days a lead waits for its better mailboxes (an aged domain, the
                                         pairing table's first host) before the next ones take it: they fill to
                                         that many days and only the overflow goes on; gateway leads go to a
                                         younger Google domain, never to Microsoft. off (default): the engine's
                                         rule, the next ones only when they start it 3 send days sooner
  brief [--project <slug>]              read this first, every session
  behaviour [<topic>] | behaviour --search <words>   how the engine behaves ("When …, the engine …"):
                                         the topics, one topic's entries, or the entries with every word;
                                         read it before answering "what happens when …"
  sql "<select …>" [--limit <n>]        read anything, read-only; @project stands for the current project's id
                                         where it stands on its own (inside quotes, as in 'a@projects.io', it is text)
  schema [<table>]                      the tables and views bh sql reads: columns, checks, references
  note add --kind <decision|insight|client_feedback|rule|todo> --title <t> [--body <b> | --body-file <path|->] [--supersedes <id,id>]
       [--strategy <id>] [--segment <id>]
  note list [--kind <k>] [--all]
  history                               what the project holds from another platform (legacy BH): imported
                                         threads and their messages, calls and transcripts, leads continuing a thread
  history continue [--strategy <id,id>] [--enrollment <id,id>] [--dry-run]
                                         a live lead not yet emailed here whose contact has an imported email thread
                                         on the lead's mailbox sends its first email into that thread, answering it
                                         under its subject (a person); without --strategy or --enrollment, every such lead
  issue report --title <t> --body <b> | --body-file <path|->  [--kind bug|question|wish]
                                         a defect, a question or a wish about the platform, to the people who
                                         fix it; the session's project goes with it when there is one. Name
                                         leads, mailboxes and strategies by id rather than pasting their text
  issues [--status open|closed|all|in_progress|done|wont_fix|duplicate] [--kind <k>] [--mine] [--org <slug>] [--limit <n>]
                                         the reports you see: yours and your organisation's (open by default)
  issue show <number>                    a report, its status and its conversation
  issue comment <number> --body <b> | --body-file <path|->   add what you found to a report
  issue close <number> [--status done|wont_fix|duplicate] [--fixed-in <pr or commit>] [--duplicate-of <n>] [--note <t>]
                                         settle a report; the note is what its reporter reads (platform admin)
  issue reopen <number> [--note <t>]     (platform admin)
  task open --title <t> --assignee <email> [--priority urgent] [--due <iso>] [--done-when <text>] [--body <b> | --body-file <path|->]
  task list [--status open|done|cancelled]
  task show <id>                        one task whole: every item a task the engine keeps per project lists
  task close <id> [--status done|cancelled] [--note <text>] | task reopen <id>
  task assign <id> --assignee <email> [--note <text>]   hand an open task to someone else; Slack tells them afresh
  session end --summary <text>           the hand-over: done, left, to watch
  segments | segment create --name <n> [--body <definition>] [--criteria <json>] [--estimate <n>]
  segment update <id> [--name <n>] [--body <definition>] [--criteria <json>] [--estimate <n>] [--status active|paused|exhausted|archived]
  personas [--all] | persona upsert --name <n> [--titles "a|b"] [--excluded-titles "a|b"] [--seniorities "a|b"]
       [--departments "a|b"] [--hints <search hints>] [--body <description>]   a field left out keeps its value
  persona update <id> [--name <n>] [--titles "a|b"] [--excluded-titles "a|b"] [--seniorities "a|b"]
       [--departments "a|b"] [--hints <t>] [--body <t>]   by id: a rename keeps the persona, its leads and ladders
  persona retire <id> | persona activate <id>   a retired persona is hidden from bh personas (--all shows it)
                                         and goes on no ladder and no enroll again; its leads keep it. One on the
                                         ladder of a strategy that is not archived is taken off first
  strategies | strategy create --file <json> | strategy update <id> --file <json> | strategy show <id|first 8+ characters>
                                         "greeting": the line its emails open with, one name slot: "Hey {first},",
                                         "Guten Tag {full},", "Добрий день, {name}!" ({name}: as the language writes it);
                                         null: the house's "Hi {first},"
                                         "callScript": the base of the calling script for its people (OPENER, WHY YOU,
                                         QUESTION, …, in the call's language, up to 10,000 characters); slots {first},
                                         {last}, {full}, {company}, {title} are filled per person when a call step
                                         puts a lead on the call list; scripts for one person are written from it
                                         (call-scripts skill); null takes it off
                                         "callPolicy": {"attempts":5,"spacingMinutes":1440,"openForDays":14}, the tries of
                                         its call-step list in the dialer (1-10, 15-10080 minutes apart, open 1-90 days; 3 a
                                         day apart for 14 days for what is left out), set before any lead reaches a call
                                         step; changed later, the dialer's list gets it within five minutes; null takes it off;
                                         a call step with its own "callPolicy" (bh plan step) calls its leads from a list of its own
  strategy launch <id> | strategy pause <id> [--reason <t>] | strategy archive <id>   (a person only); launch
                                         answers firstTouches: leads starting on each day, beside the daily limit;
                                         archive is for good: its live leads stop (strategy_archived), unsent messages cancelled
  strategy exclude <id> --company <id|domain> --reason <t>   keep a company out of this strategy only (a person only)
  strategy exclude <id> --file <json|jsonl|->          [{"domain"|"companyId","reason","excluded":false to let back in}]
  strategy include <id> --company <id|domain> [--reason <t>]   let it back in
                                         enroll skips its people; those already in a plan keep going ("live")
  leads [--q <text>] [--strategy <id>] [--state in_plan|paused|stuck|replied|ended] [--label <name>] [--limit <n>] [--offset <n>]
                                         --label: the lead or its company carries it
  lead show <enrollment-id>              one lead's plan step by step
  lead resume <enrollment-id>            put back a lead a reply stopped when the reply needed nothing, or one stopped as
                                         the wrong person once they are known to be at the company (a person only)
  lead pause <enrollment-id> [--until <YYYY-MM-DD>] [--note <why>] | lead unpause <enrollment-id>   hold a lead by
                                         hand, and let it go on (a person only; unpause also lets go one paused with
                                         thread pause-colleagues); with --until the engine lets it go on when that day
                                         begins (UTC), as after an out-of-office; pausing it again changes the date;
                                         a lead held for an away note is held longer with a later --until and --note
  lead stop <enrollment-id> --reason <t> end a lead for good; frees the contact for another strategy (a person only)
  lead restart <enrollment-id>... [--file <json|jsonl|->] [--dry-run]   send a lead already written to again from step 1
                                         as a new lead of its strategy, its copy kept: on its mailbox while that sends
                                         to it, else on the one of its sender's that would start it soonest; its first
                                         email goes before the mailbox's never-emailed leads; the caps do not count it
                                         again; --file: [{"enrollmentId"}] (a person only)
  strategy unlaunch <id>                 undo a launch or resume within a minute, before anything is sent (a person only)
  strategy respread <id> [--dry-run]     count again the start dates of a launched strategy's leads that sent nothing,
                                         on its send days, colleagues companyStaggerDays apart: earlier as well as
                                         later; a sendDays or companyStaggerDays update does it by itself (a person only)
  strategy repick-mailboxes <id> [--dry-run]   give each lead that has sent nothing yet a mailbox of its sender
                                         that serves its provider (mailbox update --recipients), sends outreach
                                         on its first day, sits on an aged domain (>=90d) for gateway and
                                         Microsoft leads when one does, and sits as high in the pairing table
                                         as one would (Gmail leads on Microsoft, every other lead on Google, a
                                         gateway's never on Microsoft; bh mailboxes plan): off held, badly
                                         placed, warming-alone and young-domain mailboxes when the sender has
                                         another; a person only
                 [--even]                   also spread leads on mailboxes that send, by room: a lead moves to the
                                         sender's mailbox that would send its first email soonest (leads that
                                         sent nothing over outreach a day), while it starts there no later than
                                         the ones left behind; so a ramping or placement-held backlog moves to
                                         warmed mailboxes, and mailboxes added after enrollment get their share
                 [--to-provider google|microsoft] [--only <mailbox-id,…>] [--skip <mailbox-id,…>]
                                         where leads may move to; where they come from is unchanged
                 [--change-sender]          a lead whose sender has no mailbox for its provider, or is no longer on
                                         the strategy, moves to another sender who has one; only leads with nothing
                                         sent on any channel; their written copy is cleared and needs writing again
                                         (needsCopy); without it the answer counts them (couldChangeSender)
                 [--to-sender <id>]         only this: leads of the strategy's other senders with nothing sent on any
                                         channel move to this one of its senders, onto their least-loaded mailbox
                                         (--only/--skip/--to-provider narrow which) while it carries 2 fewer leads
                                         than the lead's; stuck-on-room leads first. Copy is cleared (needsCopy).
                                         Their LinkedIn account, or with none the email_only template, or with
                                         none their LinkedIn steps skipped when emails do not wait on them;
                                         otherwise the lead stays (refused). A LinkedIn-only lead (no mailbox)
                                         moves onto their least-loaded LinkedIn account while it carries 2 fewer
                 [--limit <n>] [--stuck]    at most n leads of the strategy (stuck ones first), so a new mailbox
                                         is filled with a few days of what it starts; only leads stuck on
                                         mailbox_room. With --to-sender too.
                 [--enrollment <id,…>]      only these leads; with --to-sender they move whatever the load (undoes
                                         a wrong move). A referral or re-engagement lead keeps the sender of the
                                         thread it follows: it moves to another sender only back to that one
                                         The engine itself moves a lead off a mailbox that will never send it
                                         (held on its side, bad placement, paused, archived, disconnected) to
                                         another of its sender's; leads waiting a day get a task per strategy
  reply unapprove <id>                   take an approval back before the reply goes (a person only)
  plan set <strategy-id> --file <json>                 {"plans":[{"appliesWhen":"email_only","steps":[{"channel":"email"},…]}]}
                                         a "call" step puts the lead on the strategy's call list when reached
                                         (handed to the dialer when the project is linked); its guidance is the brief;
                                         "callPolicy": {"attempts":5,"spacingMinutes":1440,"openForDays":5} on a call step
                                         gives it tries of its own on a list of its own (what it leaves out: the strategy's
                                         callPolicy), so a plan calls in blocks between emails; joining it ends the
                                         lead's block before; a call step without one shares the strategy's list and tries;
                                         a "telegram_message" step goes from the sender's own Telegram to a lead it
                                         knows (a peer matched to the contact: bh telegram match), else it is skipped;
                                         a linkedin_invite step goes without a note unless it says "withoutNote": false;
                                         "withdrawAfterDays" (1-30) on it withdraws an invitation still unaccepted that long;
                                         "track": "linkedin" (an invite or LinkedIn message) runs it beside the emails:
                                         timed on its own track, it never holds an email; "delayHours" (0-23) adds
                                         hours to "delayDays"; "variants": [{"name","withoutNote","guidance"},…] (2-4)
                                         split the step's leads in turn, an A/B test read in strategy show;
                                         on a draft that has sent nothing, its enrolled leads' plans are copied again,
                                         written copy kept where a step keeps its channel and the lead its variant; a lead keeps its
                                         variant where the step still has one of that name, else that copy is written again (a person only)
  plan step <strategy-id> <step-id> --file <json>      {"guidance","hypothesis","withoutNote","withdrawAfterDays","callPolicy","newThread","threadOf","earlierThread","delayDays","track"}: one step's,
                                         frozen templates too; step ids in strategy show
                                         withoutNote (a LinkedIn invite; a person only): send it with no note; unsent invites follow
                                         withdrawAfterDays (a LinkedIn invite, 1-30 or null; a person only): withdraw its invitations
                                         still unaccepted after that many days, those already out included
                                         callPolicy (a call step, {attempts,spacingMinutes,openForDays} or null; a person only):
                                         leads reaching it from then on go on its own list with these tries; null shares the
                                         strategy's list again (leads on its own list keep their block)
                                         newThread (a follow-up email; a person only): true starts its own thread; false answers
                                         in the thread of threadOf, the position of an earlier email step (null: the first email's),
                                         as "Re: <that thread's first subject>"; every email not yet sent follows
                                         earlierThread (an email opening a thread in the plan; a person only): true when it
                                         continues a thread opened before the plan (another platform, an earlier sequence),
                                         so its subject is that thread's "Re: …" and bh copy check lets it stand
                                         delayDays (not the first step; a person only): send days after the step before;
                                         leads enrolled later get it and every lead's unsent message of the step moves
                                         track ("main" | "linkedin"; a LinkedIn step; a person only): unsent messages of the step move
  plan add-step <strategy-id> --after <position> --file <step.json> [--plan <plan-id>] [--dry-run]
                                         put a step after <position>, running leads too: later steps move one place on,
                                         each live lead that sent nothing past that point gets it (needing copy, bh copy
                                         queue); leads past it or ended do not; --plan when the strategy has several (a person only)
  plan add-template <strategy-id> --file <template.json>   {"appliesWhen","name","steps"}: one template of a kind
                                         the strategy lacks, launched too (an email_only beside email_and_linkedin);
                                         its other templates and enrolled leads' plans stay; leads enrolled later
                                         whose data picks that kind get it (a person only)
  plan remove <strategy-id> <step-id>   take the plan's last step out, frozen templates too: its unsent messages are
                                         cancelled, a lead whose next step it was ends there (a person only)
  companies upsert --file <json|jsonl|->               [{"domain","name","linkedinUrl","employeeCount","country","facts"}]
                                         a company with no site of its own (or only a bit.ly, a social page):
                                         its "linkedinUrl" company page, no "domain"; kept by that page
                                         every --file of rows: a JSON array, or JSONL (a .jsonl file always is);
                                         sent 500 rows or 512 KB at a time, answered as one; a refused row exits 1
  companies judge <segment-id> --file <json|jsonl|->   [{"domain","status":"new|qualified|disqualified","reason","questionId","signal":{…},"sourceId","searchId",
                                         "evidence":[{"fact","value","url","seenAt"}],"exclusionId"}]; signal is an object,
                                         e.g. "signal":{"seen":"2026-11-05","source":"own site","summary":"…"}
                                         every verdict is kept; a company breaking an exclusion is not qualified (the refusal
                                         names its exclusionIds); qualified and disqualified need a reason; a verdict without evidence is warned about
  companies in <segment-id> [--status new|qualified|disqualified] [--waiting fact|client] [--q <text>] [--limit <n>] [--offset <n>]
                                         answers {companies, total, counts, limit, offset}
  companies verdicts <segment-id> --company <id>       every verdict ever passed on that company
  companies breaks <segment-id>          qualified companies that break the segment's criteria or the client's rules
                                         now, each with why and its live leads (ids for bh lead stop); none is taken out
  companies domain <company-id|wrong-domain> <right-domain>   correct a company's domain, keeping the company with its
                                         contacts, verdicts and leads; refused when another company has it; its mail
                                         provider is read again from the new domain
  sources | source add <segment-id> --kind linkedin|trustpilot|web|directory|import --name <n> [--provider <p>]
       [--query <json>] [--body <instructions>] [--estimate <n>]
  source update <id> [--name <n>] [--status active|paused|exhausted] [--cursor <c>] [--estimate <n>] [--body <instructions>]
                                         --estimate reads back as estimatedCompanies, in bh segments and bh sources
  search record --file <json>            {"kind":"companies","sourceId","provider","query","cursor","results","newRecords","duplicates","callIds":[…]}
                                         {"kind":"contacts","strategyId","companyId","provider","query","results","newRecords","duplicates","callIds":[…],
                                          "dropped":{"former","title","over_cap","other_company","duplicate","location","invalid": <n>}}
                                         a company search names its sourceId, a contact search its strategyId — or,
                                         sizing a segment before its strategy exists, its segmentId
  exclusions | exclusion add --kind country|country_outside|industry|business_model|employees_below|employees_above|rating_above|other --value <v> [--note <why>]
  exclusion remove <id>
  client messages [--all] [--limit <n>] what the client wrote in the project's Slack channel and nobody
                                         has handled; --all for the whole channel, the team's included
  client handle <id> --as note|answer|task|nothing [--ref <note|question|task id>] [--title <t>]
                                         what became of it: client feedback (a note, made unless --ref),
                                         the answer to an open question (--ref), a task (--ref), nothing
  client message <id> --client|--ours    the engine counted whose it is wrongly: say whose it is
  questions [--status open|asked|answered|dropped|all] | question add (--body <question> | --body-file <path|->) [--note <context>] [--asked]
                                         [--thread <thread-id>]: the lead's thread whose answer waits for it
  question ask <id>                      post it in the project's client Slack channel; the client's reply
                                         in that thread is the answer, and the lead's thread waits in bh answers
  question asked <id> | question answer <id> (--body <answer, verbatim> | --body-file <path|->) | question drop <id>
  question link <id> --thread <thread-id>   another lead's thread waits for this question too (not a second one)
  hypothesis list [--status open|proposed|testing|confirmed|rejected|parked|all]   open: proposed and testing
  hypothesis add --claim <t> [--evidence <why> | --evidence-file <path|->] [--segment <id>] [--persona <id>] [--strategy <id>]
       [--metric <what is measured>] [--threshold <what confirms it>] [--status proposed|parked]
  hypothesis update <id> [--claim <t>] [--evidence <why> | --evidence-file <path|-> | --add-evidence <a dated line>]
       [--segment|--persona|--strategy <id|none>] [--metric <m>] [--threshold <t>]
       [--status proposed|testing|confirmed|rejected|parked] [--verdict <what the results showed>]
                                         testing: a person only, with --metric and --threshold;
                                         confirmed and rejected carry --verdict
  calls                                 the project's call lists: who was handed to callers, and how far they got
  calls create --name <n> --file <json|jsonl|-> [--note <t>] [--allow-repeat]   (a person only)
       [--attempts <1-10>] [--spacing <15-10080 minutes>] [--open-days <1-90>] [--caller <email>]   in a project linked to
                                         a dialer workspace the list goes to the dialer too: tries per person (3), minutes
                                         between them (1440), days it stays open (14); --caller gives it to that caller
                                         alone: it goes on their own queue (made the first time, them its only agent), not
                                         the project's queue every caller works and shares retries on (bh dialer people
                                         shows each one's ownQueueId); its "dialer" says what went and who was left out
                                         [{"contactId","phone","reason","script"}] in call order; phone is optional: without it
                                         the contact's first live number not on do-not-call, with it one of theirs (bh phones);
                                         reason: why this person, now (≤2,000 characters; the dialer's brief for this list);
                                         script: what to say to them (≤10,000, line breaks kept; the dialer's calling script,
                                         shown first on the call); all or nothing: a contact on dnc, outside the project,
                                         with no such number or already on a list is refused (--allow-repeat lets the last through)
  calls push <list-id> [--attempts …] [--caller <email|none>]   hand the list to the dialer again after a push that
                                         failed (a person only); --attempts, --spacing, --open-days change the tries of a
                                         list the dialer already has (what is left out stays as it has it; a strategy's
                                         call-step list takes them from the strategy's "callPolicy", a call step's own list
                                         from the step's); --caller moves the
                                         list to that caller's own queue, none back to the project's
  calls remove <list-id>                take back a list nobody called from: off the dialer's queue and archived there,
                                         its people's leads on no other live list archived too (leadsArchived),
                                         then gone from Home with its people (a person only)
  calls briefs <list-id> --file <json|jsonl|->   [{"contactId","reason","script"}] change what callers read for people
                                         on the list; null clears one, a field left out stays; a list the dialer has gets it
                                         at once ("dialer": scripts and briefs sent, who it has no lead for, an error to send again)
  calls show <list-id> [--out <file.csv>]   its people in call order; --out writes the caller's CSV
  calls rename <list-id> --name <n>     the list's name only; one already with the dialer keeps its name there
  calls outcome <list-id> --contact <contact-id> --outcome no_answer|voicemail|wrong_number|not_interested|call_back|meeting|other|none [--note <t>]
  goals | goal set <YYYY-MM> --target <meetings> [--counts qualified|held] | goal done <YYYY-MM> --done <n>   (a person only)
  goal remove <YYYY-MM>                  the month has no goal, as though none were set (a person only)
  contacts upsert --file <json|jsonl|->                [{"email","linkedinUrl","firstName","lastName","title","companyDomain","companyLinkedinUrl","emailStatus","facts",
                                          "country","timezone"}]   country: ISO 3166 two letters (PL); timezone: IANA
                                         (Europe/Warsaw) — the lead's send window and meeting times go by them
                                         a contact already at a company stays there and the row is warned; add
                                         "moveCompany": true to move them (the answer says companyChanged)
                                         a row whose address is a contact's but whose name or profile is another
                                         person's is refused, the contact kept; "samePerson": true if it is them
                                         a phone number is not a fact: facts.phone is refused, numbers go in with bh phones add
  contacts [--q <text>] [--label <name>]   --q: every word in the name, the address or the company's domain
  contacts duplicates                    contacts likely one person, with their live leads: one LinkedIn profile
                                         (match linkedin), or the same full name at one company (match name);
                                         bothLive: each has a live lead, so the merge stops one
  contacts namesakes <id> <other-id> --note <why>   two contacts of one name at one company are two people:
                                         duplicates leaves the pair out and enroll starts both (a person only)
  contacts merge <keep-id> <drop-id> [--dry-run] [--stop <lead-id>]   one person: leads, conversations, meetings,
                                         calls, numbers, labels, standings and history move to the kept contact,
                                         which fills what it lacks; the other is deleted (a person only). When both
                                         have a live lead, --stop names the one to stop with the merge; without it
                                         the merge is refused, suggesting the one to stop (fewer sent, later start)
  contacts depart <id> --reason <how you know> [--undo]   they left the company: never enrolled again; a live
                                         lead is named, not stopped
  contacts employer <id> [--confirm --note <how you know>]   whether they work at their company, read now
                                         from their LinkedIn profile ($0.0045, free when read lately), as the
                                         engine does before a first step; --confirm records that you know they
                                         do, which lets their held leads go for 90 days (a person only); a read
                                         or --confirm that finds them there takes back a departure a check set
  contacts employer <id> --unconfirm [--clear-linkedin] --note <why>   take back a confirmation or a check
                                         you no longer stand by: their leads are held again, not re-read by the
                                         engine for 90 days; --clear-linkedin also takes the profile off (a
                                         namesake's), held until one is given (a person only)
  labels                                 the project's own labels, with how many companies and contacts carry each
  label add <name> [--company <id|domain>,…] [--contact <id|email|linkedin-url>,…] [--file <json|jsonl|->]
                                         put it on (made if the project has none of that name, in any case);
                                         --file: [{"company":"acme.com"},{"contact":"ann@acme.com"},…]; answers
                                         how many it went on and what the project does not have ("unknown")
  label remove <name> [--company …] [--contact …] [--file …]   take it off; the label stays
  label rename <name> --name <new> | label delete <name>        delete takes it off everything that carries it
  phones <contact-id>                    a contact's numbers in dial order: kind, source, confidence, state, on do-not-call
  phones add --file <json|jsonl|->       [{"contactId","number","kind":"mobile|direct|company|other","source","confidence":"high|medium|low","dnc","dncReason","dncNote"}]
  phones add <contact-id> --number <n> --source <s> [--kind <k>] [--confidence <c>] [--dnc] [--dnc-reason <r>] [--dnc-note <t>]
                                         each after the contact's last number, read as E.164 (+ country code; a national
                                         number reads with the contact's country); --dnc: it also goes on dnc, for the
                                         reason given (registry for a do-not-call registry; other when none is given).
                                         Apollo's delivered numbers go in by themselves
  phones set <phone-id> [--state active|invalid --reason <why>] [--rank <n>] [--kind <k>]
                                         a dead number (a caller's wrong number marks it by itself), the dial order
  phones check <phone-id> [--again]      line type and registered name from Twilio Lookup (a person; $0.018): an invalid
                                         number is marked dead, a landline or VoIP one goes last in the dial order
  esp                                    how many companies and contacts are on each email provider (MX:
                                         google, microsoft, proofpoint, mimecast…; pending = not looked up yet)
  dnc [list] [--q <text>] [--kind email|domain|phone|linkedin] [--reason <r>]
                                         the project's entries and the every-project ones, newest first: id, kind,
                                         value, reason, note, who added it; --q matches the value or the note
  dnc add --kind email|domain|phone|linkedin --value <v> --reason <r> [--note <t>] [--every-project] | dnc remove <id>
                                         --every-project blocks it for every project of every organisation (the
                                         platform admin's alone); linkedin: a profile URL (kept as its key: the /in/
                                         name), for someone reached there alone. A value already there keeps its entry;
                                         another reason or note corrects it (updated: from, to)
  dnc import <file.csv|-> [--reason <r>] [--note <t>] [--every-project]
                                         a column email, domain, phone and/or linkedin, or value (kind from "@", a
                                         linkedin.com/in/ URL, digits, or a kind column); reason and note columns win
                                         over the flags; no header: one value a line.
                                         answers {added, already, refused, invalid}; a refused row exits 1
  dnc check <address|domain|number|profile URL>… | dnc check --file <csv>
                                         which of them the list blocks (a domain blocks its subdomains) —
                                         before paying a provider to enrich or find anyone there
  crm                                    the client's CRMs (pipedrive, hubspot) and the project's connection to each
  crm connect <crm> --token-stdin        connect it with the client's API key, read from stdin (a person; the
                                         key is checked with the CRM, sealed on the server, never shown again)
  crm disconnect <crm>                   forget the key (a person)
  crm call <crm> <METHOD> <path?query> [--body <json> | --body-file <path|->]
                                         its API as documented, the key added on the server: {status, body};
                                         a write changes the client's own records (a person, recorded)
  crm dnc <crm> [--dry-run] [--no-emails] [--no-domains] [--no-phones]
                                         everyone in the CRM onto dnc, reason crm: addresses, their company
                                         domains (not free mail, not the client's own) and numbers;
                                         --dry-run counts and shows a sample, writing nothing
  crm export [--since <date>] [--per-person] [--json] [--out <file>]
                                         the project's per-person activity, for any CRM: a CSV row per step sent,
                                         LinkedIn invitation accepted, reply (its class), answer, meeting and call,
                                         with the person and where they stand (stage); every row tagged
                                         source belkins-home:<project>, activity_id stable; --per-person one row a
                                         person; --json by person; --since keeps what happened from then on
  crm sync <crm> [--since <date>] [--limit <n>] [--dry-run]
                                         the same written into the client's CRM (hubspot; a person): each person
                                         found by address or added, each thing written once, a meeting or email
                                         whose state changed updated; runs pass after pass until done
  crm sync <crm> --auto on|off           the same every hour by itself, until switched off (a person)
  enroll <strategy-id> --file <json|jsonl|-> [--dry-run] [--allow-namesakes] [--allow-written-before]    [{"contactId","segmentId","personaId","senderId"?}]
                                         senderId: write as that sender of the strategy (skipped with why when they
                                         cannot carry the plan); each result names its senderId and mailbox;
                                         a contact written to here before and stopped is a restart (restartOf):
                                         its own earlier lead takes no second place under the caps, and its first
                                         email goes before the mailbox's never-emailed leads
                                         a lead goes first to a sender with a mailbox for its mail provider,
                                         and on an aged domain (>=90d) for gateway and Microsoft leads when one sends;
                                         unserved counts leads no sender's mailboxes serve (put on any; with the
                                         strategy's holdUnserved they wait, stuck unserved_provider, for one that does);
                                         skips a company at the project's cap of people live across strategies
                                         (bh project update --max-live-per-company), and a contact whose namesake at
                                         the company is live (likely one person: bh contacts merge; --allow-namesakes
                                         if they are two people); a contact who answered on another platform or was
                                         written to there in the last 90 days (bh history; --allow-written-before when
                                         this lead continues that conversation, then bh history continue)
                                         youngDomain counts gateway leads placed on a domain under 90 days old;
                                         zoneWarning on a lead timed by the project's zone or a guess at its
                                         country's (US, CA, AU…): set its timezone or the company's hq_state
  stand <strategy-id> --contact <id> --status candidate|held|rejected [--persona <id>] [--reason <t>]
  stand <strategy-id> --file <json|jsonl|->            [{"contactId","status","personaId","reason"}]
                                         a person live in the strategy stays enrolled (skipped, with why);
                                         --status enrolled puts back the row of one who is live
  worked <strategy-id> --file <json|jsonl|->           [{"domain","status":"pending|contacts_found|no_match|enrolled|exhausted","contactsFound"}]
                                         what a search inside a company came to; the engine records the rest as people stand
  copy queue <strategy-id> [--limit <n≤200>] [--offset <n>] [--all]   --all reads every page | copy write --file <json|jsonl|->   [{"messageId","subject","body","angle"}]
                                         at most 500 messages a call, all written or none (bh refuses a larger file);
                                         the answer lists house rules the copy breaks (written anyway, as copy check says);
                                         a referral's or re-engagement's step someone else already wrote is refused;
                                         --replace replaces theirs, on purpose only
  copy check --file <json|jsonl|->      the same file, checked against the house rules and written nowhere;
                                         every problem per messageId, exit 1 when there is one; sent 2,000 at a
                                         time and answered as one (colleagues compared within each 2,000 and
                                         with copy already written)
  copy clear <message-id> [<message-id> …]   take a written message's copy back out: it waits for copy again
                                         (needs_copy); not once sent; a person only
  copy sample <strategy-id> --file <json|jsonl|-> [--replace]   [{"position","subject","body","newThread"}]
                                         sample emails of the strategy's steps, written for no lead: warm-up and
                                         placement tests carry them before launch, or when we send through another
                                         platform; --replace takes the earlier ones out
  copy samples <strategy-id> | copy sample-remove <strategy-id> <sample-id>
  copy test <message-id> --to <email>   send one written email step, as the lead would get it (their mailbox and
                                         sender), to your own address before launch; a person only, 10 a mailbox a day
  preview <message-id>                   html is null for a plan step: steps go as plain text
  senders | sender add --name <n> [--title <t>] [--signature <text>] | sender update <id> [--name] [--title] [--signature]
                                         add, update and share take --signature-html-file <file.html> too: answers sent by
                                         hand (bh reply) then go as text and HTML; plan steps always go as plain text with
                                         the --signature text, never the HTML or a picture; an empty file clears it
  sender image <id> <file.png|jpg>       a picture for the HTML signature (100 KB at most); use the src it answers
  sender images <id> | sender image-remove <id> <image-id>
  sender photo <id> [<file.jpg|png> | --image <image-id> | --none]   the face beside their name: the engine sets it
                                         on each of their mailboxes in our tenants; with nothing, where each stands
  sender signature <id> [--out <file.html>]   how they sign on this project; --out writes it to open in a browser
  sender move <id> --to <project>        with their mailboxes and LinkedIn, while nothing was written as them
  sender remove <id>                     one nothing refers to (no mailbox, LinkedIn, message or strategy)
  sender share <id> [--title <t>] [--signature <text>] [--daily-share <n>]
                                         puts an agency sender on this project, named for this client
  sender unshare <id>                    takes them off it again

  mail-health <org> [--days <n>]         each sending domain over the last days (14): state and why, mailboxes and
                                         egresses, sent, bounces, Gmail's refusals, replies and blocks by receiving
                                         side (Google, Microsoft, Proofpoint, Mimecast, other gateways), seed
                                         verdicts — worst first
  review subscribe <org> [--email <e>] [--timezone <tz>] [--reviews on|off] [--alerts on|off]
                                         hear the weekly review (Monday 09:00 in --timezone, Europe/Berlin by
                                         default) and alerts about your projects in Slack; an admin may add --email
  review unsubscribe <org> [--email <e>] | review list <org>   who hears them, and the latest reviews
  review now <org> [--for <email>]       a review of your projects now, in your Slack messages within minutes (person)
  bounces <org> [--days <n>] [--project <slug>]
                                         how the mail sent over the last days (14) bounced: by class, day, sending
                                         mailbox, strategy, receiving side and recipient domain; codes; latest 50
  agency senders <org>                   the agency's own people, and who they write for
  agency add <org> --name <n> [--title <t>] [--signature <text>] [--signature-html-file <file.html>] [--company <name|id>]
                                         --company: they work at one of the agency's companies (bh company)
  agency remove <org> <id>               while they are on no project and hold no channel
  agency mailbox <org> --sender <id> --provider google|microsoft [--daily-limit <n>] [--delay-min <s>] [--delay-max <s>] [--warmed]
                                         a mailbox of theirs, shared by every project they are on
  agency smtp <org> --sender <id> --file <json|jsonl|-> [--daily-limit <n>] [--delay-min <s>] [--delay-max <s>] [--warmed]
                                         a password mailbox of theirs (rows as for mailbox smtp)
  agency jmap <org> --sender <id> --file <json|jsonl|-> [--daily-limit <n>] [--delay-min <s>] [--delay-max <s>] [--warmed]
                                         a JMAP mailbox of theirs (rows as for mailbox jmap)
  agency linkedin <org> <unipile-account-id> --sender <id> [--invite-limit <n>] [--message-limit <n>] [--ramp yes|no]
                                         --ramp: invitations climb from 5 a day, 5 more a week, to the limit
                                         (default yes for a person of an agency company)
  agency domains <org> | agency quote <org> <name>…   the agency's own domains, for its own senders
  agency closeouts <org> [--query <word>] [--age-min <years>] [--price-max-cents <n>] [--tld <tld>] [--limit <n>]
       [--names any|company]
                                         aged expired domains at a fixed price, as domain closeouts
  agency approve <org> <name>… --max-cents <n> [--redirect <url>] [--platform google|microsoft] [--tenant <name|id>]
       [--company <name|id>] [--closeout]
                                         buy them for the agency (its admin only); --platform picks where the
                                         mailboxes on them live (default google), --tenant which of that platform's
                                         tenants (default: the oldest in the default pool with room); --company: they
                                         are that company's, in its pod's tenant, and a sending one redirects to its site
  agency order <org> <domain> --sender <agency sender id> --first-name <n> --last-name <n> --username <u> | --file <f>
                                         a Workspace seat on it for one of its senders (its admin only)
  agency orders <org>                    what was ordered on the agency's domains and where each is
  agency retry <org> <domain>            the agency's bought domain that failed goes back on its way into a tenant;
                                         order its mailboxes again with agency order (its admin only)
  network <org>                          the agency's sending network (docs/decisions/sending-network.md): companies,
                                         people, mailboxes by platform and warm-up stage, LinkedIn, domains by status,
                                         tenants against their caps, pods, egresses, the seed pool and the network's part
  company list <org>                     its companies, each with people, mailboxes, domains, egress, who it writes for
  company show <org> <company>           one company: its people with their mailboxes and LinkedIn, its domains,
                                         orders under way, tenants, egress, site and who it writes for
  company add <org> --name <n> --domain <main domain> [--site <url>] [--linkedin <url>] [--address <postal>]
       [--country <US>] [--pod <n>] [--google-tenant <name|id>] [--microsoft-tenant <name|id>] [--egress <host name>]
                                         (its admin only) a company of a pod takes the pod's tenants unless named
  company update <org> <company> [--name] [--domain] [--site] [--linkedin] [--address] [--country] [--pod] [--google-tenant]
       [--microsoft-tenant] [--egress <host name|none>] [--status building|active|retired]   none clears a field
  company add-person <org> <company> --name <full name> [--title <t>] | <sender id>
       [--username <u>] [--sending yes|no] [--domains <d1,d2>] [--linkedin yes|no]
                                         onboards a person (a person only): an agency sender working there, their
                                         workplace mailbox first@<main domain> and one sending mailbox on each domain of
                                         the half their pair shares (--sending no: the workplace one only), warmed as
                                         every mailbox is, and their LinkedIn account made by the engine once the
                                         workplace mailbox is connected; bh company show says where each person stands
  company remove-person <org> <company> <sender id>
  company domains <org> <company> <domain>…   domains the agency holds, put under the company
  company remove-domain <org> <company> <domain>
  company order <org> <company> --sender <id> --first-name <n> --last-name <n> --username <u> --domains <d1,d2,…>
       | company order <org> <company> --file <json|jsonl|->   [{"senderId","domain","firstName","lastName","username"}]
                                         a person's mailboxes across the company's domains, or the whole company's, in
                                         one call (a person only): one a domain each, all ordered or none
  company posts <org> <company> [--status scheduled|publishing|published|failed|cancelled]   its page's posts, by time
  company post <org> <company> --file <json|jsonl|-> [--dry-run]   schedules posts as its LinkedIn page, all or none,
                                         with no client project (its admin only): each on an account of one of its
                                         people who manages the page, as in linkedin post (bh linkedin pages
                                         <account id>); without pageId on that person's own profile, once
                                         bh linkedin profile-posts <id> on; cancel one with linkedin post cancel
  calendars                              the project's calendars: state, event type or booking link, last sync
  calendar connect --sender <id> [--key - [--event-type <id>]]
                                         the sender's Cal.com; --key - reads its API key from stdin (or asks
                                         for it, hidden); without a key, a URL to open: sign in to
                                         Cal.com (or sign up, connecting Google or Outlook) and allow us
  calendar connect --sender <id> --freebusy <address> | --hours-only <address> | --ics <feed url> --address <address>
                  [--timezone <iana>] [--hours "mon-fri 09:00-17:00; sat 10:00-12:00"] [--minutes <n>]
                  [--buffer <min>] [--notice <min>] [--cap <per day>] [--window <days>]
                                         a calendar of our own, booked through our organizer (docs/decisions/
                                         booking.md): a Google calendar that shares its free/busy with the
                                         organizer, a published calendar's feed (Outlook's ICS link), or
                                         working hours alone; the address gets the invitations
  calendar invite --sender <id>          a link for the sender's owner to connect their Cal.com without
                                         access to the tool (7 days; the first link used closes the rest)
  calendar add-external --url <booking link> [--sender <id>] [--name <t>] [--minutes <n>] [--timezone <iana>]
                                         a booking page Home has no integration with (a client's Calendly): Claude
                                         reads its free times and books it in a browser, then records the meeting
                                         with --calendar (a person only)
  calendar update <id> [--event-type <id>] [--priority <n>] [--timezone <iana>] [--owner <name>] [--sender <id>]
                  [--name <t>] [--minutes <n>]   (name and minutes: an external calendar's or one of our own)
                  [--hours <spec>] [--buffer <min>] [--notice <min>] [--cap <n>|none] [--window <days>]
                                         (one of our own's rules)
  calendar archive <id>                  out of booking for good; connecting again writes a new row
  slots [--days <n>] [--calendar <id>] [--limit <n>]   free slots, soonest first (not yet offered to anyone)
  slots offer <thread-id> --slots <iso,iso> [--calendar <id>]
                                         holds them for this lead for 72 h; a newer offer replaces an older one and
                                         may keep the times the thread already holds. For times a reply sent later
                                         offers, use bh reply draft --slots: the 72 h start when it is sent
  slots link <thread-id> [--calendar <id>]   a page for the lead to book a time themselves (a week, one
                                         meeting; calendars of our own): its link and the soonest three
                                         times as links that open it with that time chosen
  meetings [--upcoming]                  each with its joinUrl and leadTimezone (null when nobody knows the lead's zone)
  meeting book --calendar <id> --at <iso> --thread <id> [--contact <id>] | --contact <id> [--lead-timezone <iana>]
                                         asks the calendar again, then writes the event with the guest invited;
                                         --thread alone: the guest is whoever wrote the thread's last reply (the lead,
                                         or a colleague at their company, made a contact); --thread with --contact:
                                         that contact, the meeting counted for the thread's plan; a scheduled agent
                                         books only a slot offered in the thread (or to this lead)
  meeting record --thread <id> | --contact <id> --at <iso> --calendar <external id> | --through <where>
                 [--minutes <n>] [--sender <id>] [--notes <t>] [--pending]
                                         a meeting booked outside Home (an external calendar, the client's own
                                         link): counted, written to no calendar; the sender defaults to the
                                         calendar's, then the thread's (a person only); --pending: agreed, but the
                                         client counts it only once the prospect confirms it
  meeting move <id> --at <iso>           on the calendar too (an agent: only to an offered slot); one booked
                                         outside Home moves in our books only, after it was moved there
  meeting cancel <id> [--reason <t>]     after 60 s, on the calendar too; the lead is told (a person only)
  meeting uncancel <id>                  keep it: within the 60 s after cancel
  meeting retry <id>                     write the event again after a calendar error (found, not doubled)
  meeting transcript <id>                what a meeting through the organizer left: who came and how long, the
                                         host bot's comings and goings, the transcript, Meet's Docs
  meeting text [--text <t> | --file <path>]   the project's own text on its meetings' invitations, in place of
                                         the lead's details: {first} {last} {full} {company} {title} filled per
                                         lead (one lacking a value it names gets the standard text); the Meet
                                         and recording line follows it; --text "" takes it off (a person only)
  meeting update <id> [--status held|no_show|pending|scheduled] [--outcome qualified|not_qualified|opportunity|won|lost]
                  [--feedback <client's words>] [--notes <t>] [--thread <id>] [--lead-timezone <iana>]   (a person only)
                                         --thread ties it to the thread it came from: it counts for that thread's
                                         plan, and takes its sender when it has none; --status pending: not counted
                                         until the prospect confirms it (one no calendar event of ours holds; the lead
                                         is told nothing), --status scheduled confirms a pending one
  mailboxes                              each mailbox, with its ladder day, placement, the receiving sides its outreach
                                         is held on (outreachHeldSides: google, microsoft) since outreachHeldAt and why,
                                         disconnectedReason, and a warning the provider gave ahead of a disconnect
  mailboxes plan [--strategy <id>] [--per-day <n>]   the mailboxes the project's leads need under the pairing
                                         table (Gmail leads from Microsoft first; Outlook, gateway and other leads from
                                         Google first, gateways on domains >=90d): leads by side, waiting and never
                                         enrolled; need and have a day per host once warmed; how many Google, aged Google
                                         and Microsoft mailboxes to buy, which sit beyond the need (held first, then
                                         the fewest leads the table puts there); --per-day the first
                                         emails a day to plan for (default: what the mailboxes send); --strategy its
                                         waiting leads and its senders' mailboxes only
  mailbox connect --provider google|microsoft [--sender <id>] [--daily-limit <n>] [--delay-min <s>] [--delay-max <s>] [--warmed]
                                         prints the URL to open in a browser
  mailbox reconnect <id>                 a disconnected mailbox connected again: one a person signs in to prints the URL
                                         to open; a seat in one of our Google tenants is tried at once and made
                                         active when Google gives its token (a person only)
  mailbox delete-user <id|address> [<id|address>…] [--confirm]   an archived mailbox's user deleted from the
                                         Google or Microsoft tenant we made it in, its mail with it, so its seat is
                                         no longer paid for; it cannot be brought back. Without --confirm it only says
                                         what it would delete (a platform admin; bh tenants cleanup names them)
  mailbox import --file <json|jsonl|-> [--daily-limit <n>] [--delay-min <s>] [--delay-max <s>] [--warmed] [--paused]
                                         from another platform, by the refresh token it holds (same OAuth app):
                                         [{"provider":"google|microsoft","refreshToken","sender":"<name>"|"senderId"}];
                                         --paused: they arrive switched off, sending and warming nothing until made active
  mailbox smtp --file <json|jsonl|-> [--daily-limit <n>] [--delay-min <s>] [--delay-max <s>] [--warmed]
                                         a mailbox on any SMTP/IMAP host, signed in with its password; both logins
                                         are tried first. [{"address","password","host":"zoho|zoho-eu|migadu|purelymail|fastmail|belkins"
                                         | "smtp":{"host","port"},"imap":{"host","port"}, "sender":"<name>"|"senderId",
                                         "saveSent":false (the host files sent mail itself)}] — adding it again reconnects it
  mailbox jmap --file <json|jsonl|-> [--daily-limit <n>] [--delay-min <s>] [--delay-max <s>] [--warmed]
                                         a mailbox on a JMAP host (Stalwart), signed in with its password; the login
                                         and the right to send as the address are tried first. [{"address","password",
                                         "host":"belkins" | "url":"https://…", "user" (else the address), "sender":"<name>"|"senderId"}]
                                         — adding it again reconnects it, also one added with mailbox smtp
  mailbox update <id> [--daily-limit <n>] [--delay-min <s>] [--delay-max <s>] [--warmed|--not-warmed] [--status active|paused|archived]
                 [--sender <id>]            another sender of the project writes from it
                 [--recipients google,microsoft,…|'!microsoft,…'|any]   write only to leads whose mail that
                                         provider takes, or ('!…') to everyone's but those, providers not known yet
                                         included (none is refused: it is a domain with no MX; to write to
                                         nobody, --status paused)
                 [--intake on|off]          off: it takes no new lead (enroll, repick, a referral, the engine's own
                                         move) while its started leads finish and its warm-up goes on
                 --not-warmed on a warmed one: the ladder again from its first day; --warmed needs a
                 domain registered 30 days ago or more
                                         (bh esp names them); a lead no mailbox of its sender serves may use any.
                                         Leads already enrolled keep theirs until strategy repick-mailboxes
  mailbox move <id> --to <project> [--sender <id>]
                                         a mailbox whose leads have all ended (none live, no step or answer left to
                                         send) goes to another project of the same organisation, writing as its
                                         sender (--sender; the project's only one when left out); its old threads stay
                                         in the first project, its domain follows once no other mailbox is left on it.
                                         An admin of the organisation
  domains                                the project's bought domains: state, tenant, DNS, cost, expiry
  domain quote <name> [<name>…]          availability and price at the registrar (free), and its credit
                                         (balanceCents; null with balanceError when the registrar does not say),
                                         and the mailboxes the project's leads need (mailboxPlan, as mailboxes plan)
  domain closeouts [--query <word>] [--age-min <years, 5>] [--price-max-cents <n>] [--tld <com>] [--limit <n, 20>]
       [--names any|company]
                                         aged expired domains at a fixed price, oldest first, without the ones on a
                                         domain blocklist or with a Spamhaus abuse history (refused says why);
                                         priceCents is the closeout alone, the first year comes on top;
                                         companyName marks a name ending in a company word (…group, …inc),
                                         --names company finds only those across the whole pool
  domain approve <name> [<name>…] --max-cents <n> [--redirect <client site url>] [--platform google|microsoft]
                 [--tenant <name|id>] [--closeout]   buy them (a person only); --closeout buys
                                         closeouts (refused while paused, since 2026-11-15): claimed,
                                         in our account days later, then as below:
                                         the engine buys, dresses DNS and puts each in a Workspace tenant
                                         (--tenant names it; default: the oldest in the default pool with room)
  domain dkim <name> --record <TXT value> [--selector google]   publish the DKIM record minted in the
                                         Admin console (the task the engine opened says when), or
                                         another service's key under its selector, exactly as given
  domain release <name>                  let it lapse at expiry; refused while a mailbox sends from it (a person only)
  domain transfer <name>                 a signed-up organisation's bought domain: ask for its transfer code, to move it
                                         to a registrar of its own; it renews until it has moved (its admin)
  domain move <name> --tenant <name|id> [--with-mailboxes] [--confirm]   a bought domain goes to another Google tenant, one
                                         with room: the engine takes it out of its tenant and sets it up again,
                                         DKIM included; then retry its failed orders (an admin). Only a domain
                                         nothing lives on moves, unless --with-mailboxes: its mailboxes pause,
                                         their users are deleted there and made again in the new tenant, and each
                                         comes back as it was, warm-up kept; its waiting orders go along.
                                         A Microsoft domain goes to another Microsoft tenant, only with no
                                         mailbox on it: without --confirm it only says what would be done;
                                         its waiting orders are made there once it is ready
  domain platform <name> google|microsoft   a bought domain no tenant has taken yet goes on the other platform,
                                         its orders not yet begun with it; its DNS is redressed (an admin)
  domain retry <name>                    a bought domain that failed on its way into a tenant goes back on it once
                                         the cause is fixed; nothing is bought again (a person only)
  domain redirect <name> <url>|none      where its website goes: a 301 from the apex and every subdomain to the
                                         client's own site, or none (a person only)
  domain dns <name>                      its DNS records and redirects at the registrar (also on a bought domain
                                         that failed on its way into a tenant: add the TXT Google asks for)
  domain dns <name> add --type A|AAAA|CNAME|ALIAS|TXT|CAA|MX|SRV|TLSA|HTTPS|SVCB|SSHFP --host <@|sub> --content <value> [--ttl <s>] [--priority <n>]
  domain dns <name> delete <record id>   (a person only; NS is refused, and on our domains the apex's MX, SPF, DMARC and DKIM)
  domain dmarc <name> --policy none|quarantine|reject [--dry-run]
                                         what receivers do with mail failing DMARC (a person only): bought
                                         domains start at none; raise it once the reports show only our mail.
                                         The engine keeps it: a record it puts back comes back with this policy
  system-mail domains                    the agency's system mail domains at Resend: status and records
  system-mail domain add <name>          connect a domain to Resend (a person only); the engine writes its
                                         records when our registrar holds it, otherwise answers what to add.
                                         Never a domain a mailbox sends from: system mail is not cold outreach
  system-mail domain verify <name>       ask Resend to check the DNS again (hourly by itself)
  system-mail send --from <addr|"Name <addr>"> --to <a,b> --subject <s> --body-file <path|->
             [--html-file <path>] [--reply-to <addr>] [--project <slug>]
                                         mail to people who expect it — a report, a notice, an invitation —
                                         from a verified system mail domain; at most 50 recipients (a person only)
  mailbox order <domain> [--sender <id>] --first-name <n> --last-name <n> --username <local part> | --file <json|jsonl|->
                                         [{"firstName","lastName","username"}] — a Workspace seat each, made once the
                                         domain is ready (a person only)
  mailbox orders                         what was ordered and where each order has got to
  mailbox retry <order-id>               a failed or held order goes back in the queue once its cause is fixed (seats
                                         freed in its tenant); a user already made is not made again (a person only)
  mailbox hold <order-id>                an order nothing was made for yet is set aside: not made, and it takes no
                                         seat in its tenant, until mailbox retry (a person only)
  mailbox cancel <order-id>              an order nothing was made for yet (ordered or held) is called off for good:
                                         no seat, no licence, and its sender can be removed (a person only)
  tenants                                our Google Workspace and Microsoft 365 tenants, with the domains and mailboxes
                                         in each; a Google one's users as the engine counts them and as Google does
                                         (the larger counts against --max-users), and whether Google refused it a
                                         user for want of a licence (fullAt) (an admin); anyone else sees each
                                         client tenant's room before an order: domains, users, free seats, fullAt
  tenant add --name <n> --admin-email <super admin> --key <service account JSON file> | --key-from <tenant>
             [--max-domains <n>] [--max-users <n>] [--role clients|network] [--default-pool yes|no]
                                         the key is proved against the tenant before it is kept (an admin);
                                         --key-from shares the key another tenant holds, opened in the engine,
                                         --max-users caps its users (default 250; Google's Business cap is 300),
                                         --role: clients' domains (default) or a pod's network companies — never
                                         both, and a network one is out of the default pool; --default-pool no
                                         takes only domains approved into it with --tenant
  tenant update <id> [--status active|paused] [--max-domains <n>] [--max-users <n>] [--default-pool yes|no]
                     [--role clients|network] [--admin-email <e>] [--key <file>] [--seat-usd <n>]   (an admin); --seat-usd is what
                                         a mailbox's seat costs a month, which Spend counts
  tenant add --provider microsoft --name <n> --tenant-id <directory id> --client-id <app id> --key <private key PEM>
             --cert <certificate PEM> [--admin-email <e>] [--max-domains <n>] [--role clients|network]
             [--default-pool yes|no]
                                         a Microsoft 365 tenant: the app's certificate is proved against Graph and
                                         Exchange before it is kept; --admin-email records its administrator (an admin)
  tenant seats <id> --provider microsoft   its licences: bought and used; new mailboxes wait for a free one
  tenant update <id> --provider microsoft [--status active|paused] [--max-domains <n>] [--default-pool yes|no]
                     [--role clients|network] [--admin-email <e>] [--seat-usd <n>] [--pax8-subscription <id|none>]
                                         --pax8-subscription: a tenant bought through Pax8 has its seats bought by
                                         setting that Pax8 subscription's quantity, not on an Azure bill
  tenants cleanup                        the users our Google tenants pay for that may be let go: a mailbox archived,
                                         paused a month or more, or two weeks old with no lead's email sent, and users
                                         the engine does not know nobody signed in to for a month; nobody on a company's main
                                         domain (its workplace mailboxes) or on the tenant's own domain is named. The engine deletes none by itself:
                                         an archived mailbox's with bh mailbox delete-user, any other in the Google Admin
                                         console (an admin; #home-alerts counts them on the 1st of each month)
  tenant users <id>                      every user Google holds in a Google tenant, last sign-in, and the mailbox
                                         or order the engine holds of it; ones it holds nothing of come first,
                                         the longest unused first: where seats are freed (an admin)
  tenant console-login <id>              sign in to the Google Admin console through the console service's IP,
                                         so it can do DKIM (an admin; #home-alerts says when it is needed again)
  tenant console-credentials <id> --email <admin> [--totp]   the login the console service signs in with by
                                         itself when Google drops its session; asks for the password (and with
                                         --totp the authenticator secret) hidden, or reads them from stdin, one a
                                         line. --remove forgets it (an admin)
  tenant console-retry <id>              sign in with the stored login on the next pass, not hours after a failed try
  meetbot                                the meeting host bot: signed in or not, last seen, what went wrong (an admin)
  meetbot login                          sign the organizer in through the bot's own IP (a window opens; an admin)
  meetbot credentials --email <organizer> [--totp]   the login the bot signs in with by itself when Google
                                         drops its session (asks the password, and the authenticator secret)
  meetbot retry                          sign in with the stored login on the next pass, not hours after a failed try
  agent runs [--limit <n>]               the server agent's runs: what was waiting, outcome, cost, summary
  agent show <run-id>                    one run with its prompt and transcript
  agent run                              queue a run for the waiting work now (a person only)
  agent cancel <run-id>                  stop a queued or running run (a person only)
  agent on | agent off                   the project's switch: whether the engine starts runs by itself
  warmup status                          the seeds, and each mailbox's ladder, notes and placement. Warm-up is
                                         always on: every mailbox climbs the four-week ladder on our own seeds —
                                         three days of warm-up alone, a trickle of 1–3 outreach a day to day 14,
                                         then 3 a day to 15 beside 15 notes (every other one the project's copy);
                                         warmed once its domain's notes are in the inbox, it keeps 8 notes a day
                                         going. Notes in spam hold the ladder; below 70% in the inbox at Google (60%
                                         at Microsoft) the engine holds the domain's outreach to that side's leads.
                                         Per mailbox: today's rung, the warm-up due
                                         by now, placement tests today (they count against the daily limit, not
                                         the rung), why it is behind (behind.why), and its domain's mail-health
                                         state and issues; pool: what the seed network carries today, and why
                                         it does not grow when short (held)
  warmup seeds                           our own seed organisations, Google and Microsoft 365: seeds held and
                                         ready, today's notes, spam and tabs (an admin)
  warmup seeds <admin email> [--count <n>]   adds an organisation lent to us, or tends it again: the engine keeps
                                         n seed users of its own there (default 4), in the home-seeds unit, on its
                                         domains; its Admin console grants the WARMUP_SEED_KEY service account
                                         domain-wide delegation first. One pool serves every mailbox; the list
                                         shows what the warming mailboxes want of it against 70% of its caps
  warmup grow [--max-microsoft <n>]      the ceiling on Microsoft 365 seed tenants (bh microsoft-seeds) the engine
                                         has made in all, those made by hand included; under it the engine orders
                                         what the network's daily decision gives Microsoft, one at a time, at most
                                         ten a day and two being made, in your name; 0 stops it (platform admin)
  warmup grow [--max-orgs <n>]           the ceiling on Google seed organisations of ours the engine orders by
                                         itself when the seeds cannot carry the warming mailboxes: daily, enough
                                         for the want two weeks out and a tenth more, Microsoft tenants first
                                         while under half the seeds and Google for the rest, at most ten a day
                                         and twenty being made at once, in the name of whoever set it; 0 stops
                                         it (an admin)
  warmup phase-out [--per-day <n>]       Folderly's lent seed organisations leaving the pool: those whose seeds'
                                         answers land in our spam most go first, n a day at most and only as our
                                         new seeds make up for them (the pool's caps stay at the floor they had
                                         when it started), in the name of whoever set it; 0 stops it. Without
                                         --per-day: how far it is — the organisations left, today's share of
                                         notes they took, when the last should leave (platform admin)
  warmup cap-trial                       trials of a higher daily cap for our own seeds: each side's notes a seed
                                         a day, answers in our spam, notes in the seeds' spam, failed seed
                                         actions, seeds lost and organisations down, over the trial and the 14
                                         days before it (platform admin)
  warmup cap-trial start --cap <n> --count <n> [--days 14] [--provider google|microsoft]
                                         the engine draws n of our own organisations 14 days old or more to take
                                         the cap (16–40) a seed a day and n others as the control; it ends the
                                         trial itself when its days are over, or early when the raised side
                                         looks harmed beside the control (platform admin)
  warmup cap-trial end [--provider google|microsoft] [--reason <text>]
                                         ends the running trial: its organisations go back to 15 at once
  warmup seeds <admin email> --provider microsoft --name <n> --tenant-id <directory id> --client-id <app id>
      --key <private key PEM> --cert <certificate PEM> [--count <n>] [--egress <host name|none>]
      [--pax8-subscription <id|none>]
                                         adds a Microsoft 365 seed tenant of ours (never a sending one), proved
                                         against Graph and Exchange first: the engine keeps n users of department
                                         home-seeds on its own domain (default 4), licensed with Exchange Online
                                         (Plan 1) — bought on the tenant's bill when none is free; a lower count
                                         takes the retired seeds' licences off and lowers the bill where Microsoft
                                         allows. Answers leave only through --egress, an egress of a group of up
                                         to five seed tenants that nothing of our sending holds; without one they
                                         are not sent. Without
                                         --key and --cert, tends it again, --count and --egress changed (an admin);
                                         --pax8-subscription: one bought through Pax8 has its seats bought there
  agent stats [--hours <n>]              across projects: runs, cost, queued / running, wait from reply to run
  placement [--days <n>]                 inbox placement on our own seeds, per environment, over the last days (an admin)
  placement seeds                        the seed mailboxes: environment, status, last note
  placement room [--days <n>]            each environment's seeds against the notes they took a day, ours and
                                         partners', and partners' notes turned away for room: when to add seeds
                                         (platform admin; 14 days unless said)
  placement seed connect --env google|m365|m365_defender|m365_proofpoint
                                         the URL to sign in to as the seed; it is only ever read (an admin)
  placement seed add <address> --env google|m365|m365_defender|m365_proofpoint
                                         a mailbox of a seed tenant the engine reads as a whole (domain-wide
                                         delegation, the tenant's app) made a seed, no sign-in (an admin)
  placement seed activate|suspect|archive <id>   put a seed back in the tests, set it aside, or retire it (an admin)
  placement test <our address> [--per-environment <n>]   notes from that mailbox to n seeds in each environment
                                         (default 2), queued and sent at the mailbox's own pace; they count
                                         toward its daily limit; once a week a mailbox, whoever asks
  placement show <test-id>               a test's notes: verdict, folders, filter scores
  placement look <seed address> --message-id <id>   where one message sits in a seed, e.g. a step sent
                                         there with bh copy test: verdict, folders, filter scores
  placement look <seed address> --from <address> [--days <n>]   the same for everything that sender sent
                                         the seed in the last days (3), e.g. a calendar invitation (an admin)
  placement digests <seed address> [--days <n>] [--all]   the quarantine digests a seed received (2 days),
                                         as text; --all lists every envelope instead, each marked digest or not
                                         (an admin: a seed's mail is every organisation's)
  placement mailbox <our address> [--days <n>] [--limit <n>]   its rate per environment over the days (30) and
                                         the notes behind it: kind, seed, subject, body, verdict, scores; its
                                         warm-up notes to our warm-up seeds and where they landed; its hold
  placement domain <domain> [--days <n>] [--limit <n>]   the same for every mailbox on a domain
  placement codes [--days <n>] [--env m365|m365_defender|m365_proofpoint] [--source sfs|eng|atp|field|detection]
                  [--code <code>] [--moved]   Microsoft's codes on the notes of the last days (30): Junk with and
                                         without each, where seen, its meaning, new or moved on the last day (an admin)
  placement codes meanings               every code meaning read so far (an admin)
  placement code <source> <code> --meaning <text> --confidence documented|inferred|unknown [--evidence <text>]
                                         set what a code means; N or x stands for a varying digit (an admin)
  egress list                            the egresses mail leaves through: name, address, region, status, the
                                         projects, mailboxes and warm-up seed tenants on each (an admin;
                                         docs/decisions/sending-identity.md); an egress of seed tenants carries
                                         up to five of them and nothing of our sending (bh warmup seeds <admin>
                                         --egress <host name>)
  egress add <host name> --ip <ipv4> --proxy - [--region <region>] [--spare|--for-seeds]
                                         --proxy - reads http://user:pass@host:port from stdin (or asks, hidden)
                                         a host whose reverse DNS is <host name>, reached through its CONNECT proxy
  egress seeds <id> [off]               keeps the egress for the next group of Microsoft seed tenants' answers
                                         (out of the spares; never our sending's); the engine starts the next group
                                         there once the groups that have one are full (platform admin)
  egress active|spare|retire <id>        put an egress in use, set it aside as a spare, or retire it
  egress region <id> <region|none>       the cloud region the egress's address belongs to
  egress regions                         each region with the addresses the cloud lets us hold there
  egress quota <region> <addresses>      record a region's address quota as the cloud granted it (a new region too)
  egress assign <host name|none> --project <slug> | --company <name|id> | --mailbox <address>
                                         a client's mail, an agency company's, or one mailbox's, leaves through that
                                         egress (none: the engine's own address; for a mailbox, back to its project's
                                         or company's); a company's egress is its own
  linkedin                               this project's LinkedIn accounts, with today's invites and messages;
                                         notesOffUntil: LinkedIn's custom-note limit reached, invitations go
                                         without their note until then
  linkedin available                     accounts linked in Unipile that no project has attached
  linkedin connect <unipile-account-id> [--sender <id>] [--invite-limit <n>] [--message-limit <n>]
                                         attaches it to the sender named like its owner unless --sender
  linkedin invite --sender <id>          a link for the sender's owner to sign in to their LinkedIn without
                                         access to the tool; a disconnected account is signed in again
  linkedin update <id> [--invite-limit <n>] [--message-limit <n>] [--delay-min <s>] [--delay-max <s>] [--status active|paused|archived]
       [--ramp yes|no]                   yes: invitations climb again from 5 a day, starting now
  linkedin pages <id>                    the company pages the account's owner manages: a post can go out as one
  linkedin posts [--status scheduled|publishing|published|failed|cancelled]   this project's posts, by time
  linkedin post --file <json|jsonl|-> [--dry-run]   schedules posts, all or none; the engine publishes each at its
                                         time, then its first comment, as the same author
                                         [{"linkedinAccountId","publishAt","text","pageId","firstComment","images"}]
                                         publishAt names its offset (2026-10-22T09:00:00-04:00); without pageId the
                                         post is the owner's own, refused unless profile posts are on for the
                                         account (bh linkedin profile-posts); an @ before a name is a mention;
                                         images: 1 to 9 PNG or JPEG paths (the file's folder unless absolute),
                                         each at most 5 MB and 6012 px a side, shown in that order
  linkedin post cancel <post-id>         a scheduled post is not published
  linkedin accounts <org>                the organisation's LinkedIn accounts: managed ones with their IP, login,
                                         sign-in and owner, and hosted-link ones
  linkedin create <org> --sender <id> [--country <US>] [--owner <user id>] [--invite-limit <n>]
       [--sign-up [--first <n>] [--last <n>] [--email <address>]]
                                         (an organisation admin) a managed account: an IP of its own in the sender's
                                         company's country, for good; --sign-up: still to be made on LinkedIn, with a
                                         password the engine makes and, for a company's person, their workplace mailbox
  linkedin show|history <id>             one account; what was done to it (the id bh linkedin or bh linkedin
                                         accounts prints, for a project's sender's account too)
  linkedin requests <id> [--day <YYYY-MM-DD>]   what it asked LinkedIn: 14 UTC days' totals with each
                                         operation's count, and the day's requests one by one (today by default)
  telegram                               this project's Telegram accounts: a sender's own Telegram, written to
                                         only for people it already knows (docs/decisions/telegram.md)
  telegram connect --sender <id> [--org <slug>]   a link for the sender's owner to link their Telegram (a QR code
                                         from the phone, Telegram → Devices); --org: an agency sender's, in Admin
  telegram invite --sender <id>          a link (7 days, once) for the sender's owner to link their Telegram
                                         without access to the tool; a disconnected account is linked again
  telegram reconnect <id>                a link to link a disconnected account again, as the same account
  telegram update <id> [--message-limit <n>] [--delay-min <s>] [--delay-max <s>] [--status active|paused|archived]
                                         at most 100 a day, delays at least 20 s
  telegram peers <id> [--search <text>] [--unmatched] [--set-aside] [--refresh]   the people the account
                                         already talks to, the latest first, and the contacts each is;
                                         --refresh: reads its chats now
  telegram match <peer-id> --contact <id>     says which contact the peer is (the account may write to them)
  telegram unmatch <peer-id> --contact <id>   takes it back
  telegram set-aside <peer-id> [--undo]  never offered, never written to (family, friends)
  linkedin login <id> [--username <address>] [--totp]   stores its LinkedIn login, sealed (password and key hidden)
  linkedin sign-in <id> [--browser]      signs it in to Unipile on its own IP now (the engine also does, every 6 h);
                                         --browser: with the session its remote browser holds
  linkedin checkpoint <id> [--code <c>]  the code LinkedIn asked for; no code waits for an approval in the app
  linkedin code|password <id>            its authenticator code now, or its password (both recorded)
  linkedin created|verified <id> [--owner <user id|none>] [--undo]   marks it made on LinkedIn, or through its checks
  linkedin profile-posts <id> on|off     (a person) posts on its owner's own profile allowed, or not: off, it posts
                                         only as the pages they manage
  linkedin warmup <id> [--likes-a-day <0-10|default>] [--comments-a-day <0-3>] [--topics "<a, b>"]
                                         (an organisation admin) what a managed account does by itself each day: likes
                                         (connections' posts first, else its feed; default: 2 or 3), comments your own
                                         Claude writes, the topics its feed is searched for; no flag: as it is set
  linkedin feed <id>                     the posts a comment may go under now, with their text, and the comments left
                                         today (two LinkedIn requests)
  linkedin comment <id> --post <post-id> --text <t> [--url <post url>] [--author <name>]
                                         comments under a post bh linkedin feed showed: in its working hours, within
                                         its comments a day, 15-300 characters, no link, hashtag or mention
  linkedin owner <id> <user id|none>     who works in its browser
  linkedin open <id> [--chrome <path>]   its browser on this computer: your own Google Chrome through its IP, with
                                         its cookies (an organisation admin); close the window when done and the
                                         cookies go back. For what the remote browser cannot pass (sign-up's captcha)
  linkedin email-link <id>               opens LinkedIn's latest link to confirm an added address (last 30 minutes,
                                         from its mailbox) in its open browser, on its own IP
  linkedin phone <id> --rent             (an organisation admin) rents it a US mobile number of its own at TextVerified,
                                         renewing monthly, for LinkedIn's texts; only on a US IP, one live number each
  linkedin phone-number <id>             types its number into LinkedIn's phone form in its open browser and sends it,
                                         then types the code LinkedIn texts to it
  linkedin phone-code <id>               types LinkedIn's latest texted code (last 10 minutes) into its open browser
  linkedin mailbox <id> --workplace      its LinkedIn codes read from its person's workplace mailbox (an account
                                         that was theirs before they joined a company; refused until it is
                                         connected); the address on LinkedIn itself is changed in its browser
  linkedin archive <id> [--undo]         after the undo window: signed out of Unipile, its IP never given again
  linkedin link <id>                     a link to its browser for its owner: opened within 15 minutes, on one
                                         device, which then works in it for an hour; a newer link stops it
  linkedin member list|add <org> [--email <a> --name <n>]   people who sign in to work in their own account
  linkedin member password|disable|enable <org> <user id>   (an organisation admin; passwords asked hidden)
  proxy list                             the LinkedIn IP pool: free, in use, failing, retired (the platform admin's)
  proxy add --country <US> --host <h> --port <n> --username <u> --provider <name> [--paid-until <YYYY-MM-DD>]
            [--usd-month <n>]           checked through itself first; the password is asked hidden; --usd-month
                                         is what it costs a month (4.00 unless given), which Spend counts
  proxy update <id> [--paid-until <date|none>] [--usd-month <n>] [--username <u>]   a new login is checked
                                         before it is kept
  proxy check|retire|unretire <id>
  inbox                                  replies waiting for triage, with the engine's classification
  answers [--all]                        what waits for your own Claude to write, across your projects: your leads'
                                         replies with no answer, answers and rewrites you asked for, drafts a client's
                                         answer reached, follow-up copy (--all: every project you see)
  inbox test-send --from <our address> --to <our address> [--subject <t>] [--body <t>] [--reply]
                                         a test of the round trip: sends through the provider; the
                                         answer reaches the inbox only through the reader. --reply answers
                                         the newest message --to sent --from
  inbox placement --mailbox <our address> --message-id <id>   where it landed: INBOX, SPAM, a tab
  thread <id>                            the whole conversation, with our replies; "colleagues": the company's
                                         other leads still in a plan (inThread / inDraft: the thread or our
                                         waiting answer copies them)
  thread pause-colleagues <id> [--only <enrollment-id,…>]   pause those still running or scheduled, reason
                                         colleague_replied; lead unpause lets one go on (a person only)
  threads [--status open|waiting|closed] [--from <address|domain>] [--lead none|any] [--since <date>] [--limit <n>]
                                         the project's conversations, newest first, those with no lead too;
                                         --from: anyone in it wrote from that address or domain
  threads close --note <why> (--ids <id,…> | --file <ids.txt> | the filters above)   closes each as thread
                                         close does; with filters, every conversation they list
  thread forward <id> --to <address> [--messages <id,…>]   copies of what we sent in it, from its own mailbox,
                                         to a team address; each message goes once (a person only)
  thread close <id> --note <why>         no answer needed: it leaves Needs reply until the lead
                                         writes again; the note says why, for whoever reads the
                                         thread later (again on a closed thread: replaces the note)
  thread reopen <id>                     takes "no answer needed" back
  thread attachments <message-id>        the files a message carried, read from its mailbox, then the pictures it
                                         shows in place (inline: true; a signature's logo, or a pasted photo that is
                                         the whole reply)
  thread refetch <message-id>            a LinkedIn message asked for again: its text, what it carried (files, a
                                         voice note, a sticker, a shared post), and bodyMissing when still empty
  thread attachment <message-id> <n> [--out <file>]   saves file or picture n (from the list) as bh-attachments/<message-id>/<n>-<its name>,
                                         or --out; never over a file already there
  thread stage <id> opportunity|proposal|won|lost|none   where the deal with its lead stands after they answered
  triage <message-id> [--class <c>] [--note <t>] [--follow-up <yyyy-mm-dd>] [--return <yyyy-mm-dd>] [--keep]
  triage undo <message-id>              take it back: an unsubscribe within 60 s, or back into the queue
                                         confirm or change what a reply means; no --class marks it handled;
                                         --keep leaves it in To review for a person (a project rule) and no
                                         server run is given it again
  reply draft <thread-id> --body <text> | --body-file <path> [--note <for the approver>] [--send-at <iso>]
       [--approve-by <iso>] [--sender <id>] [--cc a@x.com,b@y.com] [--bcc c@z.com] [--subject <s>]
       [--reviewer <email>]              who approves it; its Slack notice goes to them (left out: you, when you
                                         draft in your own session; else whoever launched the lead's strategy)
                                         --subject sends it under that subject, exactly as written (left out:
                                         "Re: " and the subject of the lead's last message; "" for that)
                                         --cc copies people in the open (left out: whom the lead's message
                                         copied, bh thread's replyCc, and the project's --reply-cc; "" for none),
                                         --bcc without the lead seeing them
                                         (left out: the project's, bh project update --reply-bcc; "" for none)
       [--attach <file>]…                 a file to send with it (repeat for more): only in an answer to a lead who
                                         wrote in this email thread; PDF, PNG, JPEG, .docx, .xlsx or .pptx, at most
                                         3 and 2 MB together, no macros, scripts or passwords
       [--slots <iso,iso> [--calendar <id>]]   the times it offers (from bh slots, or the thread's own): held with
                                         it while it waits and for 72 h once it is sent; dropped, they are let go
       [--to <address>] [--in-reply-to <message-id>]   whom it goes to, under which message of the thread (left
                                         out: whoever wrote last, under their message; a new version keeps the
                                         waiting draft's): someone a message there names — its writer, or whom it
                                         was written to or copied, such as a colleague the lead introduced in an
                                         email of its own. --to alone: under the newest message naming them;
                                         --in-reply-to alone: to whoever wrote it. Copies default to the rest of
                                         that message (the lead who introduced them)
  reply draft --contact <id> --subject <s> --body <text> | --body-file <path> [--mailbox <address>]
       [--note …] [--send-at …] [--approve-by …] [--reviewer …] [--cc …] [--bcc …]
                                         a first email to a lead we have no email thread with (met on a call,
                                         sequence not started): opens a thread on the mailbox their plan writes
                                         from (--mailbox: another of the project's), approved and sent as an
                                         answer; refused when a thread exists (write in it), no files or times
  replies [--status draft|approved|sent|failed|discarded]
  reply approve <id> [--body <final text>] [--cc …] [--bcc …] [--subject <s>] [--send-at <iso|"">]
       [--approve-by <iso|"">]           (a person only); --send-at "" sends it as soon as it may
       [--allow-dnc --reason <why>]       it goes even to an address on do-not-contact: a compliance answer (a data-
                                         subject request) on the lead's own thread; recorded, the entry stays
  reply discard <id>                     withdraws a draft, an approved reply not gone yet, or a failed one
  reply retry <id>                       sends a failed reply again as it was, after the undo minute (a person only);
                                         a LinkedIn answer that may have gone is looked for in its chat first
  reply check <id>                       a failed LinkedIn answer looked for in its chat, sending nothing: found,
                                         it is recorded as sent; not found, it stays failed
  reply resend <id> --mailbox <address> --reason <why> [--subject <s>] [--send-at …] [--approve-by …] [--reviewer …]
                                         a sent answer the lead never received, again from another of the
                                         project's mailboxes: a new thread there, the same text and copies as its
                                         draft (--subject: left out, the one it went under), approved and sent as
                                         any answer (a person only)
  reply reschedule <id> --send-at <iso|now>   moves when a draft or an approved reply goes, same id (now: as
                                         soon as it may; an approved one: a person only)
  reply assign <id> --reviewer <email>   who approves a draft: its Slack notice goes to them, posted anew
  reply revise <id> --body <text> | --body-file <path> [--note <for the approver>] [--cc …] [--bcc …]
       [--subject <s>] [--send-at <iso|"">] [--approve-by <iso|"">] [--attach <file>]… | [--no-attach]
                                         a new version of a draft; --cc/--bcc replace its copies ("" for none),
                                         --subject its subject (left out: it keeps it; "" for the lead's own),
                                         --attach its files (left out: it keeps them), --no-attach takes them off;
                                         the same text with a new --note or time keeps the same id
  reply rewrite <id> --ask <what to change>   your own Claude rewrites it on its next pass (bh answers) | reply versions <id>
  reply ask <thread-id> [--ask <what to say>]  your own Claude writes the answer on its next pass (a person only)
  reply-templates <strategy-id>          the fixed answers the engine sends on its own, by kind of reply
  reply-template approve <strategy-id> --class interested|meeting|question --body <text> | --body-file <path> [--cc a@x.com,b@y.com]
  reply-template approve <strategy-id> --class out_of_office|referral --subject <s> --body-file <path>
                                         a first email the engine sends on its own to the colleague an away note
                                         or a referral names, once Bouncer calls their address valid; no --cc;
                                         slots {first_name} {referrer_first_name} {referrer_name} {company}
                                         ({referrer_name}: the full name, "Gabriel Kesseler said to reach out")
                                         slots {first_name} {company}; --cc copies people in the open; replaces that kind's answer (a person only)
  reply-template archive <id>            take an automatic answer out of use (a person only)
  providers                              what bh call reaches, whether it is configured, prices, credits left
  providers price <provider> --usd <n>   the dollar price of one credit (an admin); books earlier calls at it
  limits                                 what each paid tool has left, how fast it goes, and which are low
  limits read                            read every balance now (an admin)
  limits set <tool> --below <n>|off      alert #home-alerts below this (an admin); limits reset <tool> to the default
  call <provider> <METHOD> <path?query> [--body <json> | --body-file <path|->] [--again]
       [--strategy <id>] [--segment <id>] [--source <id>] [--search <id>] [--company <id>] [--contact <id>]
                                         the provider's answer on stdout, untouched; cost and refusals on stderr
                                         (a refusal's details.callId names the earlier call); a collect with no refs
                                         is tied to its submit's; the leading "/" may be left out (Git Bash rewrites it)
  call show <call-id>                    an earlier call with what the provider answered (use it again instead of paying again),
                                         and what it delivered later (Apollo's phones) under deliveries
  cache person <linkedin-url>            what was bought about a person, any project, free; a Generect enrichment by URL
                                         is answered from here by itself (--again buys it anew)
  cache company <linkedin-url> | cache company --domain <d>    the same for a company
  cache people <company-url|linkedin-id> [--former]           the people bought so far who work there (not all of them)
  hiring                                 our copy of companies' public job boards (Greenhouse, Lever, Ashby,
                                         Workable): boards and open postings per ATS, and how fresh; free
  hiring companies --body <json> | --body-file <path|->
                                         companies by the postings they have open: titles, notTitles (regex),
                                         departments, postedWithinDays, countries, remote, ats, domains,
                                         minPostings, employees {from,to}, withDomain, limit, offset
  hiring postings --body <json> | --body-file <path|->    the matching postings themselves, newest first
  hiring boards --domain <d> | hiring boards <ats> <slug>  the boards we hold and how their reads went
  hiring boards add --file <jsonl> [--source import:<list>]
                                         boards to read from now on: {"ats","slug","name"?,"domain"?} a line
  spend [--from <date>] [--to <date>]    this month's spend by provider unless dates are given, and credits left;
                                         perLead: provider spend per lead enrolled with a valid address, by step,
                                         against the project's limit
  spend add --provider <p> --operation subscription|data_purchase|infrastructure|llm|other --usd <n> [--note <t>]
  address check <contact-id> --address <a> [--provider bouncer|scrubby] [--reason bounce_replacement|catch_all|new_contact] [--again]
                                         up to three guesses per bounced contact; Scrubby answers later
  address checks <contact-id> | address collect      collect: Scrubby's answers for the project
  address replace <contact-id> --address <a> [--reason <why>]   a confirmed address: the bounced step goes again to it;
                                         without a bounce (a lead who named another address), the plan and the
                                         answers in their thread go to it from now on; --reason is kept with the change
  reengage <message-id> [--on <yyyy-mm-dd>]           write again from that day; the id is the reply's, from bh inbox (a person only)
  refer <message-id> --email <e> [--first-name <n>] [--last-name <n>] [--title <t>]   the colleague they named (a person; the server agent only from a lead's referral, to a checked valid address);
                                         names given set theirs on a contact already held; the lead's whole plan is
                                         copied and its steps need copy (bh copy queue)
  token create --name <n> [--kind scheduled_agent] [--for <email>] | token list | token revoke <id> | token unrevoke <id>
  oauth-client add --name <n> --redirect <uri,...> [--auth basic|post]   a confidential client of Dylan's
                                         OAuth server, for an agent platform that asks for an id and a
                                         secret (an admin only); the secret is shown once
  oauth-client list | oauth-client remove <client-id>   remove ends every connection made through it
  platform                              every organisation side by side — people, projects, running strategies,
                                         sent in 7 days, meetings booked in 30 — and the platform admins (platform admin)
  admins | admin add <email> [--name <n>] | admin remove <user-id|email>   platform admins reach every
                                         organisation without being added to it; nobody removes themselves (platform admin)
  user add --email <e> --name <n> [--admin] | users
  user set <id> [--email <e>] [--name <n>] [--admin|--no-admin]   correct a person's record (an admin only);
                                         the email is what Google sign-in matches
  user disable <id> | user enable <id>   refuse or restore every session and token they hold
  slack                                  the workspaces the bot is in (ours is home), each project's channel,
                                         and what is reaching nobody
  slack connect [--project <slug>]       the install URL to open in a browser; with a project, Slack's
                                         own screen picks the workspace (a client's own too: its admin
                                         approves the app there) and the channel its nudges go to, and
                                         joins the app to it (a private channel included)
  slack channel <#channel|id|none> [--team <workspace>]   the project's fallback for people without Slack
                                         linked, in its workspace (or the one named); "none" leaves it quiet
  slack channel <#channel|id|none> --client [--team <workspace>]   the channel the project's client
                                         is in: their messages there reach the platform, no nudge goes
                                         there; the app must be in it (/invite @Belkins Home)
  slack client-channel create [--name <channel>] [--invite <email,...>]   Home makes the project's
                                         client channel (private, ours) unless it has one, adds the
                                         project's team, and asks the client in through Slack Connect:
                                         these addresses and every client granted the project
  slack client-channel briefs-only <on|off>   on: the client channel gets booked meetings' briefs
                                         only, and the summary after a meeting goes to the team
                                         channel instead of under the brief
  slack disconnect [--team <workspace>]  takes the bot out of one workspace (an admin only)
  slack post (--body <text> | --body-file <path|->) [--blocks-file <path|->] [--to <#channel|email>]
             [--thread <link|ts>] [--mention <email|name|member id, ...>] [--team <workspace>]
                                         the bot says it, in Markdown: to a channel, to a person by
                                         email, or to the project's channel; --thread answers under
                                         a message (Slack's "Copy link"); --mention notifies people,
                                         found by email, by name as Slack shows it, or by member id;
                                         --blocks-file posts a designed card instead (Block Kit JSON:
                                         a list of blocks, or {"blocks": [...]}), the body its
                                         notification text; only one of the two files may be -
`

/**
 * An id or name a command takes and was not given (`bh copy queue` with no strategy id): refused
 * before a request names "undefined" (belkins-home-plugin#217), with the command's usage line.
 */
class MissingArgument extends Error {}

/**
 * A value put into a request's path or query: `?`, `#` or `/` in it must not reach another route,
 * and a value left out is refused (MissingArgument) rather than sent as "undefined".
 */
const seg = (value: unknown) => {
  if (value === undefined || value === null || String(value).trim() === '')
    throw new MissingArgument()
  return encodeURIComponent(String(value))
}

/** The usage lines (USAGE) of `bh <cmd> <sub>`, or of `bh <cmd>` when it has no such sub-command. */
function usageOf(cmd: string | undefined, sub: string | undefined): string[] {
  if (!cmd) return []
  const shapes = USAGE.split('\n')
    .flatMap((line) => line.trim().split(/\s{3,}|\s\|\s/))
    .map((x) => x.trim())
  const of = (name: string) =>
    shapes.filter((x) => x === name || x.startsWith(`${name} `)).map((x) => `bh ${x}`)
  return (sub ? of(`${cmd} ${sub}`) : []).concat(sub && of(`${cmd} ${sub}`).length ? [] : of(cmd))
}

/** A missing id or name, said as bh says any usage error: what is missing, and the command's usage. */
function missingArgument(argv: readonly string[]): BhError {
  const { positionals: pos } = parsed([...argv])
  const [cmd, sub] = pos
  const usage = usageOf(cmd, sub)
  return new BhError(
    `bh ${pos.join(' ')}: an id or name it needs is missing`,
    { hint: usage.length ? usage.join(' | ') : 'bh --help' },
    2,
  )
}

/** A list flag: items split on "|" (titles can hold commas), or on "," when there is no "|". */
const list = (v: string) =>
  v
    .split(v.includes('|') ? '|' : ',')
    .map((x) => x.trim())
    .filter(Boolean)

const out = (value: unknown): void => {
  // Where the object is worked on in the web app (the engine adds it when WEB_URL is set); on
  // stderr, so the JSON on stdout stays what a script reads. Written once stdout has taken the
  // whole answer: a pipe's writes are asynchronous on macOS, and with both streams on one pipe
  // (2>&1) a line written meanwhile can land inside a string of the JSON, its line break a raw
  // control character a parser refuses (#1011).
  const link = linkOf(value)
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`, () => {
    if (link) process.stderr.write(`open: ${link}\n`)
  })
}

/** The web link an answer carries: its own, or the one its rows share. */
function linkOf(value: unknown): string | null {
  const first = Array.isArray(value) ? value[0] : value
  const link = first && typeof first === 'object' ? (first as { link?: unknown }).link : null
  return typeof link === 'string' && link ? link : null
}

const addresses = (list: string) =>
  list
    .split(',')
    .map((a) => a.trim())
    .filter(Boolean)

/** --cc and --bcc as given: a flag left out keeps what is there, an empty one clears it. */
/** `--attach <file>`…: the files to send with an answer, as the engine takes them; `--no-attach` none. */
async function attached(o: { attach?: string[]; 'no-attach'?: boolean }) {
  if (o['no-attach']) return { files: [] }
  if (!o.attach?.length) return {}
  return {
    files: await Promise.all(
      o.attach.map(async (path) => ({
        name: basename(path),
        content: (await readFile(path)).toString('base64'),
      })),
    ),
  }
}

/** A reply's times as given: '' takes one off (sends as soon as it may, or no approve-by). */
function times(o: { 'send-at'?: string; 'approve-by'?: string }) {
  return {
    ...(o['send-at'] !== undefined ? { sendAt: o['send-at'] } : {}),
    ...(o['approve-by'] !== undefined ? { approveBy: o['approve-by'] } : {}),
  }
}

/** Flags every command reads: which API, whose token, which project; --help prints the usage. */
const EVERYWHERE = ['api', 'token', 'project', 'help']

/** A flag a command does not read is refused, so nobody believes it took effect. */
function takesOnly(o: Record<string, unknown>, command: string, flags: string[]) {
  const stray = Object.keys(o).filter(
    (k) => o[k] !== undefined && !EVERYWHERE.includes(k) && !flags.includes(k),
  )
  if (stray.length)
    throw new BhError(
      `bh ${command} does not take ${stray.map((f) => `--${f}`).join(', ')}`,
      {
        hint: flags.length
          ? `It takes ${[...new Set(flags)].map((f) => `--${f}`).join(', ')}`
          : 'It takes no flags',
      },
      2,
    )
}

/**
 * A secret given as a flag's value, or `-`: read from stdin, or asked with the typing hidden at a
 * terminal, so it stays out of the shell's history.
 */
async function secret(value: string, question: string): Promise<string> {
  if (value !== '-') return value
  const [answer] = await readSecrets([question])
  if (!answer?.trim()) throw new BhError('Nothing came on stdin', { hint: question.trim() }, 2)
  return answer.trim()
}

/** `--allow-dnc` needs `--reason`: why this one answer goes past do-not-contact. */
function dncOverride(reason: string | undefined): string {
  if (!reason?.trim())
    throw new BhError(
      'Why must it go past do-not-contact?',
      { hint: '--allow-dnc --reason "GDPR article 15 request"' },
      2,
    )
  return reason.trim()
}

function copies(o: { cc?: string; bcc?: string }) {
  return {
    ...(o.cc !== undefined ? { cc: addresses(o.cc) } : {}),
    ...(o.bcc !== undefined ? { bcc: addresses(o.bcc) } : {}),
  }
}

/** A dialer list's attempt policy, from --attempts, --spacing (minutes) and --open-days. */
function attemptsOf(o: { attempts?: string; spacing?: string; 'open-days'?: string }) {
  return {
    ...(o.attempts ? { attempts: Number(o.attempts) } : {}),
    ...(o.spacing ? { spacingMinutes: Number(o.spacing) } : {}),
    ...(o['open-days'] ? { openForDays: Number(o['open-days']) } : {}),
  }
}

/** `--hours 08:00-18:00`: a dialer queue's calling hours, as minutes since local midnight. */
function callingHours(value: string | undefined) {
  if (!value) return {}
  const m = value.match(/^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/)
  if (!m) throw new BhError('Calling hours are HH:MM-HH:MM', { hint: '--hours 08:00-18:00' }, 2)
  const [, fh, fm, uh, um] = m.map(Number)
  return { callFromMinute: fh! * 60 + fm!, callUntilMinute: uh! * 60 + um! }
}

/** `--default-pool yes|no`: whether a tenant takes domains approved without naming a tenant. */
function defaultPool(value: string | undefined): { defaultPool?: boolean } {
  if (value === undefined) return {}
  if (['yes', 'true'].includes(value)) return { defaultPool: true }
  if (['no', 'false'].includes(value)) return { defaultPool: false }
  throw new BhError(`--default-pool takes yes or no, not ${value}`, {}, 2)
}

/** `--role clients|network`: what a tenant is for — clients' domains, or a pod's network companies. */
function tenantRole(value: string | undefined): { role?: 'clients' | 'network' } {
  if (value === undefined) return {}
  if (value === 'clients' || value === 'network') return { role: value }
  throw new BhError(`--role takes clients or network, not ${value}`, {}, 2)
}

/**
 * The Pax8 subscription a Microsoft tenant bought through Pax8 holds its seats in, so the engine
 * buys them there; `none` puts it back on its Azure bill.
 */
function pax8Subscription(o: Record<string, unknown>): { pax8Subscription?: string | null } {
  const given = o['pax8-subscription']
  if (typeof given !== 'string') return {}
  return { pax8Subscription: given === 'none' ? null : given }
}

/** A closeout search's filters as a query string; what is not given is left to the engine. */
function closeoutQuery(o: Record<string, unknown>): URLSearchParams {
  const q = new URLSearchParams()
  const pairs: [string, unknown][] = [
    ['query', o.query],
    ['ageMin', o['age-min']],
    ['priceMaxCents', o['price-max-cents']],
    ['tld', o.tld],
    ['limit', o.limit],
    ['names', o.names],
  ]
  for (const [k, v] of pairs) if (typeof v === 'string' && v) q.set(k, v)
  return q
}

/** `--<name> yes|no` as a boolean field of the same name; absent when not given. */
function yesNo(name: string, value: string | undefined): Record<string, boolean> {
  if (value === undefined) return {}
  if (['yes', 'true', 'on'].includes(value)) return { [name]: true }
  if (['no', 'false', 'off'].includes(value)) return { [name]: false }
  throw new BhError(`--${name} takes yes or no, not ${value}`, {}, 2)
}

/** A long text from --<name> or --<name>-file <path|-> (stdin), never both (belkins-home-plugin#112). */
async function textOf(
  name: string,
  inline: string | undefined,
  file: string | undefined,
): Promise<string | undefined> {
  if (file !== undefined && inline !== undefined)
    throw new BhError(`Give --${name} or --${name}-file, not both`, {}, 2)
  return file !== undefined ? readText(file) : inline
}

/** A text field when it has something in it; absent otherwise. */
const withText = (field: string, value: string | undefined): Record<string, string> =>
  value ? { [field]: value } : {}

/** `none` clears a field; anything else is its value. */
const orNone = (value: string) => (value === 'none' ? null : value)

/**
 * The agency's companies (docs/decisions/sending-network.md): `bh company <sub> <org> [<company>] …`.
 * An egress is given through `/egresses/assign`, so a company's address follows the same rules as
 * every other.
 */
async function company(
  config: Awaited<ReturnType<typeof loadConfig>>,
  sub: string | undefined,
  rest: string[],
  o: Record<string, string | string[] | boolean | undefined>,
) {
  const [org, ref, ...more] = rest
  const text = (v: unknown) => (typeof v === 'string' ? v : undefined)
  if (!org)
    throw new BhError('Which organisation?', { hint: `bh company ${sub ?? 'list'} belkins …` }, 2)
  const base = `/orgs/${encodeURIComponent(org)}/companies`
  const one = () => {
    if (!ref) throw new BhError('Which company?', { hint: `bh company list ${org} names them` }, 2)
    return `${base}/${encodeURIComponent(ref)}`
  }
  /** The fields a company is added or changed with, from the flags given. */
  const fields = () => {
    const f: Record<string, unknown> = {}
    const set = (flag: unknown, field: string) => {
      const v = text(flag)
      if (v !== undefined) f[field] = orNone(v)
    }
    set(o.name, 'name')
    set(o.domain, 'mainDomain')
    set(o.site, 'siteUrl')
    set(o.linkedin, 'linkedinUrl')
    set(o.address, 'postalAddress')
    set(o.country, 'country')
    set(o['google-tenant'], 'workspaceTenant')
    set(o['microsoft-tenant'], 'microsoftTenant')
    const pod = text(o.pod)
    if (pod !== undefined) f.pod = pod === 'none' ? null : Number(pod)
    return f
  }
  const egress = async (name: string) => {
    const egressName = text(o.egress)
    if (egressName === undefined) return {}
    const answer = (await call(config, 'POST', '/egresses/assign', {
      egress: orNone(egressName),
      company: name,
    })) as { egress: string | null }
    return { egress: answer.egress }
  }
  switch (sub) {
    case undefined:
    case 'list':
      return out(await call(config, 'GET', base))
    case 'show':
      return out(await call(config, 'GET', one()))
    case 'add': {
      if (!text(o.name) || !text(o.domain))
        throw new BhError(
          'A company needs its name and main domain',
          {
            hint: `bh company add ${org} --name "Larkspan Partners" --domain larkspanpartners.com`,
          },
          2,
        )
      const made = (await call(config, 'POST', base, fields())) as { id: string; name: string }
      return out({ ...made, ...(await egress(made.id)) })
    }
    case 'update': {
      const { status } = o
      const body = { ...fields(), ...(typeof status === 'string' ? { status } : {}) }
      const changed = Object.keys(body).length
        ? ((await call(config, 'PATCH', one(), body)) as { id: string })
        : ((await call(config, 'GET', one())) as { id: string })
      return out({ ...changed, ...(await egress(changed.id)) })
    }
    case 'add-person': {
      // The whole onboarding: sender, mailboxes, warm-up and the LinkedIn account asked for.
      const sender = more[0] ?? text(o.sender)
      if (!sender && !text(o.name))
        throw new BhError(
          'Who?',
          {
            hint: `bh company add-person ${org} <company> --name "Anna Reyes" [--title "…"], or a sender id`,
          },
          2,
        )
      const domains = text(o.domains)
      return out(
        await call(config, 'POST', `${one()}/onboard`, {
          ...(sender ? { senderId: sender } : { name: text(o.name) }),
          ...(text(o.title) ? { title: text(o.title) } : {}),
          ...(text(o.username) ? { username: text(o.username) } : {}),
          ...(domains
            ? {
                domains: domains
                  .split(',')
                  .map((d) => d.trim())
                  .filter(Boolean),
              }
            : {}),
          ...yesNo('sending', text(o.sending)),
          ...yesNo('linkedin', text(o.linkedin)),
        }),
      )
    }
    case 'remove-person': {
      const sender = more[0]
      if (!sender)
        throw new BhError('Which person?', { hint: `bh agency senders ${org} lists their ids` }, 2)
      return out(await call(config, 'DELETE', `${one()}/people/${encodeURIComponent(sender)}`))
    }
    case 'domains':
      if (!more.length)
        throw new BhError('Which domains?', { hint: `bh agency domains ${org} lists them` }, 2)
      return out(await call(config, 'POST', `${one()}/domains`, { domains: more }))
    case 'remove-domain':
      if (!more[0]) throw new BhError('Which domain?', {}, 2)
      return out(await call(config, 'DELETE', `${one()}/domains/${encodeURIComponent(more[0])}`))
    case 'order': {
      const rows = text(o.file)
        ? await readRows(text(o.file)!)
        : (text(o.domains) ?? '')
            .split(',')
            .map((d) => d.trim())
            .filter(Boolean)
            .map((domain) => ({
              senderId: text(o.sender),
              domain,
              firstName: text(o['first-name']),
              lastName: text(o['last-name']),
              username: text(o.username),
            }))
      if (!rows.length)
        throw new BhError(
          'Which mailboxes?',
          {
            hint: `bh company order ${org} <company> --sender <id> --first-name <n> --last-name <n> --username <u> --domains a.com,b.com, or --file`,
          },
          2,
        )
      return out(await call(config, 'POST', `${one()}/mailboxes`, { mailboxes: rows }))
    }
    case 'posts':
      return out(
        await call(
          config,
          'GET',
          `${one()}/linkedin-posts?${new URLSearchParams(text(o.status) ? { status: text(o.status)! } : {})}`,
        ),
      )
    case 'post':
      if (!text(o.file))
        throw new BhError(
          'Which posts?',
          {
            hint: `bh company post ${org} <company> --file posts.json   [{"linkedinAccountId","pageId","publishAt","text","firstComment","images"}]`,
          },
          2,
        )
      return out(
        await call(config, 'POST', `${one()}/linkedin-posts`, {
          posts: await withImages(await readRows(text(o.file)!), text(o.file)!),
          dryRun: Boolean(o['dry-run']),
        }),
      )
  }
  throw new BhError(
    `bh company has no ${sub}`,
    {
      hint: 'list, show, add, update, add-person, remove-person, domains, remove-domain, order, warmup, posts or post',
    },
    2,
  )
}

function need(file: string | undefined): string {
  if (!file)
    throw new BhError(
      'Where is the input?',
      { hint: '--file <path>, or --file - to read stdin' },
      2,
    )
  return file
}

/**
 * Where the project comes from, first found wins: --project, BH_PROJECT, then this Claude Code
 * session's `bh use`. Nothing is ever defaulted: a default is whatever someone picked last, and
 * acting on another client's project is the worst thing a wrong guess can do. A session that
 * picked more than one project names none (`several`): its subagents share the pick, and the one
 * picked last may be another agent's client (belkins-home-plugin#148).
 */
function currentProject(
  flag: string | undefined,
  session: SessionPick | undefined,
): { slug: string; from: string; several?: string[] } | null {
  if (flag) return { slug: flag, from: '--project' }
  if (process.env.BH_PROJECT) return { slug: process.env.BH_PROJECT, from: 'BH_PROJECT' }
  if (!session) return null
  return {
    slug: session.slug,
    from: 'bh use, this session',
    ...(session.picked.length > 1 ? { several: session.picked } : {}),
  }
}

function noProject(): BhError {
  return new BhError(
    SESSION ? 'No project in this session' : 'No project',
    {
      hint: SESSION
        ? 'bh use <slug> once per session, or --project <slug> on each command (a subagent always names it); bh projects lists them'
        : 'not in a Claude Code session, so bh use cannot hold: --project <slug> or BH_PROJECT; bh projects lists them',
    },
    2,
  )
}

/** Why a session that picked several projects is refused one: the agents in it share the pick. */
const SEVERAL =
  'This session picked more than one project, so bh use holds none: a Claude Code session and its subagents share one pick, and the last one may be another agent’s client'
function severalProjects(picked: string[]): BhError {
  return new BhError(
    SEVERAL,
    {
      picked,
      hint: 'name the project on every command: --project <slug>, or BH_PROJECT=<slug> before bh',
    },
    2,
  )
}

/** The one organisation the caller belongs to that pays from a wallet; asks for --org otherwise. */
async function onlyMeteredOrg(config: Parameters<typeof call>[0]): Promise<string> {
  const orgs = (await call(config, 'GET', '/orgs')) as { slug: string; billing: string }[]
  const metered = orgs.filter((x) => x.billing === 'metered')
  if (metered.length !== 1) throw new BhError('Name the organisation: --org <slug>', {}, 2)
  return metered[0]!.slug
}

/** Every flag bh knows; which command reads which is OPTIONS (options.ts). */
const FLAGS = {
  api: { type: 'string' },
  token: { type: 'string' },
  wait: { type: 'boolean' },
  'no-browser': { type: 'boolean' },
  totp: { type: 'boolean' },
  image: { type: 'string' },
  none: { type: 'boolean' },
  workplace: { type: 'boolean' },
  pending: { type: 'boolean' },
  rent: { type: 'boolean' },
  'sign-up': { type: 'boolean' },
  browser: { type: 'boolean' },
  chrome: { type: 'string' },
  first: { type: 'string' },
  last: { type: 'string' },
  'customer-id': { type: 'string' },
  city: { type: 'string' },
  'postal-code': { type: 'string' },
  'legal-name': { type: 'string' },
  website: { type: 'string' },
  'contact-phone': { type: 'string' },
  phone: { type: 'string' },
  country: { type: 'string' },
  confirm: { type: 'boolean' },
  unconfirm: { type: 'boolean' },
  'clear-linkedin': { type: 'boolean' },
  undo: { type: 'boolean' },
  refresh: { type: 'boolean' },
  unmatched: { type: 'boolean' },
  'set-aside': { type: 'boolean' },
  port: { type: 'string' },
  'paid-until': { type: 'string' },
  'usd-month': { type: 'string' },
  'seat-usd': { type: 'string' },
  'pax8-subscription': { type: 'string' },
  remove: { type: 'boolean' },
  project: { type: 'string' },
  name: { type: 'string' },
  slug: { type: 'string' },
  billing: { type: 'string' },
  price: { type: 'string' },
  grant: { type: 'string' },
  timezone: { type: 'string' },
  limit: { type: 'string' },
  hours: { type: 'string' },
  'area-code': { type: 'string' },
  kind: { type: 'string' },
  title: { type: 'string' },
  body: { type: 'string' },
  supersedes: { type: 'string' },
  all: { type: 'boolean' },
  assignee: { type: 'string' },
  priority: { type: 'string' },
  due: { type: 'string' },
  'done-when': { type: 'string' },
  status: { type: 'string' },
  note: { type: 'string' },
  only: { type: 'string' },
  skip: { type: 'string' },
  even: { type: 'boolean' },
  'to-provider': { type: 'string' },
  'change-sender': { type: 'boolean' },
  'to-sender': { type: 'string' },
  enrollment: { type: 'string' },
  stuck: { type: 'boolean' },
  summary: { type: 'string' },
  for: { type: 'string' },
  email: { type: 'string' },
  org: { type: 'string' },
  role: { type: 'string' },
  done: { type: 'string' },
  ask: { type: 'string' },
  admin: { type: 'boolean' },
  'admin-email': { type: 'string' },
  'max-domains': { type: 'string' },
  'max-users': { type: 'string' },
  'key-from': { type: 'string' },
  'default-pool': { type: 'string' },
  'google-tenant': { type: 'string' },
  'microsoft-tenant': { type: 'string' },
  site: { type: 'string' },
  linkedin: { type: 'string' },
  pod: { type: 'string' },
  domains: { type: 'string' },
  ramp: { type: 'string' },
  sending: { type: 'string' },
  tenant: { type: 'string' },
  env: { type: 'string' },
  platform: { type: 'string' },
  policy: { type: 'string' },
  'per-environment': { type: 'string' },
  ip: { type: 'string' },
  proxy: { type: 'string' },
  spare: { type: 'boolean' },
  region: { type: 'string' },
  'tenant-id': { type: 'string' },
  egress: { type: 'string' },
  'client-id': { type: 'string' },
  cert: { type: 'string' },
  'max-cents': { type: 'string' },
  closeout: { type: 'boolean' },
  'age-min': { type: 'string' },
  'price-max-cents': { type: 'string' },
  names: { type: 'string' },
  tld: { type: 'string' },
  redirect: { type: 'string' },
  auth: { type: 'string' },
  record: { type: 'string' },
  type: { type: 'string' },
  host: { type: 'string' },
  content: { type: 'string' },
  ttl: { type: 'string' },
  selector: { type: 'string' },
  username: { type: 'string' },
  'no-admin': { type: 'boolean' },
  'no-invite': { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
  provider: { type: 'string' },
  file: { type: 'string' },
  lead: { type: 'string' },
  messages: { type: 'string' },
  ids: { type: 'string' },
  titles: { type: 'string' },
  value: { type: 'string' },
  reason: { type: 'string' },
  contact: { type: 'string' },
  strategy: { type: 'string' },
  segment: { type: 'string' },
  persona: { type: 'string' },
  source: { type: 'string' },
  search: { type: 'string' },
  company: { type: 'string' },
  again: { type: 'boolean' },
  domain: { type: 'string' },
  former: { type: 'boolean' },
  'every-project': { type: 'boolean' },
  reviews: { type: 'string' },
  alerts: { type: 'string' },
  address: { type: 'string' },
  'brief-file': { type: 'string' },
  brief: { type: 'string' },
  criteria: { type: 'string' },
  'excluded-titles': { type: 'string' },
  seniorities: { type: 'string' },
  departments: { type: 'string' },
  hints: { type: 'string' },
  'approve-by': { type: 'string' },
  on: { type: 'string' },
  'first-name': { type: 'string' },
  'last-name': { type: 'string' },
  usd: { type: 'string' },
  below: { type: 'string' },
  estimate: { type: 'string' },
  cursor: { type: 'string' },
  query: { type: 'string' },
  target: { type: 'string' },
  counts: { type: 'string' },
  asked: { type: 'boolean' },
  operation: { type: 'string' },
  from: { type: 'string' },
  to: { type: 'string' },
  subject: { type: 'string' },
  reply: { type: 'boolean' },
  mailbox: { type: 'string' },
  'message-id': { type: 'string' },
  'dry-run': { type: 'boolean' },
  'with-mailboxes': { type: 'boolean' },
  after: { type: 'string' },
  plan: { type: 'string' },
  replace: { type: 'boolean' },
  q: { type: 'string' },
  waiting: { type: 'string' },
  state: { type: 'string' },
  offset: { type: 'string' },
  until: { type: 'string' },
  sender: { type: 'string' },
  recipients: { type: 'string' },
  intake: { type: 'string' },
  signature: { type: 'string' },
  'signature-html-file': { type: 'string' },
  out: { type: 'string' },
  'daily-share': { type: 'string' },
  'daily-limit': { type: 'string' },
  'invite-limit': { type: 'string' },
  'message-limit': { type: 'string' },
  'likes-a-day': { type: 'string' },
  'comments-a-day': { type: 'string' },
  topics: { type: 'string' },
  post: { type: 'string' },
  text: { type: 'string' },
  author: { type: 'string' },
  'domain-cap': { type: 'string' },
  'reply-bcc': { type: 'string' },
  'reply-cc': { type: 'string' },
  'copy-allow': { type: 'string' },
  'seed-hold': { type: 'string' },
  'pairing-wait': { type: 'string' },
  reviewer: { type: 'string' },
  'lead-cost-alert': { type: 'string' },
  'max-live-per-company': { type: 'string' },
  'allow-namesakes': { type: 'boolean' },
  'allow-written-before': { type: 'boolean' },
  stop: { type: 'string' },
  class: { type: 'string' },
  keep: { type: 'boolean' },
  cc: { type: 'string' },
  bcc: { type: 'string' },
  attach: { type: 'string', multiple: true },
  'no-attach': { type: 'boolean' },
  'follow-up': { type: 'string' },
  return: { type: 'string' },
  'body-file': { type: 'string' },
  'evidence-file': { type: 'string' },
  'blocks-file': { type: 'string' },
  'html-file': { type: 'string' },
  'reply-to': { type: 'string' },
  'in-reply-to': { type: 'string' },
  'send-at': { type: 'string' },
  'lead-timezone': { type: 'string' },
  'delay-min': { type: 'string' },
  'delay-max': { type: 'string' },
  warmed: { type: 'boolean' },
  'not-warmed': { type: 'boolean' },
  paused: { type: 'boolean' },
  key: { type: 'string' },
  'event-type': { type: 'string' },
  owner: { type: 'string' },
  url: { type: 'string' },
  day: { type: 'string' },
  days: { type: 'string' },
  calendar: { type: 'string' },
  slots: { type: 'string' },
  thread: { type: 'string' },
  mention: { type: 'string' },
  team: { type: 'string' },
  client: { type: 'boolean' },
  ours: { type: 'boolean' },
  as: { type: 'string' },
  ref: { type: 'string' },
  invite: { type: 'string' },
  at: { type: 'string' },
  through: { type: 'string' },
  minutes: { type: 'string' },
  freebusy: { type: 'string' },
  ics: { type: 'string' },
  'hours-only': { type: 'string' },
  buffer: { type: 'string' },
  notice: { type: 'string' },
  cap: { type: 'string' },
  window: { type: 'string' },
  outcome: { type: 'string' },
  'allow-repeat': { type: 'boolean' },
  'allow-dnc': { type: 'boolean' },
  attempts: { type: 'string' },
  spacing: { type: 'string' },
  'open-days': { type: 'string' },
  caller: { type: 'string' },
  queue: { type: 'string' },
  feedback: { type: 'string' },
  notes: { type: 'string' },
  upcoming: { type: 'boolean' },
  count: { type: 'string' },
  'max-orgs': { type: 'string' },
  'max-licences': { type: 'string' },
  'max-orgs-day': { type: 'string' },
  'google-key': { type: 'string' },
  'google-scopes': { type: 'string' },
  'microsoft-app': { type: 'string' },
  'microsoft-permissions': { type: 'string' },
  'max-tenants': { type: 'string' },
  'max-tenants-day': { type: 'string' },
  'max-seats': { type: 'string' },
  'placement-notes': { type: 'string' },
  'per-day': { type: 'string' },
  'max-microsoft': { type: 'string' },
  'for-seeds': { type: 'boolean' },
  'free-users': { type: 'string' },
  'free-domains': { type: 'string' },
  seeds: { type: 'string' },
  licences: { type: 'string' },
  retry: { type: 'boolean' },
  claim: { type: 'string' },
  evidence: { type: 'string' },
  'add-evidence': { type: 'string' },
  metric: { type: 'string' },
  threshold: { type: 'string' },
  verdict: { type: 'string' },
  dir: { type: 'string' },
  code: { type: 'string' },
  meaning: { type: 'string' },
  confidence: { type: 'string' },
  moved: { type: 'boolean' },
  number: { type: 'string' },
  rank: { type: 'string' },
  dnc: { type: 'boolean' },
  'dnc-reason': { type: 'string' },
  'dnc-note': { type: 'string' },
  label: { type: 'string' },
  'token-stdin': { type: 'boolean' },
  'no-emails': { type: 'boolean' },
  'no-domains': { type: 'boolean' },
  'no-phones': { type: 'boolean' },
  since: { type: 'string' },
  json: { type: 'boolean' },
  'per-person': { type: 'boolean' },
  auto: { type: 'string' },
  mine: { type: 'boolean' },
  'fixed-in': { type: 'string' },
  'duplicate-of': { type: 'string' },
} as const

/**
 * The flags as given. A flag bh does not know, or one missing its value, is a usage error (exit 2,
 * with a hint) like every other, not a crash.
 */
function parsed(argv: string[]) {
  try {
    return parseArgs({ args: argv, allowPositionals: true, options: FLAGS })
  } catch (error) {
    throw new BhError((error as Error).message.split('\n')[0]!, { hint: 'bh --help' }, 2)
  }
}

async function main(argv: string[]): Promise<void> {
  const { values: o, positionals: pos } = parsed(argv)
  const [cmd, sub, arg] = pos
  // Each command takes only the flags it reads (options.ts, made from this file), so a flag it
  // would drop is refused instead of silently ignored (belkins-home-plugin#112).
  const reads = cmd && !o.help ? OPTIONS[cmd] : undefined
  if (reads) {
    const named = sub !== undefined && Object.hasOwn(reads, sub)
    takesOnly(o, named ? `${cmd} ${sub}` : cmd!, [
      ...(reads['*'] ?? []),
      ...((named ? reads[sub] : sub === undefined ? reads[''] : undefined) ?? []),
    ])
  }
  // --api and --token go over BH_API, BH_TOKEN and the saved login, for every request this run makes.
  if (o.token === '-') o.token = await secret('-', 'Token: ')
  const config: BhConfig = {
    ...(await loadConfig()),
    ...(o.api ? { api: o.api } : {}),
    ...(o.token ? { token: o.token } : {}),
  }

  const current = currentProject(o.project, await loadSessionProject())
  const p = () => {
    if (!current) throw noProject()
    if (current.several) throw severalProjects(current.several)
    return encodeURIComponent(current.slug)
  }
  /** A file of rows, sent in chunks; a row the engine refused makes the exit non-zero. */
  const batch = async (path: string, rows?: unknown[]): Promise<void> => {
    const answer = await sendRows(config, path, rows ?? (await readRows(need(o.file))))
    out(answer)
    const refused = refusedIn(answer)
    if (refused) {
      process.stderr.write(`refused: ${refused} ${refused === 1 ? 'row' : 'rows'}, see "refused"\n`)
      process.exitCode = 1
    }
    const warned = warnedIn(answer)
    if (warned)
      process.stderr.write(`warned: ${warned} ${warned === 1 ? 'row' : 'rows'}, see "warnings"\n`)
  }

  /** The engine names a domain by id; people and agents name it by itself, in this project. */
  const domainId = async (name: string | undefined): Promise<string> => {
    if (!name) throw new BhError('Which domain?', { hint: 'Name it: bh domain … getacme.com' }, 2)
    const rows = (await call(config, 'GET', `/projects/${p()}/domains`)) as {
      id: string
      domain: string
    }[]
    const found = rows.find((r) => r.domain.toLowerCase() === name.toLowerCase())
    if (!found)
      throw new BhError(
        `${name} is not a domain of project ${current!.slug}`,
        { hint: 'bh domains lists them' },
        2,
      )
    return found.id
  }

  /**
   * The project's set-up checklist, as the web app's Setup shows it (#1036); given a step, that
   * optional step skipped (or, with --undo, taken back up) first.
   */
  const checklist = async (skip: string | undefined) => {
    const asked = sub === 'setup' ? arg : sub
    if (asked === 'skip') {
      if (!skip)
        throw new BhError(
          'Which step?',
          { hint: 'bh project setup skip <step> [--undo]; bh project setup lists the steps' },
          2,
        )
      await call(config, 'PUT', `/projects/${p()}/setup/skip`, { step: skip, skipped: !o.undo })
    }
    return call(config, 'GET', `/projects/${p()}/setup`)
  }

  if (!cmd || o.help) return void process.stdout.write(USAGE)
  switch (cmd) {
    case 'setup':
      // `bh setup status` and `bh setup skip` are the project's checklist, as the issue that asked
      // for it named them; a bare `bh setup` is still the plugin's install.
      if (sub === 'status' || sub === 'skip')
        return out(await checklist(sub === 'skip' ? arg : undefined))
      return out(await setup(o.dir))
    case 'login': {
      const saved = await loadSavedConfig()
      if (o.token) {
        // Saved only once the engine takes it: a token pasted wrong must not replace a working one.
        const next = { ...saved, api: config.api ?? DEFAULT_API, token: o.token }
        const me = await call(next, 'GET', '/me')
        await saveConfig(next)
        return out({ saved: CONFIG_PATH, api: next.api, me })
      }
      if (!o.wait) {
        const pending = await startLogin(o.api ?? saved.api ?? DEFAULT_API, !o['no-browser'])
        const minutes = Math.round((new Date(pending.expiresAt).getTime() - Date.now()) / 60_000)
        if (!process.stdout.isTTY)
          return out({ open: pending.link, expiresInMinutes: minutes, next: 'bh login --wait' })
        process.stderr.write(
          `Open this link, sign in and approve (valid ${minutes} minutes):\n\n  ${pending.link}\n\nWaiting…\n`,
        )
      }
      const { email: _, ...next } = await waitForLogin(saved)
      await saveConfig(next)
      return out({ saved: CONFIG_PATH, api: next.api, me: await call(next, 'GET', '/me') })
    }
    case 'use': {
      if (!sub) {
        if (!current) throw noProject()
        if (current.several) throw severalProjects(current.several)
        return out({ project: current.slug, from: current.from })
      }
      if (!SESSION) throw noProject()
      const found = await call(config, 'GET', `/projects/${encodeURIComponent(sub)}`)
      await saveSessionProject(sub)
      const picked = (await loadSessionProject())?.picked ?? [sub]
      // Said at once, so an agent that just picked knows its later commands must name the project.
      return out({
        project: found,
        for: 'this session',
        ...(picked.length > 1
          ? { but: `${SEVERAL}. Name it on every command: --project ${sub}`, picked }
          : {}),
      })
    }
    case 'whoami':
      return out(await call(config, 'GET', '/me'))
    case 'health':
      return out(await call(config, 'GET', '/health'))
    case 'projects': {
      const all = (await call(
        config,
        'GET',
        `/projects${o.org ? `?org=${encodeURIComponent(o.org)}` : ''}`,
      )) as { status?: string }[]
      // An archived project is off the list unless asked for (belkins-home-plugin#15).
      return out(o.all ? all : all.filter((x) => x.status !== 'archived'))
    }
    case 'project':
      if (sub === 'create')
        return out(
          await call(config, 'POST', '/projects', {
            slug: arg,
            name: o.name,
            ...(o.timezone ? { timezone: o.timezone } : {}),
            ...(o.org ? { org: o.org } : {}),
            ...(o.owner ? { ownerId: o.owner } : {}),
          }),
        )
      if (sub === 'move')
        return out(await call(config, 'PUT', `/projects/${seg(arg)}/organisation`, { org: o.org }))
      if (sub === 'copy')
        return out(
          await call(config, 'POST', `/projects/${seg(arg)}/copy`, {
            slug:
              pos[3] ??
              (() => {
                throw new BhError(
                  'The new project’s slug?',
                  { hint: 'bh project copy <from> <to>' },
                  2,
                )
              })(),
            ...(o.name ? { name: o.name } : {}),
            ...(o['dry-run'] ? { dryRun: true } : {}),
          }),
        )
      if (sub === 'remove')
        return out(
          await call(config, 'POST', `/projects/${seg(arg)}/remove`, {
            dryRun: Boolean(o['dry-run']),
          }),
        )
      if (sub === 'archive')
        return out(
          await call(
            config,
            'POST',
            `/projects/${arg ? encodeURIComponent(arg) : p()}/archive`,
            o.undo ? { undo: true } : {},
          ),
        )
      if (sub === 'members') return out(await call(config, 'GET', `/projects/${p()}/members`))
      if (sub === 'setup') return out(await checklist(arg === 'skip' ? pos[3] : undefined))
      if (sub === 'member' && arg === 'remove')
        return out(await call(config, 'DELETE', `/projects/${p()}/members/${seg(pos[3])}`))
      if (sub === 'member')
        return out(
          await call(
            config,
            'PUT',
            `/projects/${p()}/members/${seg(arg)}`,
            o.role ? { role: o.role } : {},
          ),
        )
      if (sub === 'update')
        return out(
          await call(config, 'PATCH', `/projects/${p()}`, {
            ...(o.name ? { name: o.name } : {}),
            ...(o.timezone ? { timezone: o.timezone } : {}),
            ...(o['domain-cap'] ? { dailyDomainCap: Number(o['domain-cap']) } : {}),
            ...(o['reply-bcc'] !== undefined ? { replyBcc: addresses(o['reply-bcc']) } : {}),
            ...(o['reply-cc'] !== undefined ? { replyCc: addresses(o['reply-cc']) } : {}),
            // Products and brands the copy check's word rules leave alone, comma-separated; '' for none.
            ...(o['copy-allow'] !== undefined
              ? {
                  copyAllowed: String(o['copy-allow'])
                    .split(',')
                    .map((t) => t.trim())
                    .filter(Boolean),
                }
              : {}),
            ...(o['lead-cost-alert'] !== undefined
              ? {
                  leadCostAlertUsd:
                    o['lead-cost-alert'] === 'off' ? null : Number(o['lead-cost-alert']),
                }
              : {}),
            ...(o['max-live-per-company'] !== undefined
              ? {
                  maxLivePerCompany:
                    o['max-live-per-company'] === 'off' ? null : Number(o['max-live-per-company']),
                }
              : {}),
            ...(o['seed-hold'] === undefined
              ? {}
              : o['seed-hold'] === 'on' || o['seed-hold'] === 'off'
                ? { seedHold: o['seed-hold'] === 'on' }
                : (() => {
                    throw new BhError('--seed-hold is on or off', { hint: '--seed-hold off' }, 2)
                  })()),
            // NaN would reach the engine as null and clear the setting: refused here.
            ...(o['pairing-wait'] === undefined
              ? {}
              : o['pairing-wait'] === 'off' || /^\d+$/.test(o['pairing-wait'])
                ? {
                    pairingWaitDays: o['pairing-wait'] === 'off' ? null : Number(o['pairing-wait']),
                  }
                : (() => {
                    throw new BhError(
                      '--pairing-wait is a number of send days (1-30) or off',
                      { hint: '--pairing-wait 5' },
                      2,
                    )
                  })()),
            ...(o['brief-file']
              ? { brief: await readFile(o['brief-file'], 'utf8') }
              : o.brief
                ? { brief: o.brief }
                : {}),
          }),
        )
      break
    case 'brief':
      return out(await call(config, 'GET', `/projects/${p()}/brief`))
    case 'answers':
      return out(await call(config, 'GET', `/me/answers${o.all ? '?all=1' : ''}`))
    case 'behaviour':
      if (o.search)
        return out(
          await call(config, 'GET', `/behaviour?${new URLSearchParams({ search: o.search })}`),
        )
      return out(
        await call(config, 'GET', sub ? `/behaviour/${encodeURIComponent(sub)}` : '/behaviour'),
      )
    case 'sql': {
      let query = sub ?? ''
      // @project stands for the current project's id: no shell expands it, and SQL has no use for it.
      // Only as a token of its own: inside quotes or comments it is left as written.
      if (hasProjectToken(query)) {
        const found = (await call(config, 'GET', `/projects/${p()}`)) as { id: string }
        query = withProjectId(query, found.id)
      }
      return out(
        await call(config, 'POST', '/sql', {
          query,
          ...(o.limit ? { limit: Number(o.limit) } : {}),
        }),
      )
    }
    case 'schema':
      return out(
        await call(config, 'GET', `/schema${sub ? `?${new URLSearchParams({ table: sub })}` : ''}`),
      )
    case 'history':
      if (sub === 'continue') {
        const ids = (v: string | undefined) =>
          v
            ?.split(',')
            .map((x) => x.trim())
            .filter(Boolean)
        return out(
          await call(config, 'POST', `/projects/${p()}/history/continue`, {
            dryRun: Boolean(o['dry-run']),
            ...(o.strategy ? { strategyIds: ids(o.strategy) } : {}),
            ...(o.enrollment ? { enrollmentIds: ids(o.enrollment) } : {}),
          }),
        )
      }
      if (!sub) return out(await call(config, 'GET', `/projects/${p()}/history`))
      break
    case 'note':
      if (sub === 'add') {
        return out(
          await call(config, 'POST', `/projects/${p()}/notes`, {
            kind: o.kind,
            title: o.title,
            ...withText('body', await textOf('body', o.body, o['body-file'])),
            ...(o.supersedes ? { supersedes: o.supersedes.split(',').map((s) => s.trim()) } : {}),
            ...(o.strategy ? { strategyId: o.strategy } : {}),
            ...(o.segment ? { segmentId: o.segment } : {}),
          }),
        )
      }
      if (sub === 'list') {
        const q = new URLSearchParams({
          ...(o.kind ? { kind: o.kind } : {}),
          ...(o.all ? { all: 'true' } : {}),
        })
        return out(await call(config, 'GET', `/projects/${p()}/notes?${q}`))
      }
      break
    case 'issues': {
      const q = new URLSearchParams({
        ...(o.status ? { status: o.status } : {}),
        ...(o.kind ? { kind: o.kind } : {}),
        ...(o.mine ? { mine: 'true' } : {}),
        ...(o.org ? { org: o.org } : {}),
        ...(o.limit ? { limit: o.limit } : {}),
      })
      return out(await call(config, 'GET', `/issues?${q}`))
    }
    case 'issue': {
      if (sub === 'report') {
        // The project goes with the report when the session has exactly one; a report is never
        // refused for want of one.
        const project = current && !current.several ? current.slug : undefined
        return out(
          await call(config, 'POST', '/issues', {
            title: o.title,
            ...(o.kind ? { kind: o.kind } : {}),
            ...withText('body', await textOf('body', o.body, o['body-file'])),
            ...(project ? { project } : {}),
          }),
        )
      }
      const number = () => {
        if (!arg || !/^\d+$/.test(arg))
          throw new BhError(
            'Which issue?',
            { hint: `bh issue ${sub} <number>; bh issues lists them` },
            2,
          )
        return arg
      }
      if (sub === 'show') return out(await call(config, 'GET', `/issues/${number()}`))
      if (sub === 'comment')
        return out(
          await call(config, 'POST', `/issues/${number()}/comments`, {
            ...withText('body', await textOf('body', o.body, o['body-file'])),
          }),
        )
      if (sub === 'close' || sub === 'reopen')
        return out(
          await call(config, 'POST', `/issues/${number()}/status`, {
            status: sub === 'reopen' ? 'open' : (o.status ?? 'done'),
            ...(o['fixed-in'] ? { fixedIn: o['fixed-in'] } : {}),
            ...(o['duplicate-of'] ? { duplicateOf: Number(o['duplicate-of']) } : {}),
            ...(o.note ? { note: o.note } : {}),
          }),
        )
      break
    }
    case 'task':
      if (sub === 'show') return out(await call(config, 'GET', `/tasks/${seg(arg)}`))
      if (sub === 'reopen') return out(await call(config, 'POST', `/tasks/${seg(arg)}/reopen`, {}))
      if (sub === 'assign')
        return out(
          await call(config, 'POST', `/tasks/${seg(arg)}/assign`, {
            assignee: o.assignee,
            ...(o.note ? { note: o.note } : {}),
          }),
        )
      if (sub === 'open') {
        return out(
          await call(config, 'POST', `/projects/${p()}/tasks`, {
            title: o.title,
            assignee: o.assignee,
            ...(o.priority ? { priority: o.priority } : {}),
            ...(o.due ? { dueAt: o.due } : {}),
            ...(o['done-when'] ? { doneWhen: o['done-when'] } : {}),
            ...withText('body', await textOf('body', o.body, o['body-file'])),
          }),
        )
      }
      if (sub === 'list')
        return out(
          await call(
            config,
            'GET',
            `/projects/${p()}/tasks?${new URLSearchParams(o.status ? { status: o.status } : {})}`,
          ),
        )
      if (sub === 'close')
        return out(
          await call(config, 'POST', `/tasks/${seg(arg)}/close`, {
            ...(o.status ? { status: o.status } : {}),
            ...(o.note ? { note: o.note } : {}),
          }),
        )
      break
    case 'session':
      if (sub === 'end')
        return out(
          await call(config, 'POST', `/projects/${p()}/sessions/end`, { summary: o.summary }),
        )
      break
    case 'segments':
      return out(await call(config, 'GET', `/projects/${p()}/segments`))
    case 'segment':
      if (sub === 'create')
        return out(
          await call(config, 'POST', `/projects/${p()}/segments`, {
            name: o.name,
            ...(o.body ? { definition: o.body } : {}),
            ...(o.criteria ? { criteria: JSON.parse(o.criteria) } : {}),
            ...(o.estimate ? { estimatedCompanies: Number(o.estimate) } : {}),
          }),
        )
      if (sub === 'update')
        return out(
          await call(config, 'PATCH', `/segments/${seg(arg)}`, {
            ...(o.name ? { name: o.name } : {}),
            ...(o.body ? { definition: o.body } : {}),
            ...(o.criteria ? { criteria: JSON.parse(o.criteria) } : {}),
            ...(o.estimate ? { estimatedCompanies: Number(o.estimate) } : {}),
            ...(o.status ? { status: o.status } : {}),
          }),
        )
      break
    case 'personas':
      return out(await call(config, 'GET', `/projects/${p()}/personas${o.all ? '?all=1' : ''}`))
    case 'persona': {
      const fields = {
        ...(o.titles ? { titles: list(o.titles) } : {}),
        ...(o['excluded-titles'] ? { excludedTitles: list(o['excluded-titles']) } : {}),
        ...(o.seniorities ? { seniorities: list(o.seniorities) } : {}),
        ...(o.departments ? { departments: list(o.departments) } : {}),
        ...(o.hints ? { searchHints: o.hints } : {}),
        ...(o.body ? { description: o.body } : {}),
      }
      if (sub === 'upsert')
        return out(
          await call(config, 'POST', `/projects/${p()}/personas`, { name: o.name, ...fields }),
        )
      if (sub === 'update' || sub === 'retire' || sub === 'activate') {
        if (!arg)
          throw new BhError('Which persona?', { hint: 'bh personas --all lists their ids' }, 2)
        return out(
          await call(
            config,
            'PATCH',
            `/personas/${seg(arg)}`,
            sub === 'update'
              ? { ...(o.name ? { name: o.name } : {}), ...fields }
              : { status: sub === 'retire' ? 'retired' : 'active' },
          ),
        )
      }
      break
    }
    case 'strategies':
      return out(await call(config, 'GET', `/projects/${p()}/strategies`))
    case 'strategy':
      if (sub === 'create')
        return out(
          await call(config, 'POST', `/projects/${p()}/strategies`, await readInput(need(o.file))),
        )
      if (sub === 'update')
        return out(
          await call(config, 'PATCH', `/strategies/${seg(arg)}`, await readInput(need(o.file))),
        )
      if (sub === 'show') return out(await call(config, 'GET', `/strategies/${seg(arg)}`))
      if (sub === 'exclude' || sub === 'include') {
        if (o.file)
          return out(
            await call(
              config,
              'POST',
              `/strategies/${seg(arg)}/company-exclusions`,
              await readInput(o.file),
            ),
          )
        if (!o.company)
          throw new BhError('Which company?', { hint: '--company <id|domain>, or --file' }, 2)
        return out(
          await call(config, 'POST', `/strategies/${seg(arg)}/company-exclusions`, {
            ...(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(o.company)
              ? { companyId: o.company }
              : { domain: o.company }),
            excluded: sub === 'exclude',
            ...(o.reason ? { reason: o.reason } : {}),
          }),
        )
      }
      if (sub === 'respread')
        return out(
          await call(config, 'POST', `/strategies/${seg(arg)}/respread`, {
            dryRun: Boolean(o['dry-run']),
          }),
        )
      if (sub === 'repick-mailboxes')
        return out(
          await call(config, 'POST', `/strategies/${seg(arg)}/mailboxes/repick`, {
            dryRun: Boolean(o['dry-run']),
            ...(o.even ? { even: true } : {}),
            ...(o['to-provider'] ? { toProvider: o['to-provider'] } : {}),
            ...(o.only ? { only: list(o.only) } : {}),
            ...(o.skip ? { skip: list(o.skip) } : {}),
            ...(o['change-sender'] ? { changeSender: true } : {}),
            ...(o['to-sender'] ? { toSender: o['to-sender'] } : {}),
            ...(o.limit ? { limit: Number(o.limit) } : {}),
            ...(o.stuck ? { stuck: true } : {}),
            ...(o.enrollment ? { enrollments: list(o.enrollment) } : {}),
          }),
        )
      if (sub === 'launch')
        return out(await call(config, 'POST', `/strategies/${seg(arg)}/launch`, {}))
      if (sub === 'unlaunch')
        return out(await call(config, 'POST', `/strategies/${seg(arg)}/unlaunch`, {}))
      if (sub === 'archive')
        return out(await call(config, 'POST', `/strategies/${seg(arg)}/archive`, {}))
      if (sub === 'pause')
        return out(
          await call(
            config,
            'POST',
            `/strategies/${seg(arg)}/pause`,
            o.reason ? { reason: o.reason } : {},
          ),
        )
      break
    case 'plan':
      if (sub === 'set')
        return out(
          await call(config, 'PUT', `/strategies/${seg(arg)}/plans`, await readInput(need(o.file))),
        )
      if (sub === 'step') {
        if (!pos[3])
          throw new BhError('Which step?', { hint: 'bh strategy show <id> lists its step ids' }, 2)
        return out(
          await call(
            config,
            'PATCH',
            `/strategies/${seg(arg)}/steps/${seg(pos[3])}`,
            await readInput(need(o.file)),
          ),
        )
      }
      if (sub === 'add-template')
        return out(
          await call(
            config,
            'POST',
            `/strategies/${seg(arg)}/plans`,
            await readInput(need(o.file)),
          ),
        )
      if (sub === 'add-step')
        return out(
          await call(config, 'POST', `/strategies/${seg(arg)}/steps`, {
            after: Number(need(o.after)),
            step: await readInput(need(o.file)),
            ...(o.plan ? { planId: o.plan } : {}),
            dryRun: Boolean(o['dry-run']),
          }),
        )
      if (sub === 'remove') {
        if (!pos[3])
          throw new BhError('Which step?', { hint: 'bh strategy show <id> lists its step ids' }, 2)
        return out(await call(config, 'DELETE', `/strategies/${seg(arg)}/steps/${seg(pos[3])}`))
      }
      break
    case 'companies':
      if (sub === 'upsert') return batch(`/projects/${p()}/companies`)
      if (sub === 'judge') return batch(`/segments/${seg(arg)}/companies`)
      if (sub === 'in')
        return out(
          await call(
            config,
            'GET',
            `/segments/${seg(arg)}/companies?${new URLSearchParams({
              ...(o.status ? { status: o.status } : {}),
              ...(o.waiting ? { waiting: o.waiting } : {}),
              ...(o.q ? { q: o.q } : {}),
              ...(o.limit ? { limit: o.limit } : {}),
              ...(o.offset ? { offset: o.offset } : {}),
            })}`,
          ),
        )
      if (sub === 'breaks')
        return out(await call(config, 'GET', `/segments/${seg(arg)}/criteria-breaks`))
      if (sub === 'verdicts') {
        if (!o.company)
          throw new BhError(
            'Which company?',
            { hint: '--company <id>, as bh companies in lists them' },
            2,
          )
        return out(
          await call(config, 'GET', `/segments/${seg(arg)}/companies/${seg(o.company)}/verdicts`),
        )
      }
      if (sub === 'domain') {
        if (!arg || !pos[3])
          throw new BhError(
            'Which company, and its right domain?',
            { hint: 'bh companies domain <company-id|wrong-domain> <right-domain>' },
            2,
          )
        return out(
          await call(config, 'POST', `/projects/${p()}/companies/domain`, {
            company: arg,
            domain: pos[3],
          }),
        )
      }
      break
    case 'sources':
      return out(await call(config, 'GET', `/projects/${p()}/sources`))
    case 'source':
      if (sub === 'add')
        return out(
          await call(config, 'POST', `/segments/${seg(arg)}/sources`, {
            kind: o.kind,
            name: o.name,
            ...(o.provider ? { provider: o.provider } : {}),
            ...(o.query ? { query: JSON.parse(o.query) } : {}),
            ...(o.body ? { instructions: o.body } : {}),
            ...(o.estimate ? { estimatedCompanies: Number(o.estimate) } : {}),
          }),
        )
      if (sub === 'update')
        return out(
          await call(config, 'PATCH', `/sources/${seg(arg)}`, {
            ...(o.name ? { name: o.name } : {}),
            ...(o.status ? { status: o.status } : {}),
            ...(o.cursor !== undefined ? { cursor: o.cursor } : {}),
            ...(o.estimate ? { estimatedCompanies: Number(o.estimate) } : {}),
            ...(o.body ? { instructions: o.body } : {}),
          }),
        )
      break
    case 'search':
      if (sub === 'record')
        return out(
          await call(config, 'POST', `/projects/${p()}/searches`, await readInput(need(o.file))),
        )
      break
    case 'exclusions':
      return out(await call(config, 'GET', `/projects/${p()}/exclusions`))
    case 'exclusion':
      if (sub === 'add')
        return out(
          await call(config, 'POST', `/projects/${p()}/exclusions`, {
            kind: o.kind,
            value: o.value,
            ...(o.note ? { note: o.note } : {}),
          }),
        )
      if (sub === 'remove') return out(await call(config, 'DELETE', `/exclusions/${seg(arg)}`))
      break
    case 'questions':
      return out(
        await call(
          config,
          'GET',
          `/projects/${p()}/questions?${new URLSearchParams(o.status ? { status: o.status } : {})}`,
        ),
      )
    case 'client': {
      if (sub === 'messages') {
        const q = new URLSearchParams({
          ...(o.all ? { all: '1' } : {}),
          ...(o.limit ? { limit: o.limit } : {}),
        })
        return out(await call(config, 'GET', `/projects/${p()}/client-messages?${q}`))
      }
      if ((sub === 'handle' || sub === 'message') && !arg)
        throw new BhError('Which message?', { hint: 'its id, from bh client messages' }, 2)
      if (sub === 'handle') {
        if (!o.as)
          throw new BhError('What became of it?', { hint: '--as note|answer|task|nothing' }, 2)
        return out(
          await call(config, 'POST', `/client-messages/${seg(arg)}/handle`, {
            as: o.as,
            ...(o.ref ? { ref: o.ref } : {}),
            ...(o.title ? { title: o.title } : {}),
          }),
        )
      }
      if (sub === 'message') {
        if (Boolean(o.client) === Boolean(o.ours))
          throw new BhError('Whose is it?', { hint: '--client or --ours' }, 2)
        return out(
          await call(config, 'PATCH', `/client-messages/${seg(arg)}`, {
            fromClient: Boolean(o.client),
          }),
        )
      }
      break
    }
    case 'question':
      if (sub === 'add')
        return out(
          await call(config, 'POST', `/projects/${p()}/questions`, {
            question: await textOf('body', o.body, o['body-file']),
            ...(o.note ? { context: o.note } : {}),
            ...(o.asked ? { asked: true } : {}),
            ...(o.thread ? { threadId: o.thread } : {}),
          }),
        )
      if (sub === 'ask') return out(await call(config, 'POST', `/questions/${seg(arg)}/ask`, {}))
      if (sub === 'link')
        return out(
          await call(config, 'POST', `/questions/${seg(arg)}/threads`, {
            threadId: need(o.thread),
          }),
        )
      if (sub === 'asked')
        return out(await call(config, 'PATCH', `/questions/${seg(arg)}`, { status: 'asked' }))
      if (sub === 'answer')
        return out(
          await call(config, 'PATCH', `/questions/${seg(arg)}`, {
            status: 'answered',
            answer: await textOf('body', o.body, o['body-file']),
          }),
        )
      if (sub === 'drop')
        return out(await call(config, 'PATCH', `/questions/${seg(arg)}`, { status: 'dropped' }))
      break
    case 'hypothesis': {
      // "none" clears a link; an id sets it.
      const ref = (v: string) => (v === 'none' ? null : v)
      const links = {
        ...(o.segment !== undefined ? { segmentId: ref(o.segment) } : {}),
        ...(o.persona !== undefined ? { personaId: ref(o.persona) } : {}),
        ...(o.strategy !== undefined ? { strategyId: ref(o.strategy) } : {}),
      }
      const judged = {
        ...withText('evidence', await textOf('evidence', o.evidence, o['evidence-file'])),
        ...(o.metric ? { metric: o.metric } : {}),
        ...(o.threshold ? { threshold: o.threshold } : {}),
        ...(o.status ? { status: o.status } : {}),
        ...(o.verdict ? { verdict: o.verdict } : {}),
      }
      if (sub === 'list')
        return out(
          await call(
            config,
            'GET',
            `/projects/${p()}/hypotheses${o.status ? `?status=${encodeURIComponent(o.status)}` : ''}`,
          ),
        )
      if (sub === 'add')
        return out(
          await call(config, 'POST', `/projects/${p()}/hypotheses`, {
            claim: o.claim,
            ...links,
            ...judged,
          }),
        )
      if (sub === 'update') {
        if (!arg) throw new BhError('Which hypothesis?', { hint: 'bh hypothesis list' }, 2)
        return out(
          await call(config, 'PATCH', `/hypotheses/${seg(arg)}`, {
            ...(o.claim ? { claim: o.claim } : {}),
            ...(o['add-evidence'] ? { addEvidence: o['add-evidence'] } : {}),
            ...links,
            ...judged,
          }),
        )
      }
      break
    }
    case 'calls': {
      if (!sub) return out(await call(config, 'GET', `/projects/${p()}/call-lists`))
      if (sub === 'create')
        return out(
          await call(config, 'POST', `/projects/${p()}/call-lists`, {
            name: o.name,
            ...(o.note ? { note: o.note } : {}),
            allowRepeat: o['allow-repeat'] ?? false,
            ...attemptsOf(o),
            ...(o.caller ? { caller: o.caller } : {}),
            contacts: await readRows(need(o.file)),
          }),
        )
      if (!arg) throw new BhError('Which call list?', { hint: 'bh calls' }, 2)
      if (sub === 'push')
        return out(
          await call(config, 'POST', `/call-lists/${seg(arg)}/dialer`, {
            ...attemptsOf(o),
            ...(o.caller ? { caller: o.caller === 'none' ? null : o.caller } : {}),
          }),
        )
      if (sub === 'remove') return out(await call(config, 'DELETE', `/call-lists/${seg(arg)}`))
      if (sub === 'briefs')
        return out(
          await call(config, 'PUT', `/call-lists/${seg(arg)}/briefs`, {
            contacts: await readRows(need(o.file)),
          }),
        )
      if (sub === 'rename') {
        if (!o.name) throw new BhError('What is it called now?', { hint: '--name <n>' }, 2)
        return out(await call(config, 'PATCH', `/call-lists/${seg(arg)}`, { name: o.name }))
      }
      if (sub === 'show') {
        if (o.out) {
          await writeFile(o.out, await callText(config, `/call-lists/${seg(arg)}/csv`))
          return out({ written: o.out })
        }
        return out(await call(config, 'GET', `/call-lists/${seg(arg)}`))
      }
      if (sub === 'outcome') {
        if (!o.contact) throw new BhError('Which contact?', { hint: 'bh calls show <list-id>' }, 2)
        if (!o.outcome)
          throw new BhError('What came of the call?', { hint: '--outcome no_answer|…|none' }, 2)
        return out(
          await call(config, 'PATCH', `/call-lists/${seg(arg)}/contacts/${seg(o.contact)}`, {
            outcome: o.outcome === 'none' ? null : o.outcome,
            ...(o.note ? { note: o.note } : {}),
          }),
        )
      }
      break
    }
    case 'goals':
      return out(await call(config, 'GET', `/projects/${p()}/goals`))
    case 'orgs':
      return out(await call(config, 'GET', '/orgs'))
    case 'dialer':
      if (sub === 'orgs') return out(await call(config, 'GET', '/dialer/organizations'))
      if (sub === 'users') {
        if (!arg) throw new BhError('Which dialer organization?', { hint: 'bh dialer orgs' }, 2)
        return out(
          await call(config, 'GET', `/dialer/organizations/${encodeURIComponent(arg)}/users`),
        )
      }
      if (sub === 'queue') {
        if (!arg)
          throw new BhError(
            'What is the queue called?',
            { hint: 'bh dialer queue <name> --project <project>' },
            2,
          )
        return out(
          await call(config, 'POST', `/projects/${p()}/dialer/queue`, {
            name: pos.slice(2).join(' '),
            ...callingHours(o.hours),
          }),
        )
      }
      if (sub === 'key') {
        if (!arg) throw new BhError('Which dialer organization?', { hint: 'bh dialer orgs' }, 2)
        return out(
          await call(config, 'GET', `/dialer/organizations/${encodeURIComponent(arg)}/key`),
        )
      }
      if (sub === 'read') {
        const what = pos[3]
        if (!arg || !what)
          throw new BhError(
            'Which dialer organization, and what in it?',
            { hint: 'bh dialer read <dialer-org-id> workspaces/<id>/numbers' },
            2,
          )
        const [path, query] = what.replace(/^\/+/, '').split('?', 2)
        const qs = new URLSearchParams(query ?? '')
        qs.set('path', path!)
        return out(
          await call(config, 'GET', `/dialer/organizations/${encodeURIComponent(arg)}/read?${qs}`),
        )
      }
      if (sub === 'role') {
        const role = pos[3]
        if (!arg || !['operator', 'manager', 'admin'].includes(role ?? ''))
          throw new BhError(
            'Whose role, and which?',
            { hint: 'bh dialer role <email> operator|manager|admin --project <project>' },
            2,
          )
        return out(await call(config, 'PUT', `/projects/${p()}/dialer/role`, { email: arg, role }))
      }
      if (sub === 'invite') {
        if (!arg)
          throw new BhError(
            'Whom to invite?',
            { hint: 'bh dialer invite <email,…> --project <project>' },
            2,
          )
        return out(
          await call(config, 'POST', `/projects/${p()}/dialer/invitations`, {
            emails: pos
              .slice(2)
              .flatMap((a) => a.split(','))
              .filter(Boolean),
            ...(o.role ? { role: o.role } : {}),
          }),
        )
      }
      if (sub === 'resend') {
        if (!arg)
          throw new BhError(
            'Whose invitation?',
            { hint: 'bh dialer resend <email> --project <project>' },
            2,
          )
        return out(
          await call(config, 'POST', `/projects/${p()}/dialer/invitations/resend`, { email: arg }),
        )
      }
      if (sub === 'numbers') {
        const count = Number(pos[3])
        if (arg !== 'buy' || !Number.isInteger(count) || count < 1)
          throw new BhError(
            'How many numbers to buy?',
            {
              hint: 'bh dialer numbers buy <1-10> [--country US|CA|DE] [--type local|mobile] [--region NY] [--area-code 212] [--city Austin] --project <project>',
            },
            2,
          )
        return out(
          await call(config, 'POST', `/projects/${p()}/dialer/numbers`, {
            count,
            ...(o.country ? { country: o.country.toUpperCase() } : {}),
            ...(o.type ? { type: o.type.toUpperCase() } : {}),
            ...(o.region ? { region: o.region } : {}),
            ...(o['area-code'] ? { areaCode: o['area-code'] } : {}),
            ...(o.city ? { locality: o.city } : {}),
          }),
        )
      }
      if (sub === 'people') return out(await call(config, 'GET', `/projects/${p()}/dialer/people`))
      if (sub === 'agents') {
        if (!arg)
          throw new BhError(
            'Who works the queue?',
            { hint: 'bh dialer people --project <project>' },
            2,
          )
        return out(
          await call(config, 'PUT', `/projects/${p()}/dialer/agents`, {
            agents: pos
              .slice(2)
              .flatMap((a) => a.split(','))
              .filter(Boolean),
          }),
        )
      }
      if (sub === 'workspaces') {
        if (!arg) throw new BhError('Which dialer organization?', { hint: 'bh dialer' }, 2)
        return out(
          await call(config, 'GET', `/dialer/organizations/${encodeURIComponent(arg)}/workspaces`),
        )
      }
      if (sub === 'link') {
        if (!arg)
          throw new BhError('Which workspace?', { hint: 'bh dialer workspaces <dialer-org-id>' }, 2)
        return out(
          await call(
            config,
            'PUT',
            `/projects/${p()}/dialer`,
            arg === 'none'
              ? { workspaceId: null }
              : { workspaceId: arg, ...(o.queue ? { queueId: o.queue } : {}) },
          ),
        )
      }
      if (sub === 'snapshot')
        return out(
          await call(config, 'POST', `/dialer/organizations/${encodeURIComponent(arg!)}/snapshot`),
        )
      return out(await call(config, 'GET', '/dialer'))
    case 'client-access':
      if (sub === 'add')
        return out(await call(config, 'POST', `/projects/${p()}/client-access`, { email: arg }))
      if (sub === 'remove')
        return out(await call(config, 'DELETE', `/projects/${p()}/client-access/${seg(arg)}`))
      return out(await call(config, 'GET', `/projects/${p()}/client-access`))
    case 'billing':
      if (sub === 'link')
        return out(await call(config, 'PUT', `/projects/${p()}/subscription`, { customerId: arg }))
      return out(await call(config, 'GET', `/projects/${p()}/subscription`))
    case 'google-orgs': {
      if (!sub) return out(await call(config, 'GET', '/google-orgs'))
      if (sub === 'make' && (o.for === 'seeds' || o.for === 'sending' || o.for === 'network'))
        return out(
          await call(config, 'POST', '/google-orgs', {
            purpose: o.for,
            ...(arg ? { domain: arg } : {}),
            ...(o.company ? { company: o.company } : {}),
            ...(o.seeds !== undefined ? { seeds: Number(o.seeds) } : {}),
            ...(o.licences !== undefined ? { licences: Number(o.licences) } : {}),
            ...(o['key-from'] ? { keyFrom: o['key-from'] } : {}),
            ...(o.ip ? { ip: o.ip } : {}),
          }),
        )
      if (sub === 'grow')
        return out(
          o['free-users'] === undefined
            ? await call(config, 'GET', '/google-orgs/growth')
            : await call(config, 'PUT', '/google-orgs/growth', {
                freeUsers: Number(o['free-users']),
              }),
        )
      if (sub === 'move' && arg)
        return out(
          await call(config, 'POST', `/google-orgs/${encodeURIComponent(arg)}/seed-domain`, {}),
        )
      if (sub === 'update' && arg)
        return out(
          await call(config, 'PATCH', `/google-orgs/${encodeURIComponent(arg)}`, {
            ...(o.ip ? { ip: o.ip === 'none' ? null : o.ip } : {}),
            ...(o.retry ? { retry: true } : {}),
          }),
        )
      throw new BhError(
        'bh google-orgs make --for seeds|sending [<domain>] [--company <name>] [--seeds <n>] [--licences <n>] [--key-from <tenant>] [--ip <address>]',
        { hint: 'bh google-orgs lists them' },
        2,
      )
    }
    case 'partner': {
      const usage =
        'bh partner <org> | partner set <org> [--google-key -] [--google-scopes <url,…>] [--max-orgs <n>] [--max-orgs-day <n>|none] [--max-licences <n>] [--microsoft-app <id>] [--microsoft-permissions <a,b>] [--max-tenants <n>] [--max-tenants-day <n>|none] [--max-seats <n>] [--placement-notes <n>] | partner placement <org> [--days <n>] | partner agreement <org> --first-name <f> --last-name <l> --email <e> --note <n> | partner key <org> --email <e> [--name <n>]'
      if (sub === 'set' && arg) {
        // Microsoft's flags set the organisation's Microsoft side; any other, or none, its Google's.
        const microsoftGiven =
          o['microsoft-app'] !== undefined ||
          o['microsoft-permissions'] !== undefined ||
          o['max-tenants'] !== undefined ||
          o['max-tenants-day'] !== undefined ||
          o['max-seats'] !== undefined
        const googleGiven =
          o['google-key'] !== undefined ||
          o['google-scopes'] !== undefined ||
          o['max-orgs'] !== undefined ||
          o['max-orgs-day'] !== undefined ||
          o['max-licences'] !== undefined
        // Its placement tests on our seeds: a ceiling of their own, set apart from either side.
        const placement =
          o['placement-notes'] !== undefined
            ? await call(config, 'PUT', `/partners/${seg(arg)}/placement`, {
                notesADay: Number(o['placement-notes']),
              })
            : null
        if (placement && !microsoftGiven && !googleGiven) return out(placement)
        const microsoft = microsoftGiven
          ? await call(config, 'PUT', `/partners/${seg(arg)}/microsoft`, {
              ...(o['microsoft-app'] ? { appId: o['microsoft-app'] } : {}),
              ...(o['microsoft-permissions']
                ? {
                    permissions: o['microsoft-permissions']
                      .split(',')
                      .map((p) => p.trim())
                      .filter(Boolean),
                  }
                : {}),
              ...(o['max-tenants'] !== undefined ? { maxTenants: Number(o['max-tenants']) } : {}),
              ...(o['max-tenants-day'] !== undefined
                ? {
                    maxTenantsDay:
                      o['max-tenants-day'] === 'none' ? null : Number(o['max-tenants-day']),
                  }
                : {}),
              ...(o['max-seats'] !== undefined ? { maxSeats: Number(o['max-seats']) } : {}),
            })
          : null
        if (microsoft && !googleGiven) return out(microsoft)
        return out(
          await call(config, 'PUT', `/partners/${seg(arg)}/google`, {
            // The JSON key Google Cloud made, whole: it spans lines, so stdin is read to its end.
            ...(o['google-key'] === '-'
              ? { key: (await readText('-')).trim() }
              : o['google-key']
                ? { key: o['google-key'] }
                : {}),
            ...(o['google-scopes']
              ? {
                  scopes: o['google-scopes']
                    .split(',')
                    .map((scope) => scope.trim())
                    .filter(Boolean),
                }
              : {}),
            ...(o['max-orgs'] !== undefined ? { maxOrgs: Number(o['max-orgs']) } : {}),
            ...(o['max-orgs-day'] !== undefined
              ? { maxOrgsDay: o['max-orgs-day'] === 'none' ? null : Number(o['max-orgs-day']) }
              : {}),
            ...(o['max-licences'] !== undefined ? { maxLicences: Number(o['max-licences']) } : {}),
          }),
        )
      }
      if (sub === 'agreement' && arg)
        return out(
          await call(config, 'PUT', `/partners/${seg(arg)}/microsoft/agreement`, {
            firstName: o['first-name'],
            lastName: o['last-name'],
            email: o.email,
            note: o.note,
          }),
        )
      if (sub === 'placement' && arg)
        return out(
          await call(
            config,
            'GET',
            `/partners/${seg(arg)}/placement${o.days ? `?days=${Number(o.days)}` : ''}`,
          ),
        )
      if (sub === 'key' && arg && o.email)
        return out(
          await call(config, 'POST', `/partners/${seg(arg)}/keys`, {
            email: o.email,
            ...(o.name ? { name: o.name } : {}),
          }),
        )
      if (
        sub &&
        !arg &&
        sub !== 'set' &&
        sub !== 'key' &&
        sub !== 'agreement' &&
        sub !== 'placement'
      )
        return out(await call(config, 'GET', `/partners/${seg(sub)}`))
      throw new BhError(usage, { hint: 'bh partner <org> shows one' }, 2)
    }
    case 'microsoft-seeds': {
      if (!sub) return out(await call(config, 'GET', '/microsoft-seeds'))
      if (sub === 'make')
        return out(
          await call(config, 'POST', '/microsoft-seeds', {
            ...(o.for !== undefined ? { for: o.for } : {}),
            ...(arg ? { domain: arg } : {}),
            ...(o.seeds !== undefined ? { seeds: Number(o.seeds) } : {}),
          }),
        )
      if (sub === 'grow')
        return out(
          o['free-domains'] === undefined
            ? await call(config, 'GET', '/microsoft-seeds/sending-growth')
            : await call(config, 'PUT', '/microsoft-seeds/sending-growth', {
                freeDomains: Number(o['free-domains']),
              }),
        )
      if (sub === 'mailbox') return out(await call(config, 'POST', '/microsoft-seeds/mailbox', {}))
      if (sub === 'update' && arg && o.retry)
        return out(
          await call(config, 'PATCH', `/microsoft-seeds/${encodeURIComponent(arg)}`, {
            retry: true,
          }),
        )
      throw new BhError(
        'bh microsoft-seeds [make [--for seeds|sending] [<domain>] [--seeds <n>] | grow [--free-domains <n>] | update <ref> --retry]',
        { hint: 'bh microsoft-seeds lists them' },
        2,
      )
    }
    case 'company-details': {
      const org = o.org ?? (await onlyMeteredOrg(config))
      if (sub === 'set')
        return out(
          await call(config, 'PUT', `/orgs/${seg(org)}/company-details`, {
            legalName: o['legal-name'],
            website: o.website,
            phone: o.phone,
            address: {
              lines: (o.address ?? '')
                .split(';')
                .map((line) => line.trim())
                .filter(Boolean),
              city: o.city,
              ...(o.region ? { region: o.region } : {}),
              postalCode: o['postal-code'],
              country: o.country,
            },
            contact: {
              firstName: o.first,
              lastName: o.last,
              email: o.email,
              ...(o['contact-phone'] ? { phone: o['contact-phone'] } : {}),
            },
          }),
        )
      if (sub) throw new BhError('bh company-details [set …]', {}, 2)
      return out(await call(config, 'GET', `/orgs/${seg(org)}/company-details`))
    }
    case 'google-org': {
      if (sub === 'record') {
        if (!arg || !o['customer-id'])
          throw new BhError('bh google-org record <org> --customer-id <C0…>', {}, 2)
        return out(
          await call(config, 'POST', `/orgs/${seg(arg)}/google-organisation/customer`, {
            customerId: o['customer-id'],
          }),
        )
      }
      const org = o.org ?? (await onlyMeteredOrg(config))
      if (sub === 'details')
        return out(
          await call(config, 'PUT', `/orgs/${seg(org)}/google-organisation`, {
            company: o.company,
            address: {
              lines: (o.address ?? '')
                .split(';')
                .map((line) => line.trim())
                .filter(Boolean),
              city: o.city,
              ...(o.region ? { region: o.region } : {}),
              postalCode: o['postal-code'],
              country: o.country,
            },
            contact: {
              firstName: o.first,
              lastName: o.last,
              email: o.email,
              ...(o.phone ? { phone: o.phone } : {}),
            },
          }),
        )
      if (sub)
        throw new BhError('bh google-org [details …|record <org> --customer-id <C0…>]', {}, 2)
      return out(await call(config, 'GET', `/orgs/${seg(org)}/google-organisation`))
    }
    case 'wallet': {
      const org = o.org ?? (await onlyMeteredOrg(config))
      if (sub === 'top-up') {
        const dollars = Number(arg)
        if (!Number.isFinite(dollars) || dollars <= 0)
          throw new BhError('bh wallet top-up <dollars>', {}, 2)
        return out(
          await call(config, 'POST', `/orgs/${seg(org)}/wallet/top-up`, {
            amountCents: Math.round(dollars * 100),
          }),
        )
      }
      if (sub === 'credit') {
        const dollars = Number(arg)
        if (!Number.isFinite(dollars) || dollars <= 0 || !o.org || !o.note)
          throw new BhError('bh wallet credit <dollars> --org <slug> --note <text>', {}, 2)
        return out(
          await call(config, 'POST', `/orgs/${seg(o.org)}/wallet/credit`, {
            amountCents: Math.round(dollars * 100),
            note: o.note,
          }),
        )
      }
      return out(
        await call(config, 'GET', `/orgs/${seg(org)}/wallet${o.limit ? `?limit=${o.limit}` : ''}`),
      )
    }
    case 'org':
      if (sub === 'create')
        return out(
          await call(config, 'POST', '/orgs', {
            slug: arg,
            name: o.name,
            ...(o.billing ? { billing: o.billing } : {}),
          }),
        )
      if (sub === 'billing')
        return out(await call(config, 'PATCH', `/orgs/${seg(arg)}`, { billing: pos[3] }))
      if (sub === 'rename') {
        if (!o.slug && !o.name)
          throw new BhError('Name a new slug or name', {
            hint: 'bh org rename <slug> [--slug <new>] [--name <new>]',
          })
        return out(
          await call(config, 'POST', `/orgs/${seg(arg)}/rename`, {
            ...(o.slug ? { slug: o.slug } : {}),
            ...(o.name ? { name: o.name } : {}),
          }),
        )
      }
      if (sub === 'delete')
        return out(
          await call(config, 'POST', `/orgs/${seg(arg)}/remove`, {
            dryRun: Boolean(o['dry-run']),
            ...(o.to ? { to: o.to } : {}),
          }),
        )
      if (sub === 'protections') {
        // No slug: the organisation of the project this command acts on (plugin#205).
        let org = arg
        if (!org) {
          if (!current)
            throw new BhError(
              'Which organisation?',
              { hint: 'bh org protections <slug>, or name a project: --project <slug>' },
              2,
            )
          const project = (await call(config, 'GET', `/projects/${p()}`)) as {
            organisation_id: string
          }
          const orgs = (await call(config, 'GET', '/orgs')) as { id: string; slug: string }[]
          const found = orgs.find((x) => x.id === project.organisation_id)
          if (!found)
            throw new BhError(
              `The organisation of project ${current.slug} is not one of yours`,
              { hint: 'bh orgs lists them; bh org protections <slug>' },
              2,
            )
          org = found.slug
        }
        return out(await call(config, 'GET', `/orgs/${encodeURIComponent(org)}/protections`))
      }
      if ((sub === 'autopause' || sub === 'lead-cap') && pos[3] === undefined)
        throw new BhError(
          'Which organisation, and what value?',
          { hint: `bh org ${sub} <slug> ${sub === 'autopause' ? 'on|off' : '<n>|off'}` },
          2,
        )
      if (sub === 'autopause') {
        if (pos[3] !== 'on' && pos[3] !== 'off')
          throw new BhError(`autopause takes on or off, not ${pos[3] ?? 'nothing'}`, {}, 2)
        return out(
          await call(config, 'PUT', `/orgs/${seg(arg)}/protections`, {
            autopause: pos[3] === 'on',
          }),
        )
      }
      if (sub === 'lead-cap') {
        const cap = pos[3] === 'off' ? null : Number(pos[3])
        if (cap !== null && !(Number.isInteger(cap) && cap > 0))
          throw new BhError(`lead-cap takes a whole number above 0 or off, not ${pos[3]}`, {}, 2)
        return out(
          await call(config, 'PUT', `/orgs/${seg(arg)}/protections`, { dailyLeadCap: cap }),
        )
      }
      if (sub === 'approve') return out(await call(config, 'POST', `/orgs/${seg(arg)}/approve`))
      if (sub === 'leave')
        return out(
          await call(
            config,
            'POST',
            `/orgs/${seg(arg)}/leave`,
            o.reason ? { reason: o.reason } : {},
          ),
        )
      if (sub === 'leaving') return out(await call(config, 'GET', `/orgs/${seg(arg)}/leave`))
      if (sub === 'erase') {
        if (!o.email && !o.linkedin)
          throw new BhError('erase needs --email or --linkedin (or both)', {}, 2)
        return out(
          await call(config, 'POST', `/orgs/${seg(arg)}/erasures`, {
            ...(o.email ? { email: o.email } : {}),
            ...(o.linkedin ? { linkedinUrl: o.linkedin } : {}),
            ...(o.note ? { note: o.note } : {}),
          }),
        )
      }
      if (sub === 'erasures')
        return out(
          await call(
            config,
            'GET',
            `/orgs/${seg(arg)}/erasures${o.limit ? `?limit=${o.limit}` : ''}`,
          ),
        )
      if (sub === 'tier') {
        if (o.grant !== undefined) {
          const leads = Number(o.grant)
          if (!Number.isInteger(leads) || leads < 1 || !o.note)
            throw new BhError('bh org tier <slug> --grant <leads> --note <text>', {}, 2)
          return out(
            await call(config, 'POST', `/orgs/${seg(arg)}/tier/grant`, {
              leadsPerMonth: leads,
              note: o.note,
            }),
          )
        }
        return out(
          o.price
            ? await call(config, 'POST', `/orgs/${seg(arg)}/tier`, { priceId: o.price })
            : await call(config, 'GET', `/orgs/${seg(arg)}/tier`),
        )
      }
      if (sub === 'dialer' && pos[3] === 'new')
        return out(await call(config, 'POST', `/orgs/${seg(arg)}/dialer`))
      if (sub === 'dialer')
        return out(
          await call(config, 'PUT', `/orgs/${seg(arg)}/dialer`, {
            organizationId: pos[3] === 'none' ? null : pos[3],
          }),
        )
      if (sub === 'members') return out(await call(config, 'GET', `/orgs/${seg(arg)}/members`))
      if (sub === 'add')
        return out(
          await call(config, 'POST', `/orgs/${seg(arg)}/members`, {
            email: o.email,
            ...(o.name ? { name: o.name } : {}),
            ...(o.role ? { role: o.role } : {}),
            ...(o['no-invite'] ? { invite: false } : {}),
          }),
        )
      if (sub === 'invite') {
        if (!pos[3])
          throw new BhError(
            'Which member?',
            { hint: 'bh org members <org> lists them, with ids' },
            2,
          )
        return out(
          await call(config, 'POST', `/orgs/${seg(arg)}/members/${seg(pos[3])}/invite`, {}),
        )
      }
      if (sub === 'role')
        return out(
          await call(config, 'PATCH', `/orgs/${seg(arg)}/members/${seg(pos[3])}`, { role: o.role }),
        )
      if (sub === 'remove')
        return out(await call(config, 'DELETE', `/orgs/${seg(arg)}/members/${seg(pos[3])}`))
      break
    case 'agency':
      if (sub === 'senders') return out(await call(config, 'GET', `/orgs/${seg(arg)}/senders`))
      if (sub === 'add') {
        const sender = (await call(config, 'POST', `/orgs/${seg(arg)}/senders`, {
          name: o.name,
          ...(o.title ? { title: o.title } : {}),
          ...(o.signature ? { signature: o.signature } : {}),
          ...(await signatureHtml(o['signature-html-file'])),
        })) as { id: string }
        if (!o.company) return out(sender)
        const company = (await call(
          config,
          'POST',
          `/orgs/${seg(arg)}/companies/${encodeURIComponent(o.company)}/people`,
          { senderId: sender.id },
        )) as { company: string }
        return out({ ...sender, company: company.company })
      }
      if (sub === 'remove')
        return out(await call(config, 'DELETE', `/orgs/${seg(arg)}/senders/${seg(pos[3])}`))
      if (sub === 'mailbox')
        return out(
          await call(config, 'POST', `/orgs/${seg(arg)}/mailboxes/connect`, {
            provider: o.provider,
            senderId: o.sender,
            ...(o['daily-limit'] ? { dailyLimit: Number(o['daily-limit']) } : {}),
            ...(o['delay-min'] ? { delayMinSeconds: Number(o['delay-min']) } : {}),
            ...(o['delay-max'] ? { delayMaxSeconds: Number(o['delay-max']) } : {}),
            ...(o.warmed ? { warmed: true } : {}),
            ...(o['not-warmed'] ? { warmed: false } : {}),
          }),
        )
      if (sub === 'smtp' || sub === 'jmap')
        return addPasswordMailboxes(
          config,
          `/orgs/${seg(arg)}/mailboxes/${seg(sub)}`,
          need(o.file),
          {
            senderId: o.sender,
            ...mailboxLimits(o),
          },
        )
      // The agency's own domains and the mailboxes on them, for its own senders.
      if (sub === 'domains') return out(await call(config, 'GET', `/orgs/${seg(arg)}/domains`))
      if (sub === 'quote')
        return out(
          await call(config, 'POST', `/orgs/${seg(arg)}/domains/quote`, { domains: pos.slice(3) }),
        )
      if (sub === 'closeouts')
        return out(
          await call(config, 'GET', `/orgs/${seg(arg)}/domains/closeouts?${closeoutQuery(o)}`),
        )
      if (sub === 'approve')
        return out(
          await call(config, 'POST', `/orgs/${seg(arg)}/domains`, {
            domains: pos.slice(3),
            maxCents: Number(o['max-cents']),
            ...(o.closeout ? { closeout: true } : {}),
            ...(o.redirect ? { redirectTo: o.redirect } : {}),
            ...(o.platform ? { platform: o.platform } : {}),
            ...(o.tenant ? { tenant: o.tenant } : {}),
            ...(o.company ? { company: o.company } : {}),
          }),
        )
      if (sub === 'retry') {
        const name = (pos[3] ?? '').toLowerCase()
        const domains = (await call(config, 'GET', `/orgs/${seg(arg)}/domains`)) as {
          id: string
          domain: string
        }[]
        const found = domains.find((d) => d.domain.toLowerCase() === name)
        if (!found)
          throw new BhError(
            `${name || 'That'} is not one of ${arg}'s domains`,
            { hint: `bh agency domains ${arg}` },
            2,
          )
        return out(await call(config, 'POST', `/domains/${seg(found.id)}/retry`, {}))
      }
      if (sub === 'order') {
        const name = (pos[3] ?? '').toLowerCase()
        const domains = (await call(config, 'GET', `/orgs/${seg(arg)}/domains`)) as {
          id: string
          domain: string
        }[]
        const domain = domains.find((d) => d.domain === name)
        if (!domain)
          throw new BhError(`${name || 'That'} is not one of ${arg}'s domains`, {
            hint: `bh agency domains ${arg}`,
          })
        const mailboxes = o.file
          ? await readRows(o.file)
          : [{ firstName: o['first-name'], lastName: o['last-name'], username: o.username }]
        return out(
          await call(config, 'POST', `/domains/${seg(domain.id)}/mailboxes`, {
            mailboxes,
            ...(o.sender ? { senderId: o.sender } : {}),
          }),
        )
      }
      if (sub === 'orders')
        return out(await call(config, 'GET', `/orgs/${seg(arg)}/mailbox-orders`))
      if (sub === 'linkedin')
        return out(
          await call(config, 'POST', `/orgs/${seg(arg)}/linkedin-accounts`, {
            unipileAccountId: pos[3],
            senderId: o.sender,
            ...(o['invite-limit'] ? { dailyInviteLimit: Number(o['invite-limit']) } : {}),
            ...(o['message-limit'] ? { dailyMessageLimit: Number(o['message-limit']) } : {}),
            ...yesNo('ramp', o.ramp),
          }),
        )
      break
    case 'network':
      if (!sub) throw new BhError('Which organisation?', { hint: 'bh network belkins' }, 2)
      return out(await call(config, 'GET', `/orgs/${encodeURIComponent(sub)}/network`))
    case 'company':
      return company(config, sub, pos.slice(2), o)
    case 'goal':
      if (sub === 'remove')
        return out(await call(config, 'DELETE', `/projects/${p()}/goals/${seg(arg)}`))
      if (sub === 'done')
        return out(
          await call(config, 'PUT', `/projects/${p()}/goals/${seg(arg)}/done`, {
            done: Number(o.done),
          }),
        )
      if (sub === 'set')
        return out(
          await call(config, 'PUT', `/projects/${p()}/goals/${seg(arg)}`, {
            meetingsTarget: Number(o.target),
            ...(o.counts ? { counts: o.counts } : {}),
          }),
        )
      break
    case 'contact':
    case 'contacts':
      if (sub === 'upsert') return batch(`/projects/${p()}/contacts`)
      if (sub === 'duplicates')
        return out(await call(config, 'GET', `/projects/${p()}/contacts/duplicates`))
      if (sub === 'namesakes') {
        if (!arg || !pos[3] || !o.note)
          throw new BhError(
            'Which two contacts are two people, and how do you know?',
            {
              hint: 'bh contacts namesakes <id> <other-id> --note <why>; bh contacts duplicates lists pairs',
            },
            2,
          )
        return out(
          await call(config, 'POST', `/contacts/${seg(arg)}/namesakes`, {
            other: pos[3],
            note: o.note,
          }),
        )
      }
      if (sub === 'merge') {
        if (!arg || !pos[3])
          throw new BhError(
            'Which contact stays, and which goes?',
            {
              hint: 'bh contacts merge <keep-id> <drop-id> [--dry-run] [--stop <lead-id>]; bh contacts duplicates lists pairs',
            },
            2,
          )
        return out(
          await call(config, 'POST', `/contacts/${seg(arg)}/merge`, {
            drop: pos[3],
            dryRun: Boolean(o['dry-run']),
            ...(o.stop ? { stopLead: o.stop } : {}),
          }),
        )
      }
      if (sub === 'employer') {
        if (!arg)
          throw new BhError(
            'Which contact?',
            { hint: 'bh contacts employer <id> [--confirm --note <how you know>]' },
            2,
          )
        return out(
          await call(config, 'POST', `/contacts/${seg(arg)}/employer`, {
            ...(o.confirm ? { confirm: true } : {}),
            ...(o.unconfirm ? { unconfirm: true } : {}),
            ...(o['clear-linkedin'] ? { clearLinkedin: true } : {}),
            ...(o.note ? { note: o.note } : {}),
          }),
        )
      }
      if (sub === 'depart') {
        if (!arg)
          throw new BhError('Which contact?', { hint: 'bh contacts depart <id> --reason <t>' }, 2)
        return out(
          await call(config, 'POST', `/contacts/${seg(arg)}/depart`, {
            ...(o.reason ? { reason: o.reason } : {}),
            ...(o.undo ? { undo: true } : {}),
          }),
        )
      }
      if (cmd === 'contact')
        throw new BhError(`Unknown command: ${pos.join(' ')}`, { hint: 'bh --help' }, 2)
      return out(
        await call(
          config,
          'GET',
          `/projects/${p()}/contacts?${new URLSearchParams({
            ...(o.q ? { q: o.q } : {}),
            ...(o.label ? { label: o.label } : {}),
          })}`,
        ),
      )
    case 'phones': {
      if (sub === 'add') {
        if (o.file) return batch(`/projects/${p()}/phones`)
        if (!arg || !o.number || !o.source)
          throw new BhError(
            'Which contact, which number, found where?',
            { hint: 'bh phones add <contact-id> --number +12015550100 --source apollo, or --file' },
            2,
          )
        return batch(`/projects/${p()}/phones`, [
          {
            contactId: arg,
            number: o.number,
            source: o.source,
            ...(o.kind ? { kind: o.kind } : {}),
            ...(o.confidence ? { confidence: o.confidence } : {}),
            ...(o.dnc ? { dnc: true } : {}),
            ...(o['dnc-reason'] ? { dncReason: o['dnc-reason'] } : {}),
            ...(o['dnc-note'] ? { dncNote: o['dnc-note'] } : {}),
          },
        ])
      }
      if (sub === 'set') {
        if (!arg) throw new BhError('Which number?', { hint: 'bh phones <contact-id>' }, 2)
        return out(
          await call(config, 'PATCH', `/phones/${seg(arg)}`, {
            ...(o.state ? { state: o.state } : {}),
            ...(o.reason ? { reason: o.reason } : {}),
            ...(o.rank ? { rank: Number(o.rank) } : {}),
            ...(o.kind ? { kind: o.kind } : {}),
          }),
        )
      }
      if (sub === 'check') {
        if (!arg) throw new BhError('Which number?', { hint: 'bh phones check <phone-id>' }, 2)
        return out(
          await call(config, 'POST', `/phones/${seg(arg)}/check`, o.again ? { again: true } : {}),
        )
      }
      if (!sub) throw new BhError('Whose numbers?', { hint: 'bh phones <contact-id>' }, 2)
      return out(await call(config, 'GET', `/contacts/${seg(sub)}/phones`))
    }
    case 'labels':
      return out(await call(config, 'GET', `/projects/${p()}/labels`))
    case 'label': {
      if (!arg)
        throw new BhError('Which label?', { hint: 'bh label add Partner --company acme.com' }, 2)
      if (sub === 'add' || sub === 'remove') {
        const { companies, contacts } = await labelTargets(o)
        const answers = []
        // In parts of LABEL_CHUNK, each list on its own: the engine takes that many of each.
        for (let i = 0; i < Math.max(companies.length, contacts.length); i += LABEL_CHUNK)
          answers.push(
            (await call(
              config,
              'POST',
              `/projects/${p()}/labels/${sub === 'add' ? 'apply' : 'remove'}`,
              {
                label: arg,
                companies: companies.slice(i, i + LABEL_CHUNK),
                contacts: contacts.slice(i, i + LABEL_CHUNK),
              },
            )) as LabelAnswer,
          )
        return out(mergeLabelAnswers(answers))
      }
      if (sub === 'rename' || sub === 'delete') {
        const labels = (await call(config, 'GET', `/projects/${p()}/labels`)) as {
          id: string
          name: string
        }[]
        const found = labels.find((l) => l.name.toLowerCase() === arg.toLowerCase())
        if (!found)
          throw new BhError(
            `Project ${current!.slug} has no label named ${arg}`,
            { hint: 'bh labels lists them' },
            2,
          )
        if (sub === 'delete')
          return out(await call(config, 'DELETE', `/projects/${p()}/labels/${seg(found.id)}`))
        return out(
          await call(config, 'PATCH', `/projects/${p()}/labels/${seg(found.id)}`, { name: o.name }),
        )
      }
      break
    }
    case 'esp':
      return out(await call(config, 'GET', `/projects/${p()}/esp`))
    case 'dnc':
      if (!sub || sub === 'list') {
        // Every entry, a page at a time: a project's list can run past one page.
        const query = new URLSearchParams({
          ...(o.q ? { q: o.q } : {}),
          ...(o.kind ? { kind: o.kind } : {}),
          ...(o.reason ? { reason: o.reason } : {}),
          limit: String(DNC_PAGE),
        })
        const rows: unknown[] = []
        for (let offset = 0; ; offset += DNC_PAGE) {
          query.set('offset', String(offset))
          const page = (await call(config, 'GET', `/projects/${p()}/dnc?${query}`)) as unknown[]
          rows.push(...page)
          if (page.length < DNC_PAGE) break
        }
        return out(rows)
      }
      if (sub === 'add')
        return out(
          await call(config, 'POST', `/projects/${p()}/dnc`, {
            kind: o.kind,
            value: o.value,
            reason: o.reason,
            ...(o.note ? { note: o.note } : {}),
            ...(o['every-project'] ? { everyProject: true } : {}),
          }),
        )
      if (sub === 'remove') return out(await call(config, 'DELETE', `/dnc/${seg(arg)}`))
      if (sub === 'import') {
        const rows = (await readDncCsv(need(arg ?? o.file))).map((r) => ({
          kind: r.kind,
          value: r.value,
          reason: r.reason ?? o.reason,
          ...(r.note || o.note ? { note: r.note ?? o.note } : {}),
          ...(o['every-project'] ? { everyProject: true } : {}),
        }))
        if (rows.some((r) => !r.reason))
          throw new BhError(
            'Why may these not be written to?',
            { hint: 'pass --reason, or give the file a reason column' },
            2,
          )
        const answer = await sendRows(config, `/projects/${p()}/dnc/import`, rows, {
          rows: DNC_CHUNK,
          bytes: 2 * 1024 * 1024,
        })
        out(answer)
        const refused = refusedIn(answer)
        if (refused) {
          process.stderr.write(
            `refused: ${refused} ${refused === 1 ? 'row' : 'rows'}, see "invalid"\n`,
          )
          process.exitCode = 1
        }
        return
      }
      if (sub === 'check') {
        const values = o.file ? (await readDncCsv(o.file)).map((r) => r.value) : pos.slice(2)
        if (!values.length)
          throw new BhError(
            'Which addresses or domains?',
            { hint: 'bh dnc check ann@acme.com acme.com, or bh dnc check --file <csv>' },
            2,
          )
        const parts: string[][] = []
        for (let i = 0; i < values.length; i += DNC_CHUNK)
          parts.push(values.slice(i, i + DNC_CHUNK))
        const answers: unknown[] = []
        for (const part of parts)
          answers.push(await call(config, 'POST', `/projects/${p()}/dnc/check`, part))
        return out(merge(answers))
      }
      break
    case 'enroll':
      // One request, not chunks: a dry run and the persona cap answer for the batch as a whole.
      return out(
        await call(config, 'POST', `/strategies/${seg(sub)}/enroll`, {
          leads: await readRows(need(o.file)),
          dryRun: Boolean(o['dry-run']),
          ...(o['allow-namesakes'] ? { allowNamesakes: true } : {}),
          ...(o['allow-written-before'] ? { allowWrittenBefore: true } : {}),
        }),
      )
    case 'stand':
      // One person, or a file of them: sourcing stands fifty at a time, and fifty round trips is
      // the difference between a step and a wait.
      if (o.file) return batch(`/strategies/${seg(sub)}/contacts`)
      return out(
        await call(config, 'POST', `/strategies/${seg(sub)}/contacts`, {
          contactId: o.contact,
          status: o.status,
          ...(o.persona ? { personaId: o.persona } : {}),
          ...(o.reason ? { reason: o.reason } : {}),
        }),
      )
    case 'worked':
      return batch(`/strategies/${seg(sub)}/companies`)
    case 'copy':
      if (sub === 'queue') {
        const page = (limit: string | undefined, offset: string | undefined) =>
          call(
            config,
            'GET',
            `/strategies/${seg(arg)}/copy-queue?${new URLSearchParams({
              ...(limit ? { limit } : {}),
              ...(offset ? { offset } : {}),
            })}`,
          ) as Promise<unknown[]>
        if (!o.all) return out(await page(o.limit, o.offset))
        // Every message waiting for copy, a page of 200 at a time (belkins-home-plugin#204).
        const all: unknown[] = []
        for (let offset = Number(o.offset ?? 0); ; offset += 200) {
          const rows = await page('200', String(offset))
          all.push(...rows)
          if (rows.length < 200) break
        }
        return out(all)
      }
      // One request, not chunks: the engine writes all of the copy or none of it.
      if (sub === 'write') {
        const messages = await readRows(need(o.file))
        if (messages.length > COPY_WRITE_MAX)
          throw new BhError(
            `${messages.length} messages; bh copy write takes at most ${COPY_WRITE_MAX} at a time, all or none`,
            {
              hint: `Split the file into parts of ${COPY_WRITE_MAX} or fewer (by strategy, or keeping each lead's messages together) and write each`,
            },
            2,
          )
        const written = (await call(config, 'POST', '/copy', {
          messages,
          ...(o.replace ? { replace: true } : {}),
        })) as { withProblems?: number }
        out(written)
        if (written.withProblems)
          process.stderr.write(
            `written, with house problems on ${written.withProblems} ${written.withProblems === 1 ? 'message' : 'messages'}: see "messages" (bh copy check reports the same)\n`,
          )
        return
      }
      if (sub === 'clear') {
        const ids = pos.slice(2)
        if (!ids.length)
          throw new BhError(
            'Which message?',
            { hint: 'bh copy clear <message-id> [<message-id> …]' },
            2,
          )
        const answers = []
        for (const id of ids)
          answers.push(await call(config, 'POST', `/messages/${seg(id)}/clear-copy`, {}))
        return out(answers.length === 1 ? answers[0] : answers)
      }
      if (sub === 'test') {
        if (!arg || !o.to)
          throw new BhError(
            'Which step, to which address?',
            { hint: 'bh copy test <message-id> --to you@company.com' },
            2,
          )
        return out(await call(config, 'POST', `/messages/${seg(arg)}/test`, { to: o.to }))
      }
      if (sub === 'samples') {
        if (!arg) throw new BhError('Which strategy?', { hint: 'bh copy samples <strategy-id>' }, 2)
        return out(await call(config, 'GET', `/strategies/${seg(arg)}/samples`))
      }
      if (sub === 'sample') {
        if (!arg)
          throw new BhError(
            'Which strategy?',
            { hint: 'bh copy sample <strategy-id> --file samples.json [--replace]' },
            2,
          )
        return out(
          await call(config, 'POST', `/strategies/${seg(arg)}/samples`, {
            samples: await readRows(need(o.file)),
            replace: Boolean(o.replace),
          }),
        )
      }
      if (sub === 'sample-remove') {
        if (!arg || !pos[3])
          throw new BhError(
            'Which strategy, which sample?',
            { hint: 'bh copy sample-remove <strategy-id> <sample-id>' },
            2,
          )
        return out(await call(config, 'DELETE', `/strategies/${seg(arg)}/samples/${seg(pos[3])}`))
      }
      if (sub === 'check') {
        // A file over what the engine checks at once goes in parts, answered as one; colleagues
        // are then compared within each part and with copy already written, and each part carries
        // the rest of the file's subjects, so a thread's subject is the file's in every part.
        const messages = await readRows(need(o.file))
        const answers = []
        for (const body of copyCheckParts(messages, COPY_CHECK_MAX, COPY_CHECK_BYTES))
          answers.push(await call(config, 'POST', '/copy/check', body))
        const checked = merge(answers) as { withProblems: number }
        out(checked)
        if (messages.length > COPY_WRITE_MAX)
          process.stderr.write(
            `${messages.length} messages: bh copy write takes at most ${COPY_WRITE_MAX} at a time, so write them in parts\n`,
          )
        if (checked.withProblems) process.exitCode = 1
        return
      }
      break
    case 'providers':
      if (sub === 'price') {
        if (!arg || !o.usd)
          throw new BhError(
            'Which provider, at what price?',
            { hint: 'bh providers price bettercontact --usd 0.05' },
            2,
          )
        return out(
          await call(config, 'PUT', `/providers/${seg(arg)}/credit-price`, {
            usdPerCredit: Number(o.usd),
          }),
        )
      }
      return out(await call(config, 'GET', '/providers'))
    case 'limits':
      if (sub === 'read') return out(await call(config, 'POST', '/limits/read', {}))
      if (sub === 'set') {
        if (!arg || !o.below)
          throw new BhError(
            'Which tool, below how much?',
            { hint: 'bh limits set bouncer --below 1000   (or --below off)' },
            2,
          )
        return out(
          await call(config, 'PUT', `/limits/${seg(arg)}`, {
            alertBelow: o.below === 'off' ? null : Number(o.below),
          }),
        )
      }
      if (sub === 'reset') {
        if (!arg) throw new BhError('Which tool?', { hint: 'bh limits reset bouncer' }, 2)
        return out(await call(config, 'DELETE', `/limits/${seg(arg)}`))
      }
      return out(await call(config, 'GET', '/limits'))
    case 'crm': {
      const crm = arg
      const base = () => `/projects/${p()}/crm/${encodeURIComponent(need(crm))}`
      if (!sub) return out(await call(config, 'GET', `/projects/${p()}/crm`))
      if (sub === 'export') {
        const query = new URLSearchParams()
        if (o.since) query.set('since', o.since)
        if (o.json) {
          const answer = await call(config, 'GET', `/projects/${p()}/activity?${query}`)
          if (!o.out) return out(answer)
          await writeFile(o.out, `${JSON.stringify(answer, null, 2)}\n`)
          return out({ written: o.out })
        }
        query.set('format', 'csv')
        if (o['per-person']) query.set('rows', 'people')
        const csv = await callText(config, `/projects/${p()}/activity?${query}`)
        if (!o.out) return void process.stdout.write(csv)
        await writeFile(o.out, csv)
        return out({ written: o.out })
      }
      if (sub === 'sync') {
        if (o.auto !== undefined) {
          if (o.auto !== 'on' && o.auto !== 'off')
            throw new BhError('On or off?', { hint: 'bh crm sync hubspot --auto on' }, 2)
          return out(await call(config, 'PUT', `${base()}/activity`, { auto: o.auto === 'on' }))
        }
        const body = {
          ...(o.since ? { since: o.since } : {}),
          ...(o.limit ? { limit: Number(o.limit) } : {}),
        }
        if (o['dry-run'])
          return out(await call(config, 'POST', `${base()}/activity`, { ...body, dryRun: true }))
        // Pass after pass until nothing is left: each writes up to its budget.
        type Pass = {
          contacts: { found: number; created: number }
          created: number
          updated: number
          failed: number
          errors: string[]
          more: boolean
        }
        const total = {
          contacts: { found: 0, created: 0 },
          created: 0,
          updated: 0,
          failed: 0,
          errors: [] as string[],
          passes: 0,
        }
        for (;;) {
          const r = (await call(config, 'POST', `${base()}/activity`, body)) as Pass
          total.passes++
          total.contacts.found += r.contacts.found
          total.contacts.created += r.contacts.created
          total.created += r.created
          total.updated += r.updated
          total.failed = r.failed
          total.errors = r.errors
          if (!r.more) break
          process.stderr.write(`${total.created + total.updated} written so far…\n`)
        }
        return out(total)
      }
      if (sub === 'connect') {
        if (!o['token-stdin'])
          throw new BhError(
            'Where is the key?',
            {
              hint: "pipe it in, never on the command line: op read '…' | bh crm connect pipedrive --token-stdin",
            },
            2,
          )
        const token = (await readText('-')).trim()
        return out(await call(config, 'POST', base(), { token }))
      }
      if (sub === 'disconnect') return out(await call(config, 'DELETE', base()))
      if (sub === 'call') {
        const [, , , method, target] = pos
        if (!method || !target)
          throw new BhError(
            'Which call?',
            { hint: 'bh crm call pipedrive GET /api/v2/persons?limit=10' },
            2,
          )
        const url = new URL(target, 'https://crm.invalid')
        const raw = o['body-file']
          ? await readInput(o['body-file'])
          : o.body
            ? JSON.parse(o.body)
            : undefined
        return out(
          await call(config, 'POST', `${base()}/call`, {
            method,
            path: url.pathname,
            ...(url.search ? { query: Object.fromEntries(url.searchParams) } : {}),
            ...(raw === undefined ? {} : { body: raw }),
          }),
        )
      }
      if (sub === 'dnc')
        return out(
          await call(config, 'POST', `${base()}/dnc`, {
            emails: !o['no-emails'],
            domains: !o['no-domains'],
            phones: !o['no-phones'],
            dryRun: Boolean(o['dry-run']),
          }),
        )
      break
    }
    case 'call': {
      const [, name, method, path] = pos
      if (name === 'show') return out(await call(config, 'GET', `/provider-calls/${seg(method)}`))
      if (!name || !method || path === undefined)
        throw new BhError(
          'Which call?',
          { hint: "bh call generect POST /search/database/companies/ --body '{…}'" },
          2,
        )
      const raw = o['body-file']
        ? await readInput(o['body-file'])
        : o.body
          ? JSON.parse(o.body)
          : undefined
      const refs = Object.fromEntries(
        (
          [
            ['strategyId', o.strategy],
            ['segmentId', o.segment],
            ['sourceId', o.source],
            ['searchId', o.search],
            ['companyId', o.company],
            ['contactId', o.contact],
          ] as const
        ).filter(([, v]) => v),
      )
      const answer = (await call(config, 'POST', `/providers/${seg(name)}/call`, {
        project: current ? decodeURIComponent(p()) : undefined,
        method,
        path: providerPath(path),
        ...(raw === undefined ? {} : { body: raw }),
        ...(o.again ? { again: true } : {}),
        ...(Object.keys(refs).length ? { refs } : {}),
      })) as {
        callId: string | null
        status: number
        costUsd: number | null
        results: number | null
        credits: number | null
        creditsLeft: number | null
        deliveredLater?: boolean
        cached?: { fetchedAt: string; callId: string | null }
        notice?: string
        body: unknown
      }
      const cost = answer.costUsd === null ? 'cost unknown' : `$${answer.costUsd.toFixed(4)}`
      const credits =
        answer.credits === null
          ? ''
          : ` · ${answer.credits} credits${answer.creditsLeft === null ? '' : ` (${answer.creditsLeft} left)`}`
      process.stderr.write(
        `# ${name} ${answer.status} · ${cost}${credits} · ${answer.results ?? '?'} results${answer.callId ? ` · call ${answer.callId}` : ''}\n`,
      )
      if (answer.cached)
        process.stderr.write(
          `# from the cache: bought ${answer.cached.fetchedAt}${answer.cached.callId ? ` by call ${answer.cached.callId}` : ' by another organisation'}; --again buys it anew\n`,
        )
      if (answer.deliveredLater)
        process.stderr.write(
          `# the rest arrives later, to the engine: bh call show ${answer.callId} lists it under deliveries\n`,
        )
      if (answer.notice) process.stderr.write(`# ${answer.notice}\n`)
      out(answer.body)
      if (answer.status >= 400) process.exitCode = 1
      return
    }
    case 'cache': {
      const what = pos[2]
      if (sub === 'person' && what)
        return out(
          await call(config, 'GET', `/linkedin-cache/person?url=${encodeURIComponent(what)}`),
        )
      if (sub === 'company' && (what || o.domain))
        return out(
          await call(
            config,
            'GET',
            `/linkedin-cache/company?${what ? `url=${encodeURIComponent(what)}` : `domain=${encodeURIComponent(o.domain!)}`}`,
          ),
        )
      if (sub === 'people' && what)
        return out(
          await call(
            config,
            'GET',
            `/linkedin-cache/people?company=${encodeURIComponent(what)}${o.former ? '&former=true' : ''}`,
          ),
        )
      throw new BhError(
        'Which page?',
        {
          hint: 'bh cache person https://www.linkedin.com/in/<name> | cache company <url> | cache people <company-url>',
        },
        2,
      )
    }
    case 'hiring': {
      const body = async () =>
        o['body-file'] ? await readInput(o['body-file']) : o.body ? JSON.parse(o.body) : {}
      if (!sub) return out(await call(config, 'GET', '/hiring'))
      if (sub === 'companies' || sub === 'postings')
        return out(await call(config, 'POST', `/hiring/${seg(sub)}`, await body()))
      if (sub === 'boards' && pos[2] === 'add') {
        if (!o.file)
          throw new BhError(
            'Which boards?',
            {
              hint: 'bh hiring boards add --file boards.jsonl ({"ats":"lever","slug":"acme"} a line)',
            },
            2,
          )
        const rows = await readRows(o.file)
        const totals = { boards: 0, added: 0, known: 0 }
        for (let i = 0; i < rows.length; i += 5000) {
          const r = (await call(config, 'POST', '/hiring/boards', {
            boards: rows.slice(i, i + 5000),
            ...(o.source ? { source: o.source } : {}),
          })) as typeof totals
          totals.boards += r.boards
          totals.added += r.added
          totals.known += r.known
        }
        return out(totals)
      }
      if (sub === 'boards' && (o.domain || (pos[2] && pos[3])))
        return out(
          await call(
            config,
            'GET',
            `/hiring/boards?${o.domain ? `domain=${encodeURIComponent(o.domain)}` : `ats=${encodeURIComponent(pos[2]!)}&slug=${encodeURIComponent(pos[3]!)}`}`,
          ),
        )
      throw new BhError(
        'Which part of the job boards?',
        {
          hint: 'bh hiring | hiring companies --body-file q.json | hiring postings --body-file q.json | hiring boards --domain <d> | hiring boards add --file boards.jsonl',
        },
        2,
      )
    }
    case 'spend':
      if (sub === 'add')
        return out(
          await call(config, 'POST', `/projects/${p()}/spend`, {
            provider: o.provider,
            operation: o.operation,
            costUsd: Number(o.usd),
            ...(o.note ? { note: o.note } : {}),
            ...(o.strategy ? { strategyId: o.strategy } : {}),
          }),
        )
      return out(
        await call(
          config,
          'GET',
          `/projects/${p()}/spend?${new URLSearchParams({ ...(o.from ? { from: o.from } : {}), ...(o.to ? { to: o.to } : {}) })}`,
        ),
      )
    case 'address':
      if (sub === 'check')
        return out(
          await call(config, 'POST', `/contacts/${seg(arg)}/address-checks`, {
            address: o.address,
            ...(o.provider ? { provider: o.provider } : {}),
            ...(o.reason ? { reason: o.reason } : {}),
            ...(o.again ? { again: true } : {}),
          }),
        )
      if (sub === 'checks')
        return out(await call(config, 'GET', `/contacts/${seg(arg)}/address-checks`))
      if (sub === 'collect')
        return out(await call(config, 'POST', `/projects/${p()}/address-checks/collect`, {}))
      if (sub === 'replace')
        return out(
          await call(config, 'POST', `/contacts/${seg(arg)}/replace-address`, {
            address: o.address,
            ...(o.reason ? { reason: o.reason } : {}),
          }),
        )
      break
    case 'reengage':
      return out(
        await call(
          config,
          'POST',
          `/thread-messages/${seg(sub)}/reengage`,
          o.on ? { on: o.on } : {},
        ),
      )
    case 'refer':
      return out(
        await call(config, 'POST', `/thread-messages/${seg(sub)}/refer`, {
          email: o.email,
          ...(o['first-name'] ? { firstName: o['first-name'] } : {}),
          ...(o['last-name'] ? { lastName: o['last-name'] } : {}),
          ...(o.title ? { title: o.title } : {}),
        }),
      )
    case 'inbox':
      if (sub === 'test-send')
        return out(
          await call(config, 'POST', '/inbox/test-send', {
            from: o.from,
            to: o.to,
            ...(o.subject ? { subject: o.subject } : {}),
            ...(o.body ? { body: o.body } : {}),
            ...(o.reply ? { reply: true } : {}),
          }),
        )
      if (sub === 'placement')
        return out(
          await call(
            config,
            'GET',
            `/inbox/placement?${new URLSearchParams({ mailbox: o.mailbox ?? '', messageId: o['message-id'] ?? '' })}`,
          ),
        )
      return out(await call(config, 'GET', `/projects/${p()}/inbox`))
    case 'threads': {
      const filters = new URLSearchParams({
        ...(o.status ? { status: o.status } : {}),
        ...(o.from ? { from: o.from } : {}),
        ...(o.lead ? { lead: o.lead } : {}),
        ...(o.since ? { since: o.since } : {}),
        ...(o.limit ? { limit: o.limit } : {}),
      })
      if (sub === 'close') {
        if (!o.note)
          throw new BhError(
            'Why do they need no answer?',
            {
              hint: 'bh threads close --from <our domain> --note "test mail between our mailboxes"',
            },
            2,
          )
        const ids = o.ids
          ? o.ids.split(',').map((s) => s.trim())
          : o.file
            ? (await readFile(o.file, 'utf8')).split(/\s+/).filter(Boolean)
            : filters.size
              ? (
                  (await call(config, 'GET', `/projects/${p()}/threads?${filters.toString()}`)) as {
                    id: string
                    status: string
                  }[]
                )
                  .filter((t) => t.status !== 'closed')
                  .map((t) => t.id)
              : null
        if (!ids)
          throw new BhError(
            'Which conversations?',
            { hint: '--ids <id,…>, --file <ids.txt>, or filters such as --from <domain>' },
            2,
          )
        if (!ids.length) return out({ closed: 0, threads: [] })
        return out(
          await call(config, 'POST', `/projects/${p()}/threads/close`, { ids, note: o.note }),
        )
      }
      return out(await call(config, 'GET', `/projects/${p()}/threads?${filters.toString()}`))
    }
    case 'thread':
      if (sub === 'forward') {
        if (!arg || !o.to)
          throw new BhError(
            'Which thread, and to whom?',
            { hint: 'bh thread forward <thread-id> --to <team address> [--messages <id,…>]' },
            2,
          )
        return out(
          await call(config, 'POST', `/threads/${seg(arg)}/forward`, {
            to: o.to,
            ...(o.messages ? { messageIds: o.messages.split(',').map((s) => s.trim()) } : {}),
          }),
        )
      }
      if (sub === 'close') {
        if (!arg || !o.note)
          throw new BhError(
            'Which thread, and why does it need no answer?',
            {
              hint: 'bh thread close <thread-id> --note "<what happened instead: who was referred, what was launched>"',
            },
            2,
          )
        return out(await call(config, 'POST', `/threads/${seg(arg)}/close`, { note: o.note }))
      }
      if (sub === 'reopen')
        return out(await call(config, 'POST', `/threads/${seg(arg)}/reopen`, {}))
      if (sub === 'pause-colleagues') {
        if (!arg)
          throw new BhError(
            'Which thread?',
            { hint: 'bh thread pause-colleagues <thread-id>; bh thread <thread-id> lists them' },
            2,
          )
        return out(
          await call(
            config,
            'POST',
            `/threads/${seg(arg)}/pause-colleagues`,
            o.only ? { ids: o.only.split(',').map((s) => s.trim()) } : {},
          ),
        )
      }
      if (sub === 'attachments') {
        if (!arg)
          throw new BhError('Which message?', { hint: 'bh thread <thread-id> lists them' }, 2)
        return out(await call(config, 'GET', `/thread-messages/${seg(arg)}/attachments`))
      }
      if (sub === 'refetch') {
        if (!arg)
          throw new BhError('Which message?', { hint: 'bh thread <thread-id> lists them' }, 2)
        return out(await call(config, 'POST', `/thread-messages/${seg(arg)}/refetch`, {}))
      }
      if (sub === 'attachment') {
        const n = pos[3]
        if (!arg || !n)
          throw new BhError(
            'Which message, and which of its files?',
            {
              hint: 'bh thread attachments <message-id> lists them; then bh thread attachment <message-id> 1',
            },
            2,
          )
        const file = await callFile(config, `/thread-messages/${seg(arg)}/attachments/${seg(n)}`)
        // A folder of its own, never over a file already there (attachment.ts).
        const saved = o.out ?? attachmentPath(arg, n, file.name)
        await saveNew(saved, file.content)
        return out({ saved, type: file.type, bytes: file.content.length })
      }
      if (sub === 'stage') {
        const stage = pos[3]
        if (!arg || !stage)
          throw new BhError(
            'Which thread, and which stage?',
            { hint: 'bh thread stage <thread-id> opportunity|proposal|won|lost|none' },
            2,
          )
        return out(
          await call(config, 'POST', `/threads/${seg(arg)}/deal-stage`, {
            stage: stage === 'none' ? null : stage,
          }),
        )
      }
      return out(await call(config, 'GET', `/threads/${seg(sub)}`))
    case 'triage':
      if (sub === 'undo')
        return out(await call(config, 'POST', `/thread-messages/${seg(arg)}/untriage`, {}))
      return out(
        await call(config, 'POST', `/thread-messages/${seg(sub)}/triage`, {
          ...(o.class ? { classification: o.class } : {}),
          ...(o.note ? { note: o.note } : {}),
          ...(o['follow-up'] ? { followUpOn: o['follow-up'] } : {}),
          ...(o.return ? { returnDate: o.return } : {}),
          ...(o.keep ? { keep: true } : {}),
        }),
      )
    case 'reply-templates':
      if (!sub)
        throw new BhError(
          'Which strategy?',
          { hint: 'bh reply-templates <strategy-id>; bh strategies lists them' },
          2,
        )
      return out(await call(config, 'GET', `/strategies/${seg(sub)}/reply-templates`))
    case 'reply-template':
      if (sub === 'approve') {
        if (!arg)
          throw new BhError(
            'Which strategy?',
            { hint: 'bh reply-template approve <strategy-id> --class … --body-file …' },
            2,
          )
        if (!o.class)
          throw new BhError(
            'Which kind of reply does it answer?',
            {
              hint: '--class interested, meeting or question (an answer), or out_of_office or referral (a first email to the colleague the reply names, with --subject)',
            },
            2,
          )
        const text = o['body-file'] ? await readFile(o['body-file'], 'utf8') : o.body
        if (!text)
          throw new BhError('What does it say?', { hint: '--body <text> or --body-file <path>' }, 2)
        return out(
          await call(config, 'POST', `/strategies/${seg(arg)}/reply-templates`, {
            classification: o.class,
            ...(o.subject ? { subject: o.subject } : {}),
            body: text,
            ...(o.cc !== undefined ? { cc: addresses(o.cc) } : {}),
          }),
        )
      }
      if (sub === 'archive') {
        if (!arg)
          throw new BhError(
            'Which template?',
            { hint: 'bh reply-templates <strategy-id> lists their ids' },
            2,
          )
        return out(await call(config, 'POST', `/reply-templates/${seg(arg)}/archive`, {}))
      }
      throw new BhError(
        'Which reply-template command?',
        { hint: 'bh reply-template approve|archive' },
        2,
      )
    case 'replies':
      return out(
        await call(
          config,
          'GET',
          `/projects/${p()}/replies?${new URLSearchParams(o.status ? { status: o.status } : {})}`,
        ),
      )
    case 'reply':
      if (sub === 'draft' && o.contact) {
        // A first email to a lead we have no email thread with: it opens one.
        if (arg)
          throw new BhError(
            'A thread or a contact, not both',
            { hint: 'bh reply draft <thread-id> answers in it; --contact <id> writes first' },
            2,
          )
        if (!o.subject)
          throw new BhError(
            'What is its subject?',
            { hint: '--subject <s>: a first email has no "Re:"' },
            2,
          )
        return out(
          await call(config, 'POST', `/contacts/${seg(o.contact)}/threads`, {
            body: o['body-file'] ? await readFile(o['body-file'], 'utf8') : need(o.body),
            subject: o.subject,
            ...(o.mailbox ? { mailbox: o.mailbox } : {}),
            ...(o.note ? { note: o.note } : {}),
            ...(o['send-at'] ? { sendAt: o['send-at'] } : {}),
            ...(o['approve-by'] ? { approveBy: o['approve-by'] } : {}),
            ...(o.reviewer ? { reviewer: o.reviewer } : {}),
            ...copies(o),
          }),
        )
      }
      if (sub === 'draft') {
        const text = o['body-file'] ? await readFile(o['body-file'], 'utf8') : need(o.body)
        return out(
          await call(config, 'POST', `/threads/${seg(arg)}/replies`, {
            body: text,
            ...(o.note ? { note: o.note } : {}),
            ...(o['send-at'] ? { sendAt: o['send-at'] } : {}),
            ...(o['approve-by'] ? { approveBy: o['approve-by'] } : {}),
            ...(o.sender ? { senderId: o.sender } : {}),
            ...(o.reviewer ? { reviewer: o.reviewer } : {}),
            ...(o.to ? { to: o.to } : {}),
            ...(o['in-reply-to'] ? { inReplyTo: o['in-reply-to'] } : {}),
            ...copies(o),
            ...(o.subject !== undefined ? { subject: o.subject } : {}),
            ...(await attached(o)),
            ...(o.slots
              ? {
                  slots: String(o.slots)
                    .split(',')
                    .map((x) => x.trim())
                    .filter(Boolean),
                  ...(o.calendar ? { calendarId: o.calendar } : {}),
                }
              : {}),
          }),
        )
      }
      if (sub === 'approve')
        return out(
          await call(config, 'POST', `/replies/${seg(arg)}/approve`, {
            ...(o.body ? { body: o.body } : {}),
            ...copies(o),
            ...(o.subject !== undefined ? { subject: o.subject } : {}),
            ...times(o),
            ...(o['allow-dnc'] ? { allowDnc: dncOverride(o.reason) } : {}),
          }),
        )
      if (sub === 'retry') return out(await call(config, 'POST', `/replies/${seg(arg)}/retry`, {}))
      if (sub === 'check') return out(await call(config, 'POST', `/replies/${seg(arg)}/check`, {}))
      if (sub === 'resend') {
        if (!o.mailbox)
          throw new BhError(
            'Which mailbox should it go from?',
            { hint: '--mailbox <address>: another of the project’s mailboxes (bh mailboxes)' },
            2,
          )
        if (!o.reason)
          throw new BhError(
            'Why is it sent again?',
            { hint: '--reason "the lead says it never arrived"' },
            2,
          )
        return out(
          await call(config, 'POST', `/replies/${seg(arg)}/resend`, {
            mailbox: o.mailbox,
            reason: o.reason,
            ...(o.subject ? { subject: o.subject } : {}),
            ...(o['send-at'] ? { sendAt: o['send-at'] } : {}),
            ...(o['approve-by'] ? { approveBy: o['approve-by'] } : {}),
            ...(o.reviewer ? { reviewer: o.reviewer } : {}),
          }),
        )
      }
      if (sub === 'reschedule') {
        const at = o['send-at']
        if (at === undefined)
          throw new BhError('When should it go?', { hint: '--send-at <iso>, or --send-at now' }, 2)
        return out(
          await call(config, 'POST', `/replies/${seg(arg)}/reschedule`, {
            sendAt: at === 'now' ? '' : at,
          }),
        )
      }
      if (sub === 'assign')
        return out(
          await call(config, 'POST', `/replies/${seg(arg)}/assign`, {
            reviewer: o.reviewer ?? o.to,
          }),
        )
      if (sub === 'discard')
        return out(await call(config, 'POST', `/replies/${seg(arg)}/discard`, {}))
      if (sub === 'unapprove')
        return out(await call(config, 'POST', `/replies/${seg(arg)}/unapprove`, {}))
      if (sub === 'revise') {
        const text = o['body-file'] ? await readFile(o['body-file'], 'utf8') : need(o.body)
        return out(
          await call(config, 'POST', `/replies/${seg(arg)}/revise`, {
            body: text,
            ...(o.note ? { note: o.note } : {}),
            ...copies(o),
            ...(o.subject !== undefined ? { subject: o.subject } : {}),
            ...times(o),
            ...(await attached(o)),
          }),
        )
      }
      if (sub === 'rewrite')
        return out(await call(config, 'POST', `/replies/${seg(arg)}/rewrite`, { ask: need(o.ask) }))
      if (sub === 'ask' || sub === 'agent')
        return out(
          await call(config, 'POST', `/threads/${seg(arg)}/draft`, o.ask ? { ask: o.ask } : {}),
        )
      if (sub === 'versions') return out(await call(config, 'GET', `/replies/${seg(arg)}/versions`))
      break
    case 'preview':
      return out(await call(config, 'GET', `/messages/${seg(sub)}/preview`))
    case 'senders':
      return out(await call(config, 'GET', `/projects/${p()}/senders`))
    case 'sender':
      if (sub === 'move')
        return out(await call(config, 'POST', `/senders/${seg(arg)}/move`, { project: o.to }))
      if (sub === 'remove') return out(await call(config, 'DELETE', `/senders/${seg(arg)}`))
      if (sub === 'share')
        return out(
          await call(config, 'PUT', `/projects/${p()}/senders/${seg(arg)}`, {
            ...(o.title ? { title: o.title } : {}),
            ...(o.signature ? { signature: o.signature } : {}),
            ...(await signatureHtml(o['signature-html-file'])),
            ...(o['daily-share'] ? { dailyShare: Number(o['daily-share']) } : {}),
          }),
        )
      if (sub === 'unshare')
        return out(await call(config, 'DELETE', `/projects/${p()}/senders/${seg(arg)}`))
      if (sub === 'add')
        return out(
          await call(config, 'POST', `/projects/${p()}/senders`, {
            name: o.name,
            ...(o.title ? { title: o.title } : {}),
            ...(o.signature ? { signature: o.signature } : {}),
            ...(await signatureHtml(o['signature-html-file'])),
          }),
        )
      if (sub === 'update')
        return out(
          await call(config, 'PATCH', `/senders/${seg(arg)}`, {
            ...(o.name ? { name: o.name } : {}),
            ...(o.title ? { title: o.title } : {}),
            ...(o.signature ? { signature: o.signature } : {}),
            ...(await signatureHtml(o['signature-html-file'])),
          }),
        )
      if (sub === 'image')
        return out(
          await call(config, 'POST', `/senders/${seg(arg)}/images`, {
            data: (await readFile(need(pos[3]))).toString('base64'),
          }),
        )
      if (sub === 'images') return out(await call(config, 'GET', `/senders/${seg(arg)}/images`))
      if (sub === 'photo') {
        if (pos[3])
          return out(
            await call(config, 'PUT', `/senders/${seg(arg)}/photo`, {
              data: (await readFile(pos[3])).toString('base64'),
            }),
          )
        if (o.image || o.none)
          return out(
            await call(config, 'PUT', `/senders/${seg(arg)}/photo`, {
              imageId: o.none ? null : o.image,
            }),
          )
        return out(await call(config, 'GET', `/senders/${seg(arg)}/photo`))
      }
      if (sub === 'image-remove')
        return out(await call(config, 'DELETE', `/senders/${seg(arg)}/images/${seg(need(pos[3]))}`))
      if (sub === 'signature') {
        const signature = (await call(
          config,
          'GET',
          `/projects/${p()}/senders/${seg(arg)}/signature`,
        )) as { name: string; text: string | null; html: string | null; rendered: string | null }
        if (o.out) {
          await writeFile(o.out, signaturePage(signature))
          return out({ ...signature, rendered: undefined, written: o.out })
        }
        return out({ ...signature, rendered: undefined })
      }
      break
    case 'leads': {
      const query = new URLSearchParams(
        Object.entries({
          q: o.q,
          strategy: o.strategy,
          state: o.state,
          label: o.label,
          limit: o.limit,
          offset: o.offset,
        }).filter((e): e is [string, string] => typeof e[1] === 'string'),
      ).toString()
      return out(await call(config, 'GET', `/projects/${p()}/leads${query ? `?${query}` : ''}`))
    }
    case 'lead':
      if (sub === 'show') return out(await call(config, 'GET', `/enrollments/${seg(arg)}`))
      if (sub === 'resume')
        return out(await call(config, 'POST', `/enrollments/${seg(arg)}/resume`, {}))
      if (sub === 'pause')
        return out(
          await call(config, 'POST', `/enrollments/${seg(arg)}/pause`, {
            ...(o.until ? { until: o.until } : {}),
            ...(o.note ? { note: o.note } : {}),
          }),
        )
      if (sub === 'unpause')
        return out(await call(config, 'POST', `/enrollments/${seg(arg)}/unpause`, {}))
      if (sub === 'stop')
        return out(
          await call(config, 'POST', `/enrollments/${seg(arg)}/stop`, { reason: o.reason }),
        )
      if (sub === 'restart') {
        const ids = o.file
          ? (await readRows(o.file)).map((r) =>
              typeof r === 'string' ? r : (r as { enrollmentId?: unknown }).enrollmentId,
            )
          : pos.slice(2)
        if (!ids.length)
          throw new BhError(
            'Which leads?',
            { hint: 'bh lead restart <enrollment-id>..., or --file [{"enrollmentId"}]' },
            2,
          )
        return out(
          await call(config, 'POST', '/enrollments/restart', {
            enrollmentIds: ids,
            dryRun: Boolean(o['dry-run']),
          }),
        )
      }
      break
    case 'calendars':
      return out(await call(config, 'GET', `/projects/${p()}/calendars`))
    case 'calendar': {
      /** The rules of a calendar of our own, as flags. */
      const rules = {
        ...(o.timezone ? { timezone: o.timezone } : {}),
        ...(o.hours ? { hours: o.hours } : {}),
        ...(o.minutes ? { meetingMinutes: Number(o.minutes) } : {}),
        ...(o.buffer !== undefined ? { bufferMinutes: Number(o.buffer) } : {}),
        ...(o.notice !== undefined ? { noticeMinutes: Number(o.notice) } : {}),
        ...(o.cap !== undefined ? { dailyCap: o.cap === 'none' ? null : Number(o.cap) } : {}),
        ...(o.window ? { windowDays: Number(o.window) } : {}),
      }
      if (sub === 'connect' && (o.freebusy || o['hours-only'] || o.ics))
        return out(
          await call(
            config,
            'POST',
            `/projects/${p()}/calendars/${o.freebusy ? 'freebusy' : o.ics ? 'ics' : 'hours'}`,
            {
              senderId: o.sender,
              address: o.freebusy ?? o['hours-only'] ?? o.address,
              ...(o.ics ? { url: o.ics } : {}),
              ...rules,
            },
          ),
        )
      if (sub === 'connect' && !o.key)
        return out(
          await call(config, 'POST', `/projects/${p()}/calendars/calcom/authorize`, {
            senderId: o.sender,
          }),
        )
      if (sub === 'connect')
        return out(
          await call(config, 'POST', `/projects/${p()}/calendars/calcom`, {
            key: await secret(o.key!, 'Cal.com API key: '),
            senderId: o.sender,
            ...(o['event-type'] ? { eventType: o['event-type'] } : {}),
          }),
        )
      if (sub === 'add-external')
        return out(
          await call(config, 'POST', `/projects/${p()}/calendars/external`, {
            url: o.url,
            ...(o.sender ? { senderId: o.sender } : {}),
            ...(o.name ? { name: o.name } : {}),
            ...(o.minutes ? { meetingMinutes: Number(o.minutes) } : {}),
            ...(o.timezone ? { timezone: o.timezone } : {}),
          }),
        )
      if (sub === 'invite')
        return out(
          await call(config, 'POST', `/projects/${p()}/invites`, {
            channel: 'calendar',
            senderId: o.sender,
          }),
        )
      if (sub === 'update')
        return out(
          await call(config, 'PATCH', `/calendars/${seg(pos[2])}`, {
            ...(o.priority ? { priority: Number(o.priority) } : {}),
            ...(o.timezone ? { timezone: o.timezone } : {}),
            ...(o.owner ? { ownerName: o.owner } : {}),
            ...(o['event-type'] ? { eventType: o['event-type'] } : {}),
            ...(o.sender ? { senderId: o.sender } : {}),
            ...(o.name ? { name: o.name } : {}),
            ...rules,
          }),
        )
      if (sub === 'archive')
        return out(await call(config, 'POST', `/calendars/${seg(arg)}/archive`, {}))
      break
    }
    case 'slots': {
      if (sub === 'link')
        return out(
          await call(
            config,
            'POST',
            `/threads/${seg(arg)}/booking-link`,
            o.calendar ? { calendarId: o.calendar } : {},
          ),
        )
      if (sub === 'offer')
        return out(
          await call(config, 'POST', `/threads/${seg(arg)}/slots`, {
            slots: String(o.slots ?? '')
              .split(',')
              .map((x) => x.trim())
              .filter(Boolean),
            ...(o.calendar ? { calendarId: o.calendar } : {}),
          }),
        )
      const q = new URLSearchParams({
        ...(o.days ? { days: o.days } : {}),
        ...(o.calendar ? { calendarId: o.calendar } : {}),
        ...(o.limit ? { limit: o.limit } : {}),
      })
      return out(await call(config, 'GET', `/projects/${p()}/slots${q.size ? `?${q}` : ''}`))
    }
    case 'meetbot': {
      if (!sub) return out(await call(config, 'GET', '/meetbot'))
      if (sub === 'login') return out(await meetbotLogin(config))
      if (sub === 'retry') return out(await call(config, 'POST', '/meetbot/retry', {}))
      if (sub === 'credentials') {
        if (!o.email) throw new BhError('Sign in as whom?', { hint: '--email <the organizer>' }, 2)
        const [password, totpSecret] = await readSecrets([
          `Password for ${o.email}: `,
          ...(o.totp ? ['Authenticator secret (the key under "Can\'t scan it?"): '] : []),
        ])
        if (!password) throw new BhError('No password given', {}, 2)
        return out(
          await call(config, 'PUT', '/meetbot/credentials', {
            email: o.email,
            password,
            ...(totpSecret ? { totpSecret } : {}),
          }),
        )
      }
      break
    }
    case 'meetings':
      return out(
        await call(config, 'GET', `/projects/${p()}/meetings${o.upcoming ? '?upcoming=true' : ''}`),
      )
    case 'meeting':
      if (sub === 'uncancel')
        return out(await call(config, 'POST', `/meetings/${seg(arg)}/uncancel`, {}))
      if (sub === 'transcript')
        return out(await call(config, 'GET', `/meetings/${seg(arg)}/record`))
      if (sub === 'book')
        return out(
          await call(config, 'POST', `/projects/${p()}/meetings`, {
            ...(o.thread ? { threadId: o.thread } : {}),
            ...(o.contact ? { contactId: o.contact } : {}),
            calendarId: o.calendar,
            at: o.at,
            ...(o['lead-timezone'] ? { leadTimezone: o['lead-timezone'] } : {}),
          }),
        )
      if (sub === 'record')
        return out(
          await call(config, 'POST', `/projects/${p()}/meetings/record`, {
            ...(o.thread ? { threadId: o.thread } : {}),
            ...(o.contact ? { contactId: o.contact } : {}),
            ...(o.sender ? { senderId: o.sender } : {}),
            ...(o.calendar ? { calendarId: o.calendar } : {}),
            ...(o.through ? { bookedThrough: o.through } : {}),
            ...(o.minutes ? { minutes: Number(o.minutes) } : {}),
            ...(o.notes ? { notes: o.notes } : {}),
            ...(o.pending ? { pending: true } : {}),
            at: o.at,
          }),
        )
      if (sub === 'move')
        return out(await call(config, 'POST', `/meetings/${seg(arg)}/move`, { at: o.at }))
      if (sub === 'cancel')
        return out(
          await call(
            config,
            'POST',
            `/meetings/${seg(arg)}/cancel`,
            o.reason ? { reason: o.reason } : {},
          ),
        )
      if (sub === 'retry') return out(await call(config, 'POST', `/meetings/${seg(arg)}/retry`, {}))
      if (sub === 'text')
        return out(
          o.text === undefined && !o.file
            ? await call(config, 'GET', `/projects/${p()}/meeting-text`)
            : await call(config, 'PUT', `/projects/${p()}/meeting-text`, {
                text: o.file ? await readFile(o.file, 'utf8') : o.text || null,
              }),
        )
      if (sub === 'update')
        return out(
          await call(config, 'PATCH', `/meetings/${seg(arg)}`, {
            ...(o.status ? { status: o.status } : {}),
            ...(o.outcome ? { outcome: o.outcome } : {}),
            ...(o.feedback ? { feedback: o.feedback } : {}),
            ...(o.notes ? { notes: o.notes } : {}),
            ...(o.thread ? { threadId: o.thread } : {}),
            ...(o['lead-timezone'] ? { leadTimezone: o['lead-timezone'] } : {}),
          }),
        )
      break
    case 'mailboxes':
      if (sub === 'plan') {
        const q = new URLSearchParams({
          ...(o.strategy ? { strategy: String(o.strategy) } : {}),
          ...(o['per-day'] ? { perDay: String(Number(o['per-day'])) } : {}),
        })
        return out(
          await call(config, 'GET', `/projects/${p()}/mailbox-plan${q.size ? `?${q}` : ''}`),
        )
      }
      return out(await call(config, 'GET', `/projects/${p()}/mailboxes`))
    case 'domains':
      return out(await call(config, 'GET', `/projects/${p()}/domains`))
    case 'domain': {
      const names = pos.slice(2)
      if (sub === 'quote')
        return out(await call(config, 'POST', `/projects/${p()}/domains/quote`, { domains: names }))
      if (sub === 'closeouts')
        return out(
          await call(config, 'GET', `/projects/${p()}/domains/closeouts?${closeoutQuery(o)}`),
        )
      if (sub === 'approve')
        return out(
          await call(config, 'POST', `/projects/${p()}/domains`, {
            domains: names,
            maxCents: Number(o['max-cents']),
            ...(o.closeout ? { closeout: true } : {}),
            ...(o.redirect ? { redirectTo: o.redirect } : {}),
            ...(o.platform ? { platform: o.platform } : {}),
            ...(o.tenant ? { tenant: o.tenant } : {}),
          }),
        )
      if (sub === 'dkim')
        return out(
          await call(config, 'POST', `/domains/${await domainId(arg)}/dkim`, {
            record: o.record,
            ...(o.selector ? { selector: o.selector } : {}),
          }),
        )
      if (sub === 'release')
        return out(await call(config, 'POST', `/domains/${await domainId(arg)}/release`, {}))
      if (sub === 'transfer')
        return out(await call(config, 'POST', `/domains/${await domainId(arg)}/transfer`, {}))
      if (sub === 'retry')
        return out(await call(config, 'POST', `/domains/${await domainId(arg)}/retry`, {}))
      if (sub === 'platform') {
        const platform = pos[3]
        if (platform !== 'google' && platform !== 'microsoft')
          throw new BhError('Which platform?', { hint: `bh domain platform ${arg} microsoft` }, 2)
        return out(
          await call(config, 'POST', `/domains/${await domainId(arg)}/platform`, { platform }),
        )
      }
      if (sub === 'move') {
        if (!o.tenant)
          throw new BhError(
            'Move it where?',
            { hint: '--tenant <name|id> (bh tenants lists them)' },
            2,
          )
        return out(
          await call(config, 'POST', `/domains/${await domainId(arg)}/move`, {
            tenant: o.tenant,
            ...(o['with-mailboxes'] ? { withMailboxes: true } : {}),
            ...(o.confirm ? { confirm: true } : {}),
          }),
        )
      }
      if (sub === 'redirect') {
        const url = pos[3]
        if (!url)
          throw new BhError(
            'Where to?',
            { hint: 'bh domain redirect getacme.com https://acme.com, or none to remove it' },
            2,
          )
        return out(
          await call(config, 'PUT', `/domains/${await domainId(arg)}/redirect`, {
            url: url === 'none' ? null : url,
          }),
        )
      }
      if (sub === 'dmarc') {
        if (!o.policy)
          throw new BhError(
            'Which policy?',
            { hint: `bh domain dmarc ${arg ?? '<name>'} --policy quarantine` },
            2,
          )
        return out(
          await call(config, 'PUT', `/domains/${await domainId(arg)}/dmarc`, {
            policy: o.policy,
            dryRun: Boolean(o['dry-run']),
          }),
        )
      }
      if (sub === 'dns') {
        const id = await domainId(arg)
        const action = pos[3]
        if (!action) return out(await call(config, 'GET', `/domains/${seg(id)}/dns`))
        if (action === 'add')
          return out(
            await call(config, 'POST', `/domains/${seg(id)}/dns`, {
              type: o.type,
              host: o.host ?? '@',
              content: o.content,
              ...(o.ttl ? { ttl: Number(o.ttl) } : {}),
              ...(o.priority ? { priority: Number(o.priority) } : {}),
            }),
          )
        if (action === 'delete') {
          if (!pos[4])
            throw new BhError('Which record?', { hint: `bh domain dns ${arg} lists their ids` }, 2)
          return out(await call(config, 'DELETE', `/domains/${seg(id)}/dns/${seg(pos[4])}`))
        }
        throw new BhError(`bh domain dns has no ${action}`, { hint: 'add or delete' }, 2)
      }
      break
    }
    case 'tenants':
      if (sub === 'cleanup') return out(await call(config, 'GET', '/tenants/cleanup'))
      return out({
        google: await call(config, 'GET', '/tenants'),
        microsoft: await call(config, 'GET', '/microsoft-tenants'),
      })
    case 'tenant': {
      const room = {
        ...(o['max-domains'] ? { maxDomains: Number(o['max-domains']) } : {}),
        ...defaultPool(o['default-pool']),
        ...tenantRole(o.role),
      }
      const maxUsers = o['max-users'] ? { maxUsers: Number(o['max-users']) } : {}
      const seatUsd = o['seat-usd'] ? { seatUsd: Number(o['seat-usd']) } : {}
      if (o.provider === 'microsoft') {
        if (sub === 'add')
          return out(
            await call(config, 'POST', '/microsoft-tenants', {
              name: o.name,
              directoryId: o['tenant-id'],
              clientId: o['client-id'],
              key: await readFile(need(o.key), 'utf8'),
              cert: await readFile(need(o.cert), 'utf8'),
              ...(o['admin-email'] ? { adminEmail: o['admin-email'] } : {}),
              ...room,
            }),
          )
        if (!arg) throw new BhError('Which tenant?', { hint: 'bh tenants lists them' }, 2)
        if (sub === 'seats')
          return out(await call(config, 'GET', `/microsoft-tenants/${seg(arg)}/seats`))
        if (sub === 'update')
          return out(
            await call(config, 'PATCH', `/microsoft-tenants/${seg(arg)}`, {
              ...(o.status ? { status: o.status } : {}),
              ...(o['admin-email'] ? { adminEmail: o['admin-email'] } : {}),
              ...room,
              ...seatUsd,
              ...pax8Subscription(o),
            }),
          )
        throw new BhError(
          `bh tenant ${sub} --provider microsoft is not a command`,
          { hint: 'add, seats or update' },
          2,
        )
      }
      const key = o.key ? JSON.parse(await readFile(o.key, 'utf8')) : undefined
      if (sub === 'add')
        return out(
          await call(config, 'POST', '/tenants', {
            name: o.name,
            adminEmail: o['admin-email'],
            ...(o['key-from'] ? { keyFrom: o['key-from'] } : { key }),
            ...room,
            ...maxUsers,
          }),
        )
      if (sub === 'console-login') {
        if (!arg) throw new BhError('Which tenant?', { hint: 'bh tenants lists them' }, 2)
        return out(await consoleLogin(config, arg))
      }
      if (sub === 'users') {
        if (!arg) throw new BhError('Which tenant?', { hint: 'bh tenants lists them' }, 2)
        return out(await call(config, 'GET', `/tenants/${seg(arg)}/users`))
      }
      if (sub === 'console-retry') {
        if (!arg) throw new BhError('Which tenant?', { hint: 'bh tenants lists them' }, 2)
        return out(await call(config, 'POST', `/tenants/${seg(arg)}/console-retry`, {}))
      }
      if (sub === 'console-credentials') {
        if (!arg) throw new BhError('Which tenant?', { hint: 'bh tenants lists them' }, 2)
        if (o.remove)
          return out(await call(config, 'DELETE', `/tenants/${seg(arg)}/console-credentials`))
        if (!o.email)
          throw new BhError('Sign in as whom?', { hint: '--email <an admin of the tenant>' }, 2)
        const [password, totpSecret] = await readSecrets([
          `Password for ${o.email}: `,
          ...(o.totp ? ['Authenticator secret (the key under "Can\'t scan it?"): '] : []),
        ])
        if (!password) throw new BhError('No password given', {}, 2)
        return out(
          await call(config, 'PUT', `/tenants/${seg(arg)}/console-credentials`, {
            email: o.email,
            password,
            ...(totpSecret ? { totpSecret } : {}),
          }),
        )
      }
      if (sub === 'update')
        return out(
          await call(config, 'PATCH', `/tenants/${seg(arg)}`, {
            ...(o.status ? { status: o.status } : {}),
            ...room,
            ...maxUsers,
            ...seatUsd,
            ...(o['admin-email'] ? { adminEmail: o['admin-email'] } : {}),
            ...(key ? { key } : {}),
          }),
        )
      break
    }
    case 'mailbox': {
      const limits = mailboxLimits(o)
      if (sub === 'connect')
        return out(
          await call(config, 'POST', `/projects/${p()}/mailboxes/connect`, {
            provider: o.provider,
            ...(o.sender ? { senderId: o.sender } : {}),
            ...limits,
          }),
        )
      if (sub === 'reconnect') {
        if (!arg)
          throw new BhError('Which mailbox?', { hint: 'bh mailboxes lists them, with ids' }, 2)
        return out(await call(config, 'POST', `/mailboxes/${seg(arg)}/reconnect`, {}))
      }
      if (sub === 'delete-user') {
        const refs = pos.slice(2)
        if (!refs.length)
          throw new BhError(
            'Which mailbox?',
            { hint: 'its id or address; bh tenants cleanup names the archived ones' },
            2,
          )
        // One at a time: a mailbox refused must not stop the rest.
        const users: unknown[] = []
        const refused: unknown[] = []
        for (const ref of refs) {
          try {
            users.push(
              await call(
                config,
                'POST',
                `/mailboxes/${seg(ref)}/tenant-user/delete`,
                o.confirm ? { confirm: true } : {},
              ),
            )
          } catch (error) {
            if (!(error instanceof BhError)) throw error
            refused.push({ mailbox: ref, error: error.message, detail: error.payload })
          }
        }
        out({ ...(o.confirm ? {} : { dryRun: true }), users, refused })
        if (refused.length) {
          process.stderr.write(`refused: ${refused.length} of ${refs.length}, see "refused"\n`)
          process.exitCode = 1
        }
        return
      }
      if (sub === 'import') {
        // One at a time: each token is tried against the provider, and one refused must not stop the rest.
        const rows = (await readRows(need(o.file))) as Record<string, unknown>[]
        const imported: unknown[] = []
        const refused: unknown[] = []
        for (const [row, one] of rows.entries()) {
          try {
            imported.push(
              await call(config, 'POST', `/projects/${p()}/mailboxes/import`, {
                ...one,
                ...limits,
                ...(o.paused ? { paused: true } : {}),
              }),
            )
          } catch (error) {
            if (!(error instanceof BhError)) throw error
            refused.push({ row, sender: one.sender, error: error.message, detail: error.payload })
          }
        }
        out({ imported, refused })
        if (refused.length) {
          process.stderr.write(`refused: ${refused.length} of ${rows.length}, see "refused"\n`)
          process.exitCode = 1
        }
        return
      }
      if (sub === 'smtp' || sub === 'jmap')
        return addPasswordMailboxes(
          config,
          `/projects/${p()}/mailboxes/${seg(sub)}`,
          need(o.file),
          limits,
        )
      if (sub === 'order') {
        const mailboxes = o.file
          ? await readRows(o.file)
          : [{ firstName: o['first-name'], lastName: o['last-name'], username: o.username }]
        return out(
          await call(config, 'POST', `/domains/${await domainId(arg)}/mailboxes`, {
            mailboxes,
            ...(o.sender ? { senderId: o.sender } : {}),
          }),
        )
      }
      if (sub === 'orders') return out(await call(config, 'GET', `/projects/${p()}/mailbox-orders`))
      if (sub === 'retry' || sub === 'hold' || sub === 'cancel') {
        if (!arg)
          throw new BhError('Which order?', { hint: 'bh mailbox orders lists them, with ids' }, 2)
        return out(await call(config, 'POST', `/mailbox-orders/${seg(arg)}/${seg(sub)}`, {}))
      }
      if (sub === 'move')
        return out(
          await call(config, 'POST', `/mailboxes/${seg(arg)}/move`, {
            project:
              o.to ??
              (() => {
                throw new BhError('To which project?', { hint: '--to <project>' }, 2)
              })(),
            ...(o.sender ? { senderId: o.sender } : {}),
          }),
        )
      if (sub === 'update')
        return out(
          await call(config, 'PATCH', `/mailboxes/${seg(arg)}`, {
            ...limits,
            ...(o.status ? { status: o.status } : {}),
            ...(o.sender ? { senderId: o.sender } : {}),
            ...(o.recipients
              ? { recipientEsps: o.recipients === 'any' ? null : list(o.recipients) }
              : {}),
            ...(o.intake === undefined
              ? {}
              : o.intake === 'on' || o.intake === 'off'
                ? { intake: o.intake === 'on' }
                : (() => {
                    throw new BhError('--intake is on or off', { hint: '--intake off' }, 2)
                  })()),
          }),
        )
      break
    }
    case 'agent':
      if (sub === 'runs')
        return out(
          await call(
            config,
            'GET',
            `/projects/${p()}/agent-runs${o.limit ? `?limit=${Number(o.limit)}` : ''}`,
          ),
        )
      if (sub === 'show') return out(await call(config, 'GET', `/agent-runs/${seg(arg)}`))
      if (sub === 'stats')
        return out(
          await call(
            config,
            'GET',
            `/agent-runs/stats${o.hours ? `?hours=${Number(o.hours)}` : ''}`,
          ),
        )
      if (sub === 'run') return out(await call(config, 'POST', `/projects/${p()}/agent-runs`, {}))
      if (sub === 'cancel')
        return out(await call(config, 'POST', `/agent-runs/${seg(arg)}/cancel`, {}))
      if (sub === 'on' || sub === 'off')
        return out(await call(config, 'PUT', `/projects/${p()}/agent`, { enabled: sub === 'on' }))
      break
    case 'placement': {
      if (!sub || sub === 'status')
        return out(
          await call(config, 'GET', `/placement${o.days ? `?days=${Number(o.days)}` : ''}`),
        )
      if (sub === 'seeds') return out(await call(config, 'GET', '/placement/seeds'))
      if (sub === 'room')
        return out(
          await call(config, 'GET', `/placement/room${o.days ? `?days=${Number(o.days)}` : ''}`),
        )
      if (sub === 'seed') {
        if (arg === 'connect') {
          if (!o.env)
            throw new BhError(
              'Which environment?',
              { hint: '--env google, m365, m365_defender or m365_proofpoint' },
              2,
            )
          return out(await call(config, 'POST', '/placement/seeds/connect', { environment: o.env }))
        }
        if (arg === 'add') {
          if (!pos[3])
            throw new BhError(
              'Which address?',
              { hint: 'A licensed mailbox of the seed tenant' },
              2,
            )
          if (!o.env)
            throw new BhError(
              'Which environment?',
              { hint: '--env google, m365, m365_defender or m365_proofpoint' },
              2,
            )
          return out(
            await call(config, 'POST', '/placement/seeds', { environment: o.env, address: pos[3] }),
          )
        }
        const status = { activate: 'active', suspect: 'suspect', archive: 'archived' }[arg ?? '']
        if (!status)
          throw new BhError(
            `bh placement seed has no ${arg ?? 'action'}`,
            { hint: 'connect, add, activate, suspect or archive' },
            2,
          )
        if (!pos[3]) throw new BhError('Which seed?', { hint: 'bh placement seeds lists them' }, 2)
        return out(await call(config, 'PATCH', `/placement/seeds/${seg(pos[3])}`, { status }))
      }
      if (sub === 'test') {
        if (!arg) throw new BhError('From which mailbox?', { hint: 'bh mailboxes lists them' }, 2)
        return out(
          await call(config, 'POST', '/placement/tests', {
            mailbox: arg,
            ...(o['per-environment'] ? { perEnvironment: Number(o['per-environment']) } : {}),
          }),
        )
      }
      if (sub === 'show') {
        if (!arg) throw new BhError('Which test?', { hint: 'bh placement test prints its id' }, 2)
        return out(await call(config, 'GET', `/placement/tests/${seg(arg)}`))
      }
      if (sub === 'look') {
        if (!arg) throw new BhError('Which seed?', { hint: 'bh placement seeds lists them' }, 2)
        if (o.from) {
          const q = new URLSearchParams({
            seed: arg,
            from: String(o.from),
            ...(o.days ? { days: String(Number(o.days)) } : {}),
          })
          return out(await call(config, 'GET', `/placement/look?${q}`))
        }
        if (!o['message-id'])
          throw new BhError(
            'Which message?',
            { hint: '--message-id <Message-ID>; bh copy test prints it; or --from <address>' },
            2,
          )
        const q = new URLSearchParams({ seed: arg, messageId: String(o['message-id']) })
        return out(await call(config, 'GET', `/placement/look?${q}`))
      }
      if (sub === 'digests') {
        if (!arg) throw new BhError('Which seed?', { hint: 'bh placement seeds lists them' }, 2)
        const q = new URLSearchParams({
          seed: arg,
          ...(o.days ? { days: String(Number(o.days)) } : {}),
          ...(o.all ? { all: 'true' } : {}),
        })
        return out(await call(config, 'GET', `/placement/digests?${q}`))
      }
      if (sub === 'mailbox' || sub === 'domain') {
        if (!arg)
          throw new BhError(
            sub === 'mailbox' ? 'Which mailbox?' : 'Which domain?',
            { hint: sub === 'mailbox' ? 'bh mailboxes lists them' : 'bh domains lists them' },
            2,
          )
        const q = new URLSearchParams({
          ...(o.days ? { days: String(Number(o.days)) } : {}),
          ...(o.limit ? { limit: String(Number(o.limit)) } : {}),
        })
        return out(
          await call(
            config,
            'GET',
            `/placement/${sub === 'mailbox' ? 'mailboxes' : 'domains'}/${encodeURIComponent(arg)}${q.size ? `?${q}` : ''}`,
          ),
        )
      }
      if (sub === 'codes') {
        if (arg === 'meanings') return out(await call(config, 'GET', '/placement/codes/meanings'))
        const q = new URLSearchParams({
          ...(o.days ? { days: String(Number(o.days)) } : {}),
          ...(o.env ? { environment: String(o.env) } : {}),
          ...(o.source ? { source: String(o.source) } : {}),
          ...(o.code ? { code: String(o.code) } : {}),
          ...(o.moved ? { moved: 'true' } : {}),
        })
        return out(await call(config, 'GET', `/placement/codes${q.size ? `?${q}` : ''}`))
      }
      if (sub === 'code') {
        const code = pos[3]
        if (!arg || !code)
          throw new BhError(
            'Which code?',
            { hint: 'bh placement code <source> <code>, e.g. sfs 2069299003' },
            2,
          )
        if (!o.meaning || !o.confidence)
          throw new BhError(
            'What does it mean, and how sure is it?',
            { hint: '--meaning <text> --confidence documented|inferred|unknown' },
            2,
          )
        return out(
          await call(
            config,
            'PUT',
            `/placement/codes/${encodeURIComponent(arg)}/${encodeURIComponent(code)}`,
            {
              meaning: String(o.meaning),
              confidence: String(o.confidence),
              ...(o.evidence ? { evidence: String(o.evidence) } : {}),
            },
          ),
        )
      }
      throw new BhError(
        `bh placement has no ${sub}`,
        { hint: 'status, seeds, seed, test, show, look, digests, mailbox, codes or code' },
        2,
      )
    }
    case 'egress': {
      if (!sub || sub === 'list') return out(await call(config, 'GET', '/egresses'))
      if (sub === 'add') {
        if (!arg || !o.ip || !o.proxy)
          throw new BhError(
            'Which host, address and proxy?',
            {
              hint: "bh egress add mta1.<domain> --ip <ipv4> --proxy - (then the proxy's URL, http://user:pass@<ipv4>:<port>)",
            },
            2,
          )
        return out(
          await call(config, 'POST', '/egresses', {
            hostName: arg,
            ipv4: String(o.ip),
            proxy: await secret(String(o.proxy), 'Proxy URL (http://user:pass@host:port): '),
            status: o.spare ? 'spare' : 'active',
            ...(o.region ? { region: String(o.region) } : {}),
            ...(o['for-seeds'] ? { forSeeds: true } : {}),
          }),
        )
      }
      // Kept for the next group of Microsoft seed tenants' answers, out of the spares.
      if (sub === 'seeds') {
        if (!arg)
          throw new BhError(
            'Which egress?',
            { hint: 'bh egress seeds <id> [off] (bh egress list prints the ids)' },
            2,
          )
        return out(
          await call(config, 'PATCH', `/egresses/${seg(arg)}`, { forSeeds: pos[3] !== 'off' }),
        )
      }
      if (sub === 'regions') return out(await call(config, 'GET', '/egresses/regions'))
      if (sub === 'region') {
        const region = pos[3]
        if (!arg || !region)
          throw new BhError(
            'Which egress, and which region?',
            { hint: 'bh egress region <id> us-east-1 (or none); bh egress list prints the ids' },
            2,
          )
        return out(
          await call(config, 'PATCH', `/egresses/${seg(arg)}`, {
            region: region === 'none' ? null : region,
          }),
        )
      }
      if (sub === 'quota') {
        const quota = Number(pos[3])
        if (!arg || !Number.isInteger(quota) || quota < 0)
          throw new BhError(
            'Which region, and how many addresses?',
            { hint: 'bh egress quota us-east-1 25' },
            2,
          )
        return out(await call(config, 'PUT', `/egresses/regions/${seg(arg)}`, { ipQuota: quota }))
      }
      const status = { active: 'active', spare: 'spare', retire: 'retired' }[sub]
      if (status) {
        if (!arg) throw new BhError('Which egress?', { hint: 'bh egress list prints the ids' }, 2)
        return out(await call(config, 'PATCH', `/egresses/${seg(arg)}`, { status }))
      }
      if (sub === 'assign') {
        if (!arg || [o.project, o.mailbox, o.company].filter(Boolean).length !== 1)
          throw new BhError(
            'Which egress, and for which project, company or mailbox?',
            {
              hint: 'bh egress assign <host name|none> --project <slug> | --company <name|id> | --mailbox <address>',
            },
            2,
          )
        return out(
          await call(config, 'POST', '/egresses/assign', {
            egress: arg === 'none' ? null : arg,
            ...(o.project
              ? { project: String(o.project) }
              : o.company
                ? { company: String(o.company) }
                : { mailbox: String(o.mailbox) }),
          }),
        )
      }
      throw new BhError(
        `bh egress has no ${sub}`,
        { hint: 'list, add, active, spare, retire, region, regions, quota or assign' },
        2,
      )
    }
    case 'review': {
      // The operator's weekly review and alerts in Slack (docs/decisions/tools.md).
      const org =
        sub === 'now' || sub === 'list' || sub === 'subscribe' || sub === 'unsubscribe'
          ? arg
          : undefined
      if (!org)
        throw new BhError(
          'Which organisation, and what?',
          { hint: 'bh review now belkins | list | subscribe | unsubscribe' },
          2,
        )
      const at = `/orgs/${encodeURIComponent(org)}/review`
      if (sub === 'list') return out(await call(config, 'GET', at))
      if (sub === 'now') return out(await call(config, 'POST', at, o.for ? { for: o.for } : {}))
      if (sub === 'unsubscribe')
        return out(
          await call(
            config,
            'DELETE',
            `${at}/recipients${o.email ? `?email=${encodeURIComponent(o.email)}` : ''}`,
          ),
        )
      const onOff = (name: 'reviews' | 'alerts', v: string | undefined) => {
        if (v === undefined) return {}
        if (v !== 'on' && v !== 'off')
          throw new BhError(`--${name} is on or off`, { hint: `--${name} off` }, 2)
        return { [name]: v === 'on' }
      }
      return out(
        await call(config, 'PUT', `${at}/recipients`, {
          ...(o.email ? { email: o.email } : {}),
          ...(o.timezone ? { timezone: o.timezone } : {}),
          ...onOff('reviews', o.reviews),
          ...onOff('alerts', o.alerts),
        }),
      )
    }
    case 'mail-health': {
      if (!sub) throw new BhError('Which organisation?', { hint: 'bh mail-health belkins' }, 2)
      const q = o.days ? `?days=${Number(o.days)}` : ''
      return out(await call(config, 'GET', `/orgs/${encodeURIComponent(sub)}/mail-health${q}`))
    }
    case 'bounces': {
      if (!sub) throw new BhError('Which organisation?', { hint: 'bh bounces belkins' }, 2)
      const q = new URLSearchParams()
      if (o.days) q.set('days', String(Number(o.days)))
      if (o.project) q.set('project', String(o.project))
      const qs = q.size ? `?${q}` : ''
      return out(await call(config, 'GET', `/orgs/${encodeURIComponent(sub)}/bounces${qs}`))
    }
    case 'warmup':
      if (!sub || sub === 'status') return out(await call(config, 'GET', `/projects/${p()}/warmup`))
      if (sub === 'seeds')
        return out(
          arg
            ? await call(config, 'POST', '/warmup/seeds', {
                adminEmail: arg,
                ...(o.count !== undefined ? { count: Number(o.count) } : {}),
                // A Microsoft 365 seed tenant: its app, as bh tenant add --provider microsoft takes it.
                ...(o.provider ? { provider: o.provider } : {}),
                ...(o.name ? { name: o.name } : {}),
                ...(o['tenant-id'] ? { directoryId: o['tenant-id'] } : {}),
                ...(o['client-id'] ? { clientId: o['client-id'] } : {}),
                ...(o.key ? { key: await readFile(o.key, 'utf8') } : {}),
                ...(o.cert ? { cert: await readFile(o.cert, 'utf8') } : {}),
                // The egress its answers leave through; none takes it away (they are then not sent).
                ...(o.egress ? { egress: o.egress === 'none' ? null : o.egress } : {}),
                ...pax8Subscription(o),
              })
            : await call(config, 'GET', '/warmup/seeds'),
        )
      // The ceiling on the seed organisations the engine orders by itself when the network is short.
      if (sub === 'grow') {
        if (o['max-microsoft'] !== undefined)
          return out(
            await call(config, 'PUT', '/microsoft-seeds/growth', {
              maxTenants: Number(o['max-microsoft']),
            }),
          )
        if (o['max-orgs'] === undefined)
          return out(((await call(config, 'GET', '/warmup/seeds')) as { growth: unknown }).growth)
        return out(await call(config, 'PUT', '/warmup/growth', { maxOrgs: Number(o['max-orgs']) }))
      }
      // Folderly's lent seed organisations leaving the pool, step by step.
      if (sub === 'phase-out')
        return out(
          o['per-day'] === undefined
            ? await call(config, 'GET', '/warmup/phase-out')
            : await call(config, 'PUT', '/warmup/phase-out', { perDay: Number(o['per-day']) }),
        )
      // A higher daily cap for our own seeds, tried on some organisations beside a control.
      if (sub === 'cap-trial') {
        const provider = o.provider ? { provider: o.provider } : {}
        if (!arg) return out(await call(config, 'GET', '/warmup/cap-trials'))
        if (arg === 'start') {
          if (o.cap === undefined || o.count === undefined)
            throw new BhError(
              'How high a cap, and on how many organisations?',
              { hint: 'bh warmup cap-trial start --cap 25 --count 10 [--days 14]' },
              2,
            )
          return out(
            await call(config, 'POST', '/warmup/cap-trials', {
              cap: Number(o.cap),
              count: Number(o.count),
              ...(o.days !== undefined ? { days: Number(o.days) } : {}),
              ...provider,
            }),
          )
        }
        if (arg === 'end')
          return out(
            await call(config, 'POST', '/warmup/cap-trials/end', {
              ...provider,
              ...(o.reason ? { reason: o.reason } : {}),
            }),
          )
        throw new BhError(
          `bh warmup cap-trial ${arg} is not a command`,
          { hint: 'bh warmup cap-trial [start|end]' },
          2,
        )
      }
      // Warm-up is always on for every active mailbox, a metered organisation's too (2026-11-19).
      if (sub === 'on' || sub === 'off')
        throw new BhError(
          'Warm-up is always on for every active mailbox; it cannot be switched',
          {
            hint: 'bh warmup status shows each mailbox on the ladder; pause a mailbox with bh mailbox update <id> --status paused',
          },
          2,
        )
      break
    case 'telegram': {
      // A sender's own Telegram, linked in Unipile (docs/decisions/telegram.md).
      if (!sub) return out(await call(config, 'GET', `/projects/${p()}/telegram-accounts`))
      if (sub === 'connect') {
        if (!o.sender)
          throw new BhError('Whose Telegram?', { hint: '--sender <id>: bh senders' }, 2)
        const path = o.org
          ? `/orgs/${encodeURIComponent(o.org)}/telegram-accounts/connect`
          : `/projects/${p()}/telegram-accounts/connect`
        return out(await call(config, 'POST', path, { senderId: o.sender }))
      }
      if (sub === 'invite') {
        if (!o.sender)
          throw new BhError('Whose Telegram?', { hint: '--sender <id>: bh senders' }, 2)
        return out(
          await call(config, 'POST', `/projects/${p()}/invites`, {
            channel: 'telegram',
            senderId: o.sender,
          }),
        )
      }
      if (sub === 'set-aside') {
        if (!arg) throw new BhError('Which peer?', { hint: 'bh telegram peers <account-id>' }, 2)
        return out(
          await call(
            config,
            'POST',
            `/telegram-peers/${seg(arg)}/set-aside`,
            o.undo ? { undo: true } : {},
          ),
        )
      }
      if (sub === 'match' || sub === 'unmatch') {
        if (!arg) throw new BhError('Which peer?', { hint: 'bh telegram peers <account-id>' }, 2)
        if (!o.contact)
          throw new BhError(
            'Which contact?',
            { hint: '--contact <id>: bh lead show, bh contacts' },
            2,
          )
        return out(
          await call(config, 'POST', `/telegram-peers/${seg(arg)}/${seg(sub)}`, {
            contactId: o.contact,
          }),
        )
      }
      if (!arg) throw new BhError('Which account?', { hint: 'bh telegram lists their ids' }, 2)
      if (sub === 'peers') {
        if (o.refresh) await call(config, 'POST', `/telegram-accounts/${seg(arg)}/peers/read`, {})
        const q = new URLSearchParams({
          ...(o.search ? { search: String(o.search) } : {}),
          ...(o.unmatched ? { unmatched: 'true' } : {}),
          ...(o['set-aside'] ? { setAside: 'true' } : {}),
        })
        return out(await call(config, 'GET', `/telegram-accounts/${seg(arg)}/peers?${q}`))
      }
      if (sub === 'reconnect')
        return out(await call(config, 'POST', `/telegram-accounts/${seg(arg)}/reconnect`, {}))
      if (sub === 'update')
        return out(
          await call(config, 'PATCH', `/telegram-accounts/${seg(arg)}`, {
            ...(o['message-limit'] ? { dailyMessageLimit: Number(o['message-limit']) } : {}),
            ...(o['delay-min'] ? { delayMinSeconds: Number(o['delay-min']) } : {}),
            ...(o['delay-max'] ? { delayMaxSeconds: Number(o['delay-max']) } : {}),
            ...(o.status ? { status: o.status } : {}),
          }),
        )
      break
    }
    case 'linkedin': {
      const limits = {
        ...(o['invite-limit'] ? { dailyInviteLimit: Number(o['invite-limit']) } : {}),
        ...(o['message-limit'] ? { dailyMessageLimit: Number(o['message-limit']) } : {}),
      }
      if (!sub) return out(await call(config, 'GET', `/projects/${p()}/linkedin-accounts`))
      if (sub === 'available') return out(await call(config, 'GET', '/linkedin/available'))
      if (sub === 'connect')
        return out(
          await call(config, 'POST', `/projects/${p()}/linkedin-accounts`, {
            unipileAccountId: arg,
            ...(o.sender ? { senderId: o.sender } : {}),
            ...limits,
          }),
        )
      if (sub === 'invite')
        return out(
          await call(config, 'POST', `/projects/${p()}/invites`, {
            channel: 'linkedin',
            senderId: o.sender,
          }),
        )
      if (sub === 'pages')
        return out(await call(config, 'GET', `/linkedin-accounts/${seg(arg)}/pages`))
      if (sub === 'posts')
        return out(
          await call(
            config,
            'GET',
            `/projects/${p()}/linkedin-posts?${new URLSearchParams(o.status ? { status: o.status } : {})}`,
          ),
        )
      if (sub === 'post' && arg === 'cancel') {
        if (!pos[3])
          throw new BhError('Which post?', { hint: 'bh linkedin posts lists their ids' }, 2)
        return out(await call(config, 'POST', `/linkedin-posts/${seg(pos[3])}/cancel`, {}))
      }
      if (sub === 'post')
        return out(
          await call(config, 'POST', `/projects/${p()}/linkedin-posts`, {
            posts: await withImages(await readRows(need(o.file)), need(o.file)),
            dryRun: Boolean(o['dry-run']),
          }),
        )
      // Managed accounts (docs/decisions/linkedin-hub.md): made here on an agency sender, on an IP of
      // their own, signed in only through it.
      const account = () => {
        if (!arg) throw new BhError('Which account?', { hint: 'bh linkedin accounts <org>' }, 2)
        return `/linkedin-accounts/${seg(arg)}`
      }
      if (sub === 'accounts') {
        if (!arg)
          throw new BhError('Which organisation?', { hint: 'bh linkedin accounts belkins' }, 2)
        return out(await call(config, 'GET', `/orgs/${encodeURIComponent(arg)}/linkedin-accounts`))
      }
      if (sub === 'create') {
        if (!arg)
          throw new BhError(
            'Which organisation?',
            { hint: 'bh linkedin create belkins --sender <id>' },
            2,
          )
        if (!o.sender)
          throw new BhError('Whose account?', { hint: '--sender <id>: bh agency senders' }, 2)
        const signUp = o['sign-up']
          ? {
              signUp: {
                ...(o.first ? { firstName: o.first } : {}),
                ...(o.last ? { lastName: o.last } : {}),
                ...(o.email ? { email: o.email } : {}),
              },
            }
          : {}
        return out(
          await call(config, 'POST', `/orgs/${encodeURIComponent(arg)}/linkedin-accounts/managed`, {
            senderId: o.sender,
            ...(o.country ? { country: o.country } : {}),
            ...(o.owner ? { ownerId: o.owner } : {}),
            ...(o['invite-limit'] ? { dailyInviteLimit: Number(o['invite-limit']) } : {}),
            ...signUp,
          }),
        )
      }
      if (sub === 'show') return out(await call(config, 'GET', account()))
      if (sub === 'history') return out(await call(config, 'GET', `${account()}/events`))
      if (sub === 'requests') {
        if (o.day && !/^\d{4}-\d{2}-\d{2}$/.test(o.day))
          throw new BhError('--day is a UTC date', { hint: '--day 2026-11-17' }, 2)
        return out(
          await call(config, 'GET', `${account()}/requests${o.day ? `?day=${o.day}` : ''}`),
        )
      }
      if (sub === 'login') {
        const path = account()
        const [password, totpSecret] = await readSecrets([
          'LinkedIn password (empty keeps the stored one): ',
          ...(o.totp ? ['Authenticator key (the one under "Can\'t scan the QR code"): '] : []),
        ])
        return out(
          await call(config, 'PUT', `${path}/credentials`, {
            ...(o.username ? { username: o.username } : {}),
            ...(password ? { password } : {}),
            ...(totpSecret ? { totpSecret } : {}),
          }),
        )
      }
      if (sub === 'sign-in')
        return out(
          await call(config, 'POST', `${account()}/sign-in`, o.browser ? { using: 'browser' } : {}),
        )
      if (sub === 'checkpoint')
        return out(
          await call(config, 'POST', `${account()}/checkpoint`, {
            code: o.code ? String(o.code) : '',
          }),
        )
      if (sub === 'code') return out(await call(config, 'GET', `${account()}/code`))
      if (sub === 'password') return out(await call(config, 'GET', `${account()}/password`))
      if (sub === 'created' || sub === 'verified') {
        const path = `${account()}/${sub}`
        if (o.undo) return out(await call(config, 'DELETE', path))
        return out(
          await call(config, 'PUT', path, o.owner ? { ownerId: orNone(String(o.owner)) } : {}),
        )
      }
      if (sub === 'warmup') {
        const likes = o['likes-a-day']
        const comments = o['comments-a-day']
        const topics = o.topics
        if (likes === undefined && comments === undefined && topics === undefined)
          return out(((await call(config, 'GET', account())) as { warmup: unknown }).warmup)
        return out(
          await call(config, 'PUT', `${account()}/warmup`, {
            ...(likes !== undefined
              ? { likesADay: String(likes) === 'default' ? null : Number(likes) }
              : {}),
            ...(comments !== undefined ? { commentsADay: Number(comments) } : {}),
            ...(topics !== undefined
              ? {
                  topics: String(topics)
                    .split(',')
                    .map((t) => t.trim())
                    .filter(Boolean),
                }
              : {}),
          }),
        )
      }
      if (sub === 'feed') return out(await call(config, 'GET', `${account()}/feed`))
      if (sub === 'comment') {
        if (!o.post)
          throw new BhError('Under which post?', { hint: `bh linkedin feed ${arg} lists them` }, 2)
        if (!o.text) throw new BhError('What does it say?', { hint: '--text "<comment>"' }, 2)
        return out(
          await call(config, 'POST', `${account()}/comments`, {
            postId: String(o.post),
            text: String(o.text),
            ...(o.url ? { url: String(o.url) } : {}),
            ...(o.author ? { author: String(o.author) } : {}),
          }),
        )
      }
      if (sub === 'profile-posts') {
        const path = `${account()}/profile-posts`
        const to = pos[3]
        if (to !== 'on' && to !== 'off')
          throw new BhError('On or off?', { hint: `bh linkedin profile-posts ${arg} on|off` }, 2)
        return out(
          await call(config, to === 'on' ? 'PUT' : 'DELETE', path, to === 'on' ? {} : undefined),
        )
      }
      if (sub === 'open') {
        account()
        return out(await linkedinOpen(config, arg!, o.chrome ? String(o.chrome) : undefined))
      }
      if (sub === 'email-link')
        return out(await call(config, 'POST', `${account()}/browser/email-link`, {}))
      if (sub === 'phone') {
        if (!o.rent)
          throw new BhError(
            'Rent a number?',
            {
              hint: `bh linkedin phone ${arg ?? '<id>'} --rent: a US mobile number at TextVerified, renewing monthly (bh linkedin show prints the one it has)`,
            },
            2,
          )
        return out(await call(config, 'POST', `${account()}/phone`, {}))
      }
      if (sub === 'phone-number' || sub === 'phone-code')
        return out(await call(config, 'POST', `${account()}/browser/${sub}`, {}))
      if (sub === 'mailbox') {
        if (!o.workplace)
          throw new BhError(
            'Which mailbox?',
            {
              hint: 'bh linkedin mailbox <id> --workplace: the codes come from its person’s workplace mailbox',
            },
            2,
          )
        return out(await call(config, 'PUT', `${account()}/mailbox`, { workplace: true }))
      }
      if (sub === 'owner') {
        const who = pos[3]
        if (!who)
          throw new BhError('Given to whom?', { hint: 'bh linkedin owner <id> <user id|none>' }, 2)
        return out(await call(config, 'PUT', `${account()}/owner`, { ownerId: orNone(who) }))
      }
      if (sub === 'archive')
        return out(await call(config, 'POST', `${account()}/archive${o.undo ? '/undo' : ''}`, {}))
      if (sub === 'link') return out(await call(config, 'POST', `${account()}/links`, {}))
      if (sub === 'member') {
        // The people who sign in to work in their own account's browser: bh linkedin member <verb> <org> …
        const [verb, org, who] = [arg, pos[3], pos[4]]
        if (!org)
          throw new BhError('Which organisation?', { hint: 'bh linkedin member list belkins' }, 2)
        const base = `/orgs/${encodeURIComponent(org)}/linkedin-members`
        if (verb === 'list') return out(await call(config, 'GET', base))
        if (verb === 'add') {
          if (!o.email || !o.name)
            throw new BhError(
              'Who?',
              { hint: 'bh linkedin member add <org> --email <a> --name <n>' },
              2,
            )
          const [secret] = await readSecrets(['Their password (12 characters or more): '])
          return out(
            await call(config, 'POST', base, { email: o.email, name: o.name, password: secret }),
          )
        }
        if (!who) throw new BhError('Which member?', { hint: `bh linkedin member list ${org}` }, 2)
        if (verb === 'password') {
          const [secret] = await readSecrets(['New password (12 characters or more): '])
          return out(await call(config, 'PUT', `${base}/${who}/password`, { password: secret }))
        }
        if (verb === 'disable' || verb === 'enable')
          return out(
            await call(config, 'PATCH', `${base}/${who}`, { disabled: verb === 'disable' }),
          )
      }
      if (sub === 'update')
        return out(
          await call(config, 'PATCH', `/linkedin-accounts/${seg(arg)}`, {
            ...limits,
            ...(o['delay-min'] ? { delayMinSeconds: Number(o['delay-min']) } : {}),
            ...(o['delay-max'] ? { delayMaxSeconds: Number(o['delay-max']) } : {}),
            ...(o.status ? { status: o.status } : {}),
            ...yesNo('ramp', o.ramp),
          }),
        )
      break
    }
    case 'proxy':
    case 'proxies': {
      // The pool of static ISP IPs managed LinkedIn accounts sign in from: the platform admin's.
      if (cmd === 'proxies' || !sub || sub === 'list')
        return out(await call(config, 'GET', '/linkedin-proxies'))
      if (sub === 'add') {
        // Each named as read below, so the options table sees them too.
        const given = {
          country: o.country,
          host: o.host,
          port: o.port,
          username: o.username,
          provider: o.provider,
        }
        for (const [flag, value] of Object.entries(given))
          if (!value)
            throw new BhError(
              `--${flag} is missing`,
              {
                hint: 'bh proxy add --country US --host <h> --port <n> --username <u> --provider <name>',
              },
              2,
            )
        const [password] = await readSecrets(['Proxy password: '])
        if (!password) throw new BhError('No password given', {}, 2)
        return out(
          await call(config, 'POST', '/linkedin-proxies', {
            country: o.country,
            host: o.host,
            port: Number(o.port),
            username: o.username,
            password,
            provider: o.provider,
            ...(o['paid-until'] ? { paidUntil: orNone(String(o['paid-until'])) } : {}),
            ...(o['usd-month'] ? { usdMonth: Number(o['usd-month']) } : {}),
          }),
        )
      }
      if (!arg) throw new BhError('Which proxy?', { hint: 'bh proxy list' }, 2)
      if (sub === 'update') {
        const login = o.username ? await readSecrets(['Proxy password: ']) : []
        return out(
          await call(config, 'PATCH', `/linkedin-proxies/${seg(arg)}`, {
            ...(o['paid-until'] ? { paidUntil: orNone(String(o['paid-until'])) } : {}),
            ...(o['usd-month'] ? { usdMonth: Number(o['usd-month']) } : {}),
            ...(o.username ? { username: o.username, password: login[0] } : {}),
          }),
        )
      }
      if (sub === 'check' || sub === 'retire' || sub === 'unretire')
        return out(await call(config, 'POST', `/linkedin-proxies/${seg(arg)}/${seg(sub)}`, {}))
      break
    }
    case 'oauth-client':
      if (sub === 'add')
        return out(
          await call(config, 'POST', '/saas/oauth-clients', {
            name: o.name,
            redirectUris: o.redirect ? list(String(o.redirect)) : [],
            ...(o.auth ? { authMethod: `client_secret_${String(o.auth)}` } : {}),
          }),
        )
      if (sub === 'list') return out(await call(config, 'GET', '/saas/oauth-clients'))
      if (sub === 'remove') {
        if (!arg) throw new BhError('Which client?', { hint: 'bh oauth-client list' }, 2)
        return out(await call(config, 'DELETE', `/saas/oauth-clients/${encodeURIComponent(arg)}`))
      }
      break
    case 'token':
      if (sub === 'create')
        return out(
          await call(config, 'POST', '/tokens', {
            name: o.name,
            ...(o.kind ? { kind: o.kind } : {}),
            ...(o.for ? { forEmail: o.for } : {}),
          }),
        )
      if (sub === 'list') return out(await call(config, 'GET', '/tokens'))
      if (sub === 'revoke') return out(await call(config, 'DELETE', `/tokens/${seg(arg)}`))
      if (sub === 'unrevoke')
        return out(await call(config, 'POST', `/tokens/${seg(arg)}/unrevoke`, {}))
      break
    case 'user':
      if (sub === 'add')
        return out(
          await call(config, 'POST', '/users', {
            email: o.email,
            name: o.name,
            isAdmin: Boolean(o.admin),
          }),
        )
      if (sub === 'set')
        return out(
          await call(config, 'PATCH', `/users/${seg(arg)}`, {
            ...(o.email ? { email: o.email } : {}),
            ...(o.name ? { name: o.name } : {}),
            ...(o.admin ? { isAdmin: true } : {}),
            ...(o['no-admin'] ? { isAdmin: false } : {}),
          }),
        )
      if (sub === 'disable' || sub === 'enable')
        return out(
          await call(config, 'PATCH', `/users/${seg(arg)}`, { disabled: sub === 'disable' }),
        )
      break
    case 'users':
      return out(await call(config, 'GET', '/users'))
    case 'platform':
      return out(await call(config, 'GET', '/platform'))
    case 'admins':
      return out(await call(config, 'GET', '/admins'))
    case 'admin': {
      if (sub === 'add') {
        if (!arg) throw new BhError('Whom?', { hint: 'bh admin add <email> [--name <n>]' }, 2)
        return out(
          await call(config, 'POST', '/admins', {
            email: arg,
            ...(o.name ? { name: o.name } : {}),
          }),
        )
      }
      if (sub === 'remove') {
        if (!arg) throw new BhError('Whom?', { hint: 'bh admin remove <user-id|email>' }, 2)
        let id = arg
        if (arg.includes('@')) {
          const admins = (await call(config, 'GET', '/admins')) as { id: string; email: string }[]
          const found = admins.find((a) => a.email === arg.toLowerCase())
          if (!found) throw new BhError(`${arg} is not a platform admin`, { hint: 'bh admins' }, 2)
          id = found.id
        }
        return out(await call(config, 'DELETE', `/admins/${seg(id)}`))
      }
      break
    }
    case 'system-mail': {
      if (sub === 'domains') return out(await call(config, 'GET', '/system-mail/domains'))
      if (sub === 'domain') {
        const name = pos[3]
        if (!name)
          throw new BhError('Which domain?', { hint: 'bh system-mail domain add <name>' }, 2)
        if (arg === 'add')
          return out(await call(config, 'POST', '/system-mail/domains', { domain: name }))
        if (arg === 'verify')
          return out(
            await call(
              config,
              'POST',
              `/system-mail/domains/${encodeURIComponent(name)}/verify`,
              {},
            ),
          )
      }
      if (sub === 'send') {
        if (!o['body-file'])
          throw new BhError('Where is the body?', { hint: '--body-file <path>, or - for stdin' }, 2)
        return out(
          await call(config, 'POST', '/system-mail/send', {
            from: o.from,
            to: o.to ? list(o.to) : [],
            subject: o.subject,
            text: await readText(o['body-file']),
            ...(o['html-file'] ? { html: await readText(o['html-file']) } : {}),
            ...(o['reply-to'] ? { replyTo: o['reply-to'] } : {}),
            ...(o.project ? { project: o.project } : {}),
          }),
        )
      }
      break
    }
    case 'slack':
      if (sub === 'connect')
        return out(
          current
            ? await call(config, 'POST', `/projects/${p()}/slack/connect`, {})
            : await call(config, 'POST', '/slack/connect', {}),
        )
      if (sub === 'client-channel' && arg === 'create')
        return out(
          await call(config, 'POST', `/projects/${p()}/slack/client-channel/create`, {
            ...(o.name ? { name: o.name } : {}),
            ...(o.invite ? { invite: list(o.invite) } : {}),
          }),
        )
      if (sub === 'client-channel' && arg === 'briefs-only') {
        const to = pos[3]
        if (to !== 'on' && to !== 'off')
          throw new BhError(
            'On or off?',
            { hint: 'bh slack client-channel briefs-only <on|off> --project <slug>' },
            2,
          )
        return out(
          await call(config, 'POST', `/projects/${p()}/slack/client-channel/briefs-only`, {
            on: to === 'on',
          }),
        )
      }
      if (sub === 'channel' && o.client)
        return out(
          await call(config, 'POST', `/projects/${p()}/slack/client-channel`, {
            channel: arg === 'none' ? null : arg,
            ...(o.team ? { team: o.team } : {}),
          }),
        )
      if (sub === 'channel')
        return out(
          await call(config, 'POST', `/projects/${p()}/slack`, {
            channel: arg === 'none' ? null : arg,
            ...(o.team ? { team: o.team } : {}),
          }),
        )
      if (sub === 'disconnect')
        return out(await call(config, 'POST', '/slack/disconnect', o.team ? { team: o.team } : {}))
      if (sub === 'post') {
        if (o['body-file'] === '-' && o['blocks-file'] === '-')
          throw new BhError(
            'Only one of --body-file and --blocks-file can read stdin',
            { hint: 'Write one of them to a file and pass its path' },
            2,
          )
        const text = o['body-file'] ? await readText(o['body-file']) : need(o.body)
        const blocks = o['blocks-file'] ? await readBlocks(o['blocks-file']) : undefined
        const message = {
          text,
          ...(blocks ? { blocks } : {}),
          ...(o.to ? { to: o.to } : {}),
          ...(o.thread ? { thread: o.thread } : {}),
          ...(o.mention ? { mention: list(o.mention) } : {}),
          ...(o.team ? { team: o.team } : {}),
        }
        // Named somewhere, or answering a thread, it needs no project; otherwise it is the project's channel.
        return out(
          o.project || (!o.to && !o.thread)
            ? await call(config, 'POST', `/projects/${p()}/slack/post`, message)
            : await call(config, 'POST', '/slack/post', message),
        )
      }
      return out(await call(config, 'GET', '/slack'))
  }
  throw new BhError(`Unknown command: ${pos.join(' ')}`, { hint: 'bh --help' }, 2)
}

try {
  await main(process.argv.slice(2)).catch((error: unknown) => {
    throw error instanceof MissingArgument ? missingArgument(process.argv.slice(2)) : error
  })
} catch (error) {
  if (error instanceof BhError) {
    process.stderr.write(
      `${JSON.stringify({ request: error.message, ...(error.payload as object) }, null, 2)}\n`,
    )
    process.exitCode = error.exitCode
  } else {
    process.stderr.write(
      `${JSON.stringify({ error: error instanceof Error ? error.message : String(error) })}\n`,
    )
    process.exitCode = 1
  }
}

// Every answer is written out before bh ends, however slowly the pipe reads it: a pipe's writes are
// asynchronous on macOS, and an answer must never reach a parser cut short (belkins-home-plugin#75).
// bh never calls process.exit; this also makes a failed write end non-zero instead of silently.
await new Promise<void>((resolve) =>
  process.stdout.write('', (error) => {
    if (error) process.exitCode ||= 1
    resolve()
  }),
)

/** `--signature-html-file`: the file's HTML, or null to clear it when the file is empty. */
async function signatureHtml(file: string | undefined) {
  if (!file) return {}
  const html = (await readFile(file, 'utf8')).trim()
  return { signatureHtml: html || null }
}

/**
 * A page showing a signature as the lead will see it: the HTML, and the text beneath. A function
 * declaration: main runs at the top level above, before a `const` here would be initialised.
 */
function signaturePage(s: { name: string; text: string | null; rendered: string | null }) {
  const escape = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  return `<!doctype html><meta charset="utf-8"><title>${escape(s.name)}</title>
<body style="font-family: Arial, sans-serif; font-size: 14px; max-width: 720px; margin: 32px auto">
<p>Hi Mia,</p><p>The message goes here.</p><br>
${s.rendered ?? '<p><i>No HTML signature: this sender signs in text only.</i></p>'}
<hr style="margin: 32px 0"><pre style="white-space: pre-wrap">${escape(s.text ?? '(no text signature)')}</pre>
</body>
`
}

/** `--daily-limit`, `--delay-min`, `--delay-max`, `--warmed` / `--not-warmed` as a mailbox's limits. */
function mailboxLimits(o: Record<string, unknown>) {
  return {
    ...(o['daily-limit'] ? { dailyLimit: Number(o['daily-limit']) } : {}),
    ...(o['delay-min'] ? { delayMinSeconds: Number(o['delay-min']) } : {}),
    ...(o['delay-max'] ? { delayMaxSeconds: Number(o['delay-max']) } : {}),
    ...(o.warmed ? { warmed: true } : o['not-warmed'] ? { warmed: false } : {}),
  }
}

/**
 * Password mailboxes, one at a time: each is logged in to before it is stored, and one refused
 * must not stop the rest. A refusal names the address only — never the password it came with.
 */
async function addPasswordMailboxes(
  config: BhConfig,
  path: string,
  file: string,
  extra: Record<string, unknown>,
) {
  const rows = (await readRows(file)) as Record<string, unknown>[]
  const added: unknown[] = []
  const refused: unknown[] = []
  for (const [row, one] of rows.entries()) {
    try {
      added.push(await call(config, 'POST', path, { ...one, ...extra }))
    } catch (error) {
      if (!(error instanceof BhError)) throw error
      refused.push({ row, address: one.address, error: error.message, detail: error.payload })
    }
  }
  out({ added, refused })
  if (refused.length) {
    process.stderr.write(`refused: ${refused.length} of ${rows.length}, see "refused"\n`)
    process.exitCode = 1
  }
}
