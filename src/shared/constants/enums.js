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
  DELETED: 'deleted'
});

export const authProviderEnum = Object.freeze({
  SYSTEM: "SYSTEM",
  GOOGLE: "GOOGLE",
  APPLE: "APPLE",
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
  BRANDS: 'brands',
  PRODUCTS: 'products',
  ORDERS: 'orders',
  COUPONS: 'coupons',
  BANNERS: 'banners',
  COLLECTIONS: 'collections',
  CARTS: 'carts',
  LOYALTY_POINTS: 'loyalty_points',
  NOTIFICATIONS: 'notifications',
  RETURNS: 'return',
  SERVICE_LOCATIONS: 'service_locations',
  SERVICE_RESERVATIONS: 'service_reservations',
  WALLET: 'wallet',
  WAREHOUSES: 'warehouses'
});

export const productTypeEnum = Object.freeze({
  SIMPLE: 'SIMPLE',
  VARIANT: 'VARIANT',
});

export const cartStatusEnum = Object.freeze({
  ACTIVE: 'ACTIVE',
  ABANDONED: 'ABANDONED',
});

export const serviceTypeEnum = Object.freeze({
  GROOMING: 'GROOMING',
  SHOWERING: 'SHOWERING',
  CLINIC: 'CLINIC',
});

export const serviceRoomTypeEnum = Object.freeze({
  GROOMING_ROOM: 'GROOMING_ROOM',
  CLINIC_ROOM: 'CLINIC_ROOM',
});

export const serviceReservationStatusEnum = Object.freeze({
  BOOKED: 'BOOKED',
  CANCELLED: 'CANCELLED',
  COMPLETED: 'COMPLETED',
  NO_SHOW: 'NO_SHOW',
});
