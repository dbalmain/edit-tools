package main

var flat = []int{1, 2, 3,} // flat slice

var flatMap = map[string]int{"a": 1, "b": 2,} // flat map

var broken = []int{
1,
2,
3,
}

var brokenMap = map[string]int{
"a": 1,
"b": 2,
}

type Point struct {
	X int
	Y int
}

var points = []Point{{X: 1, Y: 2}, {X: 3, Y: 4}} // a slice of structs

var matrix = [][]int{
{1, 2},
{3, 4},
}

var singleLineStruct = Point{X: 5, Y: 6,} // single-line struct
