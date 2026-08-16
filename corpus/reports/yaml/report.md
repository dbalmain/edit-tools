# YAML package report (stage C)

```
gate 1 idempotence      pass   (32/32)
gate 2 width            pass   (13 overflow lines; prettier 20)
gate 3 non-destruction  pass   (method: default)
gate 4 agreement        6/16 @ width 80,  4/16 @ width 40   (10/32)
rust/js parity          identical
refusals                none
size                    package 798 B gzip; runtime 9315 B gzip; delta vs main 0
```

`packages/yaml.json` is 22 rules, no runtime edit. `comment_gap` 1 and `blank_cap` 1 are prettier's answers, set explicitly. Indent is 2.

Matching pairs: `blank_lines`, `documents`, `flow_mapping`, `scalars` at both widths; `keys` and `nested` at 80.

## Divergences

Every pair below is unreviewed. The stage-D reviewer records verdicts.

- `yaml/anchors.yaml@80` `9a307b9c9c9c033895572fea55e59b32962a01a017f636b02162d89a039afc16` — **design limit**. `block_node` is both the document body and a pair value. The pair hard-breaks before a block value so the root stays at column 0 and a suffix comment on `:` can flush; that puts `&def` on the next line and keeps the following own-line comments inside the previous nested mapping (entries 10 and 9).
- `yaml/anchors.yaml@40` `3db9a9a1b99b2064d2d0b650107dcbfa291a8ed06b6e45039b6e236e1ae7616e` — **design limit**. Same. The flow mapping on `pair` still follows prettier's pair-then-items break.
- `yaml/block_collections.yaml@80` `9faf84e2ade313a2863bcc2f0461ee0eab9f666aa01d4de7cd2c069183f06158` — **design limit**. tree-sitter attaches the section comments to the previous nested mapping or sequence; we emit them at that indent. Prettier puts them at the parent mapping's column (entry 9).
- `yaml/block_collections.yaml@40` `9faf84e2ade313a2863bcc2f0461ee0eab9f666aa01d4de7cd2c069183f06158` — **design limit**. Same pair, width-insensitive.
- `yaml/block_scalars.yaml@80` `7370ad5f118a6050b3d8e79bac0905521f1931010260710497d8963dd9764d5e` — **design limit**. `key: |` becomes `key:\n  |` because the pair must hard-break before a `block_node` (entry 10). `|+` keep-chomping leaves two blank lines in the source gap between pairs; `blank 1` caps them and a rule cannot see the previous indicator.
- `yaml/block_scalars.yaml@40` `7370ad5f118a6050b3d8e79bac0905521f1931010260710497d8963dd9764d5e` — **design limit**. Same pair, width-insensitive.
- `yaml/comments.yaml@80` `d3b62502511421133a5b9cd0b2e3df2363f6b9eb9c0dcd948e2daf8b12d8b0b2` — **design limit**. A comment after `[` stays a suffix of `[`; prettier moves it onto the next line. Own-line comments after the last sequence item stay inside the sequence and inherit its indent (entry 9).
- `yaml/comments.yaml@40` `4b9fc84101aae863b5543985076aa76e98f811b210b0002417449829f5d2b647` — **design limit**. Same, plus entry 6: `fits` counts a trailing comment, so `host: localhost # …` and `listen_address: 0.0.0.0 # …` break. Prettier overruns.
- `yaml/flow_sequence.yaml@80` `4ca593dcfaa6aaf6193569e329fc42f5297d1aaef3546ae04d9b12925ed4ade8` — **design limit**. `already_broken` has a source trailing comma; `trail` pins the group open (entry 3). Prettier collapses a fitting collection anyway. Dropping `trail` would lose the trailing comma on every width-broken collection, including the matching `flow_mapping` pairs.
- `yaml/flow_sequence.yaml@40` `f5d8702e9ce70c1abafb6b463508470c346427a277c8333e89ab953c56cb1f6e` — **design limit**. Same pin on `already_broken`; the rest of the file matches prettier's one-item-per-line break.
- `yaml/keys.yaml@40` `87dcb64cf3bb623606fdd3bfa7bba6d146a62ec4b639efae62954fea66597a0a` — **design limit**. Entry 6: a trailing comment forces the pair group to break (`dashed-key`, `"true"`).
- `yaml/kitchen.yaml@80` `30bbe5f38a1bc6f3a9bc9df8f5096608096851e6357dbea596fd0a150d331d59` — **design limit**. `primary: &origin` and `format: |` move to the next line (entry 10). The trailing file comment is attached inside the last mapping (entry 9).
- `yaml/kitchen.yaml@40` `78b4eb5f56811ddb88b4dc84a765b32a4c6f0f706cfa0e474216b932274c307f` — **design limit**. Same, plus entry 6 on `listen: {…} # comment`, plus the pair group breaking long URL scalars (a `flow_node` value cannot be tested for "is a collection").
- `yaml/nested.yaml@40` `3e9049df64f9b41b7d1927bc7ebe70009e835b06b070b43b08cf099c05468377` — **design limit**. Entry 6: `{ ok: 1 } # tiny` is broken because the trailing comment counts. Nested collections that fit without a comment stay flat, which is the constructed case.
- `yaml/normalisation.yaml@80` `3f6373d135952e41b00ead155d1e95e8210c6ff3a8fef3842855c4416d31fa4c` — **design limit**. The explicit `?` is kept as `?\nkey\n: value` (one-line `? key: value` re-parses as a nested mapping and fails gate 3); prettier deletes the anonymous `?` (entry 4, the measured unwinnable). `trailing: [1, 2, 3,]` is pinned open (entry 3). Section comments inherit nested indent (entry 9).
- `yaml/normalisation.yaml@40` `3f6373d135952e41b00ead155d1e95e8210c6ff3a8fef3842855c4416d31fa4c` — **design limit**. Same pair, width-insensitive.
- `yaml/spelling.yaml@80` `64b11e51ad5b89212ebc91316d70a994efd9a339349ffee3f81c822131bc274c` — **design limit**. One section comment is attached inside the previous sequence (entry 9). Block vs flow spellings are otherwise preserved.
- `yaml/spelling.yaml@40` `1972b399e495d8dfe6c69f8b938807f616362bd3d5ade416bcc7ac75e984ef5e` — **design limit**. Same comment, plus the long flow list breaks one item per line the way prettier does.
- `yaml/strings.yaml@80` `16e911aa96102e7d0beaa8bfc6766538a8300c05bd52e9fd8b95b82f40cbd362` — **design limit**. The pair group that implements pair-breaks-first for flow collections also breaks `long_double`. A rule cannot ask whether a `flow_node` is a collection. Prettier never wraps scalars. Chosen: keep the group; it is why `flow_mapping` matches at both widths.
- `yaml/strings.yaml@40` `b85bf1f44ee1094fc57a8fdfb4df256d535ea582530459e1a6087608e1ea3b3d` — **design limit**. Same, plus `escaped` and `astral`.
- `yaml/tags.yaml@80` `7b93d4e1f2ece0b1a823e5cf11dd553ee1b47f85ad3148090ea349904c538586` — **design limit**. `tagged_block: !!str |` moves to the next line (entry 10).
- `yaml/tags.yaml@40` `273857fa082a4133b22f27b0a46af99b11a4983561a4232b14fee1d14436689d` — **design limit**. Same, plus entry 6 on `as_string: !!str 123 # still looks like a number`.

