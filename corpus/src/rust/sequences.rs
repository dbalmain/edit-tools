fn sequence_probe() {
    let total = first_value
        + second_value
        + third_value
        + fourth_value
        + fifth_value
        + sixth_value
        + seventh_value
        + eighth_value
        + ninth_value;

    // A long call and a long tuple exercise different sequence policies.
    let result = combine(
        first_argument,
        second_argument,
        third_argument,
        fourth_argument,
        fifth_argument,
        sixth_argument,
        seventh_argument,
        eighth_argument,
    );
    let tuple = (
        first_element,
        second_element,
        third_element,
        fourth_element,
        fifth_element,
        sixth_element,
    );
    consume(total, result, tuple);
}
