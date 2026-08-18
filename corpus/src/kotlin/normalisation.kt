// Dirty spacing: what ktfmt rewrites, not what it breaks.

fun  normalise( a : Int ,b:Int ):Int{
val result=a + b*  2
return(result)
}

fun empty( ) { // empty parameter list written with a space
val xs = listOf( ) // empty call with a space inside
val ys = mapOf( )
val zs = setOf(  )
}

fun padded( ) {
val x = listOf( 1,2,3 )
if ( x != null ) { println(x) } else { println(0) }
}

val trailingSpaces = 1       // lots of spaces before this comment

fun indented() {
        val n = 0
        if(n==0){
                println(n)
        }
}

val semis = 1; val two = 2; val three = 3
