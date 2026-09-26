// Deterministic generator for the Action Hub stress corpus (10,000 tools).
// Emits into stress/.generated/:
//   tools/<serverId>.json        one manifest per fake server (44 total)
//   stress/.generated/tools-queries.json  1,000 queries in the v2 mix (direct array,
//                                   same shape as skills-queries.json)
//   results/gen-tools.json       machine-readable summary (also last stdout line)
//
// Usage: node stress/gen-tools.mjs [--seed 0x5337c0de] [--out-dir stress/.generated/tools]
//        [--small-servers 40] [--small-tools 200] [--big-servers 4] [--big-tools 500]
//        [--queries 1000]
//
// Query schema v2 fields: query, expected, subtype, difficulty, expectedAll (multi only).
// Subtype mix: 20% exact, 20% paraphrase, 20% goal-only, 25% near-duplicate,
// 10% multi, 5% no-match. difficulty: exact|paraphrase|hard (everything but
// exact/paraphrase is hard).
//
// Reviewer-2 checks, enforced by validate() (exit 1 on violation):
//  (1) every query string unique; single-answer unless subtype === 'multi'
//      (only multi carries expectedAll; no-match uses expected: null)
//  (2) hard & goal-only queries (goal-only, near-duplicate, multi) have ZERO token
//      overlap with the gold target as indexed (tokenize(name) + tokenize(serverId)
//      + tokenize(description) + tokenize(server description), core tokenizer rules)
//  (3) paraphrase queries never contain the tool name or serverId verbatim;
//      documented overlap ceiling: at most 30% of the query's content tokens
//      (deduped, length >= 3) may appear in the gold's indexed token set
//  (4) no numeric serials in tool names (names match /^[a-z][a-z_]*[a-z]$/)
//  (5) rerunning with smaller counts leaves no stale manifests (output dir is
//      swept of *.json files not produced by this run)
//  (6) near-duplicate queries only target genuinely confusable tools: the gold
//      must have >= 1 distractor that is a sibling-server clone (same tool name
//      on another server) or shares its verb token (same verb, different object)
import { mkdirSync, writeFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ARGS = process.argv.slice(2);
function argValue(name) {
  const i = ARGS.indexOf(name);
  return i >= 0 && i + 1 < ARGS.length ? ARGS[i + 1] : undefined;
}
function argNum(name, dflt) {
  const v = argValue(name);
  if (v === undefined) return dflt;
  return v.startsWith('0x') ? parseInt(v, 16) : Number(v);
}
const SEED = argNum('--seed', 0x5337c0de) >>> 0;
const OUT_DIR = resolve(argValue('--out-dir') ?? 'stress/.generated/tools');
const RESULTS_DIR = resolve('stress/.generated/results');
// Clean (pre-noise) paraphrase texts collected during generation for the FX13 lint gate.
const paraphraseClean = [];
const SMALL_SERVERS = argNum('--small-servers', 40);
const SMALL_TOOLS = argNum('--small-tools', 200);
const BIG_SERVERS = argNum('--big-servers', 4);
const BIG_TOOLS = argNum('--big-tools', 500);
const QUERY_TOTAL = argNum('--queries', 1000);

// ---------- Deterministic RNG (mulberry32) ----------
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(SEED);
function pick(arr) { return arr[Math.floor(rnd() * arr.length)]; }
function int(lo, hi) { return lo + Math.floor(rnd() * (hi - lo + 1)); }
function shuffled(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

// ---------- Core tokenizer (mirrors packages/core/src/search/search.ts) ----------
function tokenize(text) {
  if (!text) return [];
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^a-zA-Z0-9]+/)
    .filter((t) => t.length > 0)
    .map((t) => t.toLowerCase());
}

// ---------- Constants ----------
const BIG_MANIFEST_COUNT = BIG_SERVERS;
const SMALL_MANIFEST_COUNT = SMALL_SERVERS;

// Near-duplicate groups: same tool name deliberately reused across servers
// (sibling-server clones) so retrieval must disambiguate.
const NEAR_DUP_GROUPS = [
  'list_issues', 'get_issue', 'create_issue', 'update_issue', 'close_issue',
  'list_users', 'get_user', 'search_users',
  'list_projects', 'get_project', 'create_project',
  'list_comments', 'add_comment',
  'list_events', 'get_event', 'create_event',
  'list_invoices', 'get_invoice', 'send_invoice',
  'list_files', 'get_file', 'upload_file',
  'list_deployments', 'trigger_deployment',
  'list_alerts', 'acknowledge_alert',
  'list_conversations', 'get_conversation', 'send_message',
  'run_query', 'export_report',
  'list_tickets', 'get_ticket', 'merge_tickets',
  'list_secrets', 'rotate_secret',
  'list_pipelines', 'retry_pipeline',
  'list_vms', 'resize_vm',
  'list_buckets', 'get_object',
];

