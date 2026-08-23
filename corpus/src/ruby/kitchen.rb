# Several constructs interacting. Written in syntax_tree's token form so
# this file stays comparable (kitchen is never incomparable).

DEFAULTS = { timeout: 30, retries: 3, backoff: 1.5, verbose: false }

class Registry
  def register(name, handler, replace: false)
    # Merge caller options over the defaults.
    settings = { **DEFAULTS, name: name } # shallow merge is fine
    with_lock do
      existing = handlers[name]
      if existing && !replace
        raise KeyError, "handler #{name} already registered as #{existing.inspect}"
      end
      handlers[name] = handler
    end
    handler
  end

  def process(records, options = nil, strict: false, on_error: nil)
    results = []
    records.each do |record|
      next unless record.valid?
      begin
        value =
          transform(
            record,
            options[:timeout],
            strict: strict,
            index: record.index
          )
      rescue KeyError, TypeError => error
        if on_error.nil? || !on_error.call(record, error)
          warn(error)
          raise
        end
        next
      end
      results << {
        id: record.identifier,
        value: value,
        tags: record.tags.map(&:name)
      }
    end
    results.sort_by { |item| item[:id] }.reverse
  end
end
