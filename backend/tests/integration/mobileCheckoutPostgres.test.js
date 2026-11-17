import assert from "node:assert/strict";
import { test } from "node:test";
import { createHmac, randomUUID } from "node:crypto";
import { Sequelize } from "sequelize";
import { WebhookSignatureValidator } from "mercadopago";
import { checkoutPostgresFixture } from "../helpers/checkoutPostgresFixture.js";
import { validateMobilePostgresTarget } from "../helpers/mobilePostgresTarget.js";

test("mobile Checkout Pro: real PostgreSQL preferences, concurrency and duplicate signed webhooks", {
  skip: !process.env.MOBILE_TEST_DATABASE_URL, timeout: 60000,
}, async (t) => {
  const target = process.env.MOBILE_TEST_DATABASE_URL;
  validateMobilePostgresTarget(target, process.env.MOBILE_TEST_ALLOW_LOCAL_DDL);
  const db = new Sequelize(target, { dialect: "postgres", logging: false, pool: { min: 0, max: 8 },
    dialectOptions: { ssl: false, statement_timeout: 15000, connectionTimeoutMillis: 5000 } });
  let ownsSchema = false;
  t.after(async () => { try { if (ownsSchema) await db.query('DROP SCHEMA "core" CASCADE'); } finally { await db.close(); } });
  const [identity] = await db.query("SELECT current_database() AS name, inet_server_addr()::text AS address");
  assert.equal(identity[0].name, "titanium_mobile_test");
  assert.ok(["127.0.0.1/32", "127.0.0.1", "::1/128", "::1"].includes(identity[0].address));
  const [schemas] = await db.query("SELECT 1 FROM information_schema.schemata WHERE schema_name='core'");
  assert.equal(schemas.length, 0, "Refusing to modify any existing schema.");
  await db.query('CREATE SCHEMA "core"'); ownsSchema = true;
  const f = await checkoutPostgresFixture(db);
  // Production model definitions, isolated new DB only. The schema is owned
  // by this test and no application environment/configuration is loaded.
  await db.sync();
  await db.query(`CREATE TABLE "core"."OrderNumberCounters" (
    "year" INTEGER PRIMARY KEY, "lastValue" INTEGER NOT NULL,
    "createdAt" TIMESTAMPTZ NOT NULL, "updatedAt" TIMESTAMPTZ NOT NULL);
    CREATE UNIQUE INDEX "payments_order_id_paid_unique" ON "core"."Payments" ("orderId") WHERE "status"='paid';`);
  const user = await f.models.User.create({ email: "local-checkout@example.com", role: "cliente", isVerified: true });
  const preferences = [];
  const providerPayments = new Map();
  const api = {
    async createPreference({ body, idempotencyKey }) {
      preferences.push(body);
      await new Promise((resolve) => setTimeout(resolve, 50));
      return { id: "pref-" + idempotencyKey, init_point: "https://www.mercadopago.com.mx/checkout/test" };
    },
    async getPayment({ id }) { return providerPayments.get(String(id)); },
    validateSignature: (input) => WebhookSignatureValidator.validate(input),
  };
  let purchase;
  await t.test("five simultaneous mobile requests use one payment, order and preference", async () => {
    const plan = await f.models.MembershipPlan.create({ name: "Monthly", slug: "isolated-monthly", price: "440.00", type: "individual" });
    const payload = { client: "mobile", membershipPlanId: plan.id, idempotencyKey: randomUUID() };
    const results = await Promise.all(Array.from({ length: 5 }, () => f.service.createMercadoPagoCheckout({ userId: user.id, payload, mercadoPagoApi: api })));
    assert.equal(new Set(results.map((row) => row.preferenceId)).size, 1);
    assert.equal(preferences.length, 1); assert.equal(await f.models.Order.count(), 1); assert.equal(await f.models.Payment.count(), 1);
    assert.ok(preferences[0].back_urls.success.includes("/mobile-return/memberships/success"));
    purchase = { ...results[0], payload };
  });
  await t.test("web/mobile mismatch on an existing preference conflicts without any writes", async () => {
    await assert.rejects(f.service.createMercadoPagoCheckout({ userId: user.id, payload: { ...purchase.payload, client: "web" }, mercadoPagoApi: api }), { statusCode: 409 });
    assert.equal(await f.models.Order.count(), 1); assert.equal(await f.models.Payment.count(), 1); assert.equal(preferences.length, 1);
  });
  await t.test("concurrent signed duplicate payment notifications activate exactly one receipt/subscription", async () => {
    const payment = await f.models.Payment.findOne({ where: { orderId: purchase.orderId } });
    const providerId = "98001001001";
    providerPayments.set(providerId, { id: providerId, status: "approved", status_detail: "accredited",
      transaction_amount: 440, currency_id: "MXN", external_reference: purchase.orderId,
      preference_id: payment.providerPreferenceId, metadata: { payment_id: payment.id, order_id: purchase.orderId, user_id: user.id } });
    const notify = async (requestId) => {
      const ts = String(Date.now());
      const signature = createHmac("sha256", f.env.MERCADOPAGO_WEBHOOK_SECRET).update(`id:${providerId};request-id:${requestId};ts:${ts};`).digest("hex");
      return f.service.processMercadoPagoWebhook({ mercadoPagoApi: api,
        headers: { "x-request-id": requestId, "x-signature": `ts=${ts},v1=${signature}` },
        query: { "data.id": providerId, type: "payment" }, body: { type: "payment", data: { id: providerId } } });
    };
    await Promise.all([notify("parallel-1"), notify("parallel-2")]);
    await notify("parallel-1");
    assert.equal((await payment.reload()).status, "paid");
    assert.equal(await f.models.Receipt.count({ where: { paymentId: payment.id } }), 1);
    assert.equal(await f.models.UserSubscription.count({ where: { paymentId: payment.id } }), 1);
    assert.equal(await f.models.SubscriptionHistory.count({ where: { paymentId: payment.id } }), 1);
  });
});
