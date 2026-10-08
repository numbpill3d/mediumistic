export function normalizeProfileRef(value) {
  const ref = String(value || '').trim().replace(/\/$/, '');
  const mediumHandle = ref.match(/^https?:\/\/(?:www\.)?medium\.com\/@([^/?#]+)$/i);
  return mediumHandle ? mediumHandle[1] : ref.replace(/^@/, '');
}

export function profileURL(ref) {
  const value = normalizeProfileRef(ref);
  return /^https?:\/\//i.test(value)
    ? value
    : `https://medium.com/@${value}`;
}

export function profileLabel(ref) {
  const value = normalizeProfileRef(ref);
  if (!/^https?:\/\//i.test(value)) return value ? `@${value}` : '';
  try {
    const url = new URL(value);
    return `${url.hostname}${url.pathname.replace(/\/$/, '')}`;
  } catch {
    return value;
  }
}
