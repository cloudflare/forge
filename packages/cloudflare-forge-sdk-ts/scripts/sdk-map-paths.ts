export interface SpecOperation {
  operationId: string;
  path: string;
  synthetic: boolean;
  ignored: boolean;
}

function pathShape(key: string): string {
  return key.replace(/\{[^{}]+\}/g, '{}');
}

export function createSpecOperationLookup(byKey: ReadonlyMap<string, SpecOperation>) {
  const byShape = new Map<string, SpecOperation[]>();
  for (const [key, operation] of byKey) {
    const shape = pathShape(key);
    const operations = byShape.get(shape) ?? [];
    operations.push(operation);
    byShape.set(shape, operations);
  }

  return (verb: string, path: string): SpecOperation | undefined => {
    const key = `${verb.toUpperCase()} ${path}`;
    const direct = byKey.get(key);
    if (direct) return direct;

    // Fern splits literal dots next to parameters into `/.` and uses
    // x-fern-parameter-name overrides in diagnostic paths.
    const repairedKey = `${verb.toUpperCase()} ${path.replace(/}\/\.\/?/g, '}.')}`;
    const repaired = byKey.get(repairedKey);
    if (repaired) return repaired;

    const candidates = byShape.get(pathShape(repairedKey));
    if (candidates && candidates.length > 1) {
      throw new Error(
        `generate-sdk-map: Ambiguous path match for ${key}: ${candidates.map((candidate) => candidate.path).join(', ')}`,
      );
    }
    return candidates?.[0];
  };
}
