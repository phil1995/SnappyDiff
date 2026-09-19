export function comparisonNavigation(index, total) {
  const count = Math.max(0, Number(total) || 0);
  const selected = count ? Math.max(0, Math.min(Number(index) || 0, count - 1)) : 0;
  return {
    selected,
    position: count ? selected + 1 : 0,
    total: count,
    previousDisabled: selected <= 0,
    nextDisabled: count === 0 || selected >= count - 1,
  };
}
