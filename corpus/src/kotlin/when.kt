// when is Kotlin's exhaustiveness-shaped dispatch expression.

fun classify(x: Any): String =
    when (x) { // subject
        is String -> x.uppercase()
        is Int -> x + 1
        0, 1, 2 -> "small" // comma-separated conditions
        in 10..20 -> "mid"
        !in 100..200 -> "not-large"
        else -> "other"
    }

fun noSubject(flag: Boolean): Int {
    return when {
        flag -> 1
        else -> 0 // no-subject when
    }
}
