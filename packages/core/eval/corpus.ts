import type { ActionRecord } from "../dist/types.js";

/**
 * A fixture catalog modeled on the shape of real MCP servers.
 *
 * The point of this corpus is *interference*, not size. Retrieval looks easy
 * when every action is unique; it is hard when a dozen servers each expose
 * something called "search", "list", or "create_issue". Names, summaries, and
 * descriptions are written the way upstream servers actually write them —
 * inconsistent naming conventions, terse one-liners, and heavy vocabulary
 * overlap across servers — so the eval measures disambiguation rather than
 * mere keyword presence.
 *
 * Nothing here touches the network. The corpus is a plain data fixture, so the
 * eval is deterministic and runs in milliseconds.
 */

interface ActionSeed {
  name: string;
  summary: string;
  description?: string;
  tags?: string[];
  kind?: "tool" | "skill";
}

function actions(
  serverId: string,
  trust: "trusted" | "untrusted",
  seeds: readonly ActionSeed[],
): ActionRecord[] {
  return seeds.map((seed) => {
    const record: ActionRecord = {
      id: `${serverId}:${seed.name}`,
      kind: seed.kind ?? "tool",
      serverId,
      name: seed.name,
      summary: seed.summary,
      trust,
    };
    if (seed.description) record.description = seed.description;
    if (seed.tags) record.tags = seed.tags;
    return record;
  });
}

const github = actions("github", "trusted", [
  {
    name: "create_pull_request",
    summary: "Create a new pull request in a repository",
    description:
      "Opens a pull request from a head branch into a base branch with a title and body. Supports draft pull requests and reviewer assignment.",
    tags: ["pr", "review", "git"],
  },
  {
    name: "merge_pull_request",
    summary: "Merge an open pull request",
    description:
      "Merges a pull request using a merge commit, squash, or rebase strategy. Fails when required status checks have not passed.",
    tags: ["pr", "merge", "git"],
  },
  {
    name: "list_pull_requests",
    summary: "List pull requests in a repository",
    description: "Lists pull requests filtered by state, base branch, head branch, or author.",
    tags: ["pr", "git"],
  },
  {
    name: "get_pull_request_diff",
    summary: "Get the unified diff for a pull request",
    description:
      "Returns the patch for every file changed in a pull request, in unified diff format, with additions and deletions per file.",
    tags: ["pr", "diff", "patch"],
  },
  {
    name: "create_pull_request_review",
    summary: "Submit a review on a pull request",
    description:
      "Submits an approving, commenting, or change-requesting review, optionally with inline comments anchored to lines in the diff.",
    tags: ["pr", "review", "approve"],
  },
  {
    name: "create_issue",
    summary: "Create a new issue in a GitHub repository",
    description: "Files an issue with a title, body, labels, assignees, and an optional milestone.",
    tags: ["issue", "bug", "tracking"],
  },
  {
    name: "list_issues",
    summary: "List issues in a GitHub repository",
    description: "Lists repository issues filtered by state, label, assignee, or creation date.",
    tags: ["issue", "tracking"],
  },
  {
    name: "add_issue_comment",
    summary: "Add a comment to a GitHub issue",
    description: "Appends a markdown comment to an existing issue or pull request thread.",
    tags: ["issue", "comment"],
  },
  {
    name: "search_code",
    summary: "Search code across GitHub repositories",
    description:
      "Full-text code search with qualifiers for repository, organization, language, path, and filename.",
    tags: ["search", "code", "grep"],
  },
  {
    name: "get_file_contents",
    summary: "Read a file from a GitHub repository",
    description:
      "Fetches the contents of a file, or a directory listing, at a given ref, branch, or commit SHA.",
    tags: ["file", "read", "repo"],
  },
  {
    name: "create_branch",
    summary: "Create a branch in a GitHub repository",
    description: "Creates a new git ref pointing at a base branch head or an explicit commit SHA.",
    tags: ["git", "branch"],
  },
  {
    name: "list_commits",
    summary: "List commits on a branch",
    description: "Returns commit history for a branch or path, with author, message, and SHA.",
    tags: ["git", "commit", "history"],
  },
  {
    name: "list_workflow_runs",
    summary: "List GitHub Actions workflow runs",
    description: "Lists CI workflow runs with status, conclusion, branch, and triggering event.",
    tags: ["ci", "actions", "build"],
  },
  {
    name: "get_workflow_run_logs",
    summary: "Download logs for a GitHub Actions run",
    description:
      "Retrieves the log output of a failed or completed CI job so build failures can be diagnosed without opening a browser.",
    tags: ["ci", "actions", "build"],
  },
  {
    name: "create_release",
    summary: "Publish a GitHub release",
    description: "Creates a tagged release with release notes and optional binary assets.",
    tags: ["release", "tag", "publish"],
  },
]);

