export const roles = Object.freeze({
  SUPER_ADMIN: 'superAdmin',
  ADMIN: 'admin',
  MODERATOR: 'moderator',
  USER: 'user',
  GUEST: 'guest'
});

export const accountStatus = Object.freeze({
  PENDING: 'pending',
  CONFIRMED: 'confirmed',
  PANNED: 'panned',
});


export const orderStatusEnum = Object.freeze({
  PENDING: 'pending',
  ACCEPTED: 'accepted',
  SHIPPED: 'shipped',
  DELIVERED: 'delivered',
  CANCELLED: 'cancelled',
  RETURNED: 'returned'
});

export const paymentMethodEnum = Object.freeze({
  COD: 'cod',
  CARD: 'card',
});
export const paymentStatusEnum = Object.freeze({
  PENDING: 'pending',
  PAID: 'paid',
  FAILED: 'failed',
  REFUNDED: 'refunded'
});

export const returnStatusEnum = Object.freeze({
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected'
});


export const enabledControls = Object.freeze({
  USERS: 'users',
  CONDITIONS: 'conditions',
  PETS: 'pets',
  CATEGORIES: 'categories',
  SUBCATEGORIES: 'subcategories',
  PRODUCTS: 'products',
  ORDERS: 'orders',
  COUPONES: 'coupons',
  BANNERS: 'banners'
});
