import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import express from "express";
import { deliveryFixture } from "./helpers/productDeliveryFixture.js";

async function product(f, client, input = f.pickup, idempotencyKey = randomUUID()) {
  const quote = await f.service.createProductCheckoutQuote({ userId: f.customer.id, payload: { items: f.items, fulfillment: input } });
  const payload = { items: f.items, fulfillment: input, quoteToken: quote.quoteToken, idempotencyKey, ...(client === undefined ? {} : { client }) };
  const result = await f.service.createMercadoPagoCheckout({ userId: f.customer.id, payload, requireProductFulfillment: true, mercadoPagoApi: f.api });
  return { result, payload, order: f.tables.Order.find((row) => row.id === result.orderId),
    payment: f.tables.Payment.find((row) => row.orderId === result.orderId) };
}

async function http(f, t) {
  const app = express(); app.use(express.json());
  app.use("/api", (await f.load("routes/checkoutRoutes.js")).default);
  app.use("/api", (await f.load("routes/orderRoutes.js")).default);
  const server = await new Promise((resolve) => { const server = app.listen(0, "127.0.0.1", () => resolve(server)); });
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return async (path, user, method = "GET", body) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api${path}`, { method,
      redirect: "manual", headers: { ...(user ? { Authorization: `Bearer ${await f.tokenFor(user)}` } : {}), "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    return { response, status: response.status, body: response.status < 300 || response.status >= 400 ? await response.json() : null };
  };
}

test("default and explicit web keep original back_urls and reuse legacy preferences", async () => {
  const f = await deliveryFixture(); const purchase = await product(f);
  const pref = f.preferences[0];
  for (const result of ["success", "pending", "failure"]) {
    assert.equal(pref.back_urls[result], `http://localhost:5173/pago/resultado?orderId=${purchase.order.id}&result=${result}`);
  }
  const again = await f.service.createMercadoPagoCheckout({ userId: f.customer.id, payload: { ...purchase.payload, client: "web" }, mercadoPagoApi: f.api });
  assert.equal(again.preferenceId, purchase.result.preferenceId); assert.equal(f.preferences.length, 1);
});

test("mobile product pickup and delivery preserve shipping, amounts and trusted HTTPS returns", async () => {
  for (const delivery of [false, true]) {
    const f = await deliveryFixture(); const purchase = await product(f, "mobile", delivery ? { method: "delivery", address: f.address } : f.pickup);
    assert.equal(purchase.order.total, delivery ? "275.00" : "200.00");
    assert.equal(f.preferences[0].shipments?.cost || 0, delivery ? 75 : 0);
    for (const result of ["success", "pending", "failure"]) {
      assert.equal(f.preferences[0].back_urls[result], `https://backend.example.test/api/checkout/mercadopago/mobile-return/cart/${result}?orderId=${purchase.order.id}`);
    }
    assert.equal(f.preferences[0].notification_url, "https://backend.example.test/api/webhooks/mercadopago");
    assert.equal(f.preferences[0].auto_return, "approved");
    assert.equal(purchase.payment.metadata.checkoutRequest.client, "mobile");
  }
});

test("mobile individual, student and group memberships keep server plan and correct return destination", async () => {
  for (const type of ["individual", "student", "group"]) {
    const f = await deliveryFixture();
    const plan = await f.models.MembershipPlan.create({ type, name: "Plan", price: "440.00", durationDays: 30, isActive: true, memberLimit: 4 });
    const result = await f.service.createMercadoPagoCheckout({ userId: f.customer.id, payload: {
      idempotencyKey: randomUUID(), membershipPlanId: plan.id, client: "mobile",
      ...(type === "group" ? { memberEmails: ["member@example.com"] } : {}),
      returnUrl: "https://attacker.example", back_urls: { success: "https://attacker.example" },
    }, mercadoPagoApi: f.api });
    assert.ok(f.preferences[0].back_urls.success.includes(`/mobile-return/memberships/success?orderId=${result.orderId}`));
    assert.equal(f.tables.OrderItem[0].itemType, type === "group" ? "group_membership" : "membership");
    assert.equal(f.tables.Order[0].total, "440.00");
    assert.equal(JSON.stringify(f.preferences[0]).includes("attacker"), false);
  }
});

test("changing client on an existing idempotency key conflicts and never creates another order or preference", async () => {
  for (const [first, second] of [[undefined, "mobile"], ["mobile", "web"]]) {
    const f = await deliveryFixture(); const purchase = await product(f, first);
    await assert.rejects(f.service.createMercadoPagoCheckout({ userId: f.customer.id,
      payload: { ...purchase.payload, client: second }, mercadoPagoApi: f.api }), { statusCode: 409 });
    assert.equal(f.tables.Order.length, 1); assert.equal(f.tables.Payment.length, 1); assert.equal(f.preferences.length, 1);
  }
});

