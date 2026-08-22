;; syntax-rules. emacs puts 'defun on syntax-rules, so the pattern clauses
;; indent like a body, not like a call. define-syntax itself is a def* head.
(define-syntax when-then
(syntax-rules ()
((_ test body ...)
(if test
(begin body ...)))))

(define-syntax unless-then
(syntax-rules ()
((_ test body ...)
(if test
#f
(begin body ...)))))

(define (demo x) ; uses the macros above
(when-then (positive? x)
(display x)
(newline)))
