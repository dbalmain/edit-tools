import os
from collections.abc import Iterable, Mapping

DEFAULT_OPTIONS = {"timeout": 30, "retries": 3, "backoff": 1.5, "verbose": False}


@register(name="processor", priority=10)
def process_records(records, options=None, *, strict=False, on_error=None, **extra):
    # Merge caller options over the defaults.
    settings = {**DEFAULT_OPTIONS, **(options or {})}  # shallow merge is fine
    results = []
    for index, record in enumerate(records):
        if not record.is_valid or record.identifier in seen_identifiers_registry:
            continue
        try:
            value = transform(record, settings["timeout"], strict=strict, index=index)
        except (ValueError, KeyError) as error:
            if on_error is None or not on_error(record, error):
                raise
            continue
        results.append(
            {
                "id": record.identifier,
                "value": value,
                "tags": [tag.name for tag in record.tags if tag.is_visible_to_user],
            }
        )
    return sorted(results, key=lambda item: (item["id"], item["value"]), reverse=True)


class Registry:
    def register(self, name, handler, replace=False):
        with self.lock:
            existing = self.handlers.get(name)
            if existing is not None and not replace:
                raise KeyError(f"handler {name} already registered as {existing!r}")
            self.handlers[name] = handler
        return handler
