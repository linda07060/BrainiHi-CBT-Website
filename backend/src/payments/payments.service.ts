/* payments.service.ts
   Complete PaymentsService with create/attach/capture/list helpers and added deletion/clear methods.
   Ready to copy.
*/
import { Injectable, Logger, BadRequestException, NotFoundException, HttpException, ForbiddenException } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository, DataSource, In } from "typeorm";
import { Payment } from "./payments.entity";
import { createOrderOnPayPal, captureOrderOnPayPal, getOrderOnPayPal } from "./paypal.client";
import { User } from "../user/user.entity";

/**
 * Shape of the access info returned by getAccessInfo / checkAccess.
 */
export interface AccessInfo {
  allowed: boolean;
  activeSubscription: boolean;
  hasSuccessfulPayment: boolean;
  plan: string | null;
  plan_expiry: string | null;
  reason?: string | null;
  pendingAmount?: string | null;
}

/**
 * Invoice DTO returned to the frontend by listInvoicesForUser
 */
export interface InvoiceDTO {
  id: number | string;
  date: string | Date;
  amount: string;
  currency: string;
  status: string;
  receipt_url: string;
  reason?: "change_plan" | "past_due" | "next_due" | "regular" | "unknown";
  change_to?: string | null;
  plan?: string | null;
  raw?: any;
}

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    @InjectRepository(Payment)
    private readonly paymentRepo: Repository<Payment>,
    private readonly dataSource: DataSource,
  ) {}

  /* ---------- Helpers ---------- */

  private ensureValidUserId(userId: any): number {
    const id = typeof userId === "string" ? Number(userId) : userId;
    if (!id || Number.isNaN(Number(id))) {
      throw new BadRequestException("Invalid user id");
    }
    return Number(id);
  }

  private mapPlanPrice(plan: string, billingPeriod?: string) {
    const p = (plan || "Pro").toLowerCase();
    if (p === "pro") {
      if (billingPeriod === "yearly") return { amount: "99.00", currency: "USD" };
      return { amount: "12.99", currency: "USD" };
    }
    if (p === "tutor") {
      if (billingPeriod === "yearly") return { amount: "199.00", currency: "USD" };
      return { amount: "24.99", currency: "USD" };
    }
    return { amount: "0.00", currency: "USD" };
  }

  private formatAmount(value: any): string {
    try {
      const n = Number(value ?? 0);
      if (Number.isFinite(n)) return n.toFixed(2);
      return String(value);
    } catch {
      return String(value ?? "0.00");
    }
  }

  private invoiceShapeFromRow(row: any): InvoiceDTO {
    const id = row.id;
    // Prefer the canonical created_at column (DB authoritative) or entity property createdAt
    const date = row.created_at ?? row.createdAt ?? new Date().toISOString();
    const amount = this.formatAmount(row.amount);
    const currency = row.currency ?? "USD";
    const status = row.status ?? "pending";
    let parsedRaw: any = null;
    try {
      parsedRaw = row.raw ? (typeof row.raw === "string" ? JSON.parse(row.raw) : row.raw) : null;
    } catch {
      parsedRaw = row.raw ?? null;
    }
    return {
      id,
      date,
      amount,
      currency,
      status,
      receipt_url: `/receipt/${id}`,
      reason: row.reason ?? (parsedRaw && parsedRaw.__meta && parsedRaw.__meta.reason) ?? null,
      change_to: row.change_to ?? (parsedRaw && parsedRaw.__meta && parsedRaw.__meta.change_to) ?? null,
      plan: row.plan ?? null,
      raw: parsedRaw,
    } as InvoiceDTO;
  }

  /* ---------- New helper: findExistingPending ---------- */

  /**
   * Find an existing pending invoice for the user that matches the minute bucket.
   * Returns invoice DTO or null.
   */
  public async findExistingPending(userId: number, plan?: string, billingPeriod?: string, createdAt?: string | null): Promise<InvoiceDTO | null> {
    const uid = this.ensureValidUserId(userId);
    const planName = (plan ?? "Pro");
    const billing = billingPeriod ?? "monthly";

    // Normalize minute bucket from createdAt (or now)
    let createdIso = new Date().toISOString();
    if (createdAt) {
      try {
        const d = new Date(createdAt);
        if (!isNaN(d.getTime())) createdIso = d.toISOString();
      } catch {}
    }
    const minuteBucket = new Date(createdIso);
    minuteBucket.setSeconds(0, 0);

    const pendingStatuses = ["pending", "created", "pending_capture", "authorized"];

    try {
      const qb = this.paymentRepo.createQueryBuilder("p")
        .where("COALESCE(p.user_id, 0) = COALESCE(:uid, 0)", { uid })
        .andWhere("p.plan = :planName", { planName })
        .andWhere("p.status IN (:...statuses)", { statuses: pendingStatuses })
        .andWhere("p.created_at_minute = :minute", { minute: minuteBucket.toISOString() })
        .orderBy("p.created_at", "DESC")
        .limit(1);

      if (billing === "" || billing === null) {
        qb.andWhere("p.billing_period IS NULL");
      } else {
        qb.andWhere("p.billing_period = :bp", { bp: billing });
      }

      const found = await qb.getOne();
      if (found) return this.invoiceShapeFromRow(found as any);

      return null;
    } catch (err) {
      this.logger.debug("findExistingPending query failed: " + (err as any));
      return null;
    }
  }

  /* ---------- Public API (create / capture / list / get) ---------- */

  public async createOrder(userId: number, plan: string, billingPeriod?: string): Promise<{ payment: Payment; orderID: string }> {
    const uid = this.ensureValidUserId(userId);
    const price = this.mapPlanPrice(plan, billingPeriod);
    if (!price || Number(price.amount) <= 0) throw new BadRequestException("Invalid or free plan selected");

    // statuses considered "pending"
    const pendingStatuses = ["pending", "created", "pending_capture", "authorized"];

    // Attempt to reuse only when an existing pending row already has an associated PayPal order id.
    try {
      const existing = await this.paymentRepo.findOne({
        where: { user_id: uid, plan: plan, status: In(pendingStatuses) } as any,
        order: { createdAt: "DESC" },
      });

      if (existing && (existing as any).paypalOrderId) {
        return { payment: existing, orderID: (existing as any).paypalOrderId };
      }
      // Otherwise create new order/row
    } catch (err) {
      this.logger.warn("createOrder: lookup for existing pending row failed, proceeding to create new. Err: " + (err as any));
    }

    // create new PayPal order and insert new payments row
    const purchaseUnits = [
      {
        amount: { currency_code: price.currency, value: String(price.amount) },
        description: `BrainiHi subscription — ${plan} (${billingPeriod ?? "one-off"})`,
      },
    ];

    const order = await createOrderOnPayPal(purchaseUnits, "CAPTURE");
    const orderID = order?.id ?? null;
    if (!orderID) {
      this.logger.error("PayPal order creation failed", order);
      throw new Error("PayPal order creation failed");
    }

    let reason: string | null = "regular";
    let change_to: string | null = null;
    try {
      const userRepo = this.dataSource.getRepository(User);
      const user = await userRepo.findOne({ where: { id: uid } } as any);
      const currentPlan = user?.plan ?? null;
      if (currentPlan && String(currentPlan).toLowerCase() !== String(plan).toLowerCase()) {
        reason = "change_plan";
        change_to = plan;
      }
    } catch (err) {
      this.logger.debug("createOrder: unable to fetch user for reason detection", err as any);
    }

    const now = new Date();
    // compute minute bucket
    const minuteBucket = new Date(now);
    minuteBucket.setSeconds(0, 0);

    const insertObj: any = {
      user_id: uid,
      plan,
      billing_period: billingPeriod ?? null,
      amount: Number(price.amount),
      currency: price.currency,
      paypal_order_id: orderID,
      status: "pending",
      raw: JSON.stringify({ __meta: { reason, change_to } }),
      created_at: now,
      created_at_minute: minuteBucket,
      updated_at: now,
    };

    const result = await this.dataSource
      .createQueryBuilder()
      .insert()
      .into("payments")
      .values(insertObj)
      .returning("*")
      .execute();

    const savedRaw = result?.raw && result.raw[0] ? result.raw[0] : null;
    const saved = (savedRaw as any) as Payment;

    try {
      const parsedRaw = saved.raw ? (typeof saved.raw === "string" ? JSON.parse(saved.raw) : saved.raw) : {};
      parsedRaw.__meta = parsedRaw.__meta || {};
      parsedRaw.__meta.reason = parsedRaw.__meta.reason ?? reason;
      parsedRaw.__meta.change_to = parsedRaw.__meta.change_to ?? change_to;
      // Persist created_at into raw.__meta to help client correlate authoritative row
      try {
        const createdAtIso = saved.createdAt ? new Date(saved.createdAt).toISOString() : new Date().toISOString();
        parsedRaw.__meta.createdAt = parsedRaw.__meta.createdAt ?? createdAtIso;
        parsedRaw.__meta.created_at = parsedRaw.__meta.created_at ?? createdAtIso;
      } catch {}
      saved.raw = parsedRaw;
      await this.paymentRepo.save(saved);
    } catch (err) {
      this.logger.debug("createOrder: unable to attach reason/change_to into raw JSON", err as any);
    }

    return { payment: saved, orderID };
  }

  /**
   * Create a pending invoice row for the user.
   * Will attempt to insert a new row, but relies on DB unique index on created_at_minute to prevent near-duplicates.
   * If a unique-violation occurs the existing minute-bucket row is returned.
   */
  public async createPendingPayment(
    userId: number,
    plan?: string,
    billingPeriod?: string,
    amount?: string | null,
    clientTempId?: string | null,
    createdAt?: string | null,
    reason?: string | null,
  ) {
    const uid = this.ensureValidUserId(userId);
    const planName = plan ?? "Pro";
    const billing = billingPeriod ?? "monthly";

    const price = (() => {
      try {
        if (amount && String(amount).trim() !== "") return { amount: this.formatAmount(amount), currency: "USD" };
      } catch {}
      return this.mapPlanPrice(planName, billing);
    })();

    // Normalize createdAt (if provided) or use server now
    let nowIso = new Date().toISOString();
    if (createdAt) {
      try {
        const d = new Date(createdAt);
        if (!isNaN(d.getTime())) nowIso = d.toISOString();
      } catch {
        // ignore invalid createdAt and use server timestamp
      }
    }
    const createdAtDate = new Date(nowIso);
    const minuteBucket = new Date(createdAtDate);
    minuteBucket.setSeconds(0, 0);

    // Build raw metadata and ensure client_temp_id is saved inside raw.__meta
    const rawMeta: any = { __meta: { reason: reason ?? "regular", change_to: planName } };
    if (clientTempId && String(clientTempId).trim() !== "") {
      rawMeta.__meta.client_temp_id = String(clientTempId);
    }
    rawMeta.__meta.createdAt = nowIso;
    rawMeta.__meta.created_at = nowIso;

    // Try insert; handle unique-violation by returning the existing minute-bucket row
    // If clientTempId provided, try upsert by client_temp_id first
    if (clientTempId && String(clientTempId).trim() !== "") {
      try {
        const insertSql = `
          INSERT INTO payments (
            client_temp_id, user_id, plan, billing_period, amount, currency, status, raw, created_at, created_at_minute, updated_at
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::timestamptz,$10::timestamptz,$11::timestamptz)
          ON CONFLICT (client_temp_id) DO UPDATE
            SET updated_at = EXCLUDED.updated_at
          RETURNING *;
        `;
        const params: any[] = [
          clientTempId,
          uid,
          planName,
          billing === "" ? null : billing,
          Number(price.amount),
          price.currency,
          "pending",
          JSON.stringify(rawMeta),
          createdAtDate.toISOString(),
          minuteBucket.toISOString(),
          createdAtDate.toISOString(),
        ];
        const rows: any[] = await this.dataSource.query(insertSql, params);
        if (rows && rows.length > 0) return this.invoiceShapeFromRow(rows[0]);
      } catch (err) {
        this.logger.debug("createPendingPayment upsert by client_temp_id failed: " + (err as any));
      }
    }

    const insertObj: any = {
      user_id: uid,
      plan: planName,
      billing_period: billing === "" ? null : billing,
      amount: Number(price.amount),
      currency: price.currency,
      status: "pending",
      idempotency_key: null,
      raw: JSON.stringify(rawMeta),
      created_at: createdAtDate,
      created_at_minute: minuteBucket,
      updated_at: createdAtDate,
      client_temp_id: clientTempId ?? null,
    };

    try {
      // Pre-check for existing pending in same minute bucket (strict dedupe)
      try {
        const existing = await this.findExistingPending(uid, planName, billing, createdAtDate.toISOString());
        if (existing) return existing;
      } catch {}

      const result = await this.dataSource.createQueryBuilder().insert().into("payments").values(insertObj).returning("*").execute();
      const insertedRow = result?.raw?.[0] ?? null;
      if (insertedRow) {
        const persisted = await this.paymentRepo.findOne({ where: { id: insertedRow.id } as any });
        if (persisted) return this.invoiceShapeFromRow(persisted);
        return this.invoiceShapeFromRow(insertedRow);
      }

      // fallback
      const fallback = await this.paymentRepo.findOne({
        where: { user_id: uid, plan: planName },
        order: { createdAt: "DESC" },
      });
      if (fallback) return this.invoiceShapeFromRow(fallback as any);
    } catch (err: any) {
      const pgUniqueViolationCode = "23505";
      if (err && (err.code === pgUniqueViolationCode || err.errno === 23505)) {
        // Duplicate in same minute bucket — fetch the existing row
        try {
          const qb = this.paymentRepo.createQueryBuilder("p")
            .where("COALESCE(p.user_id, 0) = COALESCE(:uid, 0)", { uid })
            .andWhere("p.plan = :planName", { planName })
            .andWhere("p.status = :status", { status: "pending" })
            .andWhere("p.created_at_minute = :minute", { minute: minuteBucket.toISOString() })
            .orderBy("p.created_at", "DESC")
            .limit(1);

          if (billing === "" || billing === null) {
            qb.andWhere("p.billing_period IS NULL");
          } else {
            qb.andWhere("p.billing_period = :bp", { bp: billing });
          }

          const found = await qb.getOne();
          if (found) return this.invoiceShapeFromRow(found);
        } catch (findErr) {
          this.logger.debug("createPendingPayment duplicate handling query failed: " + (findErr as any));
        }
      }

      // Other errors: try fallback or rethrow
      this.logger.warn("createPendingPayment insert failed", err as any);
      try {
        const fallback = await this.paymentRepo.findOne({
          where: { user_id: uid, plan: planName },
          order: { createdAt: "DESC" },
        });
        if (fallback) return this.invoiceShapeFromRow(fallback as any);
      } catch { /* ignore */ }

      throw new HttpException({ statusCode: 500, message: "Failed to create pending invoice", error: (err as any)?.message ?? String(err) }, 500);
    }

    throw new Error("Failed to create pending invoice");
  }

  /**
   * Attach a PayPal order id to an existing pending payment (authenticated flow).
   * Returns the normalized invoice shape.
   */
  public async attachOrderToPayment(userId: number, paymentId: number, orderID: string, raw?: any) {
    const uid = this.ensureValidUserId(userId);
    if (!paymentId || Number.isNaN(Number(paymentId))) throw new BadRequestException("Invalid paymentId");
    const parsedId = Number(paymentId);
    const p = await this.paymentRepo.findOne({ where: { id: parsedId } as any });
    if (!p) throw new NotFoundException("Payment not found");
    if (p.user_id !== uid) throw new NotFoundException("Payment not found for user");

    (p as any).paypalOrderId = String(orderID);
    try {
      (p as any).raw = raw ? (typeof raw === "string" ? JSON.parse(raw) : raw) : p.raw;
    } catch {
      // ignore parse error
    }

    // If incoming raw metadata contains createdAt information, ensure it's persisted on the entity (createdAt)
    try {
      const parsedRaw = (p as any).raw ? (typeof (p as any).raw === "string" ? JSON.parse((p as any).raw) : (p as any).raw) : {};
      parsedRaw.__meta = parsedRaw.__meta || {};
      const createdMeta = parsedRaw.__meta.createdAt ?? parsedRaw.__meta.created_at ?? null;
      if (createdMeta) {
        try {
          const d = new Date(createdMeta);
          if (!isNaN(d.getTime())) {
            (p as any).createdAt = d;
            const minute = new Date(d);
            minute.setSeconds(0, 0);
            (p as any).createdAtMinute = minute;
            parsedRaw.__meta.createdAt = d.toISOString();
            parsedRaw.__meta.created_at = d.toISOString();
            (p as any).raw = parsedRaw;
          }
        } catch {}
      }
    } catch {}

    (p as any).updatedAt = new Date();
    const saved = await this.paymentRepo.save(p);
    return this.invoiceShapeFromRow(saved);
  }

  public async attachOrderPublic(orderID: string, raw?: any, createdAt?: string | null, clientTempId?: string | null) {
    if (!orderID || String(orderID).trim() === "") throw new BadRequestException("Invalid order id");

    let planName = "Pro";
    let amount = "0.00";
    let currency = "USD";

    try {
      const parsed = raw && typeof raw === "string" ? JSON.parse(raw) : raw ?? {};
      const pu = (parsed?.purchase_units && parsed.purchase_units[0]) || null;
      if (pu && pu.amount) {
        amount = String(pu.amount.value ?? amount);
        currency = String(pu.amount.currency_code ?? currency);
      }
      planName = parsed?.plan ?? planName;
    } catch {}

    // If createdAt was provided explicitly, use it as authoritative created_at; if not, try to read from raw.__meta
    let createdAtIso = new Date().toISOString();
    if (createdAt) {
      try {
        const d = new Date(createdAt);
        if (!isNaN(d.getTime())) createdAtIso = d.toISOString();
      } catch {}
    } else {
      try {
        const parsed = raw && typeof raw === "string" ? JSON.parse(raw) : raw ?? {};
        const metaCreated = parsed?.__meta?.createdAt ?? parsed?.__meta?.created_at ?? null;
        if (metaCreated) {
          const d = new Date(metaCreated);
          if (!isNaN(d.getTime())) createdAtIso = d.toISOString();
        }
      } catch {}
    }
    const createdAtDate = new Date(createdAtIso);
    const minuteBucket = new Date(createdAtDate);
    minuteBucket.setSeconds(0, 0);

    const insertObj: any = {
      user_id: null,
      plan: planName,
      billing_period: null,
      amount: Number(amount ?? 0),
      currency,
      paypal_order_id: String(orderID),
      status: "pending",
      raw: raw ? (typeof raw === "string" ? JSON.parse(raw) : raw) : JSON.stringify({ __meta: { client_temp_id: null, createdAt: createdAtIso, created_at: createdAtIso } }),
      created_at: createdAtDate,
      created_at_minute: minuteBucket,
      updated_at: createdAtDate,
    };

    const result = await this.dataSource.createQueryBuilder().insert().into("payments").values(insertObj).returning("*").execute();
    const saved = (result?.raw?.[0] ?? null) as any;
    return this.invoiceShapeFromRow(saved);
  }

  public async captureOrder(userId: number, orderID: string): Promise<Payment> {
    const uid = this.ensureValidUserId(userId);
    if (!orderID) throw new BadRequestException("Missing order id");

    const captureResult = await captureOrderOnPayPal(orderID);
    const purchaseUnit: any = (captureResult?.purchase_units && captureResult.purchase_units[0]) || null;
    const capturesArray: any[] | null = purchaseUnit?.payments?.captures ?? null;
    const capture: any = Array.isArray(capturesArray) && capturesArray.length > 0 ? capturesArray[0] : null;

    const captureId: string | null = capture?.id ?? null;
    const status: string = (capture?.status ?? captureResult?.status ?? "COMPLETED") as string;
    const amountVal: string | null = capture?.amount?.value ?? (purchaseUnit?.amount?.value ?? null);
    const currency: string = capture?.amount?.currency_code ?? (purchaseUnit?.amount?.currency_code ?? "USD");

    let payment = await this.paymentRepo.findOne({ where: { paypalOrderId: orderID } });

    if (!payment) {
      const now = new Date();
      const minuteBucket = new Date(now);
      minuteBucket.setSeconds(0, 0);

      const insertObj: any = {
        user_id: uid,
        plan: "Pro",
        billing_period: null,
        amount: Number(amountVal ?? 0),
        currency,
        paypal_order_id: orderID,
        paypal_capture_id: captureId,
        status: (status ?? "completed").toLowerCase(),
        raw: JSON.stringify(captureResult),
        payer_email: captureResult?.payer?.email_address ?? null,
        payer_name:
          captureResult?.payer?.name?.given_name
            ? `${captureResult.payer.name.given_name} ${captureResult.payer.name.surname ?? ""}`
            : null,
        created_at: now,
        created_at_minute: minuteBucket,
        updated_at: now,
      };

      const result = await this.dataSource.createQueryBuilder().insert().into("payments").values(insertObj).returning("*").execute();
      payment = (result?.raw?.[0] ?? null) as Payment;
      this.logger.debug(`captureOrder: inserted new payment with created_at=${(payment as any)?.created_at ?? "unknown"}`);
    } else {
      (payment as any).paypalCaptureId = captureId ?? (payment as any).paypalCaptureId;
      payment.status = (status ?? payment.status ?? "completed").toLowerCase();
      payment.amount = Number(amountVal ?? payment.amount);
      payment.currency = currency ?? payment.currency;
      payment.raw = JSON.stringify(captureResult);
      payment.payerEmail = captureResult?.payer?.email_address ?? payment.payerEmail;
      payment.payerName =
        captureResult?.payer?.name?.given_name ? `${captureResult.payer.name.given_name} ${captureResult.payer.name.surname ?? ""}` : payment.payerName;

      payment = await this.paymentRepo.save(payment);
      this.logger.debug(`captureOrder: updated payment id=${payment.id} updated_at=${(payment as any)?.updated_at ?? "unknown"}`);
    }

    try {
      const userRepo = this.dataSource.getRepository(User);
      const user = await userRepo.findOne({ where: { id: uid } } as any);
      if (user) {
        const planName = (payment as any).plan || user.plan || "Pro";
        const billing = (payment as any).billingPeriod || "monthly";
        user.plan = planName;
        const now = new Date();
        if (billing === "monthly") {
          now.setDate(now.getDate() + 30);
          user.plan_expiry = now;
        } else if (billing === "yearly") {
          now.setFullYear(now.getFullYear() + 1);
          user.plan_expiry = now;
        } else {
          user.plan_expiry = null;
        }
        await userRepo.save(user);
      }
    } catch (err) {
      this.logger.warn("Failed to update user plan after capture", err as any);
    }

    return payment as Payment;
  }

  public async listPaymentsForUser(userId: number): Promise<Payment[]> {
    const uid = this.ensureValidUserId(userId);
    return this.paymentRepo.find({ where: { user_id: uid }, order: { createdAt: "DESC" } });
  }

  public async listInvoicesForUserCurated(userId: number, paidLimit = 10): Promise<InvoiceDTO[]> {
    const uid = this.ensureValidUserId(userId);
    const all = await this.paymentRepo.find({ where: { user_id: uid }, order: { createdAt: "DESC" } });
    const pendingStatuses = ["pending", "created", "pending_capture", "authorized"];
    const paidStatuses = ["completed", "captured", "succeeded", "success", "paid"];

    const pendingRows = all.filter((r) => pendingStatuses.includes(String(r.status).toLowerCase()));
    const paidRows = all.filter((r) => paidStatuses.includes(String(r.status).toLowerCase())).slice(0, paidLimit);

    const buildInvoiceFromPayment = async (p: Payment): Promise<InvoiceDTO> => {
      const id = p.id;
      const date = p.createdAt ?? p.createdAt;
      const amount = this.formatAmount(p.amount);
      const currency = p.currency ?? "USD";
      const status = p.status ?? "pending";
      let reason: InvoiceDTO["reason"] = "unknown";
      let change_to: string | null = null;

      try {
        const raw = p.raw ? (typeof p.raw === "string" ? JSON.parse(p.raw) : p.raw) : {};
        if (raw && raw.__meta) {
          if (raw.__meta.reason) {
            const r = String(raw.__meta.reason).toLowerCase();
            if (r.includes("change")) reason = "change_plan";
            else if (r.includes("past")) reason = "past_due";
            else if (r.includes("next")) reason = "next_due";
            else reason = "regular";
          }
          if (raw.__meta.change_to) change_to = String(raw.__meta.change_to);
        }
      } catch {}

      if (!reason || reason === "unknown") {
        try {
          const userRepo = this.dataSource.getRepository(User);
          const user = await userRepo.findOne({ where: { id: uid } } as any);
          const profilePlan = user?.plan ?? null;
          let activeSubscription = false;
          if (user?.plan_expiry) {
            const expiry = new Date(user.plan_expiry);
            activeSubscription = !isNaN(expiry.getTime()) && expiry.getTime() > Date.now();
          }
          if (String(p.plan ?? "").toLowerCase() !== String(profilePlan ?? "").toLowerCase() && profilePlan) {
            reason = "change_plan";
            change_to = String(p.plan ?? null);
          } else if (!activeSubscription && (String(profilePlan ?? "").toLowerCase() !== "free")) {
            reason = "past_due";
          } else {
            reason = "regular";
          }
        } catch {
          reason = "regular";
        }
      }

      return {
        id,
        date,
        amount,
        currency,
        status,
        receipt_url: `/receipt/${id}`,
        reason,
        change_to,
        plan: p.plan ?? null,
        raw: p.raw ? (typeof p.raw === "string" ? JSON.parse(p.raw) : p.raw) : null,
      };
    };

    const pendingInvoices = await Promise.all(pendingRows.map((r) => buildInvoiceFromPayment(r)));
    const paidInvoices = await Promise.all(paidRows.map((r) => buildInvoiceFromPayment(r)));

    const merged = [...pendingInvoices, ...paidInvoices];

    // Dedupe by unique invoice id (each server row has a unique id)
    const seen = new Set<string>();
    const deduped = merged.filter((inv) => {
      const k = String(inv.id);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });

    return deduped;
  }

  public async getPaymentForUser(userId: number, paymentId: number): Promise<Payment> {
    const uid = this.ensureValidUserId(userId);
    const p = await this.paymentRepo.findOne({ where: { id: paymentId } });
    if (!p) throw new NotFoundException("Payment not found");
    if (p.user_id !== uid) throw new NotFoundException("Payment not found for user");
    return p;
  }

  public async getPaymentMethodPreview(userId: number) {
    const uid = this.ensureValidUserId(userId);
    const p = await this.paymentRepo.findOne({ where: { user_id: uid }, order: { createdAt: "DESC" } });
    if (!p) return null;
    return {
      brand: "PayPal",
      last4: "",
      masked: p.payerEmail ?? "",
      exp_month: null,
      exp_year: null,
    };
  }

  public async checkAccess(userId: number): Promise<AccessInfo> {
    if (!userId || Number.isNaN(Number(userId))) {
      return {
        allowed: false,
        activeSubscription: false,
        hasSuccessfulPayment: false,
        plan: null,
        plan_expiry: null,
        reason: "invalid_user",
      };
    }
    return this.getAccessInfo(userId);
  }

  public async getAccessInfo(userId: number): Promise<AccessInfo> {
    if (!userId) {
      return { allowed: false, activeSubscription: false, hasSuccessfulPayment: false, plan: null, plan_expiry: null, reason: "invalid_user" };
    }

    try {
      const userRepo = this.dataSource.getRepository(User);
      const user = await userRepo.findOne({ where: { id: userId } } as any);
      if (!user) {
        return { allowed: false, activeSubscription: false, hasSuccessfulPayment: false, plan: null, plan_expiry: null, reason: "user_not_found" };
      }

      const plan = user.plan ?? "Free";
      const plan_expiry = user.plan_expiry ? new Date(user.plan_expiry).toISOString() : null;
      let activeSubscription = false;
      if (user.plan_expiry) {
        const expiry = new Date(user.plan_expiry);
        if (!isNaN(expiry.getTime()) && expiry.getTime() > Date.now()) activeSubscription = true;
      }

      const allowedStatuses = ["completed", "captured", "succeeded", "success", "paid"];
      const found = await this.paymentRepo.findOne({
        where: { user_id: userId, status: In(allowedStatuses) } as any,
        order: { createdAt: "DESC" },
      });

      const hasSuccessfulPayment = !!found;
      const allowed = String(plan).toLowerCase() === "free" ? true : (activeSubscription || hasSuccessfulPayment);

      const pendingStatuses = ["pending", "created", "pending_capture", "authorized"];
      const pending = await this.paymentRepo.findOne({
        where: { user_id: userId, status: In(pendingStatuses) } as any,
        order: { createdAt: "DESC" },
      });

      let pendingAmount: string | null = null;
      if (pending) {
        try {
          const amt = pending.amount ?? 0;
          const amtNum = Number(amt);
          const amtStr = Number.isFinite(amtNum) ? amtNum.toFixed(2) : String(amt);
          const cur = pending.currency ?? "USD";
          pendingAmount = `${amtStr} ${String(cur).toUpperCase()}`;
        } catch {
          pendingAmount = null;
        }
      }

      return { allowed, activeSubscription, hasSuccessfulPayment, plan: String(plan), plan_expiry, reason: null, pendingAmount };
    } catch (err) {
      this.logger.warn("getAccessInfo failed", err as any);
      return { allowed: false, activeSubscription: false, hasSuccessfulPayment: false, plan: null, plan_expiry: null, reason: "internal_error" };
    }
  }

  public async handleWebhook(event: any) {
    try {
      const eventType = event?.event_type ?? event?.type ?? null;
      if (!eventType) return;

      if (["CHECKOUT.ORDER.APPROVED", "PAYMENT.CAPTURE.COMPLETED", "PAYMENT.CAPTURE.DENIED", "PAYMENT.CAPTURE.PENDING"].includes(eventType)) {
        const resource = event.resource ?? {};
        const orderId = resource?.supplementary_data?.related_ids?.order_id ?? resource?.order_id ?? resource?.id ?? null;

        if (!orderId && resource?.id) {
          const captureId = resource.id;
          const payment = await this.paymentRepo.findOne({ where: { paypalCaptureId: captureId } });
          if (payment) {
            payment.status = (resource?.status ?? payment.status ?? "completed").toLowerCase();
            payment.raw = JSON.stringify(event);
            await this.paymentRepo.save(payment);
          }
          return;
        }

        if (orderId) {
          const order = await getOrderOnPayPal(orderId);
          const pu = (order.purchase_units && order.purchase_units[0]) || null;
          const captures = pu?.payments?.captures ?? null;
          const cap = Array.isArray(captures) && captures.length > 0 ? captures[0] : null;

          const payment = await this.paymentRepo.findOne({ where: { paypalOrderId: orderId } });
          if (payment) {
            (payment as any).paypalCaptureId = cap?.id ?? (payment as any).paypalCaptureId;
            payment.status = (cap?.status ?? order.status ?? payment.status ?? "completed").toLowerCase();
            payment.payerEmail = order?.payer?.email_address ?? payment.payerEmail;
            payment.payerName = order?.payer?.name?.given_name ? `${order.payer.name.given_name} ${order.payer.name.surname ?? ""}` : payment.payerName;
            payment.raw = JSON.stringify(order || event);
            await this.paymentRepo.save(payment);
          } else {
            const amount = pu?.amount?.value ?? null;
            const currency = pu?.amount?.currency_code ?? "USD";
            const now = new Date();
            const minuteBucket = new Date(now);
            minuteBucket.setSeconds(0, 0);
            const insertObj: any = {
              paypal_order_id: orderId,
              paypal_capture_id: cap?.id ?? null,
              amount: Number(amount),
              currency,
              status: (cap?.status ?? order.status ?? "completed").toLowerCase(),
              payer_email: order?.payer?.email_address ?? null,
              payer_name: order?.payer?.name?.given_name ? `${order.payer.name.given_name} ${order.payer.name.surname ?? ""}` : null,
              raw: JSON.stringify(order || event),
              created_at: now,
              created_at_minute: minuteBucket,
              updated_at: new Date(),
            };
            await this.dataSource.createQueryBuilder().insert().into("payments").values(insertObj).execute();
            this.logger.debug(`handleWebhook: inserted payment created_at=${new Date().toISOString()}`);
          }
        }
      }
    } catch (err) {
      this.logger.warn("Webhook reconciliation failed", err as any);
    }
  }

  /* ---------- New: Delete / Clear helpers ---------- */

  /**
   * Delete a single payment if it belongs to the provided user.
   * Returns true if deleted, false if not found.
   */
  public async deletePaymentForUser(userId: number, paymentId: number | string): Promise<boolean> {
    const uid = this.ensureValidUserId(userId);
    const pid = Number(paymentId);
    if (!pid || Number.isNaN(pid)) {
      throw new BadRequestException("Invalid payment id");
    }

    const payment = await this.paymentRepo.findOne({ where: { id: pid } as any });
    if (!payment) return false;
    if (payment.user_id !== uid) {
      throw new ForbiddenException("Not allowed to delete this payment");
    }

    try {
      await this.paymentRepo.delete(pid);
      this.logger.debug(`deletePaymentForUser: deleted payment id=${pid} user=${uid}`);
      return true;
    } catch (err) {
      this.logger.warn("deletePaymentForUser failed", err as any);
      throw new HttpException({ statusCode: 500, message: "Failed to delete payment", error: (err as any)?.message ?? String(err) }, 500);
    }
  }

  /**
   * Clear (delete) all pending payments for a user.
   * Returns number of rows deleted.
   */
  public async clearPendingForUser(userId: number): Promise<number> {
    const uid = this.ensureValidUserId(userId);
    const pendingStatuses = ["pending", "created", "pending_capture", "authorized"];

    try {
      const res = await this.dataSource
        .createQueryBuilder()
        .delete()
        .from("payments")
        .where("COALESCE(user_id, 0) = COALESCE(:uid, 0)", { uid })
        .andWhere("status IN (:...statuses)", { statuses: pendingStatuses })
        .execute();
      const affected = Number((res as any)?.affected ?? 0);
      this.logger.debug(`clearPendingForUser: deleted ${affected} pending rows for user=${uid}`);
      return affected;
    } catch (err) {
      this.logger.warn("clearPendingForUser failed", err as any);
      throw new HttpException({ statusCode: 500, message: "Failed to clear pending invoices", error: (err as any)?.message ?? String(err) }, 500);
    }
  }
}