const DOMAINS = [
  { name: 'crm', org: 'acme-corp', desc: 'Customer relationship management for accounts, contacts, deals, and pipeline activity.' },
  { name: 'billing', org: 'acme-corp', desc: 'Invoicing, subscriptions, payments, refunds, and revenue recognition.' },
  { name: 'ticketing', org: 'acme-corp', desc: 'Support desk for tickets, queues, SLAs, agents, and customer conversations.' },
  { name: 'git-hosting', org: 'acme-corp', desc: 'Source control: repositories, pull requests, branches, releases, and CI hooks.' },
  { name: 'cloud-infra', org: 'acme-corp', desc: 'Compute, networking, storage, and IAM resources across cloud regions.' },
  { name: 'analytics', org: 'acme-corp', desc: 'Product and business analytics: events, funnels, cohorts, and dashboards.' },
  { name: 'email', org: 'acme-corp', desc: 'Transactional and marketing email: campaigns, templates, bounces, and deliverability.' },
  { name: 'calendar', org: 'acme-corp', desc: 'Shared calendars, scheduling, meetings, rooms, and availability.' },
  { name: 'hr', org: 'acme-corp', desc: 'People operations: employees, time off, payroll runs, and performance reviews.' },
  { name: 'docs', org: 'acme-corp', desc: 'Internal knowledge base: documents, spaces, comments, and permissions.' },
  { name: 'observability', org: 'acme-corp', desc: 'Logs, metrics, traces, alerts, and on-call schedules.' },
  { name: 'iam', org: 'acme-corp', desc: 'Identity and access management: users, roles, policies, and sessions.' },
  { name: 'data-warehouse', org: 'acme-corp', desc: 'SQL warehouse: tables, queries, materialized views, and exports.' },
  { name: 'search', org: 'acme-corp', desc: 'Full-text and semantic search indexes across company content.' },
  { name: 'chat', org: 'acme-corp', desc: 'Team messaging: channels, threads, DMs, and integrations.' },
  { name: 'shipping', org: 'acme-corp', desc: 'Logistics: shipments, carriers, tracking, labels, and delivery exceptions.' },
  { name: 'inventory', org: 'acme-corp', desc: 'Warehouse and inventory: SKUs, stock levels, transfers, and counts.' },
  { name: 'payments', org: 'acme-corp', desc: 'Card processing, payouts, disputes, and fraud review queues.' },
  { name: 'marketing', org: 'acme-corp', desc: 'Ad campaigns, audiences, creatives, and attribution reporting.' },
  { name: 'legal', org: 'acme-corp', desc: 'Contracts, e-signature requests, clause libraries, and approval workflows.' },
  { name: 'crm', org: 'globex', desc: 'Globex CRM: leads, opportunities, territories, and forecast snapshots.' },
  { name: 'billing', org: 'globex', desc: 'Globex billing: plan changes, proration, credit notes, and dunning.' },
  { name: 'ticketing', org: 'globex', desc: 'Globex support: incident tickets, escalation paths, and CSAT surveys.' },
  { name: 'git-hosting', org: 'globex', desc: 'Globex git hosting: monorepos, code review, protected branches, and tags.' },
  { name: 'cloud-infra', org: 'globex', desc: 'Globex cloud: Kubernetes clusters, node pools, load balancers, and DNS zones.' },
  { name: 'analytics', org: 'globex', desc: 'Globex analytics: retention, experiments, feature adoption, and custom metrics.' },
  { name: 'email', org: 'globex', desc: 'Globex email: drip sequences, segmentation, A/B tests, and suppressions.' },
  { name: 'calendar', org: 'globex', desc: 'Globex calendar: resource booking, cross-timezone scheduling, and no-show tracking.' },
  { name: 'hr', org: 'globex', desc: 'Globex HR: onboarding, benefits enrollment, expense reports, and headcount plans.' },
  { name: 'docs', org: 'globex', desc: 'Globex docs: wikis, decision records, runbooks, and page templates.' },
  { name: 'observability', org: 'globex', desc: 'Globex SRE: golden signals, SLO burn rates, synthetic checks, and pager rotations.' },
  { name: 'iam', org: 'globex', desc: 'Globex IAM: SSO, SCIM provisioning, service accounts, and audit trails.' },
  { name: 'data-warehouse', org: 'globex', desc: 'Globex warehouse: dbt models, snapshots, grants, and query history.' },
  { name: 'search', org: 'globex', desc: 'Globex search: vector indexes, rerankers, synonyms, and click feedback.' },
  { name: 'chat', org: 'globex', desc: 'Globex chat: huddles, canvases, workflows, and guest channels.' },
  { name: 'shipping', org: 'globex', desc: 'Globex logistics: fleet routing, dock appointments, and customs paperwork.' },
  { name: 'inventory', org: 'globex', desc: 'Globex inventory: lot tracking, cycle counts, supplier POs, and shortages.' },
  { name: 'payments', org: 'globex', desc: 'Globex payments: settlements, chargebacks, 3DS challenges, and reconciliation.' },
  { name: 'marketing', org: 'globex', desc: 'Globex marketing: landing pages, webhooks, lead scoring, and journey builders.' },
  { name: 'legal', org: 'globex', desc: 'Globex legal: NDAs, vendor agreements, IP filings, and policy acknowledgments.' },
  { name: 'crm', org: 'initech', desc: 'Initech CRM: accounts, renewal pipeline, churn risk, and contact timelines.' },
  { name: 'billing', org: 'initech', desc: 'Initech billing: manual invoices, wire instructions, and tax forms.' },
  { name: 'ticketing', org: 'initech', desc: 'Initech ticketing: field service jobs, dispatch, parts, and technician notes.' },
  { name: 'git-hosting', org: 'initech', desc: 'Initech git: embedded firmware repos, artifact builds, and device releases.' },
];

// ---------- Name vocabulary ----------
const ENTITY_WORDS = ['account','contact','deal','invoice','payment','ticket','issue','pull_request','repository','branch','deployment','user','team','project','task','event','meeting','calendar','campaign','email','template','subscriber','employee','document','space','log','metric','trace','alert','dashboard','report','query','table','view','index','channel','message','thread','shipment','carrier','sku','stock','transfer','dispute','payout','settlement','audience','creative','contract','clause','signature','secret','key','policy','role','session','cluster','node','bucket','object','zone','certificate','vpn','webhook','workflow','automation','export','import','snapshot','backup','budget','forecast','review','timesheet','expense','benefit','onboarding','pipeline','run','artifact','release','tag','environment','container','image','permission','token','api_key','usage','quota','plan','subscription','credit_note','refund','chargeback','customer','order','fulfillment','warehouse','dock','supplier','batch','lot','sequence','segment','suppression','experiment','funnel','cohort','retention','journey','landing_page','lead','opportunity','territory','renewal','churn','sla','queue','agent','escalation','csat','incident','oncall','synthetic_check','slo','burn_rate','golden_signal'];
const VERBS = ['list','get','create','update','delete','search','archive','restore','assign','move','merge','export','validate','preview','publish','cancel','retry','approve','reject','close','reopen','clone','diff','sync','rotate','revoke','send','schedule','acknowledge','escalate','count','summarize','compare','enable','disable','pause','resume','transfer','attach','detach','link','unlink','resolve','split','purge','snapshot','rollback','promote','invite','verify','resend','share','lock','unlock','freeze','unfreeze','finalize','amend','void','reindex','rebuild','recalculate','prune','migrate','backfill','replay','redact','approve'];
const QUALIFIERS = ['recent','archived','active','pending','overdue','stale','orphaned','flagged','sensitive','internal','external','legacy','beta','deprecated','favorite','subscribed','unassigned','escalated','detailed','summary','compact','full','partial','incremental','delta','raw','sanitized','redacted','estimated','projected','adjusted','final','draft','published','unpublished','expired','expiring','renewed','cancelled','failed','succeeded','queued','running','paused','completed','blocked'];

