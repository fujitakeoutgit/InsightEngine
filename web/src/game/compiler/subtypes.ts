/**
 * The subtypes a phrase may name: "target Ally you control", "an Eldrazi
 * card", "Zombies you control".
 *
 * A list rather than a guess. Any word in front of "you control" could be
 * taken for a type, and then "attacking creature" would quietly become a
 * creature of the type Attacking that nothing ever is. A word that is not
 * here leaves its sentence unread instead, which is the honest way to fail.
 */

const CREATURE_TYPES = `
Advisor Aetherborn Alien Ally Angel Antelope Ape Archer Archon Armadillo Army Artificer Assassin
Astartes Atog Aurochs Avatar Azra Badger Balloon Barbarian Bard Basilisk Bat Bear Beast Beaver
Beeble Beholder Berserker Bird Blinkmoth Boar Bringer Brushwagg Camarid Camel Capybara Caribou
Carrier Cat Centaur Cephalid Child Chimera Citizen Cleric Clown Cockatrice Construct Coward Coyote
Crab Crocodile Custodes Cyberman Cyclops Dalek Dauthi Demigod Demon Deserter Detective Devil
Dinosaur Djinn Doctor Dog Dragon Drake Dreadnought Drone Druid Dryad Dwarf Efreet Egg Elder Eldrazi
Elemental Elephant Elf Elk Employee Eye Faerie Ferret Fish Flagbearer Fox Fractal Frog Fungus Gamer
Gamma Gargoyle Germ Giant Gith Glimmer Gnoll Gnome Goat Goblin God Golem Gorgon Graveborn Gremlin
Griffin Guest Hag Halfling Hamster Harpy Hellion Hero Hippo Hippogriff Homarid Homunculus Horror
Horse Human Hydra Hyena Illusion Imp Incarnation Inkling Inquisitor Insect Jackal Jellyfish
Juggernaut Kavu Kirin Kithkin Knight Kobold Kor Kraken Lamia Lammasu Leech Leviathan Lhurgoyf Licid
Lizard Llama Manticore Masticore Mercenary Merfolk Metathran Minion Minotaur Mite Mole Monger
Mongoose Monk Monkey Moonfolk Mount Mouse Mutant Myr Mystic Naga Nautilus Necron Nephilim Nightmare
Nightstalker Ninja Noble Noggle Nomad Nymph Octopus Ogre Ooze Orb Orc Orgg Otter Ouphe Ox Oyster
Pangolin Peasant Pegasus Pentavite Performer Pest Phelddagrif Phoenix Phyrexian Pilot Pincher Pirate
Plant Porcupine Possum Praetor Primarch Prism Processor Rabbit Raccoon Ranger Rat Rebel Reflection
Rhino Rigger Robot Rogue Sable Salamander Samurai Sand Saproling Satyr Scarecrow Scientist Scion
Scorpion Scout Sculpture Serf Serpent Servo Shade Shaman Shapeshifter Shark Sheep Siren Skeleton
Slith Sliver Sloth Slug Snail Snake Soldier Soltari Sorcerer Spawn Specter Spellshaper Sphinx Spider
Spike Spirit Splinter Sponge Squid Squirrel Starfish Surrakar Survivor Symbiote Synth Tentacle
Tetravite Thalakos Thopter Thrull Tiefling Toy Treefolk Trilobite Triskelavite Troll Turtle Tyranid
Unicorn Vampire Varmint Vedalken Villain Volver Wall Walrus Warlock Warrior Weasel Weird Werewolf
Whale Wizard Wolf Wolverine Wombat Worm Wraith Wurm Yeti Zombie Zubera
`.trim().split(/\s+/)

const OTHER_TYPES = `
Attraction Blood Bobblehead Clue Contraption Equipment Food Fortification Gold Incubator Junk Lander
Map Powerstone Spacecraft Treasure Vehicle
Aura Background Cartouche Case Class Curse Plan Role Room Rune Saga Shard Shrine
Cave Desert Forest Gate Island Lair Locus Mine Mountain Plains Planet Sphere Swamp Tower Town
Adventure Arcane Lesson Omen Trap
`.trim().split(/\s+/)

const BY_LOWER = new Map([...CREATURE_TYPES, ...OTHER_TYPES].map((t) => [t.toLowerCase(), t]))
const CREATURES = new Set(CREATURE_TYPES)

/** Plurals that are not the singular with an "s". */
const IRREGULAR: Record<string, string> = {
  elves: 'elf', dwarves: 'dwarf', wolves: 'wolf', werewolves: 'werewolf', pegasi: 'pegasus',
  fungi: 'fungus', cyclopes: 'cyclops', oxen: 'ox', mice: 'mouse',
}

/** The subtype a word names, singular or plural, as it is written on a type
 *  line — "allies" → "Ally" — or null if it names none. */
export function subtypeOf(word: string): string | null {
  const w = word.toLowerCase()
  const tries = [
    w,
    IRREGULAR[w],
    w.replace(/ies$/, 'y'),
    w.replace(/ies$/, 'ie'),
    w.replace(/es$/, ''),
    w.replace(/s$/, ''),
  ]
  for (const attempt of tries) {
    const found = attempt && BY_LOWER.get(attempt)
    if (found) return found
  }
  return null
}

/** Is this subtype a creature type — one a changeling has? */
export const isCreatureType = (subtype: string) => CREATURES.has(subtype)
