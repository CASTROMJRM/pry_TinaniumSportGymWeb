const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Navigation only. Never look up or mutate a payment from an untrusted return.
// The app fetches /api/orders/:id/payment-status with its authenticated session.
export function returnToMobilePayment(req, res) {
  res.set({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
  const { destination, result } = req.params;
  const orderId = req.query.orderId;
  if (!["cart", "memberships"].includes(destination) ||
      !["success", "pending", "failure", "cancelled"].includes(result) ||
      typeof orderId !== "string" || !UUID.test(orderId)) {
    return res.status(400).json({ error: "Retorno de pago inválido." });
  }
  // Do not forward provider query parameters, tokens, URLs or purported status.
  return res.redirect(302, `pryapptsg://${destination}/payment-result?orderId=${encodeURIComponent(orderId)}`);
}
