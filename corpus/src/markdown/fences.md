<!-- Fenced guests, verbatim fallbacks, empty { }. -->

A document with one unparseable snippet must still format.

A JSON fence prettier formats, including the empty object written with a space:

```json
{ }
```

```json
[1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]
```

A JavaScript fence prettier also formats:

```javascript
const x = [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1];
```

No info string, unknown info string, and unparseable JSON stay verbatim:

```
leave   this    spacing
```

```xyzzy
leave   this    too
```

```json
{broken
```

Nested markdown containing JSON — the host-in-host case:

````markdown
```json
{"a":1,"b":2,"c":3,"d":4,"e":5,"f":6,"g":7,"h":8}
```
````