const linear = actions("linear", "trusted", [
  {
    name: "create_issue",
    summary: "Create a Linear issue in a team",
    description:
      "Creates an issue on a Linear team with a title, description, priority, estimate, assignee, and optional project.",
    tags: ["issue", "ticket", "task", "tracking"],
  },
  {
    name: "update_issue",
    summary: "Update fields on a Linear issue",
    description: "Changes the state, assignee, priority, estimate, labels, or cycle of an existing issue.",
    tags: ["issue", "ticket", "update"],
  },
  {
    name: "search_issues",
    summary: "Search Linear issues by text and filters",
    description: "Finds issues matching a query string, optionally scoped by team, state, assignee, or label.",
    tags: ["issue", "search", "ticket"],
  },
  {
    name: "list_my_issues",
    summary: "List issues assigned to the current user",
    description: "Returns the authenticated user's assigned issues, ordered by priority and cycle.",
    tags: ["issue", "assigned", "mine", "todo"],
  },
  {
    name: "create_comment",
    summary: "Comment on a Linear issue",
    description: "Adds a markdown comment to an issue thread.",
    tags: ["comment", "issue"],
  },
  {
    name: "list_cycles",
    summary: "List sprint cycles for a team",
    description: "Returns active, upcoming, and completed cycles with start and end dates and scope.",
    tags: ["cycle", "sprint", "planning"],
  },
  {
    name: "create_project",
    summary: "Create a Linear project",
    description: "Creates a project with a target date, a lead, and member teams.",
    tags: ["project", "planning"],
  },
  {
    name: "list_teams",
    summary: "List Linear teams in the workspace",
    description: "Returns every team with its key, name, and membership count.",
    tags: ["team", "workspace"],
  },
]);

const slack = actions("slack", "untrusted", [
  {
    name: "post_message",
    summary: "Send a message to a Slack channel",
    description:
      "Posts a message to a public or private channel, optionally as a threaded reply or with block-kit formatting.",
    tags: ["chat", "message", "send", "notify"],
  },
  {
    name: "reply_in_thread",
    summary: "Reply to a Slack thread",
    description: "Posts a message as a reply under an existing parent message in a channel.",
    tags: ["chat", "thread", "reply"],
  },
  {
    name: "search_messages",
    summary: "Search Slack message history",
    description:
      "Full-text search across channels the authenticated user can read, with from, in, and date qualifiers.",
    tags: ["chat", "search", "history"],
  },
  {
    name: "list_channels",
    summary: "List Slack channels in the workspace",
    description: "Returns public channels, plus private channels the user belongs to, with topic and member count.",
    tags: ["chat", "channel", "workspace"],
  },
  {
    name: "upload_file",
    summary: "Upload a file to a Slack channel",
    description: "Shares a file or snippet into one or more channels with an optional initial comment.",
    tags: ["chat", "file", "upload", "share"],
  },
  {
    name: "add_reaction",
    summary: "Add an emoji reaction to a Slack message",
    description: "Attaches an emoji reaction to a specific message by channel and timestamp.",
    tags: ["chat", "emoji", "reaction"],
  },
  {
    name: "set_status",
    summary: "Set the Slack status for the current user",
    description: "Updates the user's status emoji, status text, and optional expiry.",
    tags: ["profile", "status", "presence"],
  },
  {
    name: "list_users",
    summary: "List members of the Slack workspace",
    description: "Returns workspace members with display name, email, timezone, and bot flag.",
    tags: ["users", "directory", "workspace"],
  },
]);