test("concurrent mobile checkout retries create one local payment and preference", async () => {
  const f = await deliveryFixture();
  const quote = await f.service.createProductCheckoutQuote({ userId: f.customer.id, payload: { items: f.items, fulfillment: f.pickup } });
  const payload = { idempotencyKey: randomUUID(), items: f.items, fulfillment: f.pickup, quoteToken: quote.quoteToken, client: "mobile" };
  const results = await Promise.all(Array.from({ length: 5 }, () => f.service.createMercadoPagoCheckout({ userId: f.customer.id, payload, mercadoPagoApi: f.api })));
  assert.equal(new Set(results.map((row) => row.preferenceId)).size, 1);
  assert.equal(f.preferences.length, 1); assert.equal(f.tables.Order.length, 1); assert.equal(f.tables.Payment.length, 1);
});

test("unrecognized clients fail before any writes and mobile backend URL must be HTTPS without credentials", async () => {
  const f = await deliveryFixture();
  for (const client of ["Mobile", "https://attacker.example", {}, ["mobile"]]) {
    await assert.rejects(product(f, client), { statusCode: 400 });
  }
  assert.equal(f.tables.Order.length, 0);
  for (const url of ["http://backend.example.test", "https://user:secret@backend.example.test", "https://backend.example.test?url=attacker", "https://backend.example.test/#x"]) {
    f.env.BACKEND_PUBLIC_URL = url;
    await assert.rejects(product(f, "mobile"), (error) => error.statusCode >= 500);
  }
  assert.equal(f.preferences.length, 0);
});

test("return endpoints whitelist destinations and discard status, tokens, redirects and private provider data", async (t) => {
  const f = await deliveryFixture(), request = await http(f, t), purchase = await product(f, "mobile");
  for (const destination of ["cart", "memberships"]) for (const result of ["success", "pending", "failure", "cancelled"]) {
    const response = await request(`/checkout/mercadopago/mobile-return/${destination}/${result}?orderId=${purchase.order.id}&result=success&status=approved&access_token=secret&redirect=https://attacker.example&payment_id=123`);
    assert.equal(response.status, 302);
    assert.equal(response.response.headers.get("location"), `pryapptsg://${destination}/payment-result?orderId=${purchase.order.id}`);
    assert.equal(response.response.headers.get("cache-control"), "no-store");
    assert.equal(response.response.headers.get("referrer-policy"), "no-referrer");
    assert.equal(purchase.payment.status, "pending"); assert.equal(f.tables.Receipt.length, 0);
  }
  for (const path of [`cart/success?orderId=bad`, `evil/success?orderId=${purchase.order.id}`, `cart/approved?orderId=${purchase.order.id}`,
    `cart/success?orderId=${purchase.order.id}&orderId=${purchase.order.id}`]) {
    assert.equal((await request("/checkout/mercadopago/mobile-return/" + path)).status, 400);
  }
});

test("manual browser close and cancelled/failure returns never cancel or approve server payment", async (t) => {
  const f = await deliveryFixture(), request = await http(f, t), purchase = await product(f, "mobile");
  // Closing a browser produces no HTTP callback. A later authenticated query
  // must keep showing pending until a verified webhook arrives.
  const path = `/orders/${purchase.order.id}/payment-status?result=success&status=approved`;
  assert.equal((await request(path, f.customer)).body.payment.status, "pending");
  assert.equal((await request(path)).status, 401);
  assert.equal((await request(path, f.other)).status, 404);
  for (const result of ["cancelled", "failure"]) await request(`/checkout/mercadopago/mobile-return/cart/${result}?orderId=${purchase.order.id}`);
  assert.equal(purchase.payment.status, "pending");
  await f.webhook(purchase);
  assert.equal((await request(path, f.customer)).body.payment.status, "paid");
});

test("mobile verified webhook results and duplicates retain inventory, receipt and financial idempotency", async () => {
  for (const [status, expected] of [["approved", "paid"], ["pending", "pending"], ["in_process", "pending"], ["rejected", "failed"], ["cancelled", "cancelled"]]) {
    const f = await deliveryFixture(), purchase = await product(f, "mobile");
    await f.webhook(purchase, status, "8800100", "same-event");
    await f.webhook(purchase, status, "8800100", "same-event");
    assert.equal(purchase.payment.status, expected, status);
    assert.equal(f.tables.Receipt.length, status === "approved" ? 1 : 0);
    assert.equal(f.tables.InventoryMovement.filter((row) => row.movementType === "sale").length,
      status === "approved" ? 1 : 0);
  }
});
