;; Nested lets, already broken, deep enough that emacs emits tabs
;; (indent-tabs-mode defaults to t; columns 8, 16, 24 become tabs).
(define (walk tree) ; tree is a nested list of values
(let ((value (car tree)))
(let ((kids (cdr tree)))
(let ((n (length kids)))
(let ((first (and (pair? kids) (car kids))))
(let ((rest (and (pair? kids) (cdr kids))))
(let ((left (and (pair? first) first)))
(let ((right (and (pair? rest) rest)))
(list value n left right)))))))))
