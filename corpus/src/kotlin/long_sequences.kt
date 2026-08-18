// The constructs that most often overflow a line: args, params, a long list.

fun withMany(first: String, second: String, third: String, fourth: String, fifth: String, sixth: String): String {
    return first // keep the first
}

fun demo() {
    val computed = compute(arg00, arg01, arg02, arg03, arg04, arg05, arg06, arg07, arg08, arg09, arg10, arg11, arg12)
    val xs = listOf(alpha, bravo, charlie, delta, echo, foxtrot, golf, hotel, india, juliet, kilo, lima, mike)
    val named = build(host = "localhost", port = 8080, debug = true, timeout = 30, retries = 3, backoff = 1.5)
}
