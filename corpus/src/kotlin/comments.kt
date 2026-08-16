// File-level comment at the very top.

/** Greet the caller by name. */
fun greet(name: String) { // trailing on a signature
    /* a block comment on its own line */
    // Leading comment inside the body.
    println(name) // trailing on a statement
    // comment before the closing brace
}

val values = listOf(
    1, // first element
    2, // second element
    // own-line comment inside a list
    3,
)

fun between() {
    val x = 1
    // trailing comment at the end of a block
}

// Comment at the end of the file.
