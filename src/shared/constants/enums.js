export const roles = Object.freeze({
  SUPER_ADMIN: 'superAdmin',
  ADMIN: 'admin',
  MODERATOR: 'moderator',
  USER: 'user',
});

export const accountStatus = Object.freeze({
  PENDING: 'pending',
  CONFIRMED: 'confirmed',
  PANNED: 'panned',
});


export const enabledControls = Object.freeze({
  USERS: 'users',
  CONDITIONS: 'conditions',
  PETS: 'pets',
  CATEGORIES: 'categories',
  SUBCATEGORIES: 'subcategories',
  PRODUCTS: 'products',
  ORDERS: 'orders',
});

export const GOVERNORATES = Object.freeze({
  ALEXANDRIA: 'alexandria',
  CAIRO: 'cairo',
  GIZA: 'giza',
  DAKAHLIA: 'dakahlia',
  RED_SEA: 'red_sea',
  BEHEIRA: 'beheira',
  FAYOUM: 'fayoum',
  GHARBIA: 'gharbia',
  ISMAILIA: 'ismailia',
  MONUFIA: 'monufia',
  MINYA: 'minya',
  QALYUBIA: 'qalyubia',
  NEW_VALLEY: 'new_valley',
  NORTH_SINAI: 'north_sinai',
  PORT_SAID: 'port_said',
  SHARQIA: 'sharqia',
  SOHAG: 'sohag',
  SOUTH_SINAI: 'south_sinai',
  DAMIETTA: 'damietta',
  KAFR_EL_SHEIKH: 'kafr_el_sheikh',
  MATROUH: 'matrouh',
  LUXOR: 'luxor',
  QENA: 'qena',
  ASYUT: 'asyut',
  BENI_SUEF: 'beni_suef',
  ASWAN: 'aswan',
  SUEZ: 'suez',
});

export const SUPPORTED_GOVERNORATES = Object.freeze([
  GOVERNORATES.ALEXANDRIA,
  GOVERNORATES.CAIRO,
  GOVERNORATES.GIZA,
]);
