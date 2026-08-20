<!-- File-level HTML comment. -->

# Heading <!-- trailing comment on a heading -->

Paragraph with an <!-- inline html comment --> in the middle of the text.

- item <!-- trailing on a list item -->
- next
  <!-- own-line comment inside a list, before a nested item -->
  - nested

> quote line <!-- trailing in a block quote -->
>
> <!-- own-line comment inside a quote -->
>
> still quoted

```json
{
  "a": 1, // trailing comment on a guest pair
  // own-line comment before the next pair
  "b": 2
}
```

```json
[1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]
```

<!-- comment between two blocks -->

<!-- consecutive own-line comment -->
<!-- second of the pair -->

<!-- comment at the end of the file -->
