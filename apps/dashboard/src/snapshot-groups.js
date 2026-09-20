const localizedVariant = /^(.*)\.([a-z]{2,3}(?:-[A-Z]{2})?)-(.+)\.(png)$/;

export function snapshotVariant(entry) {
  const match = String(entry.name ?? "").match(localizedVariant);
  if (!match) return { key: entry.name, name: entry.name, locale: null, device: null };
  return {
    key: `${match[1]}.${match[4]}`,
    name: `${match[1]}.${match[4]}`,
    locale: match[2],
    device: match[3],
  };
}

export function groupSnapshots(entries) {
  const groups = new Map();
  entries.forEach((entry, entryIndex) => {
    const variant = snapshotVariant(entry);
    const group = groups.get(variant.key) ?? { key: variant.key, name: variant.name, variants: [] };
    group.variants.push({ entry, entryIndex, locale: variant.locale, device: variant.device });
    groups.set(variant.key, group);
  });
  return [...groups.values()];
}

export function selectSnapshotVariant(group, locale, device) {
  if (!group?.variants.length) return null;
  return group.variants.find((variant) => variant.locale === locale && variant.device === device)
    ?? group.variants.find((variant) => variant.locale === locale)
    ?? group.variants.find((variant) => variant.device === device)
    ?? group.variants[0];
}

export function groupKind(group) {
  const kinds = new Set(group.variants.map((variant) => variant.entry.kind));
  return kinds.size === 1 ? group.variants[0].entry.kind : "mixed";
}
