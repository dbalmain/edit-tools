# A2.2 emphasis projection — running done-note

## Established before implementation

The proposed shape is consistent with the design but still needs to be checked
against the pinned reference: emphasis and strong emphasis must not be protected
whole. Their grammar-confirmed interior ASCII spaces and newlines become
candidate gaps, while each opening delimiter stays in the atom to its right and
each closing delimiter stays in the atom to its left. Nested emphasis therefore
needs a recursive range classification, not membership in the A2.1 protected
set.

The brief's documentation premise is stale at base commit `3c296d1`.
`docs/prose-projection.md` no longer leaves the A2.1 coalescing contradiction
open: it records a 19 September resolution in favour of coalescing and the
implementation already performs bilateral protection in `_block_safe`.
A2.2 inherits that one policy; it will not add a second coalescing mechanism.

## Still to establish

- Check the real emphasis-across-a-wrap-point case against Prettier 3.9.6.
- Re-walk the block-hazard closure for `*` and `_`, including nested and strong
  delimiter runs, and record whether `_ACQUIRES` plus delimiter attachment is
  sufficient.
- Add discriminating admitted/refused fixtures and mirror the implementation in
  Python and JavaScript.
- Run the live ceiling before and after the change and report the implemented
  eligibility against the priced increment of 1,547 paragraphs.
- Run the focused probe, at least 273 harness tests, and the full zero-warning
  `./test.sh` gate before the final commit.
