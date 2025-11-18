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
  PRODUCTS: 'products',
  ORDERS: 'orders',
  WAREHOUSES: 'warehouses',
  PROMOTIONS: 'promotions',
});
