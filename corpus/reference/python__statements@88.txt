if condition:
    do_something()

if first_condition and second_condition and third_condition and fourth_condition:
    handle_the_case()
elif alternative_condition or another_alternative_condition or third_alternative:
    handle_alternative()
else:
    handle_default()

for item in collection:
    process(item)

for index, (first_element, second_element) in enumerate(zip(first_seq, second_seq)):
    combine(first_element, second_element, index)

while not finished and attempts < maximum_attempts and not should_abort_early():
    attempt()

with open(path) as handle:
    contents = handle.read()

with open(input_path) as source, open(output_path, "w") as destination:
    destination.write(source.read())

try:
    risky_operation()
except ValueError as error:
    handle(error)
except (KeyError, IndexError):
    handle_lookup_failure()
finally:
    cleanup()


class Simple:
    def method(self):
        return self
