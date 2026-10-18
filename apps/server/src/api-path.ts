/** An endpoint's path in Fastify syntax: /tags/{id} becomes /tags/:id. */
export function fastifyPath(path: string): string {
  return path.replaceAll(/\{(\w+)\}/g, ':$1');
}
