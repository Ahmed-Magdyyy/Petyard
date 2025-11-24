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
