;; define variable, define procedure, define-syntax. Also a `defxyz` call:
;; emacs treats any head whose name starts with "def" as defun-style, so
;; (defxyz a / b) indents like define, not like list.
(define answer 42) ; a variable

(define (square x)
(* x x))

(define (defxyz a b) ; name starts with "def"; the *call* below is the probe
a)

(define (use-decoy a b)
(defxyz a
b))

(define (use-ordinary a b)
(list a
b))
