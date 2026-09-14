/** Stop waiting without leaving listeners or unhandled late rejections behind. */
export async function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        onAbort = () => { reject(signal.reason instanceof Error ? signal.reason : new Error('Operation aborted')); };
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      }),
    ]);
  } finally { if (onAbort) signal.removeEventListener('abort', onAbort); }
}
