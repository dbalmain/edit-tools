// if/for/while/try as expressions, plus a labeled loop.

fun sign(x:Int):String=if (x>0) "pos" else if (x<0) "neg" else "zero"

fun demo(items:List<Int>):Int {
    var total=0
    loop@ for (item in items) { // labeled
        if(item<0) continue@loop
        if(item==0) break@loop
        total+=item
    }
    var n=items.size
    while(n>0){
        n-=1
    }
    val parsed=try{ items.first() } catch(e:NoSuchElementException){ -1 } finally { n=0 } // try is an expression
    return parsed
}
