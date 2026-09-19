**Yes. All three findings are closed, and the campaign is done at `105ca0d`. Verdict: clean.**

I confirmed that local-ref dependence is removed, exceptions are document-scoped, and the control exercises the real extraction path. The narrowed histogram wording is correct.

Independently running the focused suite gave **7 tests passing**. In-memory mutations produced **2 / 3 / 1 / 4 failures** for disabled extraction, removed repository roots, global exceptions, and an always-true resolver.

**Twenty-five scoped pairs are a reasonable standing cost**, not evidence of miscalibration. They describe understandable exceptions: generated outputs, prospective artifacts, retained experiments and historical quotations. Deriving candidates mechanically and reviewing their reasons is appropriate; generating exemptions automatically would undermine the check.

No further review round is needed. No edits, `./test.sh`, or push performed.