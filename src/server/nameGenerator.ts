// Random two-word name generator (adjective-noun)

const ADJECTIVES = [
  'bold', 'calm', 'cool', 'dark', 'deep', 'fair', 'fast', 'free', 'gold',
  'good', 'gray', 'keen', 'kind', 'late', 'lean', 'live', 'loud', 'mint',
  'neat', 'nice', 'pale', 'pure', 'rare', 'rich', 'safe', 'slim', 'soft',
  'sure', 'tall', 'tidy', 'tiny', 'true', 'warm', 'wide', 'wild', 'wise',
  'blue', 'red', 'green', 'swift', 'bright', 'quick', 'sharp', 'fresh',
]

const NOUNS = [
  'arch', 'band', 'bark', 'barn', 'base', 'bay', 'beam', 'bear', 'bell',
  'bend', 'birch', 'bird', 'blade', 'bloom', 'bluff', 'boat', 'bolt', 'bond',
  'bone', 'book', 'boot', 'boss', 'bowl', 'box', 'branch', 'brass', 'brick',
  'bridge', 'brook', 'bud', 'bush', 'camp', 'canyon', 'cape', 'cave', 'cedar',
  'chain', 'chalk', 'charm', 'chest', 'chip', 'clay', 'cliff', 'cloud', 'coast',
  'coin', 'colt', 'cone', 'coral', 'core', 'cork', 'cove', 'crab', 'craft',
  'crane', 'creek', 'crest', 'crow', 'crown', 'crust', 'cube', 'cup', 'curve',
  'dale', 'dam', 'dart', 'dawn', 'deer', 'delta', 'den', 'dew', 'disk', 'dock',
  'dome', 'dove', 'drift', 'drop', 'drum', 'dune', 'dusk', 'dust', 'eagle',
  'edge', 'elm', 'ember', 'fall', 'farm', 'fawn', 'fern', 'field', 'fin',
  'fire', 'fish', 'flame', 'flare', 'flash', 'flask', 'flint', 'float', 'flock',
  'flood', 'floor', 'flow', 'foam', 'fog', 'ford', 'forge', 'fork', 'form',
  'fort', 'fox', 'frame', 'frost', 'gale', 'gap', 'gate', 'gaze', 'gear',
  'gem', 'glen', 'glow', 'goat', 'gorge', 'grain', 'grape', 'grass', 'grove',
  'gulf', 'gust', 'hall', 'hare', 'harp', 'haven', 'hawk', 'haze', 'heath',
  'hedge', 'helm', 'heron', 'hill', 'hive', 'hold', 'hollow', 'hood', 'hoof',
  'hook', 'hope', 'horn', 'inlet', 'iron', 'isle', 'ivy', 'jade', 'jar',
  'jay', 'jazz', 'jewel', 'kelp', 'key', 'kiln', 'king', 'kite', 'knoll',
  'knot', 'lace', 'lake', 'lamp', 'lance', 'land', 'lane', 'larch', 'lark',
  'latch', 'leaf', 'ledge', 'lemon', 'lens', 'light', 'lily', 'lime', 'link',
  'lion', 'loft', 'log', 'loop', 'lotus', 'lynx', 'maple', 'mark', 'marsh',
  'mask', 'mast', 'meadow', 'mint', 'mist', 'moat', 'mold', 'moon', 'moor',
  'moss', 'moth', 'mound', 'mouse', 'mud', 'nest', 'node', 'notch', 'oak',
  'oar', 'oasis', 'ocean', 'olive', 'orbit', 'otter', 'owl', 'oxbow', 'pace',
  'pad', 'palm', 'pan', 'pass', 'patch', 'path', 'paw', 'peak', 'pear',
  'peat', 'perch', 'pier', 'pike', 'pine', 'pit', 'plain', 'plane', 'plum',
  'plume', 'pod', 'point', 'pond', 'pool', 'port', 'post', 'pouch', 'prism',
  'pulse', 'quartz', 'quay', 'quest', 'quill', 'rail', 'rain', 'ram', 'range',
  'rapid', 'raven', 'ray', 'reach', 'reed', 'reef', 'ridge', 'rift', 'ring',
  'rise', 'river', 'road', 'roam', 'robin', 'rock', 'rod', 'root', 'rope',
  'rose', 'rust', 'sage', 'sail', 'salt', 'sand', 'scale', 'scar', 'seal',
  'seed', 'shade', 'shaft', 'shard', 'shell', 'shore', 'shrub', 'silk', 'silo',
  'sink', 'slate', 'slope', 'smoke', 'snail', 'snow', 'soil', 'sound', 'spark',
  'spire', 'spoke', 'spore', 'spot', 'spring', 'sprout', 'spur', 'stag', 'stake',
  'star', 'steel', 'stem', 'step', 'still', 'stone', 'stork', 'storm', 'strait',
  'strand', 'straw', 'stream', 'stripe', 'stub', 'stump', 'sun', 'surf', 'swamp',
  'swan', 'sway', 'swift', 'tarn', 'temple', 'thaw', 'thorn', 'thyme', 'tide',
  'tile', 'timber', 'toast', 'torch', 'tower', 'trace', 'track', 'trail', 'trap',
  'tree', 'trench', 'trough', 'trout', 'trunk', 'tulip', 'tundra', 'turf', 'twig',
  'vale', 'valley', 'vault', 'veil', 'vein', 'verge', 'verse', 'vine', 'vista',
  'void', 'wadi', 'wake', 'walk', 'wall', 'walnut', 'ward', 'warp', 'wash',
  'watch', 'wave', 'weald', 'web', 'wedge', 'well', 'wheat', 'wheel', 'willow',
  'wind', 'wing', 'wisp', 'wolf', 'wood', 'wool', 'wren', 'yacht', 'yard', 'yarn',
  'yew', 'yoke', 'zeal', 'zenith', 'zinc', 'zone',
]

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]
}

export function generateSessionName(): string {
  return `${pick(ADJECTIVES)}-${pick(NOUNS)}`
}

const MAX_RETRIES = 100

export function generateUniqueSessionName(
  exists: (name: string) => boolean
): string {
  for (let i = 0; i < MAX_RETRIES; i++) {
    const name = generateSessionName()
    if (!exists(name)) {
      return name
    }
  }
  // Fallback: append random suffix if all retries exhausted
  return `${generateSessionName()}-${Date.now().toString(36).slice(-4)}`
}
