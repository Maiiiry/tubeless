import { useCallback, useEffect, useState } from "preact/hooks";

export interface StudioResource<T> {
  value: T | null;
  loading: boolean;
  error?: string;
  reload(): void;
}

/** Retain a resource during refresh, but never across identity or API changes. */
export function useStudioResource<T>(
  owner: object | undefined,
  key: string,
  load: () => Promise<T>
): StudioResource<T> {
  const [attempt, setAttempt] = useState(0);
  const reload = useCallback(() => setAttempt((value) => value + 1), []);
  const [result, setResult] = useState<
    Omit<StudioResource<T>, "reload"> & { owner?: object; key: string; request: typeof load }
  >({
    key: "",
    request: load,
    value: null,
    loading: false,
  });
  useEffect(() => {
    if (!owner || !key) {
      setResult({ key: "", request: load, value: null, loading: false });
      return;
    }
    let current = true;
    setResult((previous) => ({
      owner,
      key,
      request: load,
      value: previous.owner === owner && previous.key === key ? previous.value : null,
      loading: true,
    }));
    void load()
      .then((value) => {
        if (current) setResult({ owner, key, request: load, value, loading: false });
      })
      .catch((error: unknown) => {
        if (current)
          setResult((previous) => ({
            ...previous,
            loading: false,
            error: error instanceof Error ? error.message : "Could not load definition history.",
          }));
      });
    return () => {
      current = false;
    };
  }, [owner, key, load, attempt]);
  if (!owner || !key) return { value: null, loading: false, reload };
  if (result.owner !== owner || result.key !== key) return { value: null, loading: true, reload };
  return {
    reload,
    value: result.value,
    loading: result.loading || result.request !== load,
    error: result.request === load ? result.error : undefined,
  };
}
