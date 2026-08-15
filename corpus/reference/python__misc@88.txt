identity = lambda x: x

long_lambda = lambda first, second, third: first * second + third - first / second

ternary = value if condition else fallback

long_ternary = primary_result_value if some_fairly_long_condition else other_result

nested_ternary = alpha if first_condition else (beta if second_condition else gamma)

assignment_target = value

multiple_targets = first = second = shared_value

augmented = counter

augmented += increment_amount_that_is_reasonably_long_to_force_a_line_break_here

tuple_unpack = first_variable, second_variable, third_variable = source_expression


def early_return(value):
    if not value:
        return None
    return transform_the_value(value, using_these_options, and_this_context_object)


def bare_return():
    return


parenthesised = (a + b) * (c - d)

redundant_parens = value
