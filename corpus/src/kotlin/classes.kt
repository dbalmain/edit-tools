// data, sealed, enum, object, companion: Kotlin's type-declaration surface.

data class User(val id: Int, val name: String, val email: String) // primary constructor

sealed class Result {
    data class Ok(val value: String) : Result()
    data class Err(val cause: String) : Result()
    object Empty : Result()
}

enum class Color {
    RED,
    GREEN,
    BLUE, // trailing member
}

object Registry {
    const val version: Int = 1

    companion object {
        fun create(): Registry = Registry // companion factory
    }
}

class Counter(private var n: Int = 0) {
    fun inc(): Int {
        n += 1
        return n
    }
}
