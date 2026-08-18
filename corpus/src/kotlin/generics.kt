// Type parameters, variance, reified, where, star projection.

interface Box<out T>{
    fun get():T // covariant producer
}

interface Sink<in T>{
    fun put(value:T)
}

fun <T> identity(value:T):T=value

inline fun <reified T> isType(value:Any):Boolean{
    return value is T // reified lets is work
}

fun <T> sortInPlace(items:MutableList<T>) where T:Comparable<T>{
    items.sort()
}

fun star(box:Box<*>):Any?{
    return box.get() // star projection
}