// Synonym vocabulary used to build zero-overlap hard queries. Only tools whose
// verb and entity appear here are eligible as gold targets for goal-only /
// near-duplicate / multi queries.
const VERB_SYN = {
  list: ['show', 'find'], get: ['fetch', 'look up'],
  create: ['make', 'set up'], update: ['change', 'revise'],
  delete: ['remove', 'trash'], search: ['find', 'look for'],
  archive: ['store', 'file away'], restore: ['recover', 'bring back'],
  assign: ['give', 'hand over'], move: ['shift', 'relocate'],
  merge: ['combine', 'join'], export: ['download', 'copy out'],
  validate: ['check', 'double check'], preview: ['look over', 'show'],
  publish: ['release', 'put out'], cancel: ['call off', 'abort'],
  retry: ['rerun', 'try again'], approve: ['sign off on', 'okay'],
  reject: ['turn down', 'decline'], close: ['wrap up', 'finish'],
  reopen: ['open again', 'reactivate'], clone: ['duplicate', 'copy'],
  diff: ['compare', 'contrast'], sync: ['reconcile', 'sync up'],
  rotate: ['cycle', 'swap out'], revoke: ['withdraw', 'take back'],
  send: ['dispatch', 'ship'], schedule: ['book', 'slot in'],
  acknowledge: ['confirm', 'own'], escalate: ['raise', 'flag'],
  count: ['tally up', 'count out'], summarize: ['recap', 'sum up'],
  compare: ['weigh', 'measure'], enable: ['turn on', 'switch on'],
  disable: ['turn off', 'switch off'], pause: ['freeze', 'hold'],
  resume: ['unpause', 'pick back up'], transfer: ['hand over', 'wire'],
  attach: ['fasten', 'hook up'], detach: ['unhook', 'unfasten'],
  link: ['connect', 'tie'], unlink: ['disconnect', 'untie'],
  resolve: ['settle', 'close out'], split: ['carve up', 'split apart'],
  purge: ['wipe out', 'erase for good'], rollback: ['roll back', 'undo'],
  promote: ['elevate', 'bump up'], invite: ['bring in', 'recruit'],
  verify: ['double check', 'authenticate'], resend: ['send again', 'fire off again'],
  share: ['circulate', 'hand out'], lock: ['seal', 'shut'],
  unlock: ['unseal', 'open'], freeze: ['halt', 'put on hold'],
  unfreeze: ['thaw', 'unpause'], finalize: ['nail down', 'wrap up'],
  void: ['nullify', 'cancel out'], reindex: ['reshuffle', 'refresh'],
  rebuild: ['reassemble', 'reconstruct'], recalculate: ['recompute', 'redo the math'],
  amend: ['adjust', 'revise'], snapshot: ['capture', 'freeze'],
  prune: ['trim', 'cut back'], migrate: ['port', 'move over'],
  backfill: ['fill in', 'catch up'], replay: ['rerun', 'play back'],
  redact: ['black out', 'scrub'],
};

const ENTITY_SYN = {
  issue: ['defect', 'bug report'], ticket: ['complaint', 'grievance'],
  user: ['teammate', 'person'], account: ['client profile'],
  contact: ['person'], invoice: ['bill'],
  payment: ['remittance'], payout: ['disbursement'],
  refund: ['rebate'], dispute: ['claim'],
  chargeback: ['reversal'], settlement: ['payoff'],
  project: ['initiative'], task: ['chore'],
  event: ['occurrence'], meeting: ['meet up'],
  comment: ['remark'], message: ['note'],
  conversation: ['exchange'], thread: ['discussion'],
  file: ['paper file'], document: ['writeup'],
  report: ['digest'], dashboard: ['panel'],
  metric: ['gauge'], trace: ['span'],
  log: ['trail'], alert: ['notification'],
  employee: ['staffer'], expense: ['outlay'],
  budget: ['allocation'], contract: ['agreement'],
  signature: ['sign off'], clause: ['stipulation'],
  secret: ['credential'], key: ['passcode'],
  token: ['pass'], session: ['login'],
  policy: ['rule'], role: ['position'],
  permission: ['rights'], webhook: ['callback'],
  deployment: ['rollout'], release: ['drop'],
  artifact: ['build'], tag: ['marker'],
  pipeline: ['workflow'], vm: ['machine'],
  bucket: ['storage bin', 'object store entry'],
  zone: ['area'], certificate: ['security document'],
  cluster: ['server group'], node: ['machine'],
  campaign: ['promotion'], email: ['correspondence'],
  subscriber: ['opt in'], audience: ['demographic'],
  creative: ['artwork'], shipment: ['parcel'],
  carrier: ['shipper'], warehouse: ['depot'],
  supplier: ['vendor'], order: ['purchase'],
  subscription: ['membership'], plan: ['package'],
  usage: ['consumption'], quota: ['allowance'],
  experiment: ['trial'], cohort: ['wave'],
  retention: ['repeat rate'], churn: ['attrition'],
  incident: ['outage'], queue: ['backlog'],
  review: ['assessment'], timesheet: ['hours log'],
  benefit: ['perk'], lead: ['prospect'],
  shipment_planned: ['parcel'], index: ['registry'],
  table: ['sheet'], view: ['lens'],
  channel: ['room'], branch: ['limb'],
  repository: ['code home'], pull_request: ['code review request'],
  deployment: ['rollout'], calendar: ['datebook'],
  campaign_: ['promotion'],
};

// Safe filler vocabulary: none of these tokens may appear anywhere in the
// corpus' indexed text (names, descriptions, server descs, server ids). The
// generator filters this list against the full corpus union, so hard/goal-only
// templates built from it have zero overlap with every gold by construction.
const FILLER_CANDIDATES = ['where', 'should', 'go', 'when', 'need', 'wanted', 'them', 'quickly', 'point', 'at', 'whatever', 'handles', 'so', 'can', 'which', 'app', 'lets', 'some', 'do', 'turn', 'today', 'give', 'way', 'who', 'around', 'here', 'line', 'up', 'all', 'spots', 'please', 'right', 'away', 'quickly', 'morning', 'tonight', 'soon', 'anything', 'options', 'looking', 'trying', 'hoping', 'want', 'must', 'might', 'could', 'would', 'there', 'exists', 'place', 'spot', 'corner', 'nook'];

// Documented stopword list (intake 16:56Z, from the PR 45 review): removed
// from query tokens before no-match overlap checks. Natural function words
// beyond this list are NOT exempt.
const STOPWORDS = new Set(['the','a','an','of','for','to','in','on','with','and','or','how','find','my','me','i','is','what','do']);
function contentOverlapNoStop(text, banned) {
  return [...new Set(tokenize(text))].filter((t) => t.length >= 3 && !STOPWORDS.has(t) && banned.has(t));
}

const GOAL_TEMPLATES = [
  'where should I go when I need {V} {E}',
  'point me at whatever handles {E} so I can {V} them',
  'which app lets me {V} {E} around here',
  'looking to {V} some {E} today, who do I ask',
  'give me a way to {V} {E} quickly please',
  'our team wants to {V} {E} tonight, options?',
  'need {E} handled, who does {V} that',
];
const NEARDUP_TEMPLATES = [
  'somewhere in our stack there is a spot to {V} {E}, find that one',
  'I remember a tool that can {V} {E}, which product was it',
  'whatever thing {V} {E} for us, use that',
  'need {E} {V} before tomorrow, pick correctly',
  'which of our apps should {V} {E} here',
];
const MULTI_TEMPLATES = [
  'line up every spot where our tools can {V} {E}',
  'all places {E} can be {V} across our stack',
  'round up each app able to {V} {E}',
];
const PARAPHRASE_TEMPLATES = [
  'Can you {V} {E} when you get a chance?',
  'I would love to {V} {E} if possible',
  'Please {V} {E} whenever convenient',
  'Could someone {V} {E} today?',
  'Any chance you can {V} {E}?',
];
const EXACT_TEMPLATES = [
  'Run {N}', 'Use the {N} tool', '{N}', 'Please execute {N} now', 'Invoke {N}',
];
const TYPO_RATE = 0.12;      // share of exact/paraphrase queries carrying a typo
const FRAGMENT_RATE = 0.05;  // share of exact queries that are fragments

function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
function titleFromName(name) { return name.split('_').map(cap).join(' '); }

