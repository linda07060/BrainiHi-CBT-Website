import { Controller, Post, Body, UseGuards, Req, Get, Param, Res, HttpCode, Logger, BadRequestException, HttpException, Delete, NotFoundException } from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { PaymentsService } from "./payments.service";
import { Request, Response } from "express";

@Controller("api/payments")
export class PaymentsController {
  private readonly logger = new Logger(PaymentsController.name);

  constructor(private readonly paymentsService: PaymentsService) {}

  private getUserIdFromReq(req: Request): number {
    const user = (req as any).user ?? {};
    const raw = user?.sub ?? user?.id ?? user?.userId ?? null;
    const id = typeof raw === "string" ? Number(raw) : raw;
    if (!id || Number.isNaN(Number(id))) {
      throw new BadRequestException("Invalid or missing user id");
    }
    return Number(id);
  }

  @Post("create-order")
  @UseGuards(JwtAuthGuard)
  async createOrder(@Req() req: Request, @Body() body: { plan: string; billingPeriod?: string; reason?: string }) {
    const userId = this.getUserIdFromReq(req);
    const plan = body.plan ?? "Pro";
    const billing = body.billingPeriod ?? "monthly";
    const res = await this.paymentsService.createOrder(userId, plan, billing);
    const payment = res?.payment ?? null;
    return {
      orderID: res.orderID,
      paymentId: payment?.id ?? null,
      payment: payment
        ? {
            id: payment.id,
            date: (payment as any).createdAt ?? new Date().toISOString(),
            amount: typeof payment.amount === "number" ? payment.amount.toFixed(2) : String(payment.amount ?? "0.00"),
            currency: payment.currency ?? "USD",
            status: payment.status ?? "pending",
            receipt_url: `/receipt/${payment.id}`,
            reason: (payment as any).raw ? (((typeof payment.raw === "string" ? JSON.parse(payment.raw) : payment.raw).__meta?.reason) ?? null) : null,
            change_to: (payment as any).raw ? (((typeof payment.raw === "string" ? JSON.parse(payment.raw) : payment.raw).__meta?.change_to) ?? null) : null,
            plan: (payment as any).plan ?? null,
          }
        : null,
    };
  }

  // Create a pending invoice (client calls this ASAP so UI shows a pending invoice while PayPal flow runs)
  @Post("create-pending")
  @UseGuards(JwtAuthGuard)
  async createPending(
    @Req() req: Request,
    @Body()
    body: {
      plan?: string;
      billingPeriod?: string;
      amount?: string;
      client_temp_id?: string;
      clientTempId?: string;
      createdAt?: string;
      created_at?: string;
      reason?: string;
    },
  ) {
    const userId = this.getUserIdFromReq(req);
    try {
      // Prefer createdAt (camel) or created_at (snake) if provided by client
      const clientTempId = body.client_temp_id ?? body.clientTempId ?? null;
      const createdAt = body.createdAt ?? body.created_at ?? null;
      this.logger.debug(
        `[payments.controller] createPending called by user=${userId} plan=${body.plan} billing=${body.billingPeriod} created_at=${createdAt} reason=${body.reason} client_temp_id=${clientTempId}`,
      );

      // Strict dedupe: try to find an existing pending in the same minute before creating
      try {
        const existing = await this.paymentsService.findExistingPending(userId, body.plan ?? "Pro", body.billingPeriod ?? "monthly", createdAt ?? null);
        if (existing) {
          this.logger.debug(`[payments.controller] createPending: returning existing pending for user=${userId}`);
          return { payment: existing, paymentId: existing.id ?? null };
        }
      } catch (e) {
        // continue to create if lookup fails
        this.logger.debug(`[payments.controller] createPending: existing lookup failed, proceeding - ${e as any}`);
      }

      const payment = await this.paymentsService.createPendingPayment(
        userId,
        body.plan,
        body.billingPeriod,
        body.amount ?? null,
        clientTempId ?? null,
        createdAt ?? null,
        body.reason ?? null,
      );
      const date = (payment as any)?.date ?? (payment as any)?.raw?.__meta?.createdAt ?? null;
      this.logger.debug(`[payments.controller] createPending created/returned payment id=${payment?.id ?? "null"} user=${userId} created_at=${date ?? "unknown"}`);
      return { payment, paymentId: payment.id ?? null };
    } catch (err) {
      this.logger.warn("[payments] createPending failed", (err as any)?.message ?? err);
      throw new HttpException({ statusCode: 500, message: "Failed to create pending invoice", error: (err as any)?.message ?? String(err) }, 500);
    }
  }

