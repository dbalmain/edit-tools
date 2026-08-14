# Contrib: astral width on a scored fit boundary

The scored corpus never puts a non-ASCII scalar on a group
decision at width **88** or **60**. A planted JS
`widthOf = s.length` (UTF-16) vs rust (`chars().count()`)
diverges only at 74–77 (`python__strings`) and 324–329
(`json__basic`). Gate 1 cannot see the bug the contract
warns about.

These two files close that hole. Each has one `🙂` (one
scalar, two UTF-16 units) on a list/array whose flat form
is exactly the scored width in scalars and one over in
`.length`. Padding was found by search, not by hand.

## `length_boundary.py`

Two lists, independent groups.

| name | scored width | flat scalars | flat UTF-16 |
| --- | ---: | ---: | ---: |
| `probe` | 88 | 88 | 89 |
| `short` | 60 | 60 | 61 |

Correct rust and JS print the same thing at both widths.
With `.length` planted, they do not.

Width 88, planted — rust keeps `probe` flat, JS breaks it:

```
probe = ["🙂", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]
```

```
probe = [
    "🙂",
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
]
```

Width 60, planted — both break `probe` (it is 88 wide);
rust keeps `short` flat, JS breaks it the same way.

## `length_boundary.json`

Top-level array aimed at 88 (flat 88 scalars / 89 UTF-16).
Same verification: correct runtimes agree at 88 and 60;
planted JS breaks the array at 88 and still agrees at 60
(both already broken).

```
["🙂", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]
```

```
[
  "🙂",
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
]
```

## Check

Trees are not in `corpus/trees/` — this directory is not
scored. Convert with the same tree-sitter walk as
`harness/gen_trees.py`, then:

- `fmt-rust` == `fmt-js` at 88 and 60 (correct `widthOf`)
- after planting `widthOf = s.length` in the JS printer,
  they differ at 88 on both files, and at 60 on the Python
  file
- the 30 scored baselines stay byte-identical
