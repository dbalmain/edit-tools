short = obj.attr

attribute_chain = configuration.database.connection.settings.pool.maximum_size_limit

method_chain = query.filter(active=True).order_by("name").limit(100).offset(20).all()

mixed_chain = client.session.request("GET", url).json()["data"]["items"][0]["name"]

call_then_attr = build_client(host, port).connection.metadata.version_identifier

subscript_chain = registry["handlers"]["default"]["callback"](event, context, opts)

slices = sequence[1:10]

long_slice = collection_of_items[start_index:end_index:step_size_between_elements]

open_slice = buffer[:]

negative = values[-1]

nested_subscript = matrix[row_index][column_index][depth_index][final_axis_index]
