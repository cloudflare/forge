const NAMED_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"' };

function decodeEntity(entity: string, hex?: string, decimal?: string, name?: string): string {
  if (name) return NAMED_ENTITIES[name.toLowerCase()] ?? entity;
  const code = hex ? Number.parseInt(hex, 16) : Number(decimal);
  return code <= 0x10ffff ? String.fromCodePoint(code) : entity;
}

/** Plain text of rendered description HTML: tags dropped, entities decoded in one pass. */
export function toPlainText(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(?:#x([0-9a-f]+)|#([0-9]+)|(amp|lt|gt|quot));/gi, decodeEntity)
    .replace(/\s+/g, ' ')
    .trim();
}
