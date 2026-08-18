// String, char and number spellings ktfmt must leave alone.

fun demo(name: String) {
    val plain="hello world" // ordinary double quotes
    val overlong="this is a very long string literal that definitely exceeds one hundred columns all by itself and then some more text"
    val escaped="line one\nline two\ttabbed \"quoted\" \\"
    val template="hello $name, length ${name.length}"
    val dollar="costs ${'$'}5"
    val raw="""a raw string
        with backslashes \n \t and "quotes"
        and a $name interpolation
        """
    val c='x'
    val newline='\n'
    val unicodeChar='\u00e9'
    val unicode="café ☕"
    // astral characters: width must be counted in scalar values
    val astral="🙂🙂🙂🙂🙂🙂"
    val n=1_000
    val hex=0xdead
    val long=1L
}
