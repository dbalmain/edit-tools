;; Same head symbol, two source line-breaks, two indents. `list` with the
;; first argument on the head line aligns under that argument; with it on
;; the next line, emacs uses the one-space default. Width is not involved.
(define (same-line a b c) ; first arg shares the head line
(list a
b
c))

(define (next-line a b c)
(list
a
b
c))

(define (begin-same x y)
(begin x
y))

(define (begin-next x y)
(begin
x
y))
