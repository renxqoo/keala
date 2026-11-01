export interface Scenario {
  method: string;
  route: string;
  path: string;
  body: string;
}
export const HELLO: Scenario[];
export const ROUTES: Scenario[];
export const EXTRA_CHECKS: Array<{ method: string; path: string; body: string }>;
