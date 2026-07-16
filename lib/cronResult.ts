export type CronSourceResult<T> =
  | {
      ok: true;
      durationMs: number;
      data: T;
    }
  | {
      ok: false;
      durationMs: number;
      error: string;
    };

export async function runCronSource<T>(
  route: string,
  source: string,
  work: () => Promise<T>
): Promise<CronSourceResult<T>> {
  const startedAt = Date.now();
  try {
    const data = await work();
    const result: CronSourceResult<T> = {
      ok: true,
      durationMs: Date.now() - startedAt,
      data,
    };
    console.info(JSON.stringify({ event: "cron_source_complete", route, source, ...result }));
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const result: CronSourceResult<T> = {
      ok: false,
      durationMs: Date.now() - startedAt,
      error: message.slice(0, 2_000),
    };
    console.error(JSON.stringify({ event: "cron_source_failed", route, source, ...result }));
    return result;
  }
}
