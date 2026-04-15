# Petyard Checkout Flow — Frontend Guide

## Overview

There are two payment methods: **COD** (Cash on Delivery) and **Card**. Both use the same endpoint to place an order, but the response and what you do after are different.

---

## Flow 1: COD (Simple — nothing changed)

```
User taps "Place Order" with COD
        ↓
FE calls:  POST /orders/me
Body:      { paymentMethod: "cod", couponCode: "SAVE10", notes: "Ring bell" }
        ↓
BE returns 201:
{
  data: { _id: "abc123", orderNumber: "PY-20260401-XYZW1234", status: "pending", ... }
}
        ↓
FE navigates to "Order Confirmation" screen ✅
Cart is already cleared by the backend.
```

**That's it.** Nothing new here.

---

## Flow 2: Card Payment (New Flow)

### Step 1: Place Order

User taps "Place Order" with Card selected.

```
FE calls:  POST /orders/me
Body:      { paymentMethod: "card", couponCode: "SAVE10", notes: "Ring bell" }
```

> If the user selected a saved card, also include: `savedCardId: "saved_card_id_here"`

### Step 2: Check the Response

BE returns **200** (not 201!) with a special response:

```json
{
  "data": {
    "_id": "abc123",
    "orderNumber": "PY-20260401-XYZW1234",
    "status": "awaiting_payment",
    "total": 330,
    ...
  },
  "action": "requires_payment",
  "clientSecret": "ZWdwX2ludF9saXZlX2xxxxxxxxxxxxxx",
  "publicKey": "pk_live_xxxxxxxxx"
}
```