const aws = actions("aws", "untrusted", [
  {
    name: "s3_list_objects",
    summary: "List objects in an S3 bucket",
    description: "Lists keys under a prefix in an S3 bucket, with size and last-modified timestamps.",
    tags: ["s3", "storage", "bucket"],
  },
  {
    name: "s3_get_object",
    summary: "Download an object from S3",
    description: "Retrieves the body of an S3 object by bucket and key.",
    tags: ["s3", "storage", "download"],
  },
  {
    name: "s3_put_object",
    summary: "Upload an object to an S3 bucket",
    description: "Writes bytes to a bucket and key with optional content type and server-side encryption.",
    tags: ["s3", "storage", "upload"],
  },
  {
    name: "ec2_describe_instances",
    summary: "Describe EC2 instances",
    description: "Returns EC2 virtual machines with instance type, state, availability zone, and tags.",
    tags: ["ec2", "compute", "vm", "instance"],
  },
  {
    name: "ec2_stop_instances",
    summary: "Stop running EC2 instances",
    description: "Stops one or more EC2 instances by instance id. Stopped instances retain their EBS volumes.",
    tags: ["ec2", "compute", "shutdown"],
  },
  {
    name: "lambda_invoke",
    summary: "Invoke an AWS Lambda function",
    description: "Calls a Lambda function synchronously or asynchronously with a JSON payload.",
    tags: ["lambda", "serverless", "function"],
  },
  {
    name: "lambda_list_functions",
    summary: "List AWS Lambda functions",
    description: "Returns deployed Lambda functions with runtime, memory size, and last modified date.",
    tags: ["lambda", "serverless", "function"],
  },
  {
    name: "cloudwatch_get_log_events",
    summary: "Read CloudWatch log events",
    description:
      "Fetches log lines from a CloudWatch log stream within a time range, for debugging production incidents.",
    tags: ["cloudwatch", "logs", "observability"],
  },
  {
    name: "cloudwatch_get_metric_statistics",
    summary: "Query CloudWatch metric statistics",
    description: "Returns aggregated metric datapoints such as CPU utilization or error count over a period.",
    tags: ["cloudwatch", "metrics", "observability"],
  },
  {
    name: "iam_list_roles",
    summary: "List IAM roles in the account",
    description: "Returns IAM roles with their trust policies and attached managed policies.",
    tags: ["iam", "security", "permissions"],
  },
  {
    name: "dynamodb_query",
    summary: "Query a DynamoDB table",
    description: "Runs a key-condition query against a table or secondary index and returns matching items.",
    tags: ["dynamodb", "nosql"],
  },
  {
    name: "sqs_send_message",
    summary: "Send a message to an SQS queue",
    description: "Enqueues a message onto a standard or FIFO SQS queue with an optional delay.",
    tags: ["sqs", "queue"],
  },
]);

const filesystem = actions("filesystem", "trusted", [
  {
    name: "read_file",
    summary: "Read the contents of a file on disk",
    description: "Returns the UTF-8 contents of a local file within an allowed root directory.",
    tags: ["file", "local", "disk"],
  },
  {
    name: "write_file",
    summary: "Write contents to a file on disk",
    description: "Creates or overwrites a local file with the provided contents.",
    tags: ["file", "save", "local"],
  },
  {
    name: "edit_file",
    summary: "Apply a targeted edit to a local file",
    description: "Replaces an exact string within a file, leaving the rest of the file untouched.",
    tags: ["file", "patch", "replace"],
  },
  {
    name: "list_directory",
    summary: "List entries in a local directory",
    description: "Returns file and subdirectory names within a directory, without recursing.",
    tags: ["directory", "folder", "ls"],
  },
  {
    name: "search_files",
    summary: "Find local files matching a glob pattern",
    description: "Recursively finds files whose paths match a glob pattern under a root directory.",
    tags: ["file", "find", "glob"],
  },
  {
    name: "move_file",
    summary: "Move or rename a file on disk",
    description: "Renames a file or relocates it into a different directory.",
    tags: ["file", "rename"],
  },
  {
    name: "get_file_info",
    summary: "Get metadata about a local file",
    description: "Returns size, permissions, and modification time for a file or directory.",
    tags: ["file", "stat", "metadata"],
  },
  {
    name: "create_directory",
    summary: "Create a directory on disk",
    description: "Creates a directory, including any missing parent directories.",
    tags: ["directory", "folder", "mkdir"],
  },
]);

const postgres = actions("postgres", "untrusted", [
  {
    name: "run_query",
    summary: "Run a read-only SQL query against Postgres",
    description: "Executes a SELECT statement and returns rows. Write statements are rejected.",
    tags: ["sql", "database", "select"],
  },
  {
    name: "list_tables",
    summary: "List tables in the Postgres database",
    description: "Returns table names per schema, with estimated row counts.",
    tags: ["sql", "database", "schema"],
  },
  {
    name: "describe_table",
    summary: "Describe the columns of a Postgres table",
    description: "Returns column names, data types, nullability, defaults, and indexes for a table.",
    tags: ["sql", "database", "schema", "columns"],
  },
  {
    name: "explain_query",
    summary: "Show the Postgres query plan for a statement",
    description: "Runs EXPLAIN ANALYZE and returns planner output for diagnosing slow queries.",
    tags: ["sql", "database", "performance", "plan"],
  },
]);

