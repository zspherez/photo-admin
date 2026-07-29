export function buildSmsDraftHref(phone: string, body: string): string {
  return `sms:${phone.trim()}?body=${encodeURIComponent(body)}`;
}
