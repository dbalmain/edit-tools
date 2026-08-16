package main

func main() {
  result := veryLongFunctionName(firstArgument,secondArgument,thirdArgument,fourthArgument,fifthArgument,sixthArgument,seventhArgument) // a call that will not reflow

  chained := client.NewRequest().WithTimeout(30).WithRetries(3).WithHeader("Authorization","Bearer token").Execute()

  var items=[]string{"alpha","beta","gamma","delta","epsilon","zeta","eta","theta","iota","kappa","lambda"}

  var matrix = map[string][]string{
    "colours":{"red","green","blue","yellow","purple","orange","teal","magenta"},
  }

  _ = result
  _ = chained
  _ = items
  _ = matrix
}
