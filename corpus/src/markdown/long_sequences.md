<!-- Fenced JSON arrays that overflow a line. -->

A 27-item array of ones is 81 characters, so it breaks at prettier's default
80 and stays flat at 81. The 26-item neighbour (78 characters) stays flat at
both scored widths.

```json
[1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]
```

```json
[1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]
```
