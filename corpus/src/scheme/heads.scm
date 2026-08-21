;; Smallest case: three `list` nodes, three indents. Dispatch on node.type
;; cannot tell these apart; emacs scheme-mode keys off the head symbol.
(define (as-define x)
x)

(define (as-let x)
(let ((a 1))
a))

(define (as-cons a b)
(cons a
b))

(define (as-call a b)
(list a
b))
