/** Merge UTM params into target URL; keys already on the target win. */
export function mergeUtm(targetUrl: string, utm: Record<string, string>, append: boolean): string {
  if (!append || !utm || Object.keys(utm).length === 0) return targetUrl
  try {
    const u = new URL(targetUrl)
    for (const [k, v] of Object.entries(utm)) {
      if (!u.searchParams.has(k)) u.searchParams.set(k, v)
    }
    return u.toString()
  } catch {
    return targetUrl
  }
}