function injectTypo(word) {
  if (word.length < 4) return word;
  const i = int(1, word.length - 2);
  return word.slice(0, i) + word[i + 1] + word[i] + word.slice(i + 2);
}

// ---------- JSON Schema generation ----------
const SCALAR_TYPES = ['string', 'number', 'integer', 'boolean'];
const STRING_FORMATS = ['uuid', 'date-time', 'date', 'email', 'uri', 'ipv4', 'hostname', 'duration'];
const ENUM_SETS = [
  ['open', 'in_progress', 'blocked', 'resolved', 'closed'],
  ['low', 'medium', 'high', 'critical', 'urgent'],
  ['draft', 'review', 'approved', 'published', 'archived'],
  ['succeeded', 'failed', 'running', 'queued', 'cancelled'],
  ['email', 'slack', 'webhook', 'sms', 'pager'],
  ['daily', 'weekly', 'monthly', 'quarterly', 'yearly'],
  ['read', 'write', 'admin', 'owner'],
  ['us-east-1', 'us-west-2', 'eu-west-1', 'eu-central-1', 'ap-southeast-1'],
  ['active', 'suspended', 'invited', 'deactivated'],
  ['card', 'ach', 'wire', 'paypal', 'crypto'],
];
const ID_NAMES = ['id', 'uuid', 'external_id', 'parent_id', 'owner_id', 'account_id', 'project_id', 'team_id', 'cursor', 'next_cursor', 'etag', 'slug', 'handle', 'reference', 'fingerprint', 'revision', 'version', 'sequence_number'];
const NESTED_NAMES = ['filters', 'metadata', 'pagination', 'config', 'options', 'criteria', 'sorting', 'labels', 'attributes', 'context', 'shipping_address', 'billing_details', 'notification_targets', 'retry_policy', 'access_rules', 'tags'];

function makeSchema(name, opts = {}) {
  const props = {};
  const req = [];
  const propCount = opts.minProps ? int(opts.minProps, opts.maxProps ?? opts.minProps + 6) : int(1, 8);
  const used = new Set();
  if (rnd() < 0.8) {
    const n = pick(ID_NAMES);
    props[n] = { type: 'string', description: `Unique ${titleFromName(n)} for this ${name}.` };
    used.add(n);
  }
  let guard = 0;
  while (Object.keys(props).length < propCount && guard++ < propCount * 20) {
    let n = pick(ENTITY_WORDS);
    if (used.has(n)) continue; // no numeric serials: resample instead of suffixing
    used.add(n);
    const t = rnd() < 0.55 ? 'string' : pick(SCALAR_TYPES);
    const p = { type: t, description: `${titleFromName(n)} of the ${name.replace(/_/g, ' ')}.` };
    if (t === 'string' && rnd() < 0.4) p.format = pick(STRING_FORMATS);
    if (t === 'string' && rnd() < 0.15) { p.enum = pick(ENUM_SETS); p.description += ` One of: ${p.enum.join(', ')}.`; }
    if ((t === 'number' || t === 'integer') && rnd() < 0.5) { p.minimum = int(0, 100); p.maximum = p.minimum + int(1, 10000); }
    if (rnd() < 0.2) p.default = t === 'boolean' ? rnd() < 0.5 : (t === 'string' ? 'example' : int(1, 100));
    props[n] = p;
    if (rnd() < 0.45) req.push(n);
  }
  if (opts.nested) {
    const depth = opts.deep ? int(2, 3) : 1;
    for (let d = 0; d < int(1, 3); d++) {
      const n = pick(NESTED_NAMES);
      const root = { type: 'object', properties: {}, additionalProperties: false, description: `Structured ${titleFromName(n)} for this request.` };
      let cur = root;
      for (let level = 0; level < depth; level++) {
        const childName = level === depth - 1 ? 'details' : 'inner';
        const child = { type: 'object', properties: {}, additionalProperties: false };
        for (let k = 0; k < int(2, 5); k++) {
          const pn = pick(ENTITY_WORDS) + '_l' + level;
          child.properties[pn] = { type: rnd() < 0.6 ? 'string' : pick(SCALAR_TYPES), description: `${titleFromName(pn)} at nesting level ${level}.` };
        }
        cur.properties[childName] = child;
        cur = child;
      }
      for (let k = 0; k < int(2, 6); k++) {
        const pn = pick(ENTITY_WORDS);
        cur.properties[pn] = { type: rnd() < 0.6 ? 'string' : pick(SCALAR_TYPES), description: `${titleFromName(pn)} for ${titleFromName(n)}.` };
      }
      props[n] = root;
    }
  }
  if (opts.big) {
    let g2 = 0;
    while (Object.keys(props).length < 22 && g2++ < 200) {
      const n = pick(ENTITY_WORDS) + '_x' + Object.keys(props).length;
      if (n in props) continue;
      props[n] = { type: rnd() < 0.6 ? 'string' : pick(SCALAR_TYPES), description: `${titleFromName(n)} extension field.` };
    }
  }
  const schema = { type: 'object', properties: props, additionalProperties: false };
  if (req.length) schema.required = req;
  return schema;
}

// ---------- Manifest / tool generation ----------
function makeTool(serverId, domainName, orgName, forced) {
  let name, kind;
  if (forced) {
    name = forced;
    kind = /^(list|get|search)_/.test(name) ? 'read' : /^(delete|revoke|purge)/.test(name) ? 'danger' : 'write';
  } else {
    kind = rnd() < 0.45 ? 'read' : rnd() < 0.85 ? 'write' : 'danger';
    name = pick(VERBS) + '_' + pick(ENTITY_WORDS);
    if (rnd() < 0.3) name += '_' + pick(QUALIFIERS);
  }
  const isRead = kind === 'read';
  const bigResponse = rnd() < 0.04;
  const errorRate = rnd() < 0.03 ? +(rnd() * 0.15).toFixed(3) : 0;
  const latencyMs = int(0, 50);
  const desc = `${isRead ? 'Retrieves' : kind === 'danger' ? 'Permanently removes or revokes' : 'Creates, updates, or manages'} ${titleFromName(name).toLowerCase()} in the ${orgName} ${domainName} service. ${bigResponse ? 'Returns a large paginated payload with full embedded records, audit history, and related entities.' : `Supports ${isRead ? 'filtering and pagination' : 'partial updates and idempotency keys'}${rnd() < 0.5 ? ' for automation workflows' : ''}.`}`;
  const input = makeSchema(name, {
    nested: rnd() < 0.3,
    deep: rnd() < 0.12,
    big: rnd() < 0.12,
    minProps: rnd() < 0.15 ? 18 : undefined,
    maxProps: 26,
  });
  const tool = { name, description: desc, inputSchema: input, annotations: {} };
  if (isRead) tool.annotations.readOnlyHint = true;
  if (kind === 'danger') tool.annotations.destructiveHint = true;
  const behavior = { latencyMs };
  if (errorRate > 0) behavior.errorRate = errorRate;
  if (bigResponse) behavior.responseBytes = int(600_000, 1_000_000);
  tool.behavior = behavior;
  return tool;
}

