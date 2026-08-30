/** App-level settings snapshot the request API reads (frozen per app). */
export interface RequestSettings {
  readonly proxy: boolean;
  readonly proxyIpHeader: string;
  readonly maxIpsCount?: number;
  readonly subdomainOffset: number;
}
