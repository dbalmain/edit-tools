package main

type Server struct {
	Name string
	Port int
	Timeout int
	MaxRetries int32
	Database string
}

type Commented struct {
	Alpha int // first field
	Beta string // second field
	Gamma bool // third field
}

type Config struct {
	Host string `json:"host"`
	Port int `json:"port"`
	WorkerCount int `json:"worker_count"`
}

type Grouped struct {
	A int
	B string

	LongFieldName int
	C bool
}

const (
	StatusOK = 200
	StatusNotFound = 404
	StatusInternalServerError = 500
)

const (
	One = 1 // first
	TwoLonger = 2 // second
	Three = 3
)

var (
	x = 1
	yyy = 2
)

var first = 1 // first comment
var secondLonger = 2 // second comment
var third = 3
