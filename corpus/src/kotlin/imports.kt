// Import order. ktfmt always sorts imports -- `sortedAndDistinctImports` has
// no disable flag, unlike unused-import removal -- and a linear formatter
// cannot reorder statements, so this file is declared `incomparable`.
// Every import here is used, so it probes sorting alone.

import kotlin.math.max
import java.util.ArrayList
import kotlin.math.min
import java.io.File

fun demo(file: File): Int {
    val xs = ArrayList<Int>()
    return max(min(xs.size, 1), file.name.length)
}