function makeManifest(domain, toolCount, dupNames) {
  const serverId = `${domain.org}-${domain.name}`;
  const tools = [];
  const seen = new Set();
  for (const forced of dupNames) {
    const t = makeTool(serverId, domain.name, domain.org, forced);
    if (!seen.has(t.name)) { seen.add(t.name); tools.push(t); }
  }
  let guard = 0;
  while (tools.length < toolCount && guard++ < toolCount * 30) {
    const t = makeTool(serverId, domain.name, domain.org, undefined);
    if (seen.has(t.name)) continue;
    seen.add(t.name);
    tools.push(t);
  }
  if (tools.length !== toolCount) throw new Error(`could not fill ${serverId} to ${toolCount} unique tools`);
  return { serverId, tools };
}

// ---------- Query generation ----------
function indexedTokens(serverId, tool, serverDesc) {
  return new Set([...tokenize(tool.name), ...tokenize(serverId), ...tokenize(tool.description), ...tokenize(serverDesc)]);
}
function contentTokens(text) {
  return [...new Set(tokenize(text))].filter((t) => t.length >= 3);
}
function overlap(queryText, banned) {
  return tokenize(queryText).filter((t) => banned.has(t));
}

function buildQueries(manifests, serverDescs) {
  const allTools = [];
  const byName = new Map(); // tool name -> [{serverId, tool, indexed}]
  for (const m of manifests) {
    const sd = serverDescs[m.serverId];
    for (const t of m.tools) {
      const rec = { serverId: m.serverId, tool: t, indexed: indexedTokens(m.serverId, t, sd), id: `${m.serverId}:${t.name}` };
      allTools.push(rec);
      if (!byName.has(t.name)) byName.set(t.name, []);
      byName.get(t.name).push(rec);
    }
  }
  // Eligible pool for zero-overlap construction: two-part verb_entity names
  const eligible = allTools.filter(({ tool }) => {
    const parts = tool.name.split('_');
    return parts.length === 2 && VERB_SYN[parts[0]] && ENTITY_SYN[parts[1]];
  });
  // Filler vocabulary safe against the whole corpus
  const corpusTokens = new Set();
  for (const m of manifests) {
    for (const t of tokenize(m.serverId)) corpusTokens.add(t);
    for (const t of m.tools) {
      for (const t2 of tokenize(t.name)) corpusTokens.add(t2);
      for (const t2 of tokenize(t.description)) corpusTokens.add(t2);
    }
    for (const t of tokenize(serverDescs[m.serverId])) corpusTokens.add(t);
  }
  const FILLER = FILLER_CANDIDATES.filter((w) => !corpusTokens.has(w));

  const queries = [];
  const used = new Set();
  const bySubtype = {};
  const quotas = [
    ['exact', Math.round(QUERY_TOTAL * 0.20)],
    ['paraphrase', Math.round(QUERY_TOTAL * 0.20)],
    ['goal-only', Math.round(QUERY_TOTAL * 0.20)],
    ['near-duplicate', Math.round(QUERY_TOTAL * 0.25)],
    ['multi', Math.round(QUERY_TOTAL * 0.10)],
    ['no-match', Math.round(QUERY_TOTAL * 0.05)],
  ];
  let deficit = QUERY_TOTAL - quotas.reduce((a, [, n]) => a + n, 0);
  quotas[0][1] += deficit;

  function tryEmit(subtype, difficulty, candidates) {
    // candidates: array of () => {query, expected, expectedAll?} | null
    for (let attempt = 0; attempt < 200; attempt++) {
      const c = pick(candidates)();
      if (!c) continue;
      if (used.has(c.query)) continue;
      used.add(c.query);
      const q = { query: c.query, expected: c.expected ?? null, subtype, difficulty };
      if (c.expectedAll) q.expectedAll = c.expectedAll;
      queries.push(q);
      bySubtype[subtype] = (bySubtype[subtype] || 0) + 1;
      return true;
    }
    return false;
  }

  const verbSynOf = (tool) => VERB_SYN[tool.name.split('_')[0]];
  const entSynOf = (tool) => ENTITY_SYN[tool.name.split('_')[1]];

  // EXACT
  {
    const gen = [];
    for (const rec of shuffled(allTools)) {
      gen.push(() => {
        let text = pick(EXACT_TEMPLATES).replace('{N}', rec.tool.name);
        if (rnd() < FRAGMENT_RATE) {
          const parts = rec.tool.name.split('_');
          text = `${parts[0]} ${parts[1]?.slice(0, 4) ?? parts[0]}...`;
        } else if (rnd() < TYPO_RATE) {
          text = text.replace(pick(rec.tool.name.split('_')), (w) => injectTypo(w));
        }
        return { query: text, expected: rec.id };
      });
    }
    for (let i = 0; i < quotas[0][1]; i++) {
      if (!tryEmit('exact', 'exact', gen)) throw new Error('could not fill exact quota');
    }
  }

  // PARAPHRASE: synonyms only, never tool name / serverId verbatim,
  // documented overlap ceiling 30% of content tokens. FX13 (F31): when the
  // gold tool name is cloned across servers, a bare synonym query is
  // underdetermined — the query MUST carry a domain clue (org + server
  // domain words) that uniquely picks the gold server, or generation fails.
  {
    const domainOf = (sid) => DOMAINS.find((dd) => `${dd.org}-${dd.name}` === sid);
    // Minimal clue: if every clone lives in the same org, the domain name
    // alone disambiguates (fewer indexed tokens keeps the 30% overlap ceiling
    // reachable); otherwise org + domain. Inserted before terminal
    // punctuation so the sentence stays grammatical.
    const clueOf = (rec) => {
      const group = byName.get(rec.tool.name) ?? [];
      const d = domainOf(rec.serverId);
      const sameOrg = group.every((r) => domainOf(r.serverId)?.org === d.org);
      return sameOrg
        ? `in the ${d.name.replace(/-/g, ' ')} system`
        : `in the ${d.org.replace(/-/g, ' ')} ${d.name.replace(/-/g, ' ')} system`;
    };
    const gen = [];
    for (const rec of shuffled(eligible)) {
      gen.push(() => {
        let text = pick(PARAPHRASE_TEMPLATES)
          .replace('{V}', pick(verbSynOf(rec.tool)))
          .replace('{E}', pick(entSynOf(rec.tool)));
        const clones = (byName.get(rec.tool.name) ?? []).length;
        if (clones > 1) {
          text = `${text.replace(/[?.!]*$/, "")}, ${clueOf(rec)}.`;
        }
        paraphraseClean.push(text);
        if (rnd() < TYPO_RATE) text = text.replace(/\b\w{4,}\b/, (w) => injectTypo(w));
        // Clued queries carry extra indexed tokens (the clue); drop candidates
        // whose overlap would break the documented 30% ceiling.
        if (clones > 1) {
          const ct = contentTokens(text);
          const ratio = ct.filter((t) => rec.indexed.has(t)).length / Math.max(1, ct.length);
          if (ratio > 0.3) return null;
        }
        return { query: text, expected: rec.id };
      });
    }
    for (let i = 0; i < quotas[1][1]; i++) {
      if (!tryEmit('paraphrase', 'paraphrase', gen)) throw new Error('could not fill paraphrase quota');
    }
    // Ambiguity validator (FX13 #2): fail generation if any paraphrase's gold
    // is underdetermined by construction — cloned name without a clue, or a
    // clue that does not actually pick the gold server out of the clone group.
    for (let i = 0; i < queries.length; i++) {
      if (queries[i].subtype !== 'paraphrase') continue;
      const [sid, tname] = queries[i].expected.split(':');
      const group = byName.get(tname) ?? [];
      if (group.length <= 1) continue;
      const goldTokens = new Set(tokenize(sid.replace(/-/g, ' ')));
      const queryTokens = new Set(tokenize(queries[i].query));
      const disambiguating = [...goldTokens].some((t) => queryTokens.has(t));
      if (!disambiguating) {
        throw new Error(`ambiguous paraphrase: cloned tool name "${tname}" without a disambiguating server clue: ${queries[i].query}`);
      }
    }
  }

  // GOAL-ONLY: zero token overlap with gold (checked before emit)
  {
    const gen = [];
    for (const rec of shuffled(eligible)) {
      gen.push(() => {
        const text = pick(GOAL_TEMPLATES)
          .replace('{V}', pick(verbSynOf(rec.tool)))
          .replace('{E}', pick(entSynOf(rec.tool)));
        if (overlap(text, rec.indexed).length > 0) return null;
        return { query: text, expected: rec.id };
      });
    }
    for (let i = 0; i < quotas[2][1]; i++) {
      if (!tryEmit('goal-only', 'hard', gen)) throw new Error('could not fill goal-only quota');
    }
  }

  // NEAR-DUPLICATE: gold must have >= 1 genuinely confusable distractor
  // (sibling-server clone with the same name, or same verb different object).
  {
    // Direct construction: pick gold from clone groups or same-verb siblings.
    const cloneNames = [...byName.entries()].filter(([, g]) => g.length >= 2).map(([n]) => n);
    const eligibleNames = new Set(eligible.map((r) => r.tool.name));
    const candidates = [];
    for (const name of cloneNames) {
      for (const gold of byName.get(name)) candidates.push({ gold, kind: 'clone', group: byName.get(name) });
    }
    for (const gold of shuffled(eligible)) {
      const verb = gold.tool.name.split('_')[0];
      const sibling = eligible.find((r) => r.id !== gold.id && r.tool.name.split('_')[0] === verb && r.tool.name.split('_')[1] !== gold.tool.name.split('_')[1]);
      if (sibling) candidates.push({ gold, kind: 'verb', group: [gold, sibling] });
    }
    const gen2 = shuffled(candidates).map(({ gold, kind, group }) => () => {
      const parts = gold.tool.name.split('_');
      const vs = VERB_SYN[parts[0]]; const es = ENTITY_SYN[parts[1]];
      if (!vs || !es) return null;
      let text = pick(NEARDUP_TEMPLATES)
        .replace('{V}', pick(vs))
        .replace('{E}', pick(es));
      if (rnd() < TYPO_RATE) text = text.replace(/\b\w{4,}\b/, (w) => injectTypo(w));
      if (overlap(text, gold.indexed).length > 0) return null;
      // verify distractors share no gold tokens with query but do share structure
      const distractors = group.filter((r) => r.id !== gold.id);
      if (kind === 'verb') {
        const sib = group[1];
        if (!siblingConfusable(gold, sib)) return null;
      }
      return { query: text, expected: gold.id, _kind: kind, _group: group };
    });
    for (let i = 0; i < quotas[3][1]; i++) {
      if (!tryEmit('near-duplicate', 'hard', gen2)) throw new Error('could not fill near-duplicate quota');
    }
  }

  // MULTI: 2-3 sibling-server clones of one tool name (tools-only multi;
  // skills slugs are not part of this corpus).
  {
    const cloneNames = [...byName.entries()].filter(([n, g]) => g.length >= 2 && VERB_SYN[n.split('_')[0]] && ENTITY_SYN[n.split('_')[1]]).map(([n]) => n);
    const gen = [];
    for (const name of shuffled(cloneNames)) {
      const group = shuffled(byName.get(name));
      for (let size = Math.min(3, group.length); size >= 2; size--) {
        const golds = group.slice(0, size);
        gen.push(() => {
          const parts = name.split('_');
          const vs = VERB_SYN[parts[0]]; const es = ENTITY_SYN[parts[1]];
          if (!vs || !es) return null;
          const union = new Set();
          for (const g of golds) for (const t of g.indexed) union.add(t);
          const text = pick(MULTI_TEMPLATES).replace('{V}', pick(vs)).replace('{E}', pick(es));
          if (overlap(text, union).length > 0) return null;
          return { query: text, expected: golds[0].id, expectedAll: golds.map((g) => g.id) };
        });
        break; // one candidate entry per clone name
      }
    }
    for (let i = 0; i < quotas[4][1]; i++) {
      if (!tryEmit('multi', 'hard', gen)) throw new Error('could not fill multi quota');
    }
  }

  // NO-MATCH: plausible nonsense; expected: null. Fake adjectives guaranteed
  // absent from every tool name in the corpus.
  {
    const FAKE_ADJ = ['lunar', 'underwater', 'holographic', 'invisible', 'quantum', 'haunted', 'zero-g', 'abandoned'];
    const gen = [];
    for (let i = 0; i < 400; i++) {
      const v = pick(Object.keys(VERB_SYN)); const e = pick(Object.keys(ENTITY_SYN));
      const adj = pick(FAKE_ADJ);
      gen.push(() => {
        const vs = pick(VERB_SYN[v]); const es = pick(ENTITY_SYN[e]);
        const text = `${pick(vs.split(' '))} the ${adj} ${es.split(' ')[0]} please`;
        // Rule (intake 16:56Z): no-match queries must have ZERO overlap on
        // content tokens (query tokens minus the documented stopword list)
        // with the whole indexed corpus (tool name words, description,
        // serverId, server description). Validated on the final emitted string.
        if (contentOverlapNoStop(text, corpusTokens).length > 0) return null;
        return { query: text, expected: null };
      });
    }
    for (let i = 0; i < quotas[5][1]; i++) {
      if (!tryEmit('no-match', 'hard', gen)) throw new Error('could not fill no-match quota');
    }
  }

  return queries;
}

