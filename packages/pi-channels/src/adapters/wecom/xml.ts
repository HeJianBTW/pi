export function xmlTag(xml: string, tag: string): string | undefined {
  const match = xml.match(
    new RegExp(`<${tag}><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></${tag}>|<${tag}>([\\s\\S]*?)</${tag}>`),
  );
  return match?.[1] ?? match?.[2];
}

export function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

export function xmlText(xml: string, tag: string): string {
  return decodeXml(xmlTag(xml, tag) ?? '');
}
