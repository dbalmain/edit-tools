package main

// short returns its argument unchanged.
func short(a int) int {
  return a
}

func withMany(first int,second string,third float64,fourth bool,fifth []int) int {
  return first
}

func namedReturns(count int) (sum int,product int) {
  sum=count
  product=count*2
  return
}

func variadic(base string, rest ...int) string {
  return base
}

type Counter struct {
  n int
}

func (c *Counter)Inc() {
  c.n++
}

func (c Counter)Value() int {
  return c.n // the current count
}
