# Ledger

Three running records. The orchestrator writes all of them.

## 1. Runtime changes

Dave's rule: builders may edit `rust/` and `runtime-js/` freely; the reviewer
judges after the fact and may recommend a freeze. Every edit lands here.

| #   | Language | Agent | Change | Case made | Reviewer verdict | gzip Δ | Merged |
| --- | -------- | ----- | ------ | --------- | ---------------- | ------ | ------ |
|     |          |       |        |           |                  |        |        |

**Freeze status:** open. _(A stage-D reviewer may recommend closing this. If it
does, record the recommendation, the language that prompted it, and Dave's
decision.)_

Baseline at the start of the exercise: **10,196 B gzip = 8,080 runtime + 2,116
packages** (python + json), against a 20 KB budget. After any runtime change
merges, re-score every already-merged language before the next round launches.

## 2. Template revisions

Every stage-B and stage-D review ends with a template delta. Applied deltas go
here, so the templates have a history and a repeated complaint is visible as a
pattern.

| Date | Template | Change | Prompted by |
| ---- | -------- | ------ | ----------- |
|      |          |        |             |

## 3. Model scorecard

The comparison Dave asked for. One row per attempt, not per language — an
escalation adds a row.

| Language | Agent | Stage | Wall-clock | Verdict | Gate 4 | Runtime edits | Gates honest? | Done-note | Notes |
| -------- | ----- | ----- | ---------- | ------- | ------ | ------------- | ------------- | --------- | ----- |
|          |       |       |            |         |        |               |               |           |       |

Columns worth being precise about:

- **Gates honest?** — did a claimed-green gate turn out to be green. The single
  most important number about a cheap model. One dishonest gate claim changes
  how every later result from that model must be treated.
- **Done-note** — did it describe what actually happened, including its own
  divergences and things it could not do. Grok's proactive self-flagging is the
  benchmark to compare against.
- **Runtime edits** — count, and how many the reviewer called `warranted`. A
  model that reaches for the runtime when a package expression would do is
  telling you something about its judgement.

### Agents under comparison

| Agent           | CLI        | Model                         | Lane                |
| --------------- | ---------- | ----------------------------- | ------------------- |
| grok            | `grok`     | `grok-4.6` (default)          | builder             |
| codex-Luna      | `codex`    | `gpt-5.6-luna`                | builder             |
| DeepSeek V4 Pro | `opencode` | `opencode-go/deepseek-v4-pro` | builder             |
| codex-Sol       | `codex`    | `gpt-5.6-sol`, effort `high`  | escalation (step 5) |
| Opus subagent   | Agent tool | Opus                          | escalation (step 6) |

Only grok has prior calibration data, and it is on `grok-4.5`, not the `4.6`
default. Luna and DeepSeek are uncalibrated. Round 1 is a deliberate
head-to-head on TOML precisely because of that.

### Where the findings go at the end

Per the playbook's own split:

- **General lessons about driving cheap models** — prompt shapes that work, ways
  a cheap model fails that an expensive one does not, monitoring surprises →
  `~/.claude/agent-playbook.md`.
- **The per-model table above** — stays here and in project memory. It is
  calibration data, not a general lesson, and it goes stale.
