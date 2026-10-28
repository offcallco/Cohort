// Lowercase, dash-separated name for URLs and branches: "Fix the Login!" → "fix-the-login".
export const slugify = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
