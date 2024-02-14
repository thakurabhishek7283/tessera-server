/** Public URL of a stored upload; `path` is the server-generated file name. */
export function uploadUrl(publicUrl: string, path: string): string {
  return `${publicUrl}/uploads/${path}`;
}
