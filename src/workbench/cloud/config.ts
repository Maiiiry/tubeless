const DEFAULT_CLOUD_HOST = "https://cloud.tubeless.io";

/** Normalize a service origin without allowing credential, path or redirect ambiguity. */
export function normalizeCloudHost(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Cloud host must be an HTTPS origin, for example https://cloud.tubeless.io.");
  }
  const loopback =
    url.hostname === "localhost" ||
    url.hostname === "[::1]" ||
    /^127(?:\.\d{1,3}){3}$/.test(url.hostname);
  if (
    !/^https?:\/\/[^/?#@]+\/?$/i.test(value) ||
    value !== value.trim() ||
    /[\u0000-\u0020\u007f\\]/.test(value) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
  ) {
    throw new Error(
      "Cloud host must be an HTTPS origin without credentials, path, query or fragment. HTTP is allowed only for localhost or loopback development."
    );
  }
  return url.origin;
}

export function resolveCloudHost(explicitHost?: string): string {
  return normalizeCloudHost(explicitHost ?? DEFAULT_CLOUD_HOST);
}