// Same verb, different object, genuinely confusable: sibling shares the verb
// token and at least one description token with the gold.
function siblingConfusable(a, b) {
  if (!a || !b) return false;
  const av = a.tool.name.split('_')[0];
  const bv = b.tool.name.split('_')[0];
  if (av !== bv) return false;
  const ad = new Set(tokenize(a.tool.description));
  return tokenize(b.tool.description).some((t) => ad.has(t));
}
function goldId(rec) { return rec.id; }
function sib(x) { return x; }

// ---------- Validation (reviewer-2 checks; exit 1 on violation) ----------
function validate(manifests, queries, serverDescs, staleRemoved, finalFiles) {
  const violations = [];
  const idSet = new Set();
  for (const m of manifests) for (const t of m.tools) idSet.add(`${m.serverId}:${t.name}`);

  // (1) uniqueness + single-answer
  const seen = new Set();
  for (const q of queries) {
    if (seen.has(q.query)) violations.push(`duplicate query string: ${q.query}`);
    seen.add(q.query);
    if (q.subtype === 'multi') {
      if (!Array.isArray(q.expectedAll) || q.expectedAll.length < 2 || q.expectedAll.length > 4)
        violations.push(`multi query without 2-4 expectedAll: ${q.query}`);
      for (const id of q.expectedAll ?? []) if (!idSet.has(id)) violations.push(`unresolved expectedAll id: ${id}`);
    } else if (q.subtype === 'no-match') {
      if (q.expected !== null || q.expectedAll) violations.push(`no-match query must have expected null: ${q.query}`);
    } else {
      if (typeof q.expected !== 'string' || q.expectedAll) violations.push(`non-multi query must be single-answer: ${q.query}`);
      if (!idSet.has(q.expected)) violations.push(`unresolved expected id: ${q.expected}`);
    }
  }

  // (2) zero overlap for goal-only, near-duplicate, multi vs each gold as indexed
  for (const q of queries) {
    if (!['goal-only', 'near-duplicate', 'multi'].includes(q.subtype)) continue;
    const golds = q.subtype === 'multi' ? q.expectedAll : [q.expected];
    for (const id of golds) {
      const m = manifests.find((mm) => id.startsWith(mm.serverId + ':'));
      const toolName = id.slice(m.serverId.length + 1);
      const t = m.tools.find((tt) => tt.name === toolName);
      const banned = indexedTokens(m.serverId, t, serverDescs[m.serverId]);
      const ov = overlap(q.query, banned);
      if (ov.length > 0) violations.push(`overlap ${JSON.stringify(ov)} in ${q.subtype} query: ${q.query}`);
    }
  }

  // (3) paraphrase: no verbatim tool name / serverId; <= 30% content overlap
  for (const q of queries) {
    if (q.subtype !== 'paraphrase') continue;
    const [sid, tname] = q.expected.split(':');
    const t = manifests.find((mm) => mm.serverId === sid).tools.find((x) => x.name === tname);
    const lower = q.query.toLowerCase();
    if (lower.includes(tname.toLowerCase()) || lower.includes(tname.replace(/_/g, ' ').toLowerCase()))
      violations.push(`paraphrase contains tool name verbatim: ${q.query}`);
    if (lower.includes(sid.toLowerCase())) violations.push(`paraphrase contains serverId verbatim: ${q.query}`);
    const banned = indexedTokens(sid, t, serverDescs[sid]);
    const ct = contentTokens(q.query);
    const ratio = ct.filter((t2) => banned.has(t2)).length / Math.max(1, ct.length);
    if (ratio > 0.3) violations.push(`paraphrase overlap ${(ratio).toFixed(2)} > 0.30 ceiling: ${q.query}`);
  }

  // (4) no numeric serials in tool names
  for (const m of manifests) for (const t of m.tools)
    if (!/^[a-z][a-z_]*[a-z]$/.test(t.name)) violations.push(`tool name has serials/invalid chars: ${m.serverId}:${t.name}`);

  // (4b) no-match: zero content-token overlap with the whole indexed corpus
  // (tokens minus STOPWORDS; name words, description, serverId, server desc)
  const corpusIndexed = new Set();
  for (const m of manifests) {
    for (const t of tokenize(m.serverId)) corpusIndexed.add(t);
    for (const t of tokenize(serverDescs[m.serverId])) corpusIndexed.add(t);
    for (const t of m.tools) {
      for (const t2 of tokenize(t.name)) corpusIndexed.add(t2);
      for (const t2 of tokenize(t.description)) corpusIndexed.add(t2);
    }
  }
  for (const q of queries) {
    if (q.subtype !== 'no-match') continue;
    const ov = contentOverlapNoStop(q.query, corpusIndexed);
    if (ov.length > 0) violations.push(`no-match content overlap ${JSON.stringify(ov)} with corpus: ${q.query}`);
  }

  // (5) stale manifests
  const expectedFiles = new Set(manifests.map((m) => `${m.serverId}.json`));
  for (const f of finalFiles) if (!expectedFiles.has(f)) violations.push(`stale manifest left behind: ${f}`);

  // (6) near-duplicate confusability
  let minDistractors = Infinity;
  for (const q of queries) {
    if (q.subtype !== 'near-duplicate') continue;
    const [sid, tname] = q.expected.split(':');
    const goldManifest = manifests.find((m) => m.serverId === sid);
    const goldTool = goldManifest.tools.find((t) => t.name === tname);
    const gold = { serverId: sid, tool: goldTool };
    const distractors = [];
    for (const m of manifests) {
      if (m.serverId === sid) continue;
      if (m.tools.some((t) => t.name === tname)) { distractors.push(m.serverId); continue; }
      const sibTool = m.tools.find((t) => t.name.split('_')[0] === tname.split('_')[0]);
      if (sibTool && siblingConfusable(gold, { serverId: m.serverId, tool: sibTool })) distractors.push(m.serverId);
    }
    minDistractors = Math.min(minDistractors, distractors.length);
    if (distractors.length === 0) violations.push(`near-duplicate gold has no confusable distractor: ${q.expected}`);
  }

  return { violations, minDistractors: Number.isFinite(minDistractors) ? minDistractors : 0 };
}

