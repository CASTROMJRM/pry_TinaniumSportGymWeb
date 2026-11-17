import { Router } from "express";
import {
  createMercadoPagoCheckoutPreference,
  createProductMercadoPagoCheckoutPreference,
  receiveMercadoPagoWebhook,
} from "../controllers/checkoutController.js";
import { verifyToken, authorizeRole } from "../middleware/authMiddleware.js";
import { checkBlacklist } from "../middleware/checkBlacklist.js";
import { returnToMobilePayment } from "../controllers/mobilePaymentReturnController.js";

const router = Router();
router.get("/checkout/mercadopago/mobile-return/:destination/:result", returnToMobilePayment);

router.post(
  "/checkout/products/mercadopago",
  verifyToken,
  checkBlacklist,
  authorizeRole("cliente", "administrador"),
  createProductMercadoPagoCheckoutPreference
);

router.post(
  "/checkout/mercadopago",
  verifyToken,
  checkBlacklist,
  authorizeRole("cliente", "administrador"),
  createMercadoPagoCheckoutPreference
);

router.post("/webhooks/mercadopago", receiveMercadoPagoWebhook);

export default router;
