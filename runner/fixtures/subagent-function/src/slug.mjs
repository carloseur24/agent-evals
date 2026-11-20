export function slugify(value) {
  // TODO: trim, lower-case, collapse non-alphanumeric runs into single dashes,
  // and trim leading/trailing dashes.
  return String(value).toLowerCase();
}