// ---------- Main ----------
function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  mkdirSync(RESULTS_DIR, { recursive: true });

  const dupBudget = NEAR_DUP_GROUPS.length; // each dup name planted on ~2+ servers
  const manifests = [];
  const serverDescs = {};
  for (let i = 0; i < SMALL_MANIFEST_COUNT; i++) {
    const d = DOMAINS[i % DOMAINS.length];
    const dupNames = [0, 1, 2].map((k) => NEAR_DUP_GROUPS[(i * 3 + k) % NEAR_DUP_GROUPS.length]);
    manifests.push(makeManifest(d, SMALL_TOOLS, dupNames));
  }
  for (let i = 0; i < BIG_MANIFEST_COUNT; i++) {
    const d = DOMAINS[(SMALL_MANIFEST_COUNT + i) % DOMAINS.length];
    const dupNames = NEAR_DUP_GROUPS.slice(i * 10, i * 10 + 10);
    manifests.push(makeManifest(d, BIG_TOOLS, dupNames));
  }
  for (const m of manifests) serverDescs[m.serverId] = DOMAINS.find((d) => `${d.org}-${d.name}` === m.serverId).desc;

  // (5) sweep stale manifests from previous runs
  let staleRemoved = 0;
  if (existsSync(OUT_DIR)) {
    const expected = new Set(manifests.map((m) => `${m.serverId}.json`));
    for (const f of readdirSync(OUT_DIR)) {
      if (f.endsWith('.json') && !expected.has(f)) { rmSync(join(OUT_DIR, f)); staleRemoved++; }
    }
  }

  const queries = buildQueries(manifests, serverDescs);

  for (const m of manifests) {
    writeFileSync(join(OUT_DIR, `${m.serverId}.json`), JSON.stringify(m, null, 2));
  }
  // Contract: queries are a direct array at stress/.generated/tools-queries.json
  // (same shape as skills-queries.json). Never inside the manifest directory —
  // make-config scans tools/*.json as fake-server manifests.
  writeFileSync(resolve('stress/.generated/tools-queries.json'), JSON.stringify(queries, null, 2));

  const finalFiles = readdirSync(OUT_DIR).filter((f) => f.endsWith('.json'));
  const { violations, minDistractors } = validate(manifests, queries, serverDescs, staleRemoved, finalFiles);

  // --- FX13 query-quality self-check ------------------------------------------------
  // Lint CLEAN paraphrase texts (before noise/typos). Zero lint hits is the gate.
  const toolStopwords = new Set(['can','you','would','love','to','please','whenever','could','someone','today','any','chance','if','possible','when','get','a','i','me','my','the','in','of','for','and','or','on','at','is','are','with','what','how','find','do','our']);
  const toolVocab = new Set(toolStopwords);
  for (const table of [VERB_SYN, ENTITY_SYN]) {
    for (const [k, vals] of Object.entries(table)) {
      for (const t of tokenize(k)) toolVocab.add(t);
      for (const v of vals) for (const t of tokenize(v)) toolVocab.add(t);
    }
  }
  for (const d of DOMAINS) {
    for (const t of tokenize(d.name)) toolVocab.add(t);
    for (const t of tokenize(d.org.replace(/-/g, ' '))) toolVocab.add(t);
  }
  for (const t of ['system', 'recent', 'convenient']) toolVocab.add(t);
  const toolLint = { debris: 0, doubleSpace: 0, malformed: 0, unknownVocab: 0, ambiguous: 0 };
  const unknownSamples = [];
  for (const clean of paraphraseClean) {
    // Debris = two consecutive prepositions (mid-sentence deletion class).
    if (/\b(?:for|against|with|of|to|in)\s+(?:for|against|with|of|to|in)\b/i.test(clean)) toolLint.debris += 1;
    if (/ {2,}/.test(clean)) toolLint.doubleSpace += 1;
    // Malformed = lowercase start, or ends on a dangling function word (the
    // mid-sentence deletion signature). Casual templates without terminal
    // punctuation are fine; dangling connectives are not.
    if (!/^[A-Z]/.test(clean) || /\b(?:for|against|with|of|to|in|and|or|the|a|an)$/i.test(clean.trim())) {
      toolLint.malformed += 1;
    }
    const unknown = tokenize(clean).filter((t) => !toolVocab.has(t));
    if (unknown.length > 0) {
      toolLint.unknownVocab += 1;
      unknownSamples.push(...unknown.slice(0, 5));
    }
  }
  // Ambiguity count for the record: the validator inside buildQueries already
  // fails hard on ambiguous paraphrases; this recomputes the same predicate
  // over the emitted rows so the results file carries the number.
  const cloneCounts = new Map();
  for (const m of manifests) for (const t of m.tools) cloneCounts.set(t.name, (cloneCounts.get(t.name) ?? 0) + 1);
  const ambiguousCount = queries.filter((q) => {
    if (q.subtype !== 'paraphrase' || !q.expected) return false;
    const [sid, tname] = q.expected.split(':');
    if ((cloneCounts.get(tname) ?? 0) <= 1) return false;
    const goldTokens = new Set(tokenize(sid.replace(/-/g, ' ')));
    return ![...goldTokens].some((t) => tokenize(q.query).includes(t));
  }).length;
  toolLint.ambiguous = ambiguousCount;
  const toolLintTotal = Object.values(toolLint).reduce((a, b) => a + b, 0);

  const emittedParaphrases = queries.filter((q) => q.subtype === 'paraphrase');
  const sampleStride = Math.max(1, Math.floor(emittedParaphrases.length / 30));
  const paraphraseSamples = emittedParaphrases.filter((_, i) => i % sampleStride === 0).slice(0, 30).map((q) => q.query);
  console.log('--- FX13 tool paraphrase samples (30) ---');
  for (const sample of paraphraseSamples) console.log('  ' + sample);
  console.log('--- FX13 tool lint counts (clean text, gate = all zero) ---');
  console.log(JSON.stringify(toolLint));
  if (toolLintTotal > 0) {
    throw new Error(`FX13 lint gate failed for tools: ${JSON.stringify(toolLint)} unknown-tokens: ${[...new Set(unknownSamples)].slice(0, 30).join(',')}`);
  }
  writeFileSync(
    join(RESULTS_DIR, 'query-quality-tools.json'),
    JSON.stringify({ generatorVersion: 3, lint: toolLint, samples: paraphraseSamples }, null, 2),
  );

  const bySubtype = {};
  const byDifficulty = {};
  for (const q of queries) {
    bySubtype[q.subtype] = (bySubtype[q.subtype] || 0) + 1;
    byDifficulty[q.difficulty] = (byDifficulty[q.difficulty] || 0) + 1;
  }
  const summary = {
    script: 'gen-tools.mjs',
    generatorVersion: 3,
    seed: SEED,
    manifestCount: manifests.length,
    totalTools: manifests.reduce((a, m) => a + m.tools.length, 0),
    bigManifests: BIG_MANIFEST_COUNT,
    queryTotal: queries.length,
    queryQuality: { generatorVersion: 3, lint: toolLint, lintHits: toolLintTotal, sampleCount: paraphraseSamples.length },
    bySubtype,
    byDifficulty,
    checks: {
      uniqueQueryStrings: new Set(queries.map((q) => q.query)).size === queries.length,
      unresolvedExpected: queries.filter((q) => q.expected !== null && !idExists(manifests, q.expected)).length,
      paraphraseCeiling: 0.3,
      noMatchRule: 'zero content-token overlap with the whole indexed corpus (tool name words, description, serverId, server description) after removing the documented stopword list: ' + [...STOPWORDS].join(','),
      staleRemoved,
      minDistractors,
      violations: violations.slice(0, 20),
      violationCount: violations.length,
    },
    ok: violations.length === 0,
  };
  writeFileSync(join(RESULTS_DIR, 'gen-tools.json'), JSON.stringify(summary, null, 2));
  // Contract: last stdout line is a single-line machine-readable JSON summary.
  const summaryLine = JSON.stringify(summary);
  console.log(summaryLine);
  if (!summary.ok) process.exit(1);
  // Smoke assertion: the last stdout line parses as JSON.
  JSON.parse(summaryLine.trim());
}
function idExists(manifests, id) {
  const i = id.indexOf(':');
  const sid = id.slice(0, i); const tn = id.slice(i + 1);
  const m = manifests.find((x) => x.serverId === sid);
  return !!m && m.tools.some((t) => t.name === tn);
}
main();
