/**
 * Labeled retrieval queries over `EVAL_CORPUS`.
 *
 * Each case is one natural-language query and the single action id a competent
 * agent should land on. Cases are grouped into difficulty bands so a report can
 * show *where* quality moved, not just that it moved:
 *
 * - `exact`      the query names the action almost verbatim; failing here is a
 *                tokenizer or weighting bug
 * - `paraphrase` ordinary intent phrased in user language, with no shared rare
 *                token guaranteed
 * - `ambiguous`  several servers offer a plausible action and only one word in
 *                the query disambiguates; these are the cases that regress
 *                first when ranking changes
 *
 * `note` records *why* a case is interesting, so a future failure is
 * debuggable without re-deriving the intent.
 */

export type EvalDifficulty = "exact" | "paraphrase" | "ambiguous";

export interface EvalCase {
  query: string;
  /** The single correct action id in `EVAL_CORPUS`. */
  expected: string;
  difficulty: EvalDifficulty;
  note?: string;
}

export const EVAL_QUERIES: readonly EvalCase[] = Object.freeze([
  // --- exact / near-exact name matches -----------------------------------
  {
    query: "create pull request",
    expected: "github:create_pull_request",
    difficulty: "exact",
    note: "Competes with list_pull_requests, merge_pull_request, and the review action.",
  },
  {
    query: "merge pull request",
    expected: "github:merge_pull_request",
    difficulty: "exact",
  },
  {
    query: "get pull request diff",
    expected: "github:get_pull_request_diff",
    difficulty: "exact",
  },
  {
    query: "list workflow runs",
    expected: "github:list_workflow_runs",
    difficulty: "exact",
  },
  {
    query: "search code",
    expected: "github:search_code",
    difficulty: "exact",
    note: "Must beat filesystem:search_files and gdrive:search_files.",
  },
  {
    query: "createBranch",
    expected: "github:create_branch",
    difficulty: "exact",
    note: "camelCase form of a snake_case upstream name; exercises the tokenizer.",
  },
  {
    query: "s3 list objects",
    expected: "aws:s3_list_objects",
    difficulty: "exact",
  },
  {
    query: "lambda invoke",
    expected: "aws:lambda_invoke",
    difficulty: "exact",
  },
  {
    query: "scale deployment",
    expected: "kubernetes:scale_deployment",
    difficulty: "exact",
    note: "Three deployment actions in the same server.",
  },
  {
    query: "describe table",
    expected: "postgres:describe_table",
    difficulty: "exact",
  },
  {
    query: "add reaction",
    expected: "slack:add_reaction",
    difficulty: "exact",
  },
  {
    query: "explain query",
    expected: "postgres:explain_query",
    difficulty: "exact",
    note: "Competes with run_query, dynamodb_query, and query_database.",
  },

  // --- paraphrases -------------------------------------------------------
  {
    query: "open a PR for my branch",
    expected: "github:create_pull_request",
    difficulty: "paraphrase",
    note: "\"open\" and \"PR\" never appear as a name token; relies on tags and summary.",
  },
  {
    query: "leave a comment on a github issue",
    expected: "github:add_issue_comment",
    difficulty: "paraphrase",
    note: "\"comment\" also matches linear:create_comment; the server name should decide.",
  },
  {
    query: "why did CI fail on my build",
    expected: "github:get_workflow_run_logs",
    difficulty: "paraphrase",
    note: "No name token overlaps at all; must come from the description.",
  },
  {
    query: "cut a new version and publish it",
    expected: "github:create_release",
    difficulty: "paraphrase",
    note: "Competes with the release-checklist skill and sentry:list_releases.",
  },
  {
    query: "what am I supposed to be working on",
    expected: "linear:list_my_issues",
    difficulty: "paraphrase",
  },
  {
    query: "move a ticket to done",
    expected: "jira:transition_issue",
    difficulty: "paraphrase",
    note: "\"ticket\" is a tag on both linear and jira issue actions.",
  },
  {
    query: "notify the team in chat",
    expected: "slack:post_message",
    difficulty: "paraphrase",
  },
  {
    query: "give a customer their money back",
    expected: "stripe:create_refund",
    difficulty: "paraphrase",
    note: "\"customer\" pulls hard toward retrieve_customer; \"money back\" must win.",
  },
  {
    query: "turn off a virtual machine",
    expected: "aws:ec2_stop_instances",
    difficulty: "paraphrase",
  },
  {
    query: "who is on call right now",
    expected: "pagerduty:get_oncall_schedule",
    difficulty: "paraphrase",
  },
  {
    query: "grab a webpage as markdown",
    expected: "browser:fetch_url",
    difficulty: "paraphrase",
  },
  {
    query: "change one line in a local file",
    expected: "filesystem:edit_file",
    difficulty: "paraphrase",
    note: "read_file and write_file share the dominant token.",
  },
  {
    query: "add rows to a spreadsheet",
    expected: "gdrive:append_sheet_rows",
    difficulty: "paraphrase",
    note: "create_spreadsheet shares 'spreadsheet'; 'rows' is the only separator.",
  },
  {
    query: "bounce the pods without changing config",
    expected: "kubernetes:restart_deployment",
    difficulty: "paraphrase",
  },
  {
    query: "see the stack trace for a crash",
    expected: "sentry:get_issue_events",
    difficulty: "paraphrase",
  },
  {
    query: "how do I make this slow query faster",
    expected: "skills:sql-optimization",
    difficulty: "paraphrase",
    note: "A skill must be able to outrank postgres:explain_query on advice-shaped intent.",
  },

  // --- genuinely ambiguous ----------------------------------------------
  {
    query: "create an issue in Linear",
    expected: "linear:create_issue",
    difficulty: "ambiguous",
    note: "Three servers expose create_issue; only the server token disambiguates.",
  },
  {
    query: "file a bug in the github repo",
    expected: "github:create_issue",
    difficulty: "ambiguous",
    note: "Same name collision, resolved from the other direction.",
  },
  {
    query: "raise a jira ticket",
    expected: "jira:create_issue",
    difficulty: "ambiguous",
  },
  {
    query: "search my notes and docs",
    expected: "notion:search",
    difficulty: "ambiguous",
    note: "Competes with gdrive:search_files and gdrive:read_document.",
  },
  {
    query: "find a file by glob on disk",
    expected: "filesystem:search_files",
    difficulty: "ambiguous",
    note: "Name-identical to gdrive:search_files.",
  },
  {
    query: "search files in google drive",
    expected: "gdrive:search_files",
    difficulty: "ambiguous",
    note: "The mirror image of the previous case; both must resolve correctly.",
  },
  {
    query: "read application logs to debug an error",
    expected: "aws:cloudwatch_get_log_events",
    difficulty: "ambiguous",
    note: "Competes with kubernetes:get_pod_logs and github:get_workflow_run_logs.",
  },
  {
    query: "get container logs from the cluster",
    expected: "kubernetes:get_pod_logs",
    difficulty: "ambiguous",
  },
  {
    query: "list the open errors in production",
    expected: "sentry:list_issues",
    difficulty: "ambiguous",
    note: "list_issues exists on github and sentry; 'errors' is the discriminator.",
  },
  {
    query: "upload a file",
    expected: "slack:upload_file",
    difficulty: "ambiguous",
    note: "Deliberately underspecified: aws:s3_put_object is a defensible answer, so this case chiefly measures recall@5 stability.",
  },
  {
    query: "review someone else's changes before approving",
    expected: "skills:code-review",
    difficulty: "ambiguous",
    note: "github:create_pull_request_review is the tool form of the same intent.",
  },
  {
    query: "send a message to a queue",
    expected: "aws:sqs_send_message",
    difficulty: "ambiguous",
    note: "slack:post_message owns 'send a message' in ordinary usage.",
  },
]);
