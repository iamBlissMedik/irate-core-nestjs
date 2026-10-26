/**
 * Escape LIKE/ILIKE wildcards so user input is matched literally. Prisma's
 * `contains` does NOT do this: searching for "%" would match every row.
 */
export function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, (char) => `\\${char}`);
}
