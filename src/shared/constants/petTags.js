export const petTypeTags = Object.freeze({
  DOG: "dog",
  CAT: "cat",
  BIRD: "bird",
  SMALL_ANIMAL: "small-animal",
});

export const petLifeStageTags = Object.freeze({
  BABY: "baby",
  ADULT: "adult",
});

export const knownBreedTagsByPetType = Object.freeze({
  [petTypeTags.CAT]: Object.freeze([
    "baladi",
    "persian",
    "scottish-fold",
    "siamese",
    "mixed-breed",
    "other",
  ]),
  [petTypeTags.DOG]: Object.freeze([
    "baladi",
    "poodle",
    "yorkshire-terrier",
    "maltese",
    "cocker",
    "pomeranian",
    "pug",
    "shih-tzu",
    "french-bulldog",
    "english-bulldog",
    "american-bulldog",
    "cavalier-king",
    "pekingese",
    "malinois",
    "golden-retriever",
    "german-shepherd",
    "rottweiler",
    "husky",
    "great-dane",
    "mastiff",
    "dogo-argentino",
    "pitbull",
    "bully",
    "saint-bernard",
    "cane-corso",
    "mixed-breed",
    "other",
  ]),
  [petTypeTags.BIRD]: Object.freeze(["birds", "parrot"]),
  [petTypeTags.SMALL_ANIMAL]: Object.freeze(["hamster", "turtle", "rabbit"]),
});

export const breedAliasMapByPetType = Object.freeze({
  [petTypeTags.CAT]: Object.freeze({
    "scotch-fold": "scottish-fold",
    "scottishfold": "scottish-fold",
  }),
  [petTypeTags.DOG]: Object.freeze({
    maltses: "maltese",
    "german-shepard": "german-shepherd",
    gsd: "german-shepherd",
    "grad-dan": "great-dane",
    "great-dan": "great-dane",
    yorkshire: "yorkshire-terrier",
  }),
  [petTypeTags.BIRD]: Object.freeze({
    bird: "birds",
  }),
  [petTypeTags.SMALL_ANIMAL]: Object.freeze({
    "small-animals": "small-animal",
    "small-animal": "small-animal",
  }),
});

export const nonSpecificBreedTags = Object.freeze([
  "mixed-breed",
  "other",
]);
