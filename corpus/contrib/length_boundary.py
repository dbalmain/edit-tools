# Astral scalar on a list's fit boundary at a scored width.
# Correct width is Unicode scalars; JS .length counts 🙂 as two.

# Width 88: flat form is 88 scalars / 89 UTF-16 units.
probe = ["🙂", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]

# Width 60: flat form is 60 scalars / 61 UTF-16 units.
short = ["🙂", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]
