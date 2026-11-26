export async function getStored<T>(key: string, fallback: T): Promise<T> {
  const values = await chrome.storage.local.get(key);
  return (values[key] as T | undefined) ?? fallback;
}
