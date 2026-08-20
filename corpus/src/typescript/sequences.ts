// The constructs that overflow a line: value lists, typed parameter lists,
// named tuples, and a long type-only import. Numbers pack (prettier fills);
// identifiers go one per line.
import type { Alpha, Beta, Gamma, Delta, Epsilon, Zeta, Eta, Theta } from "./types";

const numbers: number[] = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150, 160, 170, 180, 190, 200];

const identifiers = [alpha, beta, gamma, delta, epsilon, zeta, eta, theta, iota, kappa, lambda, mu, nu, xi];

const call = render(firstArgument, secondArgument, thirdArgument, fourthArgument, fifthArgument, sixth);

type NamedTuple = [first: string, second: number, third: boolean, fourth: Date, fifth: URL, sixth: Error];

type Fn = (first: string, second: number, third: boolean, fourth: Date, fifth: URL) => Promise<string>;
