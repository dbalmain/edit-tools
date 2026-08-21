;; if / cond / case / do / and / or. `if` has no scheme-indent-function
;; property, so it follows the default (align under the test when the test
;; shares the head line). `do` is specform 2. `cond` is nil.
(define (sign n) ; three-way if
(if (negative? n)
-1
(if (zero? n)
0
1)))

(define (classify n)
(cond
((negative? n) 'neg)
((zero? n) 'zero)
(else 'pos)))

(define (name-of n)
(case n
((0) 'zero)
((1) 'one)
((2) 'two)
(else 'other)))

(define (upto n)
(do ((i 0 (+ i 1))
(acc '() (cons i acc)))
((= i n) (reverse acc))))

(define (both a b)
(and (number? a)
(number? b)
(< a b)))

(define (either a b)
(or (not a)
(not b)
(eq? a b)))
