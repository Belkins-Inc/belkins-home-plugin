#!/usr/bin/env node
// bh — the team's CLI for the engine's API (docs/decisions/tools.md). JSON out; errors verbatim.

import { readFile, writeFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'

import { merge, refusedIn, sendRows } from './batch.ts'
import { consoleLogin } from './console-login.ts'
import { BhError, call } from './client.ts'
import { readDncCsv } from './csv.ts'
import {
  CONFIG_PATH,
  SESSION,
  type BhConfig,
  loadConfig,
  loadSessionProject,
  saveConfig,
  saveSessionProject,
} from './config.ts'
import { readInput, readRows, readSecrets, readText } from './input.ts'
import { DEFAULT_API, startLogin, waitForLogin } from './login.ts'
import { setup } from './setup.ts'

/** Rows per dnc import or check request; the engine takes up to 10,000. */
const DNC_CHUNK = 5000

const USAGE = `bh <command> [options] — JSON out, errors verbatim.

  setup [--dir <path>]                  once, after the plugin is installed: the working directory
                                         (~/work/belkins-home) and bh on your terminal's PATH
  login [--api <url>] [--no-browser]    connect: prints a link to approve in the browser (production by default);
                                         in a terminal it waits, elsewhere run bh login --wait after approving
  login --wait                           collect the token once the link is approved
  login --api <url> --token <token>     save a token made by hand
  use [<project>]                       the project this Claude Code session acts on; with no slug, which one
                                         and why. Each session keeps its own and none is ever defaulted;
                                         outside a session, --project or BH_PROJECT; either beats bh use
  whoami | health
  projects [--org <slug>] | project create <slug> --name <name> [--timezone <tz>] [--org <slug>] [--owner <user-id>]
  project members | project member <user-id> [--role owner|member] | project member remove <user-id>
  orgs | org create <slug> --name <name>   organisations you belong to (the platform admin: all)
  org members <org> | org add <org> --email <e> [--name <n>] [--role admin|member] | org role <org> <user-id> --role admin|member | org remove <org> <user-id>
  project update [--name <n>] [--timezone <tz>] [--domain-cap <n>] [--brief <text> | --brief-file <path>]   (a person only)
  brief [--project <slug>]              read this first, every session
  sql "<select …>" [--limit <n>]        read anything, read-only; @project stands for the current project's id
  note add --kind <decision|insight|client_feedback|rule|todo> --title <t> [--body <b>] [--supersedes <id,id>]
       [--strategy <id>] [--segment <id>]
  note list [--kind <k>] [--all]
  task open --title <t> --assignee <email> [--priority urgent] [--due <iso>] [--done-when <text>] [--body <b>]
  task list [--status open|done|cancelled]
  task close <id> [--status done|cancelled] [--note <text>] | task reopen <id>
  task assign <id> --assignee <email> [--note <text>]   hand an open task to someone else; Slack tells them afresh
  session end --summary <text>           the hand-over: done, left, to watch
  segments | segment create --name <n> [--body <definition>] [--criteria <json>] [--estimate <n>]
  segment update <id> [--name <n>] [--body <definition>] [--criteria <json>] [--estimate <n>] [--status active|paused|exhausted|archived]
  personas | persona upsert --name <n> [--titles "a|b"] [--excluded-titles "a|b"] [--seniorities "a|b"]
       [--departments "a|b"] [--hints <search hints>] [--body <description>]   a field left out keeps its value
  strategies | strategy create --file <json> | strategy update <id> --file <json> | strategy show <id>
  strategy launch <id> | strategy pause <id> [--reason <t>] | strategy archive <id>   (a person only)
  strategy exclude <id> --company <id|domain> --reason <t>   keep a company out of this strategy only (a person only)
  strategy exclude <id> --file <json|jsonl|->          [{"domain"|"companyId","reason","excluded":false to let back in}]
  strategy include <id> --company <id|domain> [--reason <t>]   let it back in
                                         enroll skips its people; those already in a plan keep going ("live")
  leads [--q <text>] [--strategy <id>] [--state in_plan|paused|stuck|replied|ended] [--limit <n>] [--offset <n>]
  lead show <enrollment-id>              one lead's plan step by step
  lead resume <enrollment-id>            put back a lead a reply stopped when the reply needed nothing (a person only)
  lead pause <enrollment-id> | lead unpause <enrollment-id>   hold a lead by hand, and let it go on (a person only)
  lead stop <enrollment-id> --reason <t> end a lead for good; frees the contact for another strategy (a person only)
  strategy unlaunch <id>                 undo a launch or resume within a minute, before anything is sent
  reply unapprove <id>                   take an approval back before the reply goes (a person only)
  plan set <strategy-id> --file <json>                 {"plans":[{"appliesWhen":"email_only","steps":[{"channel":"email"},…]}]}
  plan step <strategy-id> <step-id> --file <json>      {"guidance","hypothesis"}: one step's, frozen templates too; step ids in strategy show
  companies upsert --file <json|jsonl|->               [{"domain","name","employeeCount","country","facts"}]
                                         every --file of rows: a JSON array, or JSONL (a .jsonl file always is);
                                         sent 500 rows or 512 KB at a time, answered as one; a refused row exits 1
  companies judge <segment-id> --file <json|jsonl|->   [{"domain","status":"new|qualified|disqualified","reason","questionId","signal","sourceId","searchId",
                                         "evidence":[{"fact","value","url","seenAt"}],"exclusionId"}]
                                         every verdict is kept; a company breaking an exclusion is not qualified (the refusal
                                         names its exclusionIds); qualified and disqualified need a reason; a verdict without evidence is warned about
  companies in <segment-id> [--status new|qualified|disqualified] [--waiting fact|client] [--q <text>] [--limit <n>] [--offset <n>]
                                         answers {companies, total, counts, limit, offset}
  companies verdicts <segment-id> --company <id>       every verdict ever passed on that company
  sources | source add <segment-id> --kind linkedin|trustpilot|web|directory|import --name <n> [--provider <p>]
       [--query <json>] [--body <instructions>] [--estimate <n>]
  source update <id> [--status active|paused|exhausted] [--cursor <c>] [--estimate <n>] [--body <instructions>]
                                         --estimate reads back as estimatedCompanies, in bh segments and bh sources
  search record --file <json>            {"kind":"companies","sourceId","provider","query","cursor","results","newRecords","duplicates","callIds":[…]}
                                         {"kind":"contacts","strategyId","companyId","provider","query","results","newRecords","duplicates","callIds":[…]}
                                         a company search names its sourceId, a contact search its strategyId
  exclusions | exclusion add --kind country|country_outside|industry|business_model|employees_below|employees_above|rating_above|other --value <v> [--note <why>]
  exclusion remove <id>
  questions [--status open|asked|answered|dropped|all] | question add --body <question> [--note <context>] [--asked]
  question asked <id> | question answer <id> --body <answer, verbatim> | question drop <id>
  hypothesis list [--status open|proposed|testing|confirmed|rejected|parked|all]   open: proposed and testing
  hypothesis add --claim <t> [--evidence <why>] [--segment <id>] [--persona <id>] [--strategy <id>]
       [--metric <what is measured>] [--threshold <what confirms it>] [--status proposed|parked]
  hypothesis update <id> [--claim <t>] [--evidence <why> | --add-evidence <a dated line>]
       [--segment|--persona|--strategy <id|none>] [--metric <m>] [--threshold <t>]
       [--status proposed|testing|confirmed|rejected|parked] [--verdict <what the results showed>]
                                         testing: a person only, with --metric and --threshold;
                                         confirmed and rejected carry --verdict
  goals | goal set <YYYY-MM> --target <meetings> [--counts qualified|held] | goal done <YYYY-MM> --done <n>   (a person only)
  contacts upsert --file <json|jsonl|->                [{"email","linkedinUrl","firstName","lastName","title","companyDomain","emailStatus","facts"}]
  contacts [--q <text>]
  dnc add --kind email|domain --value <v> --reason <r> [--note <t>] [--every-project] | dnc remove <id>
                                         --every-project blocks it for every project, not only this one
  dnc import <file.csv|-> [--reason <r>] [--note <t>] [--every-project]
                                         a column email and/or domain, or value (kind from "@", or a kind column);
                                         reason and note columns win over the flags; no header: one value a line.
                                         answers {added, already, refused, invalid}; a refused row exits 1
  dnc check <address|domain>… | dnc check --file <csv>
                                         which of them the list blocks (a domain blocks its subdomains) —
                                         before paying a provider to enrich or find anyone there
  enroll <strategy-id> --file <json|jsonl|-> [--dry-run]    [{"contactId","segmentId","personaId"}]
  stand <strategy-id> --contact <id> --status candidate|held|rejected [--persona <id>] [--reason <t>]
  stand <strategy-id> --file <json|jsonl|->            [{"contactId","status","personaId","reason"}]
  worked <strategy-id> --file <json|jsonl|->           [{"domain","status":"pending|contacts_found|no_match|enrolled|exhausted","contactsFound"}]
                                         what a search inside a company came to; the engine records the rest as people stand
  copy queue <strategy-id> [--limit <n>] | copy write --file <json|jsonl|->   [{"messageId","subject","body","angle"}]
  copy check --file <json|jsonl|->      the same file, checked against the house rules and written nowhere;
                                         every problem per messageId, exit 1 when there is one
  preview <message-id>
  senders | sender add --name <n> [--title <t>] [--signature <text>] | sender update <id> [--name] [--title] [--signature]
                                         add, update and share take --signature-html-file <file.html> too: the email then
                                         goes as text and HTML (the text keeps --signature); an empty file clears it
  sender image <id> <file.png|jpg>       a picture for the HTML signature (100 KB at most); use the src it answers
  sender images <id> | sender image-remove <id> <image-id>
  sender signature <id> [--out <file.html>]   how they sign on this project; --out writes it to open in a browser
  sender move <id> --to <project>        with their mailboxes and LinkedIn, while nothing was written as them
  sender remove <id>                     one nothing refers to (no mailbox, LinkedIn, message or strategy)
  sender share <id> [--title <t>] [--signature <text>] [--daily-share <n>]
                                         puts an agency sender on this project, named for this client
  sender unshare <id>                    takes them off it again

  agency senders <org>                   the agency's own people, and who they write for
  agency add <org> --name <n> [--title <t>] [--signature <text>] [--signature-html-file <file.html>]
  agency remove <org> <id>               while they are on no project and hold no channel
  agency mailbox <org> --sender <id> --provider google|microsoft [--daily-limit <n>] [--delay-min <s>] [--delay-max <s>] [--warmed]
                                         a mailbox of theirs, shared by every project they are on
  agency smtp <org> --sender <id> --file <json|jsonl|-> [--daily-limit <n>] [--delay-min <s>] [--delay-max <s>] [--warmed]
                                         a password mailbox of theirs (rows as for mailbox smtp)
  agency linkedin <org> <unipile-account-id> --sender <id> [--invite-limit <n>] [--message-limit <n>]
  agency domains <org> | agency quote <org> <name>…   the agency's own domains, for its own senders
  agency approve <org> <name>… --max-cents <n> [--redirect <url>]   buy them for the agency (its admin only)
  agency order <org> <domain> --sender <agency sender id> --first-name <n> --last-name <n> --username <u> | --file <f>
                                         a Workspace seat on it for one of its senders (its admin only)
  agency orders <org>                    what was ordered on the agency's domains and where each is
  calendars                              the project's calendars: state, event type, last sync
  calendar connect --sender <id> --key <Cal.com API key> [--event-type <id>]
                                         the sender's Cal.com; its Google, Outlook and hours are set up there
  calendar update <id> [--event-type <id>] [--priority <n>] [--timezone <iana>] [--owner <name>] [--sender <id>]
  calendar archive <id>                  out of booking for good; connecting again writes a new row
  slots [--days <n>] [--calendar <id>] [--limit <n>]   free slots, soonest first (not yet offered to anyone)
  slots offer <thread-id> --slots <iso,iso> [--calendar <id>]
                                         holds them for this lead for 72 h; a newer offer replaces an older one
  meetings [--upcoming]
  meeting book --thread <id> | --contact <id> --calendar <id> --at <iso>
                                         asks the calendar again, then writes the event with the lead invited;
                                         a scheduled agent books only a slot offered to this lead
  meeting move <id> --at <iso>           on the calendar too (an agent: only to an offered slot)
  meeting cancel <id> [--reason <t>]     after 60 s, on the calendar too; the lead is told (a person only)
  meeting uncancel <id>                  keep it: within the 60 s after cancel
  meeting retry <id>                     write the event again after a calendar error (found, not doubled)
  meeting update <id> [--status held|no_show] [--outcome qualified|not_qualified|opportunity|won|lost]
                  [--feedback <client's words>] [--notes <t>]      (a person only)
  mailboxes
  mailbox connect --provider google|microsoft [--sender <id>] [--daily-limit <n>] [--delay-min <s>] [--delay-max <s>] [--warmed]
                                         prints the URL to open in a browser
  mailbox import --file <json|jsonl|-> [--daily-limit <n>] [--delay-min <s>] [--delay-max <s>] [--warmed]
                                         from another platform, by the refresh token it holds (same OAuth app):
                                         [{"provider":"google|microsoft","refreshToken","sender":"<name>"|"senderId"}]
  mailbox smtp --file <json|jsonl|-> [--daily-limit <n>] [--delay-min <s>] [--delay-max <s>] [--warmed]
                                         a mailbox on any SMTP/IMAP host, signed in with its password; both logins
                                         are tried first. [{"address","password","host":"zoho|zoho-eu|migadu|purelymail|fastmail"
                                         | "smtp":{"host","port"},"imap":{"host","port"}, "sender":"<name>"|"senderId",
                                         "saveSent":false (the host files sent mail itself)}] — adding it again reconnects it
  mailbox update <id> [--daily-limit <n>] [--delay-min <s>] [--delay-max <s>] [--warmed|--not-warmed] [--status active|paused|archived]
                 [--sender <id>]            another sender of the project writes from it
  domains                                the project's bought domains: state, tenant, DNS, cost, expiry
  domain quote <name> [<name>…]          availability and price at the registrar (free)
  domain approve <name> [<name>…] --max-cents <n> [--redirect <client site url>]   buy them (a person only):
                                         the engine buys, dresses DNS and puts each in a Workspace tenant
  domain dkim <name> --record <TXT value> [--selector google]   publish the DKIM record minted in the
                                         Admin console (the task the engine opened says when)
  domain release <name>                  let it lapse at expiry; refused while a mailbox sends from it (a person only)
  domain redirect <name> <url>|none      where its website goes: a 301 from the apex and every subdomain to the
                                         client's own site, or none (a person only)
  domain dns <name>                      its DNS records and redirects at the registrar
  domain dns <name> add --type A|AAAA|CNAME|ALIAS|TXT|CAA --host <@|sub> --content <value> [--ttl <s>]
  domain dns <name> delete <record id>   (a person only; MX, SPF, DMARC and DKIM are the engine's and refused)
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
  tenants                                our Google Workspace tenants, with the domains and mailboxes in each (an admin)
  tenant add --name <n> --admin-email <super admin> --key <service account JSON file> [--max-domains <n>]
                                         the key is proved against the tenant before it is kept (an admin)
  tenant update <id> [--status active|paused] [--max-domains <n>] [--admin-email <e>] [--key <file>]   (an admin)
  tenant console-login <id>              sign in to the Google Admin console through the console service's IP,
                                         so it can do DKIM (an admin; #home-alerts says when it is needed again)
  tenant console-credentials <id> --email <admin> [--totp]   the login the console service signs in with by
                                         itself when Google drops its session; asks for the password (and with
                                         --totp the authenticator secret) hidden, or reads them from stdin, one a
                                         line. --remove forgets it (an admin)
  tenant console-retry <id>              sign in with the stored login on the next pass, not hours after a failed try
  agent runs [--limit <n>]               the server agent's runs: what was waiting, outcome, cost, summary
  agent show <run-id>                    one run with its prompt and transcript
  agent run                              queue a run for the waiting work now (a person only)
  agent cancel <run-id>                  stop a queued or running run (a person only)
  agent on | agent off                   the project's switch: whether the engine starts runs by itself
  warmup status                          the switch, the seed types, and each mailbox's notes and placement
  warmup on [--seeds gmail,gsuite,outlook,yahoo,aol|default] | warmup off   (a person only)
                                         on warms every mailbox not yet warmed; --seeds picks the seed
                                         types it writes to (default: gmail, gsuite, outlook); off tells the provider too
  agent stats [--hours <n>]              across projects: runs, cost, queued / running, wait from reply to run
  linkedin                               this project's LinkedIn accounts, with today's invites and messages
  linkedin available                     accounts linked in Unipile that no project has attached
  linkedin connect <unipile-account-id> [--sender <id>] [--invite-limit <n>] [--message-limit <n>]
                                         attaches it to the sender named like its owner unless --sender
  linkedin update <id> [--invite-limit <n>] [--message-limit <n>] [--delay-min <s>] [--delay-max <s>] [--status active|paused|archived]
  inbox                                  replies waiting for triage, with the engine's classification
  inbox test-send --from <our address> --to <our address> [--subject <t>] [--body <t>] [--reply]
                                         an admin's test of the round trip: sends through the provider; the
                                         answer reaches the inbox only through the reader. --reply answers
                                         the newest message --to sent --from
  inbox placement --mailbox <our address> --message-id <id>   where it landed: INBOX, SPAM, a tab (an admin)
  thread <id>                            the whole conversation, with our replies
  triage <message-id> [--class <c>] [--note <t>] [--follow-up <yyyy-mm-dd>] [--return <yyyy-mm-dd>]
  triage undo <message-id>              take it back: an unsubscribe within 60 s, or back into the queue
                                         confirm or change what a reply means; no --class marks it handled
  reply draft <thread-id> --body <text> | --body-file <path> [--note <for the approver>] [--send-at <iso>]
       [--approve-by <iso>] [--sender <id>]
  replies [--status draft|approved|sent|failed|discarded]
  reply approve <id> [--body <final text>] (a person only) | reply discard <id>
  reply revise <id> --body <text> | --body-file <path> [--note <for the approver>]   a new version of a draft
  reply rewrite <id> --ask <what to change>   the server agent rewrites it (a person only) | reply versions <id>
  reply-templates <strategy-id>          the fixed answers the engine sends on its own, by kind of reply
  reply-template approve <strategy-id> --class interested|meeting|question --body <text> | --body-file <path> [--cc a@x.com,b@y.com]
  reply-template approve <strategy-id> --class out_of_office|referral --subject <s> --body-file <path>
                                         a first email the engine sends on its own to the colleague an away note
                                         or a referral names; slots {first_name} {referrer_first_name} {company}
                                         slots {first_name} {company}; --cc copies people in the open; replaces that kind's answer (a person only)
  reply-template archive <id>            take an automatic answer out of use (a person only)
  providers                              what bh call reaches, whether it is configured, prices, credits left
  providers price <provider> --usd <n>   the dollar price of one credit (an admin); books earlier calls at it
  limits                                 what each paid tool has left, how fast it goes, and which are low
  limits read                            read every balance now (an admin)
  limits set <tool> --below <n>|off      alert #home-alerts below this (an admin); limits reset <tool> to the default
  call <provider> <METHOD> <path?query> [--body <json> | --body-file <path|->] [--again]
       [--strategy <id>] [--segment <id>] [--source <id>] [--search <id>] [--company <id>] [--contact <id>]
                                         the provider's answer on stdout, untouched; cost on stderr
  call show <call-id>                    an earlier call with what the provider answered (use it again instead of paying again)
  spend [--from <date>] [--to <date>]    this month's spend by provider unless dates are given, and credits left
  spend add --provider <p> --operation subscription|data_purchase|infrastructure|llm|other --usd <n> [--note <t>]
  address check <contact-id> --address <a> [--provider bouncer|scrubby] [--reason bounce_replacement|catch_all|new_contact] [--again]
                                         up to three guesses per bounced contact; Scrubby answers later
  address checks <contact-id> | address collect      collect: Scrubby's answers for the project
  address replace <contact-id> --address <a>          a confirmed address: the bounced step goes again to it
  reengage <message-id> [--on <yyyy-mm-dd>]           write again from that day; the id is the reply's, from bh inbox (a person only)
  refer <message-id> --email <e> [--first-name <n>] [--last-name <n>] [--title <t>]   the colleague they named (a person only)
  token create --name <n> [--kind scheduled_agent] [--for <email>] | token list | token revoke <id> | token unrevoke <id>
  user add --email <e> --name <n> [--admin] | users
  user set <id> [--email <e>] [--name <n>] [--admin|--no-admin]   correct a person's record (an admin only);
                                         the email is what Google sign-in matches
  user disable <id> | user enable <id>   refuse or restore every session and token they hold
  slack                                  the workspace, each project's channel, and what is reaching nobody
  slack connect [--project <slug>]       the install URL to open in a browser; with a project, Slack's
                                         own screen picks the channel its nudges go to and joins the
                                         app to it (a private channel included)
  slack channel <#channel|id|none>       change where this project's nudges go; "none" leaves it quiet
  slack disconnect                       (an admin only)
  slack post (--body <text> | --body-file <path|->) [--to <#channel|email>] [--thread <link|ts>]
             [--mention <email|name|member id, ...>]
                                         the bot says it, in Markdown: to a channel, to a person by
                                         email, or to the project's channel; --thread answers under
                                         a message (Slack's "Copy link"); --mention notifies people,
                                         found by email, by name as Slack shows it, or by member id
`

/** A list flag: items split on "|" (titles can hold commas), or on "," when there is no "|". */
const list = (v: string) =>
  v
    .split(v.includes('|') ? '|' : ',')
    .map((x) => x.trim())
    .filter(Boolean)

const out = (value: unknown): void => {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
  // Where the object is worked on in the web app (the engine adds it when WEB_URL is set); on
  // stderr, so the JSON on stdout stays what a script reads.
  const link = linkOf(value)
  if (link) process.stderr.write(`open: ${link}\n`)
}

/** The web link an answer carries: its own, or the one its rows share. */
function linkOf(value: unknown): string | null {
  const first = Array.isArray(value) ? value[0] : value
  const link = first && typeof first === 'object' ? (first as { link?: unknown }).link : null
  return typeof link === 'string' && link ? link : null
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
 * acting on another client's project is the worst thing a wrong guess can do.
 */
function currentProject(
  flag: string | undefined,
  session: string | undefined,
): { slug: string; from: string } | null {
  if (flag) return { slug: flag, from: '--project' }
  if (process.env.BH_PROJECT) return { slug: process.env.BH_PROJECT, from: 'BH_PROJECT' }
  return session ? { slug: session, from: 'bh use, this session' } : null
}

function noProject(): BhError {
  return new BhError(
    SESSION ? 'No project in this session' : 'No project',
    {
      hint: SESSION
        ? 'bh use <slug> once per session (each Claude Code session keeps its own), or --project <slug>; bh projects lists them'
        : 'not in a Claude Code session, so bh use cannot hold: --project <slug> or BH_PROJECT; bh projects lists them',
    },
    2,
  )
}

async function main(argv: string[]): Promise<void> {
  const { values: o, positionals: pos } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      api: { type: 'string' },
      token: { type: 'string' },
      wait: { type: 'boolean' },
      'no-browser': { type: 'boolean' },
      totp: { type: 'boolean' },
      remove: { type: 'boolean' },
      project: { type: 'string' },
      name: { type: 'string' },
      timezone: { type: 'string' },
      limit: { type: 'string' },
      hours: { type: 'string' },
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
      'max-cents': { type: 'string' },
      redirect: { type: 'string' },
      record: { type: 'string' },
      type: { type: 'string' },
      host: { type: 'string' },
      content: { type: 'string' },
      ttl: { type: 'string' },
      selector: { type: 'string' },
      username: { type: 'string' },
      'no-admin': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
      provider: { type: 'string' },
      file: { type: 'string' },
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
      'every-project': { type: 'boolean' },
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
      q: { type: 'string' },
      waiting: { type: 'string' },
      state: { type: 'string' },
      offset: { type: 'string' },
      sender: { type: 'string' },
      signature: { type: 'string' },
      'signature-html-file': { type: 'string' },
      out: { type: 'string' },
      'daily-share': { type: 'string' },
      'daily-limit': { type: 'string' },
      'invite-limit': { type: 'string' },
      'message-limit': { type: 'string' },
      'domain-cap': { type: 'string' },
      class: { type: 'string' },
      cc: { type: 'string' },
      'follow-up': { type: 'string' },
      return: { type: 'string' },
      'body-file': { type: 'string' },
      'html-file': { type: 'string' },
      'reply-to': { type: 'string' },
      'send-at': { type: 'string' },
      'delay-min': { type: 'string' },
      'delay-max': { type: 'string' },
      warmed: { type: 'boolean' },
      'not-warmed': { type: 'boolean' },
      key: { type: 'string' },
      'event-type': { type: 'string' },
      owner: { type: 'string' },
      days: { type: 'string' },
      calendar: { type: 'string' },
      slots: { type: 'string' },
      thread: { type: 'string' },
      mention: { type: 'string' },
      at: { type: 'string' },
      outcome: { type: 'string' },
      feedback: { type: 'string' },
      notes: { type: 'string' },
      upcoming: { type: 'boolean' },
      seeds: { type: 'string' },
      claim: { type: 'string' },
      evidence: { type: 'string' },
      'add-evidence': { type: 'string' },
      metric: { type: 'string' },
      threshold: { type: 'string' },
      verdict: { type: 'string' },
      dir: { type: 'string' },
    },
  })
  const config = await loadConfig()
  const [cmd, sub, arg] = pos
  const current = currentProject(o.project, await loadSessionProject())
  const p = () => {
    if (!current) throw noProject()
    return encodeURIComponent(current.slug)
  }
  /** A file of rows, sent in chunks; a row the engine refused makes the exit non-zero. */
  const batch = async (path: string): Promise<void> => {
    const answer = await sendRows(config, path, await readRows(need(o.file)))
    out(answer)
    const refused = refusedIn(answer)
    if (refused) {
      process.stderr.write(`refused: ${refused} ${refused === 1 ? 'row' : 'rows'}, see "refused"\n`)
      process.exitCode = 1
    }
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

  if (!cmd || o.help) return void process.stdout.write(USAGE)
  switch (cmd) {
    case 'setup':
      return out(await setup(o.dir))
    case 'login': {
      if (o.token) {
        const next = { ...config, ...(o.api ? { api: o.api } : {}), token: o.token }
        await saveConfig(next)
        return out({ saved: CONFIG_PATH, api: next.api, me: await call(next, 'GET', '/me') })
      }
      if (!o.wait) {
        const pending = await startLogin(o.api ?? config.api ?? DEFAULT_API, !o['no-browser'])
        const minutes = Math.round((new Date(pending.expiresAt).getTime() - Date.now()) / 60_000)
        if (!process.stdout.isTTY)
          return out({ open: pending.link, expiresInMinutes: minutes, next: 'bh login --wait' })
        process.stderr.write(
          `Open this link, sign in and approve (valid ${minutes} minutes):\n\n  ${pending.link}\n\nWaiting…\n`,
        )
      }
      const { email: _, ...next } = await waitForLogin(config)
      await saveConfig(next)
      return out({ saved: CONFIG_PATH, api: next.api, me: await call(next, 'GET', '/me') })
    }
    case 'use': {
      if (!sub) {
        if (!current) throw noProject()
        return out({ project: current.slug, from: current.from })
      }
      if (!SESSION) throw noProject()
      const found = await call(config, 'GET', `/projects/${encodeURIComponent(sub)}`)
      await saveSessionProject(sub)
      return out({ project: found, for: 'this session' })
    }
    case 'whoami':
      return out(await call(config, 'GET', '/me'))
    case 'health':
      return out(await call(config, 'GET', '/health'))
    case 'projects':
      return out(
        await call(config, 'GET', `/projects${o.org ? `?org=${encodeURIComponent(o.org)}` : ''}`),
      )
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
      if (sub === 'members') return out(await call(config, 'GET', `/projects/${p()}/members`))
      if (sub === 'member' && arg === 'remove')
        return out(await call(config, 'DELETE', `/projects/${p()}/members/${pos[3]}`))
      if (sub === 'member')
        return out(
          await call(
            config,
            'PUT',
            `/projects/${p()}/members/${arg}`,
            o.role ? { role: o.role } : {},
          ),
        )
      if (sub === 'update')
        return out(
          await call(config, 'PATCH', `/projects/${p()}`, {
            ...(o.name ? { name: o.name } : {}),
            ...(o.timezone ? { timezone: o.timezone } : {}),
            ...(o['domain-cap'] ? { dailyDomainCap: Number(o['domain-cap']) } : {}),
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
    case 'sql': {
      let query = sub ?? ''
      // @project stands for the current project's id: no shell expands it, and SQL has no use for it.
      if (query.includes('@project')) {
        const found = (await call(config, 'GET', `/projects/${p()}`)) as { id: string }
        query = query.replaceAll('@project', `'${found.id}'`)
      }
      return out(
        await call(config, 'POST', '/sql', {
          query,
          ...(o.limit ? { limit: Number(o.limit) } : {}),
        }),
      )
    }
    case 'note':
      if (sub === 'add') {
        return out(
          await call(config, 'POST', `/projects/${p()}/notes`, {
            kind: o.kind,
            title: o.title,
            ...(o.body ? { body: o.body } : {}),
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
    case 'task':
      if (sub === 'reopen') return out(await call(config, 'POST', `/tasks/${arg}/reopen`, {}))
      if (sub === 'assign')
        return out(
          await call(config, 'POST', `/tasks/${arg}/assign`, {
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
            ...(o.body ? { body: o.body } : {}),
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
          await call(config, 'POST', `/tasks/${arg}/close`, {
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
          await call(config, 'PATCH', `/segments/${arg}`, {
            ...(o.name ? { name: o.name } : {}),
            ...(o.body ? { definition: o.body } : {}),
            ...(o.criteria ? { criteria: JSON.parse(o.criteria) } : {}),
            ...(o.estimate ? { estimatedCompanies: Number(o.estimate) } : {}),
            ...(o.status ? { status: o.status } : {}),
          }),
        )
      break
    case 'personas':
      return out(await call(config, 'GET', `/projects/${p()}/personas`))
    case 'persona':
      if (sub === 'upsert')
        return out(
          await call(config, 'POST', `/projects/${p()}/personas`, {
            name: o.name,
            ...(o.titles ? { titles: list(o.titles) } : {}),
            ...(o['excluded-titles'] ? { excludedTitles: list(o['excluded-titles']) } : {}),
            ...(o.seniorities ? { seniorities: list(o.seniorities) } : {}),
            ...(o.departments ? { departments: list(o.departments) } : {}),
            ...(o.hints ? { searchHints: o.hints } : {}),
            ...(o.body ? { description: o.body } : {}),
          }),
        )
      break
    case 'strategies':
      return out(await call(config, 'GET', `/projects/${p()}/strategies`))
    case 'strategy':
      if (sub === 'create')
        return out(
          await call(config, 'POST', `/projects/${p()}/strategies`, await readInput(need(o.file))),
        )
      if (sub === 'update')
        return out(await call(config, 'PATCH', `/strategies/${arg}`, await readInput(need(o.file))))
      if (sub === 'show') return out(await call(config, 'GET', `/strategies/${arg}`))
      if (sub === 'exclude' || sub === 'include') {
        if (o.file)
          return out(
            await call(
              config,
              'POST',
              `/strategies/${arg}/company-exclusions`,
              await readInput(o.file),
            ),
          )
        if (!o.company)
          throw new BhError('Which company?', { hint: '--company <id|domain>, or --file' }, 2)
        return out(
          await call(config, 'POST', `/strategies/${arg}/company-exclusions`, {
            ...(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(o.company)
              ? { companyId: o.company }
              : { domain: o.company }),
            excluded: sub === 'exclude',
            ...(o.reason ? { reason: o.reason } : {}),
          }),
        )
      }
      if (sub === 'launch') return out(await call(config, 'POST', `/strategies/${arg}/launch`, {}))
      if (sub === 'archive')
        return out(await call(config, 'POST', `/strategies/${arg}/archive`, {}))
      if (sub === 'pause')
        return out(
          await call(
            config,
            'POST',
            `/strategies/${arg}/pause`,
            o.reason ? { reason: o.reason } : {},
          ),
        )
      break
    case 'plan':
      if (sub === 'set')
        return out(
          await call(config, 'PUT', `/strategies/${arg}/plans`, await readInput(need(o.file))),
        )
      if (sub === 'step') {
        if (!pos[3])
          throw new BhError('Which step?', { hint: 'bh strategy show <id> lists its step ids' }, 2)
        return out(
          await call(
            config,
            'PATCH',
            `/strategies/${arg}/steps/${pos[3]}`,
            await readInput(need(o.file)),
          ),
        )
      }
      break
    case 'companies':
      if (sub === 'upsert') return batch(`/projects/${p()}/companies`)
      if (sub === 'judge') return batch(`/segments/${arg}/companies`)
      if (sub === 'in')
        return out(
          await call(
            config,
            'GET',
            `/segments/${arg}/companies?${new URLSearchParams({
              ...(o.status ? { status: o.status } : {}),
              ...(o.waiting ? { waiting: o.waiting } : {}),
              ...(o.q ? { q: o.q } : {}),
              ...(o.limit ? { limit: o.limit } : {}),
              ...(o.offset ? { offset: o.offset } : {}),
            })}`,
          ),
        )
      if (sub === 'verdicts') {
        if (!o.company)
          throw new BhError(
            'Which company?',
            { hint: '--company <id>, as bh companies in lists them' },
            2,
          )
        return out(await call(config, 'GET', `/segments/${arg}/companies/${o.company}/verdicts`))
      }
      break
    case 'sources':
      return out(await call(config, 'GET', `/projects/${p()}/sources`))
    case 'source':
      if (sub === 'add')
        return out(
          await call(config, 'POST', `/segments/${arg}/sources`, {
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
          await call(config, 'PATCH', `/sources/${arg}`, {
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
      if (sub === 'remove') return out(await call(config, 'DELETE', `/exclusions/${arg}`))
      break
    case 'questions':
      return out(
        await call(
          config,
          'GET',
          `/projects/${p()}/questions?${new URLSearchParams(o.status ? { status: o.status } : {})}`,
        ),
      )
    case 'question':
      if (sub === 'add')
        return out(
          await call(config, 'POST', `/projects/${p()}/questions`, {
            question: o.body,
            ...(o.note ? { context: o.note } : {}),
            ...(o.asked ? { asked: true } : {}),
          }),
        )
      if (sub === 'asked')
        return out(await call(config, 'PATCH', `/questions/${arg}`, { status: 'asked' }))
      if (sub === 'answer')
        return out(
          await call(config, 'PATCH', `/questions/${arg}`, { status: 'answered', answer: o.body }),
        )
      if (sub === 'drop')
        return out(await call(config, 'PATCH', `/questions/${arg}`, { status: 'dropped' }))
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
        ...(o.evidence ? { evidence: o.evidence } : {}),
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
          await call(config, 'PATCH', `/hypotheses/${arg}`, {
            ...(o.claim ? { claim: o.claim } : {}),
            ...(o['add-evidence'] ? { addEvidence: o['add-evidence'] } : {}),
            ...links,
            ...judged,
          }),
        )
      }
      break
    }
    case 'goals':
      return out(await call(config, 'GET', `/projects/${p()}/goals`))
    case 'orgs':
      return out(await call(config, 'GET', '/orgs'))
    case 'org':
      if (sub === 'create')
        return out(await call(config, 'POST', '/orgs', { slug: arg, name: o.name }))
      if (sub === 'members') return out(await call(config, 'GET', `/orgs/${arg}/members`))
      if (sub === 'add')
        return out(
          await call(config, 'POST', `/orgs/${arg}/members`, {
            email: o.email,
            ...(o.name ? { name: o.name } : {}),
            ...(o.role ? { role: o.role } : {}),
          }),
        )
      if (sub === 'role')
        return out(await call(config, 'PATCH', `/orgs/${arg}/members/${pos[3]}`, { role: o.role }))
      if (sub === 'remove')
        return out(await call(config, 'DELETE', `/orgs/${arg}/members/${pos[3]}`))
      break
    case 'agency':
      if (sub === 'senders') return out(await call(config, 'GET', `/orgs/${arg}/senders`))
      if (sub === 'add')
        return out(
          await call(config, 'POST', `/orgs/${arg}/senders`, {
            name: o.name,
            ...(o.title ? { title: o.title } : {}),
            ...(o.signature ? { signature: o.signature } : {}),
            ...(await signatureHtml(o['signature-html-file'])),
          }),
        )
      if (sub === 'remove')
        return out(await call(config, 'DELETE', `/orgs/${arg}/senders/${pos[3]}`))
      if (sub === 'mailbox')
        return out(
          await call(config, 'POST', `/orgs/${arg}/mailboxes/connect`, {
            provider: o.provider,
            senderId: o.sender,
            ...(o['daily-limit'] ? { dailyLimit: Number(o['daily-limit']) } : {}),
            ...(o['delay-min'] ? { delayMinSeconds: Number(o['delay-min']) } : {}),
            ...(o['delay-max'] ? { delayMaxSeconds: Number(o['delay-max']) } : {}),
            ...(o.warmed ? { warmed: true } : {}),
            ...(o['not-warmed'] ? { warmed: false } : {}),
          }),
        )
      if (sub === 'smtp')
        return addSmtpMailboxes(config, `/orgs/${arg}/mailboxes/smtp`, need(o.file), {
          senderId: o.sender,
          ...mailboxLimits(o),
        })
      // The agency's own domains and the mailboxes on them, for its own senders.
      if (sub === 'domains') return out(await call(config, 'GET', `/orgs/${arg}/domains`))
      if (sub === 'quote')
        return out(
          await call(config, 'POST', `/orgs/${arg}/domains/quote`, { domains: pos.slice(3) }),
        )
      if (sub === 'approve')
        return out(
          await call(config, 'POST', `/orgs/${arg}/domains`, {
            domains: pos.slice(3),
            maxCents: Number(o['max-cents']),
            ...(o.redirect ? { redirectTo: o.redirect } : {}),
          }),
        )
      if (sub === 'order') {
        const name = (pos[3] ?? '').toLowerCase()
        const domains = (await call(config, 'GET', `/orgs/${arg}/domains`)) as {
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
          await call(config, 'POST', `/domains/${domain.id}/mailboxes`, {
            mailboxes,
            ...(o.sender ? { senderId: o.sender } : {}),
          }),
        )
      }
      if (sub === 'orders') return out(await call(config, 'GET', `/orgs/${arg}/mailbox-orders`))
      if (sub === 'linkedin')
        return out(
          await call(config, 'POST', `/orgs/${arg}/linkedin-accounts`, {
            unipileAccountId: pos[3],
            senderId: o.sender,
            ...(o['invite-limit'] ? { dailyInviteLimit: Number(o['invite-limit']) } : {}),
            ...(o['message-limit'] ? { dailyMessageLimit: Number(o['message-limit']) } : {}),
          }),
        )
      break
    case 'goal':
      if (sub === 'done')
        return out(
          await call(config, 'PUT', `/projects/${p()}/goals/${arg}/done`, { done: Number(o.done) }),
        )
      if (sub === 'set')
        return out(
          await call(config, 'PUT', `/projects/${p()}/goals/${arg}`, {
            meetingsTarget: Number(o.target),
            ...(o.counts ? { counts: o.counts } : {}),
          }),
        )
      break
    case 'contacts':
      if (sub === 'upsert') return batch(`/projects/${p()}/contacts`)
      return out(
        await call(
          config,
          'GET',
          `/projects/${p()}/contacts?${new URLSearchParams(o.q ? { q: o.q } : {})}`,
        ),
      )
    case 'dnc':
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
      if (sub === 'remove') return out(await call(config, 'DELETE', `/dnc/${arg}`))
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
        await call(config, 'POST', `/strategies/${sub}/enroll`, {
          leads: await readRows(need(o.file)),
          dryRun: Boolean(o['dry-run']),
        }),
      )
    case 'stand':
      // One person, or a file of them: sourcing stands fifty at a time, and fifty round trips is
      // the difference between a step and a wait.
      if (o.file) return batch(`/strategies/${sub}/contacts`)
      return out(
        await call(config, 'POST', `/strategies/${sub}/contacts`, {
          contactId: o.contact,
          status: o.status,
          ...(o.persona ? { personaId: o.persona } : {}),
          ...(o.reason ? { reason: o.reason } : {}),
        }),
      )
    case 'worked':
      return batch(`/strategies/${sub}/companies`)
    case 'copy':
      if (sub === 'queue')
        return out(
          await call(
            config,
            'GET',
            `/strategies/${arg}/copy-queue?${new URLSearchParams(o.limit ? { limit: o.limit } : {})}`,
          ),
        )
      // One request, not chunks: the engine writes all of the copy or none of it.
      if (sub === 'write')
        return out(await call(config, 'POST', '/copy', { messages: await readRows(need(o.file)) }))
      if (sub === 'check') {
        const checked = (await call(config, 'POST', '/copy/check', {
          messages: await readRows(need(o.file)),
        })) as { withProblems: number }
        out(checked)
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
          await call(config, 'PUT', `/providers/${arg}/credit-price`, {
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
          await call(config, 'PUT', `/limits/${arg}`, {
            alertBelow: o.below === 'off' ? null : Number(o.below),
          }),
        )
      }
      if (sub === 'reset') {
        if (!arg) throw new BhError('Which tool?', { hint: 'bh limits reset bouncer' }, 2)
        return out(await call(config, 'DELETE', `/limits/${arg}`))
      }
      return out(await call(config, 'GET', '/limits'))
    case 'call': {
      const [, name, method, path] = pos
      if (name === 'show') return out(await call(config, 'GET', `/provider-calls/${method}`))
      if (!name || !method || !path)
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
      const answer = (await call(config, 'POST', `/providers/${name}/call`, {
        project: current?.slug,
        method,
        path,
        ...(raw === undefined ? {} : { body: raw }),
        ...(o.again ? { again: true } : {}),
        ...(Object.keys(refs).length ? { refs } : {}),
      })) as {
        callId: string
        status: number
        costUsd: number | null
        results: number | null
        credits: number | null
        creditsLeft: number | null
        body: unknown
      }
      const cost = answer.costUsd === null ? 'cost unknown' : `$${answer.costUsd.toFixed(4)}`
      const credits =
        answer.credits === null
          ? ''
          : ` · ${answer.credits} credits${answer.creditsLeft === null ? '' : ` (${answer.creditsLeft} left)`}`
      process.stderr.write(
        `# ${name} ${answer.status} · ${cost}${credits} · ${answer.results ?? '?'} results · call ${answer.callId}\n`,
      )
      out(answer.body)
      if (answer.status >= 400) process.exitCode = 1
      return
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
          await call(config, 'POST', `/contacts/${arg}/address-checks`, {
            address: o.address,
            ...(o.provider ? { provider: o.provider } : {}),
            ...(o.reason ? { reason: o.reason } : {}),
            ...(o.again ? { again: true } : {}),
          }),
        )
      if (sub === 'checks') return out(await call(config, 'GET', `/contacts/${arg}/address-checks`))
      if (sub === 'collect')
        return out(await call(config, 'POST', `/projects/${p()}/address-checks/collect`, {}))
      if (sub === 'replace')
        return out(
          await call(config, 'POST', `/contacts/${arg}/replace-address`, { address: o.address }),
        )
      break
    case 'reengage':
      return out(
        await call(config, 'POST', `/thread-messages/${sub}/reengage`, o.on ? { on: o.on } : {}),
      )
    case 'refer':
      return out(
        await call(config, 'POST', `/thread-messages/${sub}/refer`, {
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
    case 'thread':
      return out(await call(config, 'GET', `/threads/${sub}`))
    case 'triage':
      if (sub === 'undo')
        return out(await call(config, 'POST', `/thread-messages/${arg}/untriage`, {}))
      return out(
        await call(config, 'POST', `/thread-messages/${sub}/triage`, {
          ...(o.class ? { classification: o.class } : {}),
          ...(o.note ? { note: o.note } : {}),
          ...(o['follow-up'] ? { followUpOn: o['follow-up'] } : {}),
          ...(o.return ? { returnDate: o.return } : {}),
        }),
      )
    case 'reply-templates':
      if (!sub)
        throw new BhError(
          'Which strategy?',
          { hint: 'bh reply-templates <strategy-id>; bh strategies lists them' },
          2,
        )
      return out(await call(config, 'GET', `/strategies/${sub}/reply-templates`))
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
          await call(config, 'POST', `/strategies/${arg}/reply-templates`, {
            classification: o.class,
            ...(o.subject ? { subject: o.subject } : {}),
            body: text,
            ...(o.cc
              ? {
                  cc: o.cc
                    .split(',')
                    .map((a) => a.trim())
                    .filter(Boolean),
                }
              : {}),
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
        return out(await call(config, 'POST', `/reply-templates/${arg}/archive`, {}))
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
      if (sub === 'draft') {
        const text = o['body-file'] ? await readFile(o['body-file'], 'utf8') : need(o.body)
        return out(
          await call(config, 'POST', `/threads/${arg}/replies`, {
            body: text,
            ...(o.note ? { note: o.note } : {}),
            ...(o['send-at'] ? { sendAt: o['send-at'] } : {}),
            ...(o['approve-by'] ? { approveBy: o['approve-by'] } : {}),
            ...(o.sender ? { senderId: o.sender } : {}),
          }),
        )
      }
      if (sub === 'approve')
        return out(
          await call(config, 'POST', `/replies/${arg}/approve`, o.body ? { body: o.body } : {}),
        )
      if (sub === 'discard') return out(await call(config, 'POST', `/replies/${arg}/discard`, {}))
      if (sub === 'unapprove')
        return out(await call(config, 'POST', `/replies/${arg}/unapprove`, {}))
      if (sub === 'revise') {
        const text = o['body-file'] ? await readFile(o['body-file'], 'utf8') : need(o.body)
        return out(
          await call(config, 'POST', `/replies/${arg}/revise`, {
            body: text,
            ...(o.note ? { note: o.note } : {}),
          }),
        )
      }
      if (sub === 'rewrite')
        return out(await call(config, 'POST', `/replies/${arg}/rewrite`, { ask: need(o.ask) }))
      if (sub === 'versions') return out(await call(config, 'GET', `/replies/${arg}/versions`))
      break
    case 'preview':
      return out(await call(config, 'GET', `/messages/${sub}/preview`))
    case 'senders':
      return out(await call(config, 'GET', `/projects/${p()}/senders`))
    case 'sender':
      if (sub === 'move')
        return out(await call(config, 'POST', `/senders/${arg}/move`, { project: o.to }))
      if (sub === 'remove') return out(await call(config, 'DELETE', `/senders/${arg}`))
      if (sub === 'share')
        return out(
          await call(config, 'PUT', `/projects/${p()}/senders/${arg}`, {
            ...(o.title ? { title: o.title } : {}),
            ...(o.signature ? { signature: o.signature } : {}),
            ...(await signatureHtml(o['signature-html-file'])),
            ...(o['daily-share'] ? { dailyShare: Number(o['daily-share']) } : {}),
          }),
        )
      if (sub === 'unshare')
        return out(await call(config, 'DELETE', `/projects/${p()}/senders/${arg}`))
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
          await call(config, 'PATCH', `/senders/${arg}`, {
            ...(o.name ? { name: o.name } : {}),
            ...(o.title ? { title: o.title } : {}),
            ...(o.signature ? { signature: o.signature } : {}),
            ...(await signatureHtml(o['signature-html-file'])),
          }),
        )
      if (sub === 'image')
        return out(
          await call(config, 'POST', `/senders/${arg}/images`, {
            data: (await readFile(need(pos[3]))).toString('base64'),
          }),
        )
      if (sub === 'images') return out(await call(config, 'GET', `/senders/${arg}/images`))
      if (sub === 'image-remove')
        return out(await call(config, 'DELETE', `/senders/${arg}/images/${need(pos[3])}`))
      if (sub === 'signature') {
        const signature = (await call(
          config,
          'GET',
          `/projects/${p()}/senders/${arg}/signature`,
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
          limit: o.limit,
          offset: o.offset,
        }).filter((e): e is [string, string] => typeof e[1] === 'string'),
      ).toString()
      return out(await call(config, 'GET', `/projects/${p()}/leads${query ? `?${query}` : ''}`))
    }
    case 'lead':
      if (sub === 'show') return out(await call(config, 'GET', `/enrollments/${arg}`))
      if (sub === 'resume') return out(await call(config, 'POST', `/enrollments/${arg}/resume`, {}))
      if (sub === 'pause') return out(await call(config, 'POST', `/enrollments/${arg}/pause`, {}))
      if (sub === 'unpause')
        return out(await call(config, 'POST', `/enrollments/${arg}/unpause`, {}))
      if (sub === 'stop')
        return out(await call(config, 'POST', `/enrollments/${arg}/stop`, { reason: o.reason }))
      break
    case 'calendars':
      return out(await call(config, 'GET', `/projects/${p()}/calendars`))
    case 'calendar':
      if (sub === 'connect')
        return out(
          await call(config, 'POST', `/projects/${p()}/calendars/calcom`, {
            key: o.key,
            senderId: o.sender,
            ...(o['event-type'] ? { eventType: o['event-type'] } : {}),
          }),
        )
      if (sub === 'update')
        return out(
          await call(config, 'PATCH', `/calendars/${pos[2]}`, {
            ...(o.priority ? { priority: Number(o.priority) } : {}),
            ...(o.timezone ? { timezone: o.timezone } : {}),
            ...(o.owner ? { ownerName: o.owner } : {}),
            ...(o['event-type'] ? { eventType: o['event-type'] } : {}),
            ...(o.sender ? { senderId: o.sender } : {}),
          }),
        )
      if (sub === 'archive') return out(await call(config, 'POST', `/calendars/${arg}/archive`, {}))
      break
    case 'slots': {
      if (sub === 'offer')
        return out(
          await call(config, 'POST', `/threads/${arg}/slots`, {
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
    case 'meetings':
      return out(
        await call(config, 'GET', `/projects/${p()}/meetings${o.upcoming ? '?upcoming=true' : ''}`),
      )
    case 'meeting':
      if (sub === 'uncancel')
        return out(await call(config, 'POST', `/meetings/${arg}/uncancel`, {}))
      if (sub === 'book')
        return out(
          await call(config, 'POST', `/projects/${p()}/meetings`, {
            ...(o.thread ? { threadId: o.thread } : {}),
            ...(o.contact ? { contactId: o.contact } : {}),
            calendarId: o.calendar,
            at: o.at,
          }),
        )
      if (sub === 'move')
        return out(await call(config, 'POST', `/meetings/${arg}/move`, { at: o.at }))
      if (sub === 'cancel')
        return out(
          await call(
            config,
            'POST',
            `/meetings/${arg}/cancel`,
            o.reason ? { reason: o.reason } : {},
          ),
        )
      if (sub === 'retry') return out(await call(config, 'POST', `/meetings/${arg}/retry`, {}))
      if (sub === 'update')
        return out(
          await call(config, 'PATCH', `/meetings/${arg}`, {
            ...(o.status ? { status: o.status } : {}),
            ...(o.outcome ? { outcome: o.outcome } : {}),
            ...(o.feedback ? { feedback: o.feedback } : {}),
            ...(o.notes ? { notes: o.notes } : {}),
          }),
        )
      break
    case 'mailboxes':
      return out(await call(config, 'GET', `/projects/${p()}/mailboxes`))
    case 'domains':
      return out(await call(config, 'GET', `/projects/${p()}/domains`))
    case 'domain': {
      const names = pos.slice(2)
      if (sub === 'quote')
        return out(await call(config, 'POST', `/projects/${p()}/domains/quote`, { domains: names }))
      if (sub === 'approve')
        return out(
          await call(config, 'POST', `/projects/${p()}/domains`, {
            domains: names,
            maxCents: Number(o['max-cents']),
            ...(o.redirect ? { redirectTo: o.redirect } : {}),
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
      if (sub === 'dns') {
        const id = await domainId(arg)
        const action = pos[3]
        if (!action) return out(await call(config, 'GET', `/domains/${id}/dns`))
        if (action === 'add')
          return out(
            await call(config, 'POST', `/domains/${id}/dns`, {
              type: o.type,
              host: o.host ?? '@',
              content: o.content,
              ...(o.ttl ? { ttl: Number(o.ttl) } : {}),
            }),
          )
        if (action === 'delete') {
          if (!pos[4])
            throw new BhError('Which record?', { hint: `bh domain dns ${arg} lists their ids` }, 2)
          return out(await call(config, 'DELETE', `/domains/${id}/dns/${pos[4]}`))
        }
        throw new BhError(`bh domain dns has no ${action}`, { hint: 'add or delete' }, 2)
      }
      break
    }
    case 'tenants':
      return out(await call(config, 'GET', '/tenants'))
    case 'tenant': {
      const key = o.key ? JSON.parse(await readFile(o.key, 'utf8')) : undefined
      const maxDomains = o['max-domains'] ? { maxDomains: Number(o['max-domains']) } : {}
      if (sub === 'add')
        return out(
          await call(config, 'POST', '/tenants', {
            name: o.name,
            adminEmail: o['admin-email'],
            key,
            ...maxDomains,
          }),
        )
      if (sub === 'console-login') {
        if (!arg) throw new BhError('Which tenant?', { hint: 'bh tenants lists them' }, 2)
        return out(await consoleLogin(config, arg))
      }
      if (sub === 'console-retry') {
        if (!arg) throw new BhError('Which tenant?', { hint: 'bh tenants lists them' }, 2)
        return out(await call(config, 'POST', `/tenants/${arg}/console-retry`, {}))
      }
      if (sub === 'console-credentials') {
        if (!arg) throw new BhError('Which tenant?', { hint: 'bh tenants lists them' }, 2)
        if (o.remove)
          return out(await call(config, 'DELETE', `/tenants/${arg}/console-credentials`))
        if (!o.email)
          throw new BhError('Sign in as whom?', { hint: '--email <an admin of the tenant>' }, 2)
        const [password, totpSecret] = await readSecrets([
          `Password for ${o.email}: `,
          ...(o.totp ? ['Authenticator secret (the key under "Can\'t scan it?"): '] : []),
        ])
        if (!password) throw new BhError('No password given', {}, 2)
        return out(
          await call(config, 'PUT', `/tenants/${arg}/console-credentials`, {
            email: o.email,
            password,
            ...(totpSecret ? { totpSecret } : {}),
          }),
        )
      }
      if (sub === 'update')
        return out(
          await call(config, 'PATCH', `/tenants/${arg}`, {
            ...(o.status ? { status: o.status } : {}),
            ...maxDomains,
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
      if (sub === 'smtp')
        return addSmtpMailboxes(config, `/projects/${p()}/mailboxes/smtp`, need(o.file), limits)
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
      if (sub === 'update')
        return out(
          await call(config, 'PATCH', `/mailboxes/${arg}`, {
            ...limits,
            ...(o.status ? { status: o.status } : {}),
            ...(o.sender ? { senderId: o.sender } : {}),
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
      if (sub === 'show') return out(await call(config, 'GET', `/agent-runs/${arg}`))
      if (sub === 'stats')
        return out(
          await call(
            config,
            'GET',
            `/agent-runs/stats${o.hours ? `?hours=${Number(o.hours)}` : ''}`,
          ),
        )
      if (sub === 'run') return out(await call(config, 'POST', `/projects/${p()}/agent-runs`, {}))
      if (sub === 'cancel') return out(await call(config, 'POST', `/agent-runs/${arg}/cancel`, {}))
      if (sub === 'on' || sub === 'off')
        return out(await call(config, 'PUT', `/projects/${p()}/agent`, { enabled: sub === 'on' }))
      break
    case 'warmup':
      if (!sub || sub === 'status') return out(await call(config, 'GET', `/projects/${p()}/warmup`))
      if (sub === 'on') {
        const seeds = o.seeds
          ? await call(config, 'PUT', `/projects/${p()}/warmup`, {
              seedTypes: o.seeds === 'default' ? null : list(o.seeds),
            })
          : null
        const on = (await call(config, 'POST', `/projects/${p()}/warmup/on`, {})) as object
        return out(seeds ? { ...on, ...(seeds as object) } : on)
      }
      if (sub === 'off') return out(await call(config, 'POST', `/projects/${p()}/warmup/off`, {}))
      break
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
      if (sub === 'update')
        return out(
          await call(config, 'PATCH', `/linkedin-accounts/${arg}`, {
            ...limits,
            ...(o['delay-min'] ? { delayMinSeconds: Number(o['delay-min']) } : {}),
            ...(o['delay-max'] ? { delayMaxSeconds: Number(o['delay-max']) } : {}),
            ...(o.status ? { status: o.status } : {}),
          }),
        )
      break
    }
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
      if (sub === 'revoke') return out(await call(config, 'DELETE', `/tokens/${arg}`))
      if (sub === 'unrevoke') return out(await call(config, 'POST', `/tokens/${arg}/unrevoke`, {}))
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
          await call(config, 'PATCH', `/users/${arg}`, {
            ...(o.email ? { email: o.email } : {}),
            ...(o.name ? { name: o.name } : {}),
            ...(o.admin ? { isAdmin: true } : {}),
            ...(o['no-admin'] ? { isAdmin: false } : {}),
          }),
        )
      if (sub === 'disable' || sub === 'enable')
        return out(await call(config, 'PATCH', `/users/${arg}`, { disabled: sub === 'disable' }))
      break
    case 'users':
      return out(await call(config, 'GET', '/users'))
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
      if (sub === 'channel')
        return out(
          await call(config, 'POST', `/projects/${p()}/slack`, {
            channel: arg === 'none' ? null : arg,
          }),
        )
      if (sub === 'disconnect') return out(await call(config, 'POST', '/slack/disconnect', {}))
      if (sub === 'post') {
        const text = o['body-file'] ? await readText(o['body-file']) : need(o.body)
        const message = {
          text,
          ...(o.to ? { to: o.to } : {}),
          ...(o.thread ? { thread: o.thread } : {}),
          ...(o.mention ? { mention: list(o.mention) } : {}),
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
  await main(process.argv.slice(2))
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

/** `--signature-html-file`: the file's HTML, or null to clear it when the file is empty. */
async function signatureHtml(file: string | undefined) {
  if (!file) return {}
  const html = (await readFile(file, 'utf8')).trim()
  return { signatureHtml: html || null }
}

/** A page showing a signature as the lead will see it: the HTML, and the text beneath. */
const signaturePage = (s: { name: string; text: string | null; rendered: string | null }) => {
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
async function addSmtpMailboxes(
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
