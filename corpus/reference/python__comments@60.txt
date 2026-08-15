# Module level comment at the very top of the file.

import os  # trailing comment on an import


# Own-line comment before a definition, separated by a blank line.
def documented(a, b):
    # Leading comment inside the body.
    result = a + b  # trailing comment on a statement
    # Comment before return.
    return result


values = [
    1,  # first
    2,  # second
    # own-line comment inside a bracketed list
    3,
]

config = {
    # comment before the first key
    "host": "localhost",
    "port": 8080,  # trailing on a pair
}


def between():
    pass
    # trailing comment at the end of a block


# Comment at the end of the file.