All of these were noticed and classified. None is a remaining package bug I would still write a rule for.

## Runtime edits

None shipped. Runtime gzip is 9315 B, delta vs `main` is 0.

I implemented `["parent", "type"]` in both runtimes, used it so a `block_node` under a pair could keep `&anchor` / `|` on the key line, and reverted it. The construct that seemed to force it is `block_node` as both document body and pair value (entry 10). What actually happened: with the prefix on the key line there is no hard before the value, so a lead comment between `:` and the `block_node` prints as `server:# comment` (entry 9). `descend` on `block_node` then indented comments after `---` and glued them to the first pair (`# First document.name: one`). Parent and descend each fix one side and break the other. A package-level workaround that special-cases one corpus file is the trade the house-style note forbids. The missing capability is not parent alone — it is a hanging block value that can flush colon comments without stealing the prefix's line.

No second house-style constant turned up. `comment_gap` 1 and `blank_cap` 1 are prettier's defaults.

## Harness edits

None outside `harness/languages/yaml.toml` (untouched this slice).

## What was hardest, and one ask

The hard part is not flow collections. `flow_mapping` matches at both widths with the IR's two-level group: the pair breaks first (`key:\n  { … }`), then the mapping. Nested containers that fit stay flat. Prettier does not convert block ↔ flow.

The hard part is `block_node`. It is the document root (must not indent), a pair value (must hang, and `key: &a` / `key: |` want the prefix on the key line), and a sequence item (must stay on the dash line for `- - item`). Comments between `:` and that node have to flush onto the key line. Those three sites are one node type. Count cannot tell them apart. Parent can, and is still not enough, because decorate emits lead comments before the rule runs.

If I could ask for one thing: a hanging-value form whose first same-line prefix (`&a`, `!!str`, `|`) stays after the colon, whose collection starts on the next line at +indent, and whose lead comments land on that next line rather than before the prefix. That is one YAML construct, not three opcodes.

## Entry 7 — comment-forced vs width-forced

A rule cannot distinguish them. Confirmed, and the confirmation is a negative on layout: prettier's *broken* flow collection is the same shape either way — brackets on their own lines, one item per line, trailing comma. `comments.yaml` (comment-pinned) and `flow_sequence.yaml` `long` (width-pinned) agree on that shape. What differs is *whether* the collection breaks: an interior comment emits `BreakParent` and pins it (we do this); a trailing comment on the pair does not make prettier break the collection (entry 6, we cannot). Stage B's "different layout depending on why" is those two decisions, not a third broken layout.

## The `fill` question

YAML flow collections do not want `fill`. When they break, prettier writes one item per line. Files that show it: `flow_sequence`, `flow_mapping`, `nested`, `kitchen`, `spelling`. None packs several items onto a continuation line. A third language that wanted `fill` would have been useful; this is a clean negative.

## Template delta

The brief said pair-breaks-first "expresses directly" and that is true for flow collections — `flow_mapping` is 2/2. It was easy to read as "YAML's width problem is solved by two-level groups." The width problem is the small half. The structural problem is `block_node` plus colon comments, which the brief's stage-B facts did not name as the thing that would dominate the score.

Entry 4's omitted quote rewrites and block-scalar reindents did not mislead; they are not in the corpus and I did not try to reproduce them.

## Package shape, briefly

Flow sequences are JSON arrays (`soft` inside the brackets, no padding). Flow mappings are JSON objects (`line` inside the braces, padded). Empty containers are `[]` / `{}`. Block collections never become flow. Quoted scalars and block scalars are `verbatim` because their interiors are untokenised gaps. Directives are `verbatim` because `%YAML` / `%TAG` are untokenised prefixes. An explicit `?` stays, on its own line, because `? key: value` is a different tree.
