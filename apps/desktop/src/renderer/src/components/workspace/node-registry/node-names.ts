/**
 * Curated pool of friendly, distinct node names (mythology / constellations), used as the
 * default identifier for every canvas node. The shown name is also the peer identifier
 * (`peer-graph.ts` `resolvePeers` derives the peer name from `node.title`), so names here must
 * be pleasant, unambiguous, and free of punctuation that would read oddly in chat.
 */
export const NODE_NAME_POOL: readonly string[] = [
  'Hermes',
  'Atlas',
  'Orion',
  'Vega',
  'Juno',
  'Rhea',
  'Leto',
  'Cassio',
  'Lyra',
  'Nova',
  'Iris',
  'Helios',
  'Selene',
  'Phoebe',
  'Thalia',
  'Maia',
  'Electra',
  'Merope',
  'Alcyone',
  'Taygete',
  'Celaeno',
  'Sterope',
  'Castor',
  'Pollux',
  'Andromeda',
  'Perseus',
  'Cassiopeia',
  'Cepheus',
  'Draco',
  'Cygnus',
  'Aquila',
  'Pegasus',
  'Corvus',
  'Hydra',
  'Leo',
  'Sagitta',
  'Delphinus',
  'Auriga',
  'Bootes',
  'Carina',
  'Centaurus',
  'Circinus',
  'Columba',
  'Corona',
  'Crater',
  'Fornax',
  'Grus',
  'Hercules',
  'Lacerta',
  'Lepus',
  'Lupus',
  'Lynx',
  'Norma',
  'Octans',
  'Ophiuchus',
  'Pavo',
  'Phoenix',
  'Pyxis',
  'Sculptor',
  'Scutum',
  'Serpens',
  'Sextans',
  'Triangulum',
  'Vulpecula',
  'Argus',
  'Calliope',
  'Clio',
  'Euterpe',
  'Terpsichore',
  'Erato',
  'Polyhymnia',
  'Urania',
  'Daphne',
  'Echo',
  'Freya',
  'Odin',
  'Loki',
  'Thor',
  'Saga',
  'Idun',
];

/**
 * First pool name not in `inUse`; if the pool is exhausted, the first "<name> N" (N>=2 over the
 * pool) not in `inUse`. Comparison is case-insensitive and trimmed.
 */
export function assignNodeName(inUse: ReadonlySet<string>): string {
  const normalized = normalizedSet(inUse);
  for (const name of NODE_NAME_POOL) {
    if (!normalized.has(normalize(name))) return name;
  }
  const base = NODE_NAME_POOL[0]!;
  let suffix = 2;
  while (normalized.has(normalize(`${base} ${suffix}`))) suffix += 1;
  return `${base} ${suffix}`;
}

/**
 * Returns `desired` (trimmed) if free; otherwise `desired` + " N" (smallest N>=2) not in `inUse`.
 * Comparison is case-insensitive and trimmed, matching peer-graph name resolution. Empty or
 * whitespace-only input falls back to `assignNodeName`.
 */
export function ensureUniqueNodeName(desired: string, inUse: ReadonlySet<string>): string {
  const trimmed = desired.trim();
  if (trimmed === '') return assignNodeName(inUse);
  const normalized = normalizedSet(inUse);
  if (!normalized.has(normalize(trimmed))) return trimmed;
  let suffix = 2;
  while (normalized.has(normalize(`${trimmed} ${suffix}`))) suffix += 1;
  return `${trimmed} ${suffix}`;
}

function normalize(name: string): string {
  return name.trim().toLowerCase();
}

function normalizedSet(inUse: ReadonlySet<string>): ReadonlySet<string> {
  return new Set([...inUse].map(normalize));
}
