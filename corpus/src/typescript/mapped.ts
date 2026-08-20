// Mapped and conditional types, `infer`, `keyof`, and template-literal types —
// the type-level programs a person would notice if they were laid out wrongly.
type Optional<T> = { [K in keyof T]?: T[K] | null };

type ReadonlyPicked<T, K extends keyof T> = { readonly [P in K]: T[P] };

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

type RequiredKeys<T> = { [K in keyof T]-?: T[K] };

type Unpacked<T> = T extends Promise<infer U> ? U : T extends Array<infer U> ? U : T;

type EventName<T extends string> = `on${Capitalize<T>}`;

type DeepPartial<T> = T extends object ? { [K in keyof T]?: DeepPartial<T[K]> } : T;

type Lookup = Person["name" | "age"];