const sentry = actions("sentry", "trusted", [
  {
    name: "list_issues",
    summary: "List unresolved Sentry error groups",
    description: "Returns error groups for a project ordered by event count, with culprit and last-seen time.",
    tags: ["errors", "exceptions", "crash", "monitoring"],
  },
  {
    name: "get_issue_events",
    summary: "Get individual error events for a Sentry issue",
    description: "Returns raw events with stack traces, breadcrumbs, and request context.",
    tags: ["errors", "stacktrace", "exception"],
  },
  {
    name: "resolve_issue",
    summary: "Mark a Sentry issue as resolved",
    description: "Resolves an error group, optionally in the next release.",
    tags: ["errors", "triage"],
  },
  {
    name: "list_releases",
    summary: "List releases tracked by Sentry",
    description: "Returns releases with associated commits, deploy times, and new-issue counts.",
    tags: ["release", "deploy", "monitoring"],
  },
]);

const stripe = actions("stripe", "untrusted", [
  {
    name: "create_refund",
    summary: "Refund a Stripe payment",
    description: "Issues a full or partial refund against a charge or payment intent.",
    tags: ["payments", "refund", "billing", "money"],
  },
  {
    name: "list_charges",
    summary: "List Stripe charges",
    description: "Returns charges filtered by customer, date range, or status.",
    tags: ["payments", "charges", "billing"],
  },
  {
    name: "retrieve_customer",
    summary: "Retrieve a Stripe customer record",
    description: "Fetches a customer by id, including default payment method and metadata.",
    tags: ["payments", "customer", "billing"],
  },
  {
    name: "list_subscriptions",
    summary: "List Stripe subscriptions",
    description: "Returns active, trialing, and canceled subscriptions with plan and billing interval.",
    tags: ["payments", "subscription", "billing", "recurring"],
  },
  {
    name: "create_invoice",
    summary: "Create a Stripe invoice",
    description: "Drafts an invoice for a customer with line items and a due date.",
    tags: ["payments", "invoice", "billing"],
  },
]);

const notion = actions("notion", "untrusted", [
  {
    name: "search",
    summary: "Search Notion pages and databases",
    description: "Full-text search across the workspace, returning pages and databases the integration can access.",
    tags: ["docs", "notes", "wiki"],
  },
  {
    name: "create_page",
    summary: "Create a Notion page",
    description: "Creates a page under a parent page or database with rich-text block content.",
    tags: ["docs", "notes", "page"],
  },
  {
    name: "append_block_children",
    summary: "Append blocks to a Notion page",
    description: "Adds paragraphs, headings, lists, or code blocks to the end of an existing page.",
    tags: ["docs", "notes", "blocks"],
  },
  {
    name: "query_database",
    summary: "Query a Notion database",
    description: "Filters and sorts rows in a Notion database and returns matching page properties.",
    tags: ["docs", "table"],
  },
]);

const gdrive = actions("gdrive", "untrusted", [
  {
    name: "search_files",
    summary: "Search files in Google Drive",
    description: "Finds Drive files by name, full-text content, mime type, or owner.",
    tags: ["drive", "docs", "cloud"],
  },
  {
    name: "read_document",
    summary: "Read the text of a Google Doc",
    description: "Exports a Google Doc as plain text or markdown for summarization.",
    tags: ["drive", "docs"],
  },
  {
    name: "create_spreadsheet",
    summary: "Create a Google Sheets spreadsheet",
    description: "Creates a new spreadsheet with named sheets and an optional header row.",
    tags: ["drive", "sheets", "spreadsheet"],
  },
  {
    name: "append_sheet_rows",
    summary: "Append rows to a Google Sheet",
    description: "Adds rows to the end of a sheet range, growing the sheet as needed.",
    tags: ["drive", "sheets", "spreadsheet", "rows"],
  },
]);

