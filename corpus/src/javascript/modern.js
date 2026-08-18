// Modern syntax: optional chaining, nullish coalescing, regex, bigint.
const safe = user?.profile?.address?.zip ?? "unknown";

const regex = /^[a-z]+-[0-9]{2,4}\.js$/i;

const bigint = 123456789012345678901234567890n;

const coalesceAssign = config ??= defaults;

const andAssign = flags &&= required;

const orAssign = fallback ||= computed;

const optionalCall = handler?.onChange?.(value);

const optionalIndex = matrix?.[row]?.[column];

const power = base ** exponent;

const dynamicImport = await import("./lazy.js");