**What each field means:**
| Field | What it is |
|---|---|
| `data` | The order object (but it's not confirmed yet, status is `awaiting_payment`) |
| `action` | Always `"requires_payment"` for card orders. This is how you know to open the payment screen. |
| `clientSecret` | Token you pass to the Paymob SDK to open the payment screen |
| `publicKey` | Paymob public key, also needed by the SDK |

**Save the `_id` from `data` — you'll need it in Step 4.**

### Step 3: Open Paymob Payment Screen

Use the Paymob Flutter SDK to open the payment UI:

```dart
await PaymobSDK.pay(clientSecret: clientSecret);
```

The user sees the card entry form, types their card info, and completes payment. The SDK handles everything (3D Secure, OTP, etc).

### Step 4: SDK Returns — Show YOUR Loading Screen

> [!IMPORTANT]
> **The Paymob SDK does NOT keep a processing screen up while waiting for the webhook.** When the bank responds, the SDK fires a callback and closes immediately. You MUST show your own loading overlay.

The SDK gives you a callback with `response.success` (true/false). This is a **client-side hint** — useful for UI, but the real source of truth is the backend webhook.

Here's what happens under the hood when the user clicks "Pay":

```
User clicks "Pay" in Paymob screen
              ↓
     SDK contacts the bank
     (3D Secure / OTP if needed)
              ↓
       Bank responds to Paymob
              ↓
   ┌─────────┴──────────┐
   │  TWO THINGS HAPPEN │
   │   AT THE SAME TIME  │
   └─────────┬──────────┘
             │
    ┌────────┴────────┐
    ▼                 ▼
[Path A]          [Path B]
SDK fires          Paymob fires
onPayment()        webhook to
callback &         YOUR server
closes screen      (POST /payments/webhook)
```

**What the FE should do:**

| SDK callback says | What it means | What to do |
|---|---|---|
| `response.success = true` | Bank approved the card | Show loading spinner → poll backend to **confirm** |
| `response.success = false` | Bank rejected / user cancelled | Hide spinner → show error → stay on checkout |

> [!WARNING]
> **Never trust `response.success = true` alone to navigate to the success screen.** It's client-side and can be faked. Always confirm with the backend.

### Step 5: Poll Backend for Confirmation (only on success)

When the SDK says success, show a full-screen loading overlay ("Processing your payment...") and poll the backend:

```dart
final order = await api.get('/orders/me/$orderId');
```

Check `order.status`:
| Status | Meaning | What to do |
|---|---|---|
| `"pending"` | ✅ Payment confirmed by webhook, order is real | Navigate to Order Confirmation screen |
| `"cancelled"` | ❌ Something went wrong server-side | Show error message, stay on checkout page |
| `"awaiting_payment"` | ⏳ Webhook hasn't arrived yet | Wait 2 seconds, then check again |

### Step 6: Retry Logic (for the ⏳ case)

The webhook usually arrives in 1-3 seconds, but sometimes it's slow. Retry up to 5 times with a 2-second gap:

```dart
Future<void> _pollForConfirmation(String orderId) async {
  for (int i = 0; i < 5; i++) {
    final order = await api.get('/orders/me/$orderId');

    if (order['status'] == 'pending') {
      // ✅ SUCCESS — navigate to confirmation
      hideLoader();
      navigateTo(OrderConfirmationScreen(orderId: orderId));
      return;
    }

    if (order['status'] == 'cancelled') {
      // ❌ FAILED — show error, stay on checkout
      hideLoader();
      showError('Payment failed. Try again or use a different method.');
      return;
    }

    // Still awaiting_payment — wait and retry
    await Future.delayed(Duration(seconds: 2));
  }

  // After 5 retries (10 seconds), still awaiting_payment
  hideLoader();
  showMessage('Your order is being processed. Check "My Orders" for updates.');
}
```

---

## Complete Flutter Code Example

```dart
Future<void> placeOrder() async {
  // Show loading on the Place Order button
  setState(() => isLoading = true);

  try {
    // ──────────────────────────────────────────────
    // 1. Call the create order API
    // ──────────────────────────────────────────────
    final response = await api.post('/orders/me', {
      'paymentMethod': selectedMethod,     // "cod" or "card"
      'couponCode': couponCode,            // optional
      'notes': notes,                      // optional
      'savedCardId': selectedSavedCardId,  // optional, only for card
    });

    // ──────────────────────────────────────────────
    // 2. COD? Done! Navigate to success.
    // ──────────────────────────────────────────────
    if (response['action'] == null) {
      navigateTo(OrderConfirmationScreen(order: response['data']));
      return;
    }

    // ──────────────────────────────────────────────
    // 3. Card — open Paymob payment screen
    // ──────────────────────────────────────────────
    if (response['action'] == 'requires_payment') {
      final orderId = response['data']['_id'];
      final clientSecret = response['clientSecret'];

      // Open Paymob payment UI — user enters card, clicks Pay
      await PaymobSDK.pay(
        clientSecret: clientSecret,
        onPayment: (paymentResponse) async {

          if (paymentResponse.success) {
            // ──────────────────────────────────────
            // 4. SDK says success → show OUR loader
            //    and poll backend to CONFIRM
            // ──────────────────────────────────────
            showFullScreenLoader("Processing your payment...");
            await _pollForConfirmation(orderId);

          } else {
            // ──────────────────────────────────────
            // 5. SDK says failure → show error
            //    Cart is still intact, user stays
            //    on checkout and can retry
            // ──────────────────────────────────────
            showError(
              'Payment failed. You can try again or choose another payment method.'
            );
          }
        },
      );
    }
  } on ApiException catch (e) {
    // Handle API errors (e.g., "out of stock", "payment in progress")
    showError(e.message);
  } finally {
    setState(() => isLoading = false);
  }
}

// ──────────────────────────────────────────────────
// Poll backend until order is confirmed or cancelled
// ──────────────────────────────────────────────────
Future<void> _pollForConfirmation(String orderId) async {
  for (int attempt = 0; attempt < 5; attempt++) {
    try {
      final response = await api.get('/orders/me/$orderId');
      final status = response['data']['status'];

      if (status == 'pending') {
        // ✅ Payment confirmed by webhook!
        hideLoader();
        navigateTo(OrderConfirmationScreen(orderId: orderId));
        return;
      }

      if (status == 'cancelled') {
        // ❌ Something went wrong server-side
        hideLoader();
        showError('Payment could not be processed. Please try again.');
        return;  // Stay on checkout — cart is still there
      }
    } catch (e) {
      // Network error during status check — keep retrying
    }

    // ⏳ Still "awaiting_payment" — wait 2 seconds
    await Future.delayed(Duration(seconds: 2));
  }

  // Gave up after 5 retries (10 seconds total)
  hideLoader();
  showMessage('Your order is being processed. Check your orders for updates.');
  navigateTo(OrdersListScreen());
}
```

---

## UX Timeline — What the User Actually Sees

```
┌─────────────────────────────────────┐
│  1. Checkout Page                   │
│     User taps "Place Order"         │
│     [Loading on button]             │
└──────────────┬──────────────────────┘
               ↓
┌─────────────────────────────────────┐
│  2. Paymob SDK Payment Screen       │
│     (Card form, 3D Secure, OTP)     │
│     User enters card → taps "Pay"   │
└──────────────┬──────────────────────┘
               ↓
┌─────────────────────────────────────┐
│  3. YOUR Full-Screen Loader         │
│     "Processing your payment..."    │
│     ⏳ (1-5 seconds typically)      │
│                                     │
│     This is YOUR screen, not the    │
│     SDK's. You show it immediately  │
│     when onPayment fires with       │
│     success = true.                 │
└──────────────┬──────────────────────┘
               ↓
       ┌───────┴───────┐
       ↓               ↓
┌──────────────┐ ┌──────────────┐
│ ✅ Success   │ │ ❌ Failed    │
│ Order        │ │ Error toast  │
│ Confirmation │ │ Back to      │
│ Screen       │ │ Checkout     │
└──────────────┘ └──────────────┘
```

---

## What Happens After a Failed Payment?

This is the best part of the new flow:

- **Cart is NOT cleared.** Everything is still in the cart exactly as it was.
- **The user stays on the checkout page.**
- They can **try paying again** with a different card → a new order is created.
- They can **switch to COD** → works perfectly, normal COD flow.
- The failed order sits on the backend as `cancelled` — the user never sees it.

---

## Error Cases the FE Should Handle

| Error | HTTP Code | When it happens | What to show |
|---|---|---|---|
| `"You already have a payment in progress"` | 409 | User tapped "Place Order" twice quickly | "You already have a pending payment. Please wait." |
| `"Cart is empty"` | 400 | Cart was somehow cleared | "Your cart is empty" |
| `"Insufficient stock for X"` | 400 | Product went out of stock between browsing and checkout | "Sorry, [product] is no longer available in this quantity" |
| `"Payment initialization failed"` | 502 | Paymob is down | "Payment service is temporarily unavailable. Try again later." |
| `"Delivery address is missing..."` | 400 | Address not fully set | "Please complete your delivery address" |

---

## Visual Flow Diagram

```
┌─────────────────────────────────────────────┐
│           User taps "Place Order"           │
└──────────────────┬──────────────────────────┘
                   │
          ┌────────┴────────┐
          │   COD or Card?  │
          └────┬───────┬────┘
               │       │
          COD  │       │  Card
               │       │
               ▼       ▼
        ┌──────────┐  ┌──────────────────────┐
        │ 201 JSON │  │ 200 JSON             │
        │ { data } │  │ { data, action,      │
        └────┬─────┘  │   clientSecret,      │
             │        │   publicKey }         │
             ▼        └──────────┬───────────┘
     Order Confirmed             │
          ✅                     ▼
                        ┌────────────────┐
                        │ Open Paymob    │
                        │ Payment Screen │
                        └───────┬────────┘
                                │
                      User completes payment
                                │
                                ▼
                     ┌─────────────────────┐
                     │ SDK onPayment fires │
                     │ success = true/false│
                     └────────┬────────────┘
                              │
                    ┌─────────┴──────────┐
                    │                    │
               success=true        success=false
                    │                    │
                    ▼                    ▼
          ┌──────────────────┐    ❌ Show error
          │ Show YOUR loader │    Stay on checkout
          │ "Processing..."  │    Cart is intact
          └────────┬─────────┘
                   │
                   ▼
          ┌────────────────┐
          │ GET /orders/   │
          │ me/{orderId}   │◄──── retry up to 5x
          └───────┬────────┘      (2s apart)
                  │
        ┌─────────┼──────────┐
        │         │          │
   "pending"  "awaiting_  "cancelled"
        │      payment"      │
        ▼         │          ▼
   ✅ Success  ⏳ Retry   ❌ Failed
   Go to order  (wait 2s)  Show error
   confirmation            Stay on
                           checkout
```

---

## Quick FAQ

**Q: Do I need to create any new screens?**
A: No new screens. You just need: (1) modify the checkout/place-order logic, and (2) add a full-screen loading overlay for the "Processing payment..." state.

**Q: Does the cart get cleared on card payment?**
A: Only after the payment **succeeds** and the backend webhook confirms it. If it fails, the cart stays intact.

**Q: What if the user kills the app during payment?**
A: The backend has a cleanup job that cancels unpaid orders after 30 minutes. The cart stays intact. Next time the user opens the app, they can try again.

**Q: Can the user see `awaiting_payment` orders in "My Orders"?**
A: Yes, but they'll be very short-lived (seconds to minutes). They'll transition to `pending` or `cancelled` quickly.

**Q: What endpoint do I use to check order status?**
A: `GET /orders/me/{orderId}` — the same endpoint you already use to view an order.

**Q: Should I trust the SDK's `response.success` to show the success screen?**
A: **No.** Use it only to decide whether to show the loading spinner or the error message. Always confirm with the backend via polling before navigating to the success screen.

**Q: What if polling times out (5 retries, still `awaiting_payment`)?**
A: Show a message like "Your order is being processed" and send the user to the Orders list. The webhook will arrive eventually and update the order status.
