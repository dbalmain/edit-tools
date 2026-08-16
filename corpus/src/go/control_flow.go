package main

// classify reports whether n is negative, zero or positive.
func classify(n int) string {
  if n<0 {
    return "negative"
  } else if n==0 {
    return "zero"
  } else {
    return "positive"
  }
}

func sum(xs []int) int {
  total := 0
  for i:=0; i<len(xs); i++ {
    total+=xs[i] // accumulate
  }
  return total
}

func loop(xs []int) {
  for i,v := range xs {
    _ = i
    _ = v
  }
}

func switchOn(x interface{}) string {
  switch v := x.(type) {
  case int:
    return "int"
  case string:
    return "string"
  case nil:
    return "nil"
  default:
    _ = v
    return "other"
  }
}

func selectLoop(ch chan int, done chan bool) {
  for {
    select {
    case v := <-ch:
      _ = v
    case <-done:
      return
    default:
      return
    }
  }
}
