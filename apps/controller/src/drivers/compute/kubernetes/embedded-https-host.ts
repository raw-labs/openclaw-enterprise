/** Operator-entered embedded HTTPS host patterns; "*" must occupy a whole entry or label. */
export function isEmbeddedHttpsHost(value: unknown): boolean {
  if (typeof value !== "string" || value.length > 253) {
    return false;
  }
  if (value === "*") {
    return true;
  }
  const name = value.startsWith("*.") ? value.slice(2) : value;
  return (
    !/^[0-9.]+$/.test(name) &&
    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(name)
  );
}
