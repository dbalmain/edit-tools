;; let / let* / letrec / named let. Named let is the same `let` head as
;; the unnamed one; emacs scheme-let-indent looks at whether the cadr is
;; a symbol. Both are a `list` node.
(define (plain-let x)
(let ((a 1)
(b 2))
(+ a b x)))

(define (star-let x)
(let* ((a x)
(b (+ a 1)))
b))

(define (rec-let n)
(letrec ((even?
(lambda (x)
(if (zero? x) #t (odd? (- x 1)))))
(odd?
(lambda (x)
(if (zero? x) #f (even? (- x 1))))))
(even? n)))

(define (named-sum n) ; named let: cadr is a symbol, so specform 2
(let loop ((i 0)
(acc 0))
(if (= i n)
acc
(loop (+ i 1) (+ acc i)))))
