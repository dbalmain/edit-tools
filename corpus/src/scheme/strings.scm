;; String and character interiors: escapes, a multi-line string (emacs
;; does not reindent inside quotes -- measured), unicode, characters.
(define short "hello") ; simple string

(define escaped "line one\nline two\ttabbed\r\nquoted \"bit\"")

(define multi "hello
world")

(define unicode "café")

(define space-char #\space)

(define letter-char #\a)

(define newline-char #\newline)