  // Attach PayPal order to existing payment (authenticated)
  @Post("attach-order")
  @UseGuards(JwtAuthGuard)
  async attachOrder(@Req() req: Request, @Body() body: { paymentId: number | string; orderID: string; raw?: any }) {
    const userId = this.getUserIdFromReq(req);
    const paymentId = Number(body.paymentId);
    const orderID = body.orderID;
    if (!paymentId || Number.isNaN(paymentId)) throw new BadRequestException("Invalid paymentId");
    if (!orderID || String(orderID).trim() === "") throw new BadRequestException("Invalid orderID");
    try {
      const invoice = await this.paymentsService.attachOrderToPayment(userId, paymentId, orderID, body.raw ?? null);
      return { payment: invoice, paymentId: invoice.id };
    } catch (err) {
      this.logger.warn("[payments] attachOrder failed", (err as any)?.message ?? err);
      throw new HttpException({ statusCode: 500, message: "Failed to attach order to invoice", error: (err as any)?.message ?? String(err) }, 500);
    }
  }

  // Public attach (no auth) used as fallback when the client cannot authenticate
  @Post("attach-order-public")
  async attachOrderPublic(@Body() body: { orderID: string; raw?: any; createdAt?: string; created_at?: string; client_temp_id?: string }) {
    const orderID = body?.orderID;
    if (!orderID || String(orderID).trim() === "") throw new BadRequestException("Invalid orderID");
    try {
      // Prefer createdAt if provided by the client
      const createdAt = body.createdAt ?? body.created_at ?? null;
      const clientTempId = body.client_temp_id ?? null;
      this.logger.debug(`[payments.controller] attachOrderPublic orderID=${orderID} created_at=${createdAt ?? "none"} client_temp_id=${clientTempId ?? "none"}`);
      const invoice = await this.paymentsService.attachOrderPublic(String(orderID), body.raw ?? null, createdAt ?? null, clientTempId ?? null);
      return { payment: invoice, paymentId: invoice.id };
    } catch (err) {
      this.logger.warn("[payments] attachOrderPublic failed", (err as any)?.message ?? err);
      throw new HttpException({ statusCode: 500, message: "Failed to attach order (public)", error: (err as any)?.message ?? String(err) }, 500);
    }
  }

  @Post("capture")
  @UseGuards(JwtAuthGuard)
  async capture(@Req() req: Request, @Body() body: { orderID: string }) {
    const userId = this.getUserIdFromReq(req);
    const orderID = body.orderID;
    const saved = await this.paymentsService.captureOrder(userId, orderID);
    return saved;
  }

  @Get("invoices")
  @UseGuards(JwtAuthGuard)
  async invoices(@Req() req: Request) {
    const userId = this.getUserIdFromReq(req);
    const items = await this.paymentsService.listInvoicesForUserCurated(userId);
    // Ensure created_at/date are included (invoice DTO uses date which maps to created_at on server)
    return items.map((it) => ({
      id: it.id,
      date: it.date,
      amount: it.amount,
      currency: it.currency,
      status: it.status,
      receipt_url: it.receipt_url,
      reason: it.reason ?? null,
      change_to: it.change_to ?? null,
      plan: it.plan ?? null,
    }));
  }

  @Get("payment-method")
  @UseGuards(JwtAuthGuard)
  async paymentMethod(@Req() req: Request) {
    const userId = this.getUserIdFromReq(req);
    const pm = await this.paymentsService.getPaymentMethodPreview(userId);
    return pm;
  }

  @Get(":id")
  @UseGuards(JwtAuthGuard)
  async getPayment(@Req() req: Request, @Param("id") id: string) {
    const userId = this.getUserIdFromReq(req);
    const parsed = Number(id);
    if (!parsed || Number.isNaN(parsed)) throw new BadRequestException("Invalid payment id");
    const p = await this.paymentsService.getPaymentForUser(userId, parsed);
    return p;
  }

