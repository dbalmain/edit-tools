// Trailing lambda vs last-arg lambda: same construct, different CST, and
// ktfmt preserves both. Source-broken lambda bodies stay broken.

fun demo(x:Int, items:List<Int>) {
    foo( x ){ println(it) } // trailing form
    foo(x,{ println(it) }) // last-arg form, not rewritten
    foo(x,y){ a -> a+1 }
    items.forEach({ println(it) })
    items.map{ it*2 }.filter{ it>0 }

    // source-broken DSL stays multi-line (preserveLambdaBreaks)
    App {
        SelectableCard {
            Button { Text("Click me") }
        }
    }
    // source-flat DSL stays flat
    App { SelectableCard { Button { Text("Click me") } } }
}
