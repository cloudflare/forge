/** Display labels for Fern endpoint availability statuses. */
const AVAILABILITY_LABELS: Record<string, string> = {
  alpha: 'Alpha',
  beta: 'Beta',
  preview: 'Preview',
  'generally-available': 'Generally Available',
  deprecated: 'Deprecated',
  legacy: 'Legacy',
};

/** Human label for an availability status. Unknown statuses keep their words. */
export function availabilityLabel(status: string): string {
  return AVAILABILITY_LABELS[status] ?? status.replaceAll('-', ' ');
}
