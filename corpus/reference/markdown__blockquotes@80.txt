<!-- Nested quotes and quoted lists. -->

> outer quote <!-- trailing on the first quoted line -->
> still outer
>
> > inner quote
> > still inner
>
> - quoted list
> - quoted next
>   - nested in the quote

A quoted fence, and the bare `>` that ends it. The grammar hands that marker to
the fence as its last child, so the line break belongs to the fence rule and
not to whatever follows:

> before the fence
>
> ```json
> { "quoted": true }
> ```
>
> after the fence

> ```sh
> echo 'a fence that opens the quote'
> ```
>
> and still in it
