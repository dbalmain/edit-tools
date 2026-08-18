// Stacked annotations and use-site targets. Written attached, on one line,
// because tree-sitter-kotlin 1.1.0 parses an own-line annotation as a
// sibling `annotated_expression` in some surrounding contexts and as a
// `modifiers` child in others -- it is not "stacked splits, single
// attaches". ktfmt joins an own-line stack onto the declaration, so where
// the grammar splits, the join changes the named tree and gate 3 rejects
// the reference output. Own-line annotations are therefore unmeasured
// (FINDINGS 4). See the report for the contexts that were tried.

@JvmStatic @Throws(IOException::class) fun demo(@param:Min(0) count:Int) {} // stacked + use-site

@Deprecated("use other",ReplaceWith("other()")) fun old():String="gone"

class Holder(@get:JvmName("readValue") val value:Int)

annotation class Min(val n:Int)
