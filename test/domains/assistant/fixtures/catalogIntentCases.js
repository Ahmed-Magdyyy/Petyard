const pet = "pet:111111111111111111111111", other = "pet:222222222222222222222222";
const none = { weight: null, price: null, options: [] };
const row = (id, language, input, expected, review) => ({ id, language, replyLanguage: language === "arabizi" ? "ar" : language, input, expected: {
  action: "pet", scopes: ["pet_care", "petyard"], subjectAction: "keep", subjectId: pet, warning: null, ...none, ...expected }, review });

// Synthetic evaluation inputs and expectations; these are never catalog facts or launch policy.
export const catalogIntentCases = [
  row("ar_weight_price_flavor", "ar", "عايز دراي فود لقطتي ميلو، كيس ٣ كيلو أو أكتر، وسعره مايزيدش عن ١٠٠٠ جنيه، بطعم فراخ.",
    { weight: 3000, price: 100000, options: [{ name: "flavor", value: "فراخ" }] },
    "Preserve cat/dry-food intent, minimum mass, maximum EGP price and exact flavor quote. Do not certify suitability."),
  row("arabizi_weight_price", "arabizi", "3ayez dry food le Milo el 2otta, 3 kilo aw aktar, mesh aktar men 1000 geneh.",
    { weight: 3000, price: 100000 }, "Understand the complete Arabizi sentence and negated maximum. Do not invent flavor or another pet."),
  row("en_price_color", "en", "Show pink cat toys for Milo, up to EGP 300.",
    { price: 30000, options: [{ name: "color", value: "pink" }] }, "Preserve cat/toy intent and exact color. Do not infer weight or flavor."),
  row("ar_pet_toys", "ar", "وريني ألعاب للقطط لميلو من غير ما تفترض وزن أو سعر معين.", {},
    "Use pet shopping with no invented filters. Empty search reply; backend supplies results."),
  row("arabizi_pet_toys", "arabizi", "warreeni le3ab lel 2otat le Milo, ma3andish budget mo3ayan.", {},
    "Understand toy shopping and no specified budget. Do not convert Arabizi numerals into package mass."),
  row("en_general_browse", "en", "Show cat toys for general browsing; this is not a recommendation for either of my pets.",
    { action: "general", subjectId: null }, "Keep explicitly unpersonalized browsing separate; no health or suitability claim."),
  row("ar_no_shopping", "ar", "مش عايز أشتري أكل دلوقتي، عايز فكرتين لعب بسيطتين مع ميلو في البيت.",
    { action: "none", scopes: ["pet_care"] }, "Reply naturally in Egyptian Arabic with low-risk play ideas. Respect the explicit shopping negation."),
  row("arabizi_no_shopping", "arabizi", "mesh 3ayez ashtary food delwa2ty, 3ayez fekreteen le3b baseeta ma3 Milo fel beit.",
    { action: "none", scopes: ["pet_care"] }, "Understand Arabizi and reply naturally in Egyptian Arabic. Food mentioned under negation must not trigger shopping."),
  row("en_no_shopping", "en", "Do not search for products. Give me two simple indoor play ideas for Milo instead.",
    { action: "none", scopes: ["pet_care"] }, "Provide play ideas in English. No catalog intent or claimed search."),
  row("ar_same_turn_warning", "ar", "ميلو عنده حساسية من الفراخ، وريني ألعاب للقطط.",
    { warning: "ميلو عنده حساسية من الفراخ", scopes: ["pet_care", "petyard", "health"] }, "Capture only the user's exact reported warning for Milo; search toys without certifying clinical suitability."),
  row("arabizi_switch", "arabizi", "Roy el kalb, mesh Milo el 2otta: warreeni le3ab leeh howa.",
    { action: "none", subjectAction: "select", targetId: other }, "Resolve Roy's owned ID first. Empty draft, no memory/search; do not transfer Milo's facts. No second call in this pack."),
  row("en_urgent_before_shopping", "en", "Milo is struggling to breathe right now. Can you also find a toy?",
    { action: "none", scopes: ["urgent"] }, "Immediate veterinary escalation before shopping. Human and veterinary review required; a structural gate is not clinical acceptance."),
];