const kubernetes = actions("kubernetes", "untrusted", [
  {
    name: "list_pods",
    summary: "List pods in a Kubernetes namespace",
    description: "Returns pods with phase, restart count, node, and readiness.",
    tags: ["k8s", "cluster", "containers"],
  },
  {
    name: "get_pod_logs",
    summary: "Get logs from a Kubernetes pod",
    description: "Streams container logs from a pod, optionally from a previous crashed container.",
    tags: ["k8s", "logs", "containers"],
  },
  {
    name: "describe_deployment",
    summary: "Describe a Kubernetes deployment",
    description: "Returns replica counts, rollout status, strategy, and pod template for a deployment.",
    tags: ["k8s", "rollout"],
  },
  {
    name: "restart_deployment",
    summary: "Restart a Kubernetes deployment",
    description: "Triggers a rolling restart of every pod in a deployment without changing its spec.",
    tags: ["k8s", "rollout", "bounce"],
  },
  {
    name: "scale_deployment",
    summary: "Scale a Kubernetes deployment",
    description: "Sets the desired replica count for a deployment.",
    tags: ["k8s", "replicas"],
  },
]);

const jira = actions("jira", "untrusted", [
  {
    name: "create_issue",
    summary: "Create a Jira issue",
    description: "Creates a Jira issue of a given type in a project, with summary, description, and priority.",
    tags: ["issue", "ticket", "tracking", "atlassian"],
  },
  {
    name: "transition_issue",
    summary: "Move a Jira issue to another workflow status",
    description: "Applies a workflow transition, for example from In Progress to Done.",
    tags: ["issue", "ticket", "status", "workflow"],
  },
  {
    name: "search_jql",
    summary: "Search Jira issues with JQL",
    description: "Runs a Jira Query Language expression and returns matching issues.",
    tags: ["issue", "jql", "atlassian"],
  },
]);

const pagerduty = actions("pagerduty", "trusted", [
  {
    name: "list_incidents",
    summary: "List PagerDuty incidents",
    description: "Returns triggered, acknowledged, and resolved incidents for a service.",
    tags: ["oncall", "incident", "alerting"],
  },
  {
    name: "acknowledge_incident",
    summary: "Acknowledge a PagerDuty incident",
    description: "Acknowledges an incident so it stops escalating to the next responder.",
    tags: ["oncall", "incident", "ack"],
  },
  {
    name: "get_oncall_schedule",
    summary: "Look up who is currently on call",
    description: "Returns the current and upcoming on-call responders for an escalation policy.",
    tags: ["oncall", "schedule", "rotation"],
  },
]);

const browser = actions("browser", "untrusted", [
  {
    name: "navigate",
    summary: "Navigate the browser to a URL",
    description: "Loads a page in the controlled browser and waits for it to settle.",
    tags: ["web", "browser", "url"],
  },
  {
    name: "take_screenshot",
    summary: "Take a screenshot of the current page",
    description: "Captures the visible viewport or the full page as a PNG image.",
    tags: ["web", "browser", "image"],
  },
  {
    name: "click_element",
    summary: "Click an element on the page",
    description: "Clicks a page element identified by an accessibility-tree reference.",
    tags: ["web", "browser", "interact"],
  },
  {
    name: "fetch_url",
    summary: "Fetch a URL and return its content as markdown",
    description: "Retrieves a web page over HTTP and converts the HTML into readable markdown.",
    tags: ["web", "http", "scrape", "markdown"],
  },
]);

const skills = actions("skills", "trusted", [
  {
    name: "code-review",
    summary: "Guide a thorough code review of a diff",
    description:
      "A skill that walks through reviewing a change set for correctness, security, and test coverage before approving.",
    tags: ["review", "quality"],
    kind: "skill",
  },
  {
    name: "incident-response",
    summary: "Run a production incident from detection to postmortem",
    description:
      "A skill covering triage, comms, mitigation, and writing the postmortem after a production outage.",
    tags: ["incident", "outage", "oncall", "postmortem"],
    kind: "skill",
  },
  {
    name: "release-checklist",
    summary: "Prepare and ship a versioned release",
    description:
      "A skill covering changelog generation, version bumping, tagging, and post-release verification.",
    tags: ["release", "ship", "version", "changelog"],
    kind: "skill",
  },
  {
    name: "sql-optimization",
    summary: "Diagnose and speed up a slow SQL query",
    description: "A skill for reading query plans, spotting missing indexes, and rewriting inefficient joins.",
    tags: ["sql", "performance", "tuning"],
    kind: "skill",
  },
]);

export const EVAL_CORPUS: readonly ActionRecord[] = Object.freeze([
  ...github,
  ...linear,
  ...slack,
  ...aws,
  ...filesystem,
  ...postgres,
  ...sentry,
  ...stripe,
  ...notion,
  ...gdrive,
  ...kubernetes,
  ...jira,
  ...pagerduty,
  ...browser,
  ...skills,
]);
