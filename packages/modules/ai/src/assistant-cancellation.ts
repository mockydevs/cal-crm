/** Retry waits end promptly on Stop, including waits before provider fallback. */
export function waitForRetry(
  ms: number,
  signal?: AbortSignal,
  sleep?: (ms: number) => Promise<void>,
): Promise<void> {
  if (signal?.aborted === true) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
    };
    const finish = (): void => {
      cleanup();
      resolve();
    };
    signal?.addEventListener('abort', finish, { once: true });
    if (sleep === undefined) timer = setTimeout(finish, ms);
    else
      void Promise.resolve()
        .then(() => sleep(ms))
        .then(finish, (error: unknown) => {
          cleanup();
          reject(error instanceof Error ? error : new Error('Retry delay failed.'));
        });
  });
}

/** Node's AbortSignal closes the provider exchange; this observer bridges durable Stop requests. */
export async function withAssistantCancellation<T>(
  cancelled: () => Promise<boolean>,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (await cancelled()) throw new DOMException('Stopped', 'AbortError');
  const controller = new AbortController();
  const observation = Promise.withResolvers<T>();
  let active = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const observe = async (): Promise<void> => {
    try {
      const stopped = await cancelled();
      if (!active) return;
      if (stopped) controller.abort();
      else
        timer = setTimeout(() => {
          void observe();
        }, 250);
    } catch (error) {
      if (!active) return;
      controller.abort();
      observation.reject(error);
    }
  };
  timer = setTimeout(() => {
    void observe();
  }, 250);
  try {
    return await Promise.race([work(controller.signal), observation.promise]);
  } finally {
    active = false;
    clearTimeout(timer);
  }
}
