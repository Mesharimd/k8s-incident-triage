export interface PrometheusRangeRequest {
  readonly query: string;
  readonly start: string;
  readonly end: string;
  readonly stepSeconds: number;
  readonly timeoutSeconds: number;
  readonly maxSeries: number;
}

export interface PrometheusApi {
  queryRange(request: PrometheusRangeRequest): Promise<unknown>;
}