  @Get("check-access")
  @UseGuards(JwtAuthGuard)
  async checkAccess(@Req() req: Request) {
    try {
      const user = (req as any).user;
      const raw = user?.sub ?? user?.id ?? user?.userId ?? null;
      const userId = typeof raw === "string" ? Number(raw) : raw;
      if (!userId || Number.isNaN(Number(userId))) {
        return {
          allowed: false,
          activeSubscription: false,
          hasSuccessfulPayment: false,
          plan: user ? (user.plan ?? "Free") : "Free",
          plan_expiry: null,
          reason: "invalid_user",
        };
      }
      const info = await this.paymentsService.getAccessInfo(Number(userId));
      return {
        allowed: Boolean(info?.allowed ?? false),
        activeSubscription: Boolean(info?.activeSubscription ?? false),
        hasSuccessfulPayment: Boolean(info?.hasSuccessfulPayment ?? false),
        plan: info?.plan ?? (user?.plan ?? "Free"),
        plan_expiry: info?.plan_expiry ?? null,
        reason: info?.reason ?? null,
        pendingAmount: info?.pendingAmount ?? null,
      };
    } catch (err) {
      this.logger.warn("[payments] checkAccess error", err?.message ?? err);
      const user = (req as any).user ?? {};
      const profilePlan = user?.plan ?? "Free";
      const isProfileFree = String(profilePlan).toLowerCase().includes("free");
      return {
        allowed: isProfileFree ? true : false,
        activeSubscription: false,
        hasSuccessfulPayment: false,
        plan: profilePlan,
        plan_expiry: null,
        reason: "internal_error",
      };
    }
  }

  @Post("portal")
  @UseGuards(JwtAuthGuard)
  async portal(@Req() req: Request) {
    this.getUserIdFromReq(req);
    return { url: null };
  }

  @Post("cancel")
  @UseGuards(JwtAuthGuard)
  async cancel(@Req() req: Request) {
    this.getUserIdFromReq(req);
    return { message: "Cancellation via PayPal is handled by PayPal subscriptions. Contact support." };
  }

  @Post("reactivate")
  @UseGuards(JwtAuthGuard)
  async reactivate(@Req() req: Request) {
    this.getUserIdFromReq(req);
    return { message: "Reactivation via PayPal subscriptions must be managed in PayPal. Contact support." };
  }

  // Public webhook endpoint (PayPal)
  @Post("webhook")
  @HttpCode(200)
  async webhook(@Req() req: Request, @Res() res: Response) {
    const event = req.body;
    setImmediate(async () => {
      try {
        await this.paymentsService.handleWebhook(event);
      } catch (err) {
        this.logger.warn("Webhook handler background error", err as any);
      }
    });
    res.json({ received: true });
  }

  // Debug endpoint to return recent raw payments for authenticated user (useful while debugging)
  @Get("debug/recent")
  @UseGuards(JwtAuthGuard)
  async debugRecent(@Req() req: Request) {
    const userId = this.getUserIdFromReq(req);
    this.logger.debug(`[payments.controller] debugRecent requested by user=${userId}`);
    const rows = await this.paymentsService.listPaymentsForUser(userId);
    return rows;
  }

  /* ---------- New: delete single and clear pending endpoints ---------- */

  // Delete a single payment by id (authenticated)
  @Delete(":id")
  @UseGuards(JwtAuthGuard)
  async deletePayment(@Req() req: Request, @Param("id") id: string) {
    const userId = this.getUserIdFromReq(req);
    const parsed = Number(id);
    if (!parsed || Number.isNaN(parsed)) throw new BadRequestException("Invalid payment id");
    try {
      const deleted = await this.paymentsService.deletePaymentForUser(userId, parsed);
      if (!deleted) throw new NotFoundException("Payment not found");
      return { success: true };
    } catch (err) {
      this.logger.warn(`[payments.controller] deletePayment failed id=${id}`, (err as any)?.message ?? err);
      throw err;
    }
  }

  // Clear all pending payments for authenticated user
  @Delete("clear-pending")
  @UseGuards(JwtAuthGuard)
  async clearPending(@Req() req: Request) {
    const userId = this.getUserIdFromReq(req);
    try {
      const deletedCount = await this.paymentsService.clearPendingForUser(userId);
      return { success: true, deleted: deletedCount };
    } catch (err) {
      this.logger.warn(`[payments.controller] clearPending failed user=${userId}`, (err as any)?.message ?? err);
      throw err;
    }
  }
}