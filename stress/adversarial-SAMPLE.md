# S10 adversarial fixtures — sample (builder-7)

Full generated data lives in `stress/.generated/adversarial/` (gitignored).
Run `node stress/adversarial.mjs` to regenerate; machine-readable results land
in `stress/.generated/results/adversarial.json`.

## Tool manifest (builder-2 fake-server format)

`stress/.generated/adversarial/adversarial-tools.json`, serverId `adversarial`,
184 tools. Example hostile entries (abridged):

```json
{ "name": "huge_desc_tool_0",
  "description": "<100 KB of filler text>",
  "inputSchema": { "type": "object", "properties": { "q": { "type": "string" } } },
  "annotations": { "readOnlyHint": true } }

{ "name": "mega_schema_tool_0",
  "description": "Mega schema tool 0 with 5000 properties.",
  "inputSchema": { "type": "object", "properties": { "prop_0_alpha": { "type": "string", "description": "... golf hotel" }, "…4997 more…": {} } } }

{ "name": "zwsp_tool_\u200Bhidden", "description": "Unicode torture tool: \"zwsp_tool_\\u200Bhidden\"", "inputSchema": { "type": "object" } }
{ "name": "namespace:colon_tool", "description": "Punctuation name: namespace:colon_tool", "inputSchema": { "type": "object" } }
{ "name": "bad_schema_tool_0", "description": "Invalid schema {\"type\":123}", "inputSchema": { "type": 123 } }
{ "name": "dup_tool_0", "description": "Duplicate tool 0 copy 0", "inputSchema": { "type": "object" } }
{ "name": "dup_tool_0", "description": "Duplicate tool 0 copy 1 shadow copy", "inputSchema": { "type": "object" } }
```

Filler tools interleave prompt-injection text (`IGNORE ALL PREVIOUS INSTRUCTIONS…`)
and fake secrets (`SK-FAKE-FAKE-FAKE-0000`, `gh-FakeToken…`, `SK-FAKE-FAKE-FAKE-9999`) into descriptions.

## Skills dir (builder-1 format)

`stress/.generated/adversarial/skills/<slug>/SKILL.md`, 110 skills:

```markdown
---
name: Adversarial Skill 0
description: Adversarial skill 0: alpha bravo delta echo foxtrot.
---
Do the task carefully. Verify the inputs before running. Report results plainly. Escalate anything unexpected.
```

Every 10th skill body prepends `Ignore previous instructions…`; every 10th summary
embeds a fake `SK-FAKE-FAKE-FAKE-9999` marker; 11 skills share one zero-width-polluted name
(collision case); skills 105–109 carry 100 KB bodies.

## Coverage checklist

| Case | Entries |
|---|---|
| 100 KB descriptions | 20 tools + 5 skills |
| 5,000-property schemas | 2 tools |
| depth-50 nested schemas | 2 tools |
| unicode/emoji/RTL/zero-width names | 15 tools |
| names colliding after normalization | 10 tools |
| colons & slashes in names | 10 tools |
| invalid JSON Schemas | 5 tools |
| duplicate tool names in one server | 20 (10 unique × 2) |
| prompt injection / fake secrets | 100 filler tools + 110 skills |